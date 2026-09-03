/**
 * Shared Wikidata → PostGIS sightseeing seed engine.
 *
 * SPARQL quality filters match the Europe seed exactly:
 * `SPARQL_POI_CATEGORIES` + `SPARQL_INSTANCE_OF_CLAUSE` from
 * `utils/places-lookup-utils.mjs`.
 *
 * Country queries use `wdt:P17`. City queries use `wdt:P131*` (admin tree)
 * plus an optional `wdt:P17` when the country is known.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWikidataQid } from "../../services/ensure-sightseeing-by-qid.mjs";
import {
    closeSightseeingPool,
    getSightseeingPool,
    resetSightseeingPoolForTests,
    sightseeingQuery,
} from "../../services/sightseeing-db.mjs";
import {
    SPARQL_INSTANCE_OF_CLAUSE,
    SPARQL_POI_CATEGORIES,
    classifyPlaceTypeFromCategory,
    parseWktPoint,
    readSparqlBinding,
    runWikidataSparql,
    wikidataIdFromItemUri,
} from "../../utils/places-lookup-utils.mjs";
import { sleep } from "./script-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(__dirname, "..", "..", "db", "001_sightseeing.sql");

export const DEFAULT_PAGE_SIZE = 2000;
export const DEFAULT_DELAY_MS = 1500;
export const DEFAULT_MIN_SITELINKS = 1;
export const DEFAULT_REGION_RETRIES = 2;
export const DEFAULT_CITY_RADIUS_KM = 20;
export const SPARQL_TIMEOUT_MS = 120_000;
export const SPARQL_MAX_ATTEMPTS = 3;
export const MAX_TILE_DEPTH = 5;
export const UPSERT_BATCH_SIZE = 50;
export const UPSERT_MAX_ATTEMPTS = 4;
export const HEARTBEAT_MS = 5 * 60_000;
export const LOOKUP_TIMEOUT_MS = 45_000;

/** City / town / municipality classes used when resolving `--city`. */
export const SPARQL_CITY_CLASSES = `
    wd:Q515 wd:Q1549591 wd:Q1093829 wd:Q1637706 wd:Q5119 wd:Q3957
    wd:Q15284 wd:Q486972 wd:Q208511 wd:Q1549593 wd:Q174844 wd:Q532
    wd:Q133442 wd:Q2264924 wd:Q51929311
`;

/** Country / sovereign-state classes used when resolving `--country`. */
export const SPARQL_COUNTRY_CLASSES = `
    wd:Q6256 wd:Q3624078 wd:Q7275 wd:Q161243 wd:Q123480 wd:Q1520223
`;

/**
 * Tight bboxes for countries whose full-country Wikidata queries time out.
 * Values may be a single bbox or an array (US: contiguous + Alaska + Hawaii).
 *
 * @type {Record<string, { minLon: number, maxLon: number, minLat: number, maxLat: number } | Array<{ minLon: number, maxLon: number, minLat: number, maxLat: number }>>}
 */
export const COUNTRY_SIGHTSEEING_BOUNDS = {
    // United States — contiguous, Alaska, Hawaii
    Q30: [
        { minLon: -125, maxLon: -66.5, minLat: 24.5, maxLat: 49.5 },
        { minLon: -180, maxLon: -129, minLat: 51, maxLat: 72 },
        { minLon: -161, maxLon: -154.5, minLat: 18.5, maxLat: 22.5 },
    ],
    // Canada (south of high Arctic)
    Q16: { minLon: -141, maxLon: -52, minLat: 41.5, maxLat: 70 },
    // Mexico
    Q96: { minLon: -118.5, maxLon: -86.5, minLat: 14.5, maxLat: 32.8 },
    // Metropolitan France + Corsica
    Q142: { minLon: -5.5, maxLon: 9.8, minLat: 41.2, maxLat: 51.2 },
    // Germany
    Q183: { minLon: 5.8, maxLon: 15.1, minLat: 47.2, maxLat: 55.1 },
    // Italy (incl. Sicily / Sardinia)
    Q38: { minLon: 6.5, maxLon: 18.6, minLat: 36.6, maxLat: 47.2 },
    // Austria
    Q40: { minLon: 9.4, maxLon: 17.2, minLat: 46.3, maxLat: 49.1 },
    // European Russia
    Q159: { minLon: 19.5, maxLon: 60, minLat: 41, maxLat: 72 },
    // United Kingdom
    Q145: { minLon: -9, maxLon: 2.1, minLat: 49.8, maxLat: 61 },
    // Spain
    Q29: { minLon: -9.4, maxLon: 4.4, minLat: 35.9, maxLat: 43.9 },
    // China
    Q148: { minLon: 73, maxLon: 135, minLat: 18, maxLat: 54 },
    // India
    Q668: { minLon: 68, maxLon: 97.5, minLat: 6.5, maxLat: 35.7 },
    // Brazil
    Q155: { minLon: -74, maxLon: -34.7, minLat: -34, maxLat: 5.3 },
    // Australia
    Q408: { minLon: 113, maxLon: 154, minLat: -44, maxLat: -10 },
    // Japan
    Q17: { minLon: 129, maxLon: 146, minLat: 30.5, maxLat: 45.6 },
    // Indonesia
    Q252: { minLon: 95, maxLon: 141, minLat: -11, maxLat: 6 },
};

/** Wikidata QIDs that must start tiled (never a single full-country SPARQL). */
export const FORCE_TILE_COUNTRY_QIDS = new Set(Object.keys(COUNTRY_SIGHTSEEING_BOUNDS));

/**
 * @typedef {{
 *   minLon: number,
 *   maxLon: number,
 *   minLat: number,
 *   maxLat: number,
 * }} SeedBounds
 *
 * @typedef {{
 *   name: string,
 *   wikidataId: string,
 *   kind: "country" | "city",
 *   countryQid?: string | null,
 *   city?: string | null,
 *   lat?: number | null,
 *   lng?: number | null,
 *   bounds?: SeedBounds | null,
 * }} SeedRegion
 */

/**
 * @param {string} value
 * @returns {string}
 */
export function sparqlStringLiteral(value) {
    return String(value ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, " ")
        .trim()
        .slice(0, 120);
}

/**
 * @param {string} qid
 * @returns {string}
 */
export function normalizeQid(qid) {
    const parsed = parseWikidataQid(qid);
    if (!parsed) {
        throw new Error(`Invalid Wikidata QID: ${qid}`);
    }
    return parsed;
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @returns {SeedBounds}
 */
export function boundsFromCenterRadius(lat, lng, radiusKm) {
    const radius = Math.max(1, Number(radiusKm) || DEFAULT_CITY_RADIUS_KM);
    const dLat = radius / 111.32;
    const cos = Math.cos((Number(lat) * Math.PI) / 180);
    const dLon = radius / (111.32 * Math.max(0.2, Math.abs(cos)));
    return {
        minLat: Number(lat) - dLat,
        maxLat: Number(lat) + dLat,
        minLon: Number(lng) - dLon,
        maxLon: Number(lng) + dLon,
    };
}

/**
 * @param {Array<{ lat: number, lng: number } | null | undefined>} points
 * @returns {SeedBounds | null}
 */
export function boundsFromPoints(points) {
    const valid = points.filter(
        (point) =>
            point &&
            Number.isFinite(point.lat) &&
            Number.isFinite(point.lng),
    );
    if (valid.length < 2) return null;
    return {
        minLat: Math.min(...valid.map((point) => point.lat)),
        maxLat: Math.max(...valid.map((point) => point.lat)),
        minLon: Math.min(...valid.map((point) => point.lng)),
        maxLon: Math.max(...valid.map((point) => point.lng)),
    };
}

/**
 * Same quality category whitelist + P31 instance-of clause as the Europe seed.
 *
 * @param {{
 *   countryQid?: string | null,
 *   cityQid?: string | null,
 *   minSitelinks: number,
 *   maxSitelinks?: number | null,
 *   pageSize: number,
 *   offset: number,
 *   bounds?: Partial<SeedBounds> | null,
 * }} options
 * @returns {string}
 */
export function buildRegionSightseeingSparql({
    countryQid = null,
    cityQid = null,
    minSitelinks,
    maxSitelinks = null,
    pageSize,
    offset,
    bounds = null,
}) {
    const country = countryQid ? normalizeQid(countryQid) : null;
    const city = cityQid ? normalizeQid(cityQid) : null;
    if (!country && !city) {
        throw new Error("Sightseeing SPARQL requires a country QID and/or city QID");
    }

    const scopeClauses = [
        country ? `?item wdt:P17 wd:${country} .` : "",
        city ? `?item wdt:P131* wd:${city} .` : "",
    ]
        .filter(Boolean)
        .join("\n  ");

    const bboxFilter = bounds
        ? `
  FILTER(
    geof:longitude(?location) >= ${Number(bounds.minLon ?? -180)} &&
    geof:longitude(?location) < ${Number(bounds.maxLon ?? 180)} &&
    geof:latitude(?location) >= ${Number(bounds.minLat ?? -90)} &&
    geof:latitude(?location) < ${Number(bounds.maxLat ?? 90)}
  )`
        : "";

    const min = Math.max(0, Number(minSitelinks) || 0);
    const maxFilter =
        maxSitelinks != null && Number.isFinite(Number(maxSitelinks))
            ? ` && ?sitelinks < ${Number(maxSitelinks)}`
            : "";

    return `
SELECT DISTINCT ?item ?itemLabel ?image ?location ?categoryLabel ?sitelinks ?countryLabel ?countryCode WHERE {
  ${scopeClauses}
  VALUES ?category { ${SPARQL_POI_CATEGORIES} }
  ${SPARQL_INSTANCE_OF_CLAUSE}
  ?item wdt:P625 ?location .
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    ?country wdt:P297 ?countryCode .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${min}${maxFilter})
  ${bboxFilter}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks) ?item
LIMIT ${pageSize} OFFSET ${offset}
`.trim();
}

/** @deprecated use buildRegionSightseeingSparql — kept for Europe/NA call sites */
export function buildCountrySightseeingSparql(options) {
    return buildRegionSightseeingSparql(options);
}

/**
 * @param {{ needle: string, kind: "city" | "country", countryQid?: string | null }} options
 * @returns {string}
 */
export function buildPlaceSearchSparql({ needle, kind, countryQid = null }) {
    const raw = String(needle ?? "").trim();
    if (!raw) throw new Error("Place search needle is empty");
    const literal = sparqlStringLiteral(raw);
    const iso2 = /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : "";
    const iso3 = /^[A-Za-z]{3}$/.test(raw) ? raw.toUpperCase() : "";
    const classes = kind === "country" ? SPARQL_COUNTRY_CLASSES : SPARQL_CITY_CLASSES;
    const countryFilter = countryQid
        ? `?item wdt:P17 wd:${normalizeQid(countryQid)} .`
        : "";

    const isoClauses = [];
    if (kind === "country" && iso2) {
        isoClauses.push(`{ ?item wdt:P297 "${iso2}" . }`);
    }
    if (kind === "country" && iso3) {
        isoClauses.push(`{ ?item wdt:P298 "${iso3}" . }`);
    }

    return `
SELECT DISTINCT ?item ?itemLabel ?location ?country ?countryLabel ?iso ?sitelinks WHERE {
  {
    { ?item rdfs:label "${literal}"@en . }
    UNION
    { ?item skos:altLabel "${literal}"@en . }
    ${isoClauses.length ? `UNION\n    ${isoClauses.join("\n    UNION\n    ")}` : ""}
  }
  VALUES ?class { ${classes} }
  ?item wdt:P31/wdt:P279* ?class .
  ${countryFilter}
  OPTIONAL { ?item wdt:P625 ?location . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    OPTIONAL { ?country wdt:P297 ?iso . }
  }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks)
LIMIT 8
`.trim();
}

/**
 * @param {string} qid
 * @returns {string}
 */
export function buildPlaceMetaSparql(qid) {
    const safe = normalizeQid(qid);
    return `
SELECT ?itemLabel ?location ?country ?countryLabel ?iso ?north ?south ?east ?west ?sitelinks WHERE {
  BIND(wd:${safe} AS ?item)
  OPTIONAL { ?item wdt:P625 ?location . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    OPTIONAL { ?country wdt:P297 ?iso . }
  }
  OPTIONAL { ?item wdt:P1332 ?north . }
  OPTIONAL { ?item wdt:P1333 ?south . }
  OPTIONAL { ?item wdt:P1334 ?east . }
  OPTIONAL { ?item wdt:P1335 ?west . }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 1
`.trim();
}

/**
 * @param {Record<string, unknown>} binding
 * @param {Partial<SeedBounds> | null | undefined} bounds
 * @returns {Record<string, unknown> | null}
 */
export function bindingToSightseeingRow(binding, bounds = null) {
    const itemUri = readSparqlBinding(binding, "item") ?? "";
    const wikidataId = wikidataIdFromItemUri(itemUri);
    const name = readSparqlBinding(binding, "itemLabel") ?? "";
    if (!wikidataId || !name || /^Q\d+$/.test(name) || name === "Unknown Place") {
        return null;
    }

    const coords = parseWktPoint(readSparqlBinding(binding, "location") ?? "");
    if (!coords) return null;

    if (bounds) {
        if (bounds.maxLon != null && coords.lng > bounds.maxLon) return null;
        if (bounds.minLon != null && coords.lng < bounds.minLon) return null;
        if (bounds.maxLat != null && coords.lat > bounds.maxLat) return null;
        if (bounds.minLat != null && coords.lat < bounds.minLat) return null;
    }

    const categoryLabel = readSparqlBinding(binding, "categoryLabel") ?? "Point of Interest";
    const countryCode = (readSparqlBinding(binding, "countryCode") ?? "")
        .toUpperCase()
        .slice(0, 2);
    const country = readSparqlBinding(binding, "countryLabel") ?? "";
    const sitelinks = Number.parseInt(readSparqlBinding(binding, "sitelinks") ?? "0", 10) || 0;
    const image = readSparqlBinding(binding, "image");

    return {
        wikidata_id: wikidataId,
        name,
        type: classifyPlaceTypeFromCategory(categoryLabel),
        category_label: categoryLabel,
        country_code: countryCode || null,
        country: country || null,
        city: null,
        sitelinks,
        image_url: image || null,
        wikipedia_url: null,
        lat: coords.lat,
        lng: coords.lng,
    };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableDbError(error) {
    const message = String(error?.message ?? error ?? "").toLowerCase();
    return (
        message.includes("connection") ||
        message.includes("timeout") ||
        message.includes("econnreset") ||
        message.includes("econnrefused") ||
        message.includes("terminat") ||
        message.includes("too many clients")
    );
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableRegionError(error) {
    if (error?.name === "WikidataSparqlTransientError") return true;
    const message = String(error?.message ?? error ?? "");
    return (
        isRetryableDbError(error) ||
        /^Wikidata SPARQL HTTP (429|5\d\d)/.test(message) ||
        message.includes("All tiles failed") ||
        message.includes("All regions failed")
    );
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Promise<number>}
 */
export async function upsertSightseeingRows(rows) {
    if (rows.length === 0) return 0;
    let written = 0;

    for (let start = 0; start < rows.length; start += UPSERT_BATCH_SIZE) {
        const batch = rows.slice(start, start + UPSERT_BATCH_SIZE);
        const values = [];
        const params = [];
        batch.forEach((row, index) => {
            const base = index * 12;
            values.push(
                `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, ` +
                    `$${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, ` +
                    `ST_SetSRID(ST_MakePoint($${base + 12}, $${base + 11}), 4326)::geography, now())`,
            );
            params.push(
                row.wikidata_id,
                row.name,
                row.type,
                row.category_label,
                row.country_code,
                row.country,
                row.city,
                row.sitelinks,
                row.image_url,
                row.wikipedia_url,
                row.lat,
                row.lng,
            );
        });

        const sql = `
INSERT INTO sightseeing (
  wikidata_id, name, type, category_label, country_code, country, city,
  sitelinks, image_url, wikipedia_url, lat, lng, location, updated_at
) VALUES
  ${values.join(",\n  ")}
ON CONFLICT (wikidata_id) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  category_label = EXCLUDED.category_label,
  country_code = EXCLUDED.country_code,
  country = EXCLUDED.country,
  city = EXCLUDED.city,
  sitelinks = EXCLUDED.sitelinks,
  image_url = EXCLUDED.image_url,
  wikipedia_url = EXCLUDED.wikipedia_url,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  location = EXCLUDED.location,
  updated_at = now()
`.trim();

        let lastError = null;
        for (let attempt = 0; attempt < UPSERT_MAX_ATTEMPTS; attempt++) {
            try {
                await sightseeingQuery(sql, params);
                written += batch.length;
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                if (!isRetryableDbError(error) || attempt >= UPSERT_MAX_ATTEMPTS - 1) {
                    break;
                }
                const delayMs = 1000 * 2 ** attempt;
                console.warn(
                    `[seed] DB upsert retry ${attempt + 1}/${UPSERT_MAX_ATTEMPTS} ` +
                        `in ${delayMs}ms: ${error?.message || error}`,
                );
                await closeSightseeingPool().catch(() => {});
                resetSightseeingPoolForTests();
                getSightseeingPool({ max: 2 });
                await sleep(delayMs);
            }
        }
        if (lastError) throw lastError;
    }

    return written;
}

/**
 * @param {SeedBounds} bounds
 * @returns {SeedBounds[]}
 */
export function splitBounds(bounds) {
    const midLon = (bounds.minLon + bounds.maxLon) / 2;
    const midLat = (bounds.minLat + bounds.maxLat) / 2;
    return [
        { minLon: bounds.minLon, maxLon: midLon, minLat: midLat, maxLat: bounds.maxLat },
        { minLon: midLon, maxLon: bounds.maxLon, minLat: midLat, maxLat: bounds.maxLat },
        { minLon: bounds.minLon, maxLon: midLon, minLat: bounds.minLat, maxLat: midLat },
        { minLon: midLon, maxLon: bounds.maxLon, minLat: bounds.minLat, maxLat: midLat },
    ];
}

/**
 * @param {SeedRegion} region
 * @returns {SeedBounds[]}
 */
export function regionSightseeingBoundList(region) {
    const qid = String(region.wikidataId || "").replace(/^wd:/, "");
    const tight = COUNTRY_SIGHTSEEING_BOUNDS[qid];
    if (Array.isArray(tight)) {
        return tight.map((box) => ({ ...box }));
    }
    if (tight) return [{ ...tight }];
    if (region.bounds) return [{ ...region.bounds }];
    return [];
}

/**
 * @param {SeedRegion} region
 * @returns {SeedBounds | null}
 */
export function regionSightseeingBounds(region) {
    return regionSightseeingBoundList(region)[0] ?? region.bounds ?? null;
}

/** @deprecated use regionSightseeingBounds */
export function countrySightseeingBoundList(country) {
    return regionSightseeingBoundList(country);
}

/** @deprecated use regionSightseeingBounds */
export function countrySightseeingBounds(country) {
    return regionSightseeingBounds(country);
}

/**
 * @param {SeedRegion} region
 * @param {boolean} [forceTilesFlag]
 * @returns {boolean}
 */
export function shouldForceTileSeed(region, forceTilesFlag = false) {
    if (forceTilesFlag) return true;
    const qid = String(region.wikidataId || "").replace(/^wd:/, "");
    if (FORCE_TILE_COUNTRY_QIDS.has(qid)) return true;
    const bounds = regionSightseeingBounds(region);
    if (!bounds) return false;
    const spanLon = Math.abs(bounds.maxLon - bounds.minLon);
    const spanLat = Math.abs(bounds.maxLat - bounds.minLat);
    return spanLon > 12 || spanLat > 10;
}

/**
 * @param {string[]} argv
 */
export function parseSharedSeedOpts(argv) {
    const opts = {
        dryRun: false,
        city: "",
        country: "",
        limit: 0,
        offset: 0,
        resume: false,
        delayMs: DEFAULT_DELAY_MS,
        pageSize: DEFAULT_PAGE_SIZE,
        minSitelinks: DEFAULT_MIN_SITELINKS,
        /** @type {number | null} */
        maxSitelinks: null,
        forceTiles: false,
        regionRetries: DEFAULT_REGION_RETRIES,
        migrateDb: false,
        noCaffeinate: false,
        reportDir: "reports",
        databaseUrl: "",
        radiusKm: DEFAULT_CITY_RADIUS_KM,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--migrate-db") opts.migrateDb = true;
        else if (arg === "--resume") opts.resume = true;
        else if (arg === "--force-tiles") opts.forceTiles = true;
        else if (arg === "--no-caffeinate") opts.noCaffeinate = true;
        else if (arg === "--help" || arg === "-h") opts.help = true;
        else if ((arg === "--city" || arg === "-c") && next) {
            opts.city = next;
            i++;
        } else if (arg.startsWith("--city=")) {
            opts.city = arg.slice("--city=".length);
        } else if (arg === "--country" && next) {
            opts.country = next;
            i++;
        } else if (arg.startsWith("--country=")) {
            opts.country = arg.slice("--country=".length);
        } else if (arg === "--limit" && next) {
            opts.limit = Number.parseInt(next, 10) || 0;
            i++;
        } else if (arg === "--offset" && next) {
            opts.offset = Number.parseInt(next, 10) || 0;
            i++;
        } else if (arg === "--delay-ms" && next) {
            opts.delayMs = Number.parseInt(next, 10) || DEFAULT_DELAY_MS;
            i++;
        } else if (arg === "--page-size" && next) {
            opts.pageSize = Number.parseInt(next, 10) || DEFAULT_PAGE_SIZE;
            i++;
        } else if (arg === "--min-sitelinks" && next) {
            opts.minSitelinks = Number.parseInt(next, 10) || DEFAULT_MIN_SITELINKS;
            i++;
        } else if (arg === "--max-sitelinks" && next) {
            const parsed = Number.parseInt(next, 10);
            opts.maxSitelinks = Number.isFinite(parsed) ? parsed : null;
            i++;
        } else if ((arg === "--country-retries" || arg === "--region-retries") && next) {
            opts.regionRetries = Math.max(
                1,
                Number.parseInt(next, 10) || DEFAULT_REGION_RETRIES,
            );
            i++;
        } else if (arg === "--radius-km" && next) {
            opts.radiusKm = Math.max(1, Number.parseFloat(next) || DEFAULT_CITY_RADIUS_KM);
            i++;
        } else if (arg.startsWith("--radius-km=")) {
            opts.radiusKm = Math.max(
                1,
                Number.parseFloat(arg.slice("--radius-km=".length)) || DEFAULT_CITY_RADIUS_KM,
            );
        } else if (arg === "--report-dir" && next) {
            opts.reportDir = next;
            i++;
        } else if (arg === "--database-url" && next) {
            opts.databaseUrl = next;
            i++;
        } else if (arg.startsWith("--database-url=")) {
            opts.databaseUrl = arg.slice("--database-url=".length);
        } else if (arg.startsWith("-")) {
            throw new Error(`Unknown flag: ${arg}`);
        } else {
            throw new Error(`Unexpected argument: ${arg}`);
        }
    }

    if (opts.maxSitelinks != null && opts.maxSitelinks <= opts.minSitelinks) {
        throw new Error(
            `--max-sitelinks (${opts.maxSitelinks}) must be greater than --min-sitelinks (${opts.minSitelinks})`,
        );
    }
    return opts;
}

/**
 * Re-launch under macOS caffeinate so long Wikidata runs survive idle sleep.
 */
export function ensureCaffeinate(opts) {
    if (opts.noCaffeinate || process.env.SIGHTSEEING_SEED_NO_CAFFEINATE === "1") {
        return;
    }
    if (process.env.SIGHTSEEING_SEED_CAFFEINATED === "1") return;
    if (process.platform !== "darwin") return;

    console.log(
        "[seed] re-launching under `caffeinate -dims` to prevent idle sleep " +
            "(use --no-caffeinate to skip)",
    );
    const result = spawnSync(
        "caffeinate",
        ["-dims", "--", process.execPath, ...process.argv.slice(1)],
        {
            env: { ...process.env, SIGHTSEEING_SEED_CAFFEINATED: "1" },
            stdio: "inherit",
        },
    );
    process.exit(result.status ?? 1);
}

/**
 * @param {string} reportDir
 * @returns {string}
 */
export function resolveReportDir(reportDir) {
    const abs = reportDir.startsWith("/") ? reportDir : join(__dirname, reportDir);
    mkdirSync(abs, { recursive: true });
    return abs;
}

/**
 * @param {string} reportDir
 * @param {string} progressLogFile
 * @param {string} message
 */
export function logProgress(reportDir, progressLogFile, message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(message.startsWith("[seed]") ? message : `[seed] ${message}`);
    try {
        appendFileSync(join(reportDir, progressLogFile), `${line}\n`, "utf8");
    } catch {
        // progress log is best-effort
    }
}

/**
 * @param {string} reportDir
 * @param {string} checkpointFile
 */
export function readCheckpoint(reportDir, checkpointFile) {
    const path = join(reportDir, checkpointFile);
    if (!existsSync(path)) {
        return { completedQids: [], regions: [] };
    }
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const regions = Array.isArray(raw.regions)
            ? raw.regions
            : Array.isArray(raw.countries)
              ? raw.countries
              : [];
        return {
            completedQids: Array.isArray(raw.completedQids)
                ? raw.completedQids.map(String)
                : [],
            regions,
            updatedAt: raw.updatedAt,
        };
    } catch {
        return { completedQids: [], regions: [] };
    }
}

/**
 * @param {string} reportDir
 * @param {string} checkpointFile
 * @param {{ completedQids: string[], regions: Array<Record<string, unknown>> }} checkpoint
 */
export function writeCheckpoint(reportDir, checkpointFile, checkpoint) {
    const path = join(reportDir, checkpointFile);
    writeFileSync(
        path,
        `${JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
    );
}

export async function applySchema() {
    const sql = readFileSync(SCHEMA_PATH, "utf8");
    await sightseeingQuery(sql);
    console.log("[seed] applied schema %s", SCHEMA_PATH);
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} extra
 */
function sparqlOptions(extra) {
    return {
        timeoutMs: SPARQL_TIMEOUT_MS,
        maxAttempts: SPARQL_MAX_ATTEMPTS,
        extra,
    };
}

/**
 * @param {Record<string, unknown>} binding
 */
function candidateFromSearchBinding(binding) {
    const itemUri = readSparqlBinding(binding, "item") ?? "";
    const wikidataId = wikidataIdFromItemUri(itemUri);
    const name = readSparqlBinding(binding, "itemLabel") ?? "";
    if (!wikidataId || !name) return null;
    const coords = parseWktPoint(readSparqlBinding(binding, "location") ?? "");
    return {
        wikidataId,
        name,
        countryQid: wikidataIdFromItemUri(readSparqlBinding(binding, "country") ?? ""),
        country: readSparqlBinding(binding, "countryLabel") ?? null,
        iso: (readSparqlBinding(binding, "iso") ?? "").toUpperCase() || null,
        sitelinks: Number.parseInt(readSparqlBinding(binding, "sitelinks") ?? "0", 10) || 0,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
    };
}

/**
 * @param {Record<string, unknown>} binding
 * @param {{ name?: string, kind: "city" | "country" }} extra
 */
function regionFromMetaBinding(qid, binding, extra) {
    const name =
        readSparqlBinding(binding, "itemLabel") || extra.name || qid;
    const coords = parseWktPoint(readSparqlBinding(binding, "location") ?? "");
    const extremes = boundsFromPoints([
        parseWktPoint(readSparqlBinding(binding, "north") ?? ""),
        parseWktPoint(readSparqlBinding(binding, "south") ?? ""),
        parseWktPoint(readSparqlBinding(binding, "east") ?? ""),
        parseWktPoint(readSparqlBinding(binding, "west") ?? ""),
    ]);
    const countryQid = wikidataIdFromItemUri(readSparqlBinding(binding, "country") ?? "");
    /** @type {SeedRegion} */
    const region = {
        name,
        wikidataId: qid,
        kind: extra.kind,
        countryQid: extra.kind === "country" ? qid : countryQid,
        city: extra.kind === "city" ? name : null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        bounds: extremes,
    };
    return region;
}

/**
 * Resolve a city or country name / ISO code / QID to a seed region.
 *
 * @param {{
 *   needle: string,
 *   kind: "city" | "country",
 *   countryNeedle?: string,
 *   radiusKm?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<SeedRegion>}
 */
export async function resolveSeedPlace({
    needle,
    kind,
    countryNeedle = "",
    radiusKm = DEFAULT_CITY_RADIUS_KM,
    fetchImpl = fetch,
}) {
    const raw = String(needle ?? "").trim();
    if (!raw) {
        throw new Error(`Missing ${kind} name or QID`);
    }

    /** @type {string | null} */
    let countryQidFilter = null;
    if (kind === "city" && countryNeedle) {
        const asQid = parseWikidataQid(countryNeedle);
        if (asQid) {
            countryQidFilter = asQid;
        } else {
            const country = await resolveSeedPlace({
                needle: countryNeedle,
                kind: "country",
                fetchImpl,
            });
            countryQidFilter = country.wikidataId;
        }
    }

    let qid = parseWikidataQid(raw);
    let searchName = raw;
    if (!qid) {
        const searchSparql = buildPlaceSearchSparql({
            needle: raw,
            kind,
            countryQid: countryQidFilter,
        });
        const bindings = await runWikidataSparql(searchSparql, fetchImpl, {
            timeoutMs: LOOKUP_TIMEOUT_MS,
            maxAttempts: SPARQL_MAX_ATTEMPTS,
            extra: `lookup ${kind}=${raw}`,
        });
        const candidates = bindings
            .map((binding) => candidateFromSearchBinding(binding))
            .filter(Boolean);
        if (candidates.length === 0) {
            throw new Error(`No Wikidata ${kind} matched "${raw}"`);
        }
        const picked = candidates[0];
        qid = picked.wikidataId;
        searchName = picked.name;
        if (candidates.length > 1) {
            console.log(
                `[seed] ${kind} "${raw}" matched ${candidates.length} places; ` +
                    `using ${picked.name} (${qid}, sitelinks=${picked.sitelinks})`,
            );
        }
    }

    const metaBindings = await runWikidataSparql(buildPlaceMetaSparql(qid), fetchImpl, {
        timeoutMs: LOOKUP_TIMEOUT_MS,
        maxAttempts: SPARQL_MAX_ATTEMPTS,
        extra: `meta ${kind}=${qid}`,
    });
    const region = regionFromMetaBinding(qid, metaBindings[0] ?? {}, {
        name: searchName,
        kind,
    });
    if (countryQidFilter && kind === "city") {
        region.countryQid = countryQidFilter;
    }

    const known = COUNTRY_SIGHTSEEING_BOUNDS[region.wikidataId];
    if (known && !Array.isArray(known) && !region.bounds) {
        region.bounds = { ...known };
    }
    if (kind === "city") {
        if (!region.bounds) {
            if (region.lat == null || region.lng == null) {
                throw new Error(
                    `City ${region.name} (${qid}) has no coordinates on Wikidata`,
                );
            }
            region.bounds = boundsFromCenterRadius(region.lat, region.lng, radiusKm);
        }
        region.city = region.name;
    }

    return region;
}

/**
 * @param {{
 *   region: SeedRegion,
 *   bounds: SeedBounds | null,
 *   pageSize: number,
 *   minSitelinks: number,
 *   maxSitelinks?: number | null,
 *   delayMs: number,
 *   dryRun: boolean,
 *   depth?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ fetched: number, upserted: number, pages: number, tileErrors?: string[] }>}
 */
async function seedRegionTile({
    region,
    bounds,
    pageSize,
    minSitelinks,
    maxSitelinks = null,
    delayMs,
    dryRun,
    depth = 0,
    fetchImpl = fetch,
}) {
    let offset = 0;
    let upserted = 0;
    let pages = 0;
    /** @type {Map<string, Record<string, unknown>>} */
    const seen = new Map();
    const configured = COUNTRY_SIGHTSEEING_BOUNDS[
        String(region.wikidataId || "").replace(/^wd:/, "")
    ];
    const rowBoundsFilter =
        bounds ??
        (configured && !Array.isArray(configured) ? configured : null) ??
        region.bounds ??
        null;

    while (true) {
        const sparql = buildRegionSightseeingSparql({
            countryQid: region.kind === "country" ? region.wikidataId : region.countryQid,
            cityQid: region.kind === "city" ? region.wikidataId : null,
            minSitelinks,
            maxSitelinks,
            pageSize,
            offset,
            bounds,
        });

        console.log(
            `[seed] ${region.name} depth=${depth} offset=${offset}` +
                (bounds
                    ? ` bbox=[${bounds.minLon},${bounds.minLat}..${bounds.maxLon},${bounds.maxLat}]`
                    : ""),
        );

        let bindings;
        try {
            bindings = await runWikidataSparql(sparql, fetchImpl, sparqlOptions(
                `${region.kind}=${region.name} offset=${offset}`,
            ));
        } catch (error) {
            if (depth < MAX_TILE_DEPTH) {
                const tileBounds = bounds ?? regionSightseeingBounds(region);
                if (!tileBounds) throw error;
                console.warn(
                    `[seed] ${region.name} SPARQL failed at depth=${depth}; subdividing: ${error?.message || error}`,
                );
                return seedRegionTilesFanout({
                    region,
                    bounds: tileBounds,
                    pageSize,
                    minSitelinks,
                    maxSitelinks,
                    delayMs,
                    dryRun,
                    depth,
                    fetchImpl,
                });
            }
            throw error;
        }

        pages++;
        if (!bindings.length) break;

        if (!bounds && offset === 0 && bindings.length >= pageSize && depth === 0) {
            const tileBounds = regionSightseeingBounds(region);
            if (tileBounds) {
                console.log(`[seed] ${region.name} large result set; switching to bbox tiles`);
                await sleep(delayMs);
                return seedRegionTilesFanout({
                    region,
                    bounds: tileBounds,
                    pageSize,
                    minSitelinks,
                    maxSitelinks,
                    delayMs,
                    dryRun,
                    depth: 0,
                    fetchImpl,
                });
            }
        }

        for (const binding of bindings) {
            const row = bindingToSightseeingRow(binding, rowBoundsFilter);
            if (!row) continue;
            if (region.kind === "city" && region.city) {
                row.city = region.city;
            }
            seen.set(String(row.wikidata_id), row);
        }

        offset += pageSize;
        await sleep(delayMs);

        if (bindings.length < pageSize) break;
    }

    const rows = [...seen.values()];
    if (!dryRun) {
        upserted = await upsertSightseeingRows(rows);
    } else {
        upserted = rows.length;
        console.log(`[seed] dry-run would upsert ${rows.length} rows for ${region.name}`);
    }

    return { fetched: rows.length, upserted, pages, tileErrors: [] };
}

/**
 * @param {{
 *   region: SeedRegion,
 *   bounds: SeedBounds,
 *   pageSize: number,
 *   minSitelinks: number,
 *   maxSitelinks?: number | null,
 *   delayMs: number,
 *   dryRun: boolean,
 *   depth?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
async function seedRegionTilesFanout({
    region,
    bounds,
    pageSize,
    minSitelinks,
    maxSitelinks = null,
    delayMs,
    dryRun,
    depth = 0,
    fetchImpl = fetch,
}) {
    const tiles = splitBounds(bounds);
    console.log(
        `[seed] ${region.name} force-tiled depth=${depth} into ${tiles.length} tiles ` +
            `bbox=[${bounds.minLon},${bounds.minLat}..${bounds.maxLon},${bounds.maxLat}]`,
    );

    let fetched = 0;
    let upserted = 0;
    let pages = 0;
    /** @type {string[]} */
    const tileErrors = [];

    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        await sleep(delayMs);
        try {
            const sub = await seedRegionTile({
                region,
                bounds: tile,
                pageSize,
                minSitelinks,
                maxSitelinks,
                delayMs,
                dryRun,
                depth: depth + 1,
                fetchImpl,
            });
            fetched += sub.fetched;
            upserted += sub.upserted;
            pages += sub.pages;
            if (Array.isArray(sub.tileErrors) && sub.tileErrors.length) {
                tileErrors.push(...sub.tileErrors);
            }
        } catch (error) {
            const message = error?.message || String(error);
            const label =
                `tile[${i}] [${tile.minLon},${tile.minLat}..${tile.maxLon},${tile.maxLat}]: ${message}`;
            tileErrors.push(label);
            console.error(`[seed] ${region.name} ${label}`);
        }
    }

    if (upserted === 0 && tileErrors.length > 0) {
        const err = new Error(
            `All tiles failed for ${region.name}: ${tileErrors[0]}` +
                (tileErrors.length > 1 ? ` (+${tileErrors.length - 1} more)` : ""),
        );
        err.tileErrors = tileErrors;
        throw err;
    }

    return { fetched, upserted, pages, tileErrors };
}

/**
 * @param {{
 *   region: SeedRegion,
 *   pageSize: number,
 *   minSitelinks: number,
 *   maxSitelinks?: number | null,
 *   delayMs: number,
 *   dryRun: boolean,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
async function seedRegionForceTiledRegions({
    region,
    pageSize,
    minSitelinks,
    maxSitelinks = null,
    delayMs,
    dryRun,
    fetchImpl = fetch,
}) {
    const regions = regionSightseeingBoundList(region);
    if (regions.length === 0) {
        throw new Error(`No bbox available to tile ${region.name}`);
    }
    let fetched = 0;
    let upserted = 0;
    let pages = 0;
    /** @type {string[]} */
    const tileErrors = [];

    for (let r = 0; r < regions.length; r++) {
        const box = regions[r];
        console.log(
            `[seed] ${region.name} region ${r + 1}/${regions.length} ` +
                `bbox=[${box.minLon},${box.minLat}..${box.maxLon},${box.maxLat}]`,
        );
        const sub = await seedRegionTilesFanout({
            region,
            bounds: box,
            pageSize,
            minSitelinks,
            maxSitelinks,
            delayMs,
            dryRun,
            depth: 0,
            fetchImpl,
        });
        fetched += sub.fetched;
        upserted += sub.upserted;
        pages += sub.pages;
        if (Array.isArray(sub.tileErrors) && sub.tileErrors.length) {
            tileErrors.push(...sub.tileErrors);
        }
    }

    if (upserted === 0 && tileErrors.length > 0) {
        const err = new Error(
            `All regions failed for ${region.name}: ${tileErrors[0]}` +
                (tileErrors.length > 1 ? ` (+${tileErrors.length - 1} more)` : ""),
        );
        err.tileErrors = tileErrors;
        throw err;
    }

    return { fetched, upserted, pages, tileErrors };
}

/**
 * @param {SeedRegion} region
 * @param {ReturnType<typeof parseSharedSeedOpts>} opts
 * @param {typeof fetch} [fetchImpl]
 */
export async function seedOneRegion(region, opts, fetchImpl = fetch) {
    const forceTiles = shouldForceTileSeed(region, opts.forceTiles);
    const shared = {
        region,
        pageSize: opts.pageSize,
        minSitelinks: opts.minSitelinks,
        maxSitelinks: opts.maxSitelinks,
        delayMs: opts.delayMs,
        dryRun: opts.dryRun,
        fetchImpl,
    };
    return forceTiles
        ? seedRegionForceTiledRegions(shared)
        : seedRegionTile({
              ...shared,
              bounds: region.kind === "city" ? region.bounds ?? null : null,
              depth: 0,
          });
}

/**
 * @param {{
 *   regions: SeedRegion[],
 *   opts: ReturnType<typeof parseSharedSeedOpts>,
 *   reportPrefix: string,
 *   checkpointFile: string,
 *   progressLogFile: string,
 *   fetchImpl?: typeof fetch,
 * }} args
 */
export async function runSightseeingSeed({
    regions: inputRegions,
    opts,
    reportPrefix,
    checkpointFile,
    progressLogFile,
    fetchImpl = fetch,
}) {
    if (opts.databaseUrl) {
        process.env.DATABASE_URL = opts.databaseUrl;
    }

    const reportDir = resolveReportDir(opts.reportDir);
    let regions = [...inputRegions];
    if (opts.offset > 0) regions = regions.slice(opts.offset);
    if (opts.limit > 0) regions = regions.slice(0, opts.limit);

    const checkpoint = readCheckpoint(reportDir, checkpointFile);
    const completed = new Set(checkpoint.completedQids);
    if (opts.resume && completed.size > 0) {
        const before = regions.length;
        regions = regions.filter((region) => !completed.has(region.wikidataId));
        logProgress(
            reportDir,
            progressLogFile,
            `[seed] resume: skipped ${before - regions.length} completed regions ` +
                `(${completed.size} in checkpoint)`,
        );
    }

    logProgress(
        reportDir,
        progressLogFile,
        `[seed] regions=${regions.length} dryRun=${opts.dryRun} pageSize=${opts.pageSize}` +
            ` sitelinks=[${opts.minSitelinks}, ${opts.maxSitelinks ?? "∞"})` +
            ` forceTiles=${opts.forceTiles} regionRetries=${opts.regionRetries}` +
            ` filters=SPARQL_POI_CATEGORIES+INSTANCE_OF (same as Europe)`,
    );

    if (!opts.dryRun) {
        getSightseeingPool({ max: 2 });
        if (opts.migrateDb) {
            await applySchema();
        }
    }

    const report = {
        startedAt: new Date().toISOString(),
        dryRun: opts.dryRun,
        filters: {
            categories: "SPARQL_POI_CATEGORIES",
            instanceOf: "SPARQL_INSTANCE_OF_CLAUSE",
            source: "utils/places-lookup-utils.mjs",
        },
        regions: /** @type {Array<Record<string, unknown>>} */ (
            opts.resume ? [...checkpoint.regions] : []
        ),
        totals: { fetched: 0, upserted: 0, failed: 0, skipped: 0 },
    };
    if (opts.resume) {
        for (const row of checkpoint.regions) {
            report.totals.fetched += Number(row.fetched) || 0;
            report.totals.upserted += Number(row.upserted) || 0;
        }
    }

    const heartbeat = setInterval(() => {
        logProgress(
            reportDir,
            progressLogFile,
            `[seed] heartbeat still running — upserted=${report.totals.upserted} ` +
                `failed=${report.totals.failed} completedQids=${completed.size}`,
        );
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
        for (let index = 0; index < regions.length; index++) {
            const region = regions[index];
            const forceTiles = shouldForceTileSeed(region, opts.forceTiles);
            logProgress(
                reportDir,
                progressLogFile,
                `[seed] start ${region.name} (${index + 1}/${regions.length}) ` +
                    `kind=${region.kind} qid=${region.wikidataId} forceTiles=${forceTiles}`,
            );

            let lastError = null;
            let result = null;
            for (let attempt = 1; attempt <= opts.regionRetries; attempt++) {
                try {
                    result = await seedOneRegion(region, opts, fetchImpl);
                    lastError = null;
                    break;
                } catch (error) {
                    lastError = error;
                    if (!isRetryableRegionError(error) || attempt >= opts.regionRetries) {
                        break;
                    }
                    const delayMs = 5000 * attempt;
                    logProgress(
                        reportDir,
                        progressLogFile,
                        `[seed] ${region.name} attempt ${attempt}/${opts.regionRetries} failed; ` +
                            `retry in ${delayMs}ms: ${error?.message || error}`,
                    );
                    await sleep(delayMs);
                }
            }

            if (lastError || !result) {
                report.totals.failed += 1;
                const row = {
                    name: region.name,
                    wikidataId: region.wikidataId,
                    kind: region.kind,
                    forceTiles,
                    ok: false,
                    error: lastError?.message || String(lastError),
                    tileErrors: lastError?.tileErrors,
                };
                report.regions.push(row);
                logProgress(
                    reportDir,
                    progressLogFile,
                    `[seed] failed ${region.name}: ${row.error}`,
                );
            } else {
                const tileErrors = Array.isArray(result.tileErrors) ? result.tileErrors : [];
                const ok = result.upserted > 0 || tileErrors.length === 0;
                const row = {
                    name: region.name,
                    wikidataId: region.wikidataId,
                    kind: region.kind,
                    fetched: result.fetched,
                    upserted: result.upserted,
                    pages: result.pages,
                    forceTiles,
                    tileErrors: tileErrors.length ? tileErrors : undefined,
                    ok,
                    ...(ok ? {} : { error: tileErrors[0] || "no places upserted" }),
                };
                report.regions.push(row);
                report.totals.fetched += result.fetched;
                report.totals.upserted += result.upserted;
                if (!ok) {
                    report.totals.failed += 1;
                } else {
                    completed.add(region.wikidataId);
                    writeCheckpoint(reportDir, checkpointFile, {
                        completedQids: [...completed],
                        regions: report.regions.filter((entry) => entry.ok),
                    });
                }
                logProgress(
                    reportDir,
                    progressLogFile,
                    `[seed] done ${region.name}: fetched=${result.fetched} upserted=${result.upserted} ` +
                        `pages=${result.pages} forceTiles=${forceTiles}` +
                        (tileErrors.length ? ` tileErrors=${tileErrors.length}` : ""),
                );
            }
            await sleep(opts.delayMs);
        }
    } finally {
        clearInterval(heartbeat);
    }

    report.finishedAt = new Date().toISOString();
    return { report, reportDir, completed };
}
