#!/usr/bin/env node
/**
 * Seeds the Europe sightseeing table (Postgres + PostGIS) from Wikidata.
 *
 * Prerequisites
 * -------------
 *   # Local Docker example:
 *   docker run --name guidex-postgis -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=sightseeing -p 5432:5432 -d postgis/postgis:16-3.4
 *   export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/sightseeing
 *
 *   cd backend
 *   psql "$DATABASE_URL" -f db/001_sightseeing.sql
 *   npm run sightseeing:seed -- --dry-run --country=Andorra
 *
 * Usage
 * -----
 *   node scripts/seed-europe-sightseeing.mjs --dry-run --country=Malta
 *   node scripts/seed-europe-sightseeing.mjs --country=DE   # ISO or full name
 *   node scripts/seed-europe-sightseeing.mjs --limit 1      # first N countries
 *   node scripts/seed-europe-sightseeing.mjs                # full Europe
 *
 * Flags
 * -----
 *   --dry-run           Fetch Wikidata only; no DB writes
 *   --country NAME      Single country (name, Wikidata Q-id, or ISO-ish name match)
 *   --limit N           Process at most N countries
 *   --offset N          Skip first N countries
 *   --delay-ms N        Pause between SPARQL requests (default: 1500)
 *   --page-size N       SPARQL page size (default: 2000)
 *   --min-sitelinks N   Keep POIs with sitelinks >= N (default: 1)
 *   --max-sitelinks N   Keep POIs with sitelinks < N (exclusive upper bound; omit for no cap)
 *                       Example after a --min-sitelinks=15 pass:
 *                         --min-sitelinks=5 --max-sitelinks=15   # fetches [5, 15)
 *   --force-tiles       Always start with a country bbox split into tiles (also default for
 *                       FR/DE/IT/AT/RU which time out on full-country SPARQL)
 *   --skip-migrate      Do not apply db/001_sightseeing.sql
 *   --report-dir PATH   Report output dir (default: scripts/reports)
 *   --database-url URL  Override DATABASE_URL / SIGHTSEEING_DATABASE_URL
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import {
    EUROPEAN_COUNTRIES,
} from "./european-cities-config.mjs";
import {
    sleep,
    writeTimestampedReport,
} from "./script-common.mjs";
import {
    SPARQL_INSTANCE_OF_CLAUSE,
    SPARQL_POI_CATEGORIES,
    classifyPlaceTypeFromCategory,
    parseWktPoint,
    readSparqlBinding,
    runWikidataSparql,
    wikidataIdFromItemUri,
} from "../places-lookup-utils.mjs";
import {
    closeSightseeingPool,
    getSightseeingPool,
    sightseeingQuery,
} from "../sightseeing-db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "db", "001_sightseeing.sql");
const DEFAULT_PAGE_SIZE = 2000;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_MIN_SITELINKS = 1;
const SPARQL_TIMEOUT_MS = 120_000;
const MAX_TILE_DEPTH = 5;

/**
 * Tight bboxes for countries whose full-country Wikidata queries time out.
 * Metropolitan / European portion only (skips overseas departments).
 *
 * @type {Record<string, { minLon: number, maxLon: number, minLat: number, maxLat: number }>}
 */
export const COUNTRY_SIGHTSEEING_BOUNDS = {
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
};

/** Wikidata QIDs that must start tiled (never a single full-country SPARQL). */
export const FORCE_TILE_COUNTRY_QIDS = new Set(Object.keys(COUNTRY_SIGHTSEEING_BOUNDS));

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        dryRun: false,
        country: "",
        limit: 0,
        offset: 0,
        delayMs: DEFAULT_DELAY_MS,
        pageSize: DEFAULT_PAGE_SIZE,
        minSitelinks: DEFAULT_MIN_SITELINKS,
        /** @type {number | null} exclusive upper bound; null = no cap */
        maxSitelinks: null,
        forceTiles: false,
        skipMigrate: false,
        reportDir: "reports",
        databaseUrl: "",
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--skip-migrate") opts.skipMigrate = true;
        else if (arg === "--country" && next) {
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
        } else if (arg === "--force-tiles") {
            opts.forceTiles = true;
        } else if (arg === "--report-dir" && next) {
            opts.reportDir = next;
            i++;
        } else if (arg === "--database-url" && next) {
            opts.databaseUrl = next;
            i++;
        }
    }
    if (
        opts.maxSitelinks != null &&
        opts.maxSitelinks <= opts.minSitelinks
    ) {
        throw new Error(
            `--max-sitelinks (${opts.maxSitelinks}) must be greater than --min-sitelinks (${opts.minSitelinks})`,
        );
    }
    return opts;
}

/**
 * @param {string} needle
 * @returns {typeof EUROPEAN_COUNTRIES}
 */
function selectCountries(needle) {
    if (!needle) return [...EUROPEAN_COUNTRIES];
    const q = needle.trim().toLowerCase();
    const matched = EUROPEAN_COUNTRIES.filter((country) => {
        return (
            country.name.toLowerCase() === q ||
            country.name.toLowerCase().includes(q) ||
            country.wikidataId.toLowerCase() === q ||
            country.wikidataId.toLowerCase() === `q${q.replace(/^q/i, "")}`
        );
    });
    if (matched.length === 0) {
        throw new Error(`No European country matched --country=${needle}`);
    }
    return matched;
}

/**
 * @param {{
 *   countryQid: string,
 *   minSitelinks: number,
 *   maxSitelinks?: number | null,
 *   pageSize: number,
 *   offset: number,
 *   bounds?: { minLon?: number, maxLon?: number, minLat?: number, maxLat?: number } | null,
 * }} options
 * @returns {string}
 */
export function buildCountrySightseeingSparql({
    countryQid,
    minSitelinks,
    maxSitelinks = null,
    pageSize,
    offset,
    bounds = null,
}) {
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
  ?item wdt:P17 wd:${countryQid.replace(/^wd:/, "")} .
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

/**
 * @param {Record<string, unknown>} binding
 * @param {{ minLon?: number, maxLon?: number, minLat?: number, maxLat?: number } | null | undefined} bounds
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
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Promise<number>}
 */
async function upsertSightseeingRows(rows) {
    if (rows.length === 0) return 0;
    let written = 0;
    for (const row of rows) {
        await sightseeingQuery(
            `
INSERT INTO sightseeing (
  wikidata_id, name, type, category_label, country_code, country, city,
  sitelinks, image_url, wikipedia_url, lat, lng, location, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11, $12,
  ST_SetSRID(ST_MakePoint($12, $11), 4326)::geography,
  now()
)
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
`.trim(),
            [
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
            ],
        );
        written++;
    }
    return written;
}

/**
 * Split a bbox into four quadrants.
 * @param {{ minLon: number, maxLon: number, minLat: number, maxLat: number }} bounds
 */
function splitBounds(bounds) {
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
 * Default continental Europe bbox used when subdividing countries without a tight bbox.
 * @returns {{ minLon: number, maxLon: number, minLat: number, maxLat: number }}
 */
function defaultEuropeBounds() {
    return { minLon: -25, maxLon: 45, minLat: 34, maxLat: 72 };
}

/**
 * @param {import("./european-cities-config.mjs").EuropeanCountry} country
 * @returns {{ minLon: number, maxLon: number, minLat: number, maxLat: number }}
 */
export function countrySightseeingBounds(country) {
    const qid = String(country.wikidataId || "").replace(/^wd:/, "");
    const tight = COUNTRY_SIGHTSEEING_BOUNDS[qid];
    if (tight) return { ...tight };

    const base = defaultEuropeBounds();
    return {
        minLon: country.bounds?.minLon ?? base.minLon,
        maxLon: country.bounds?.maxLon ?? base.maxLon,
        minLat: country.bounds?.minLat ?? base.minLat,
        maxLat: country.bounds?.maxLat ?? base.maxLat,
    };
}

/** @deprecated use countrySightseeingBounds */
function countrySeedBounds(country) {
    return countrySightseeingBounds(country);
}

/**
 * @param {import("./european-cities-config.mjs").EuropeanCountry} country
 * @param {boolean} [forceTilesFlag]
 * @returns {boolean}
 */
export function shouldForceTileSeed(country, forceTilesFlag = false) {
    if (forceTilesFlag) return true;
    const qid = String(country.wikidataId || "").replace(/^wd:/, "");
    return FORCE_TILE_COUNTRY_QIDS.has(qid);
}

/**
 * Immediately split a country bbox into quadrants and seed each tile.
 * Survives individual tile failures so partial progress is kept.
 *
 * @param {{
 *   country: import("./european-cities-config.mjs").EuropeanCountry,
 *   bounds: { minLon: number, maxLon: number, minLat: number, maxLat: number },
 *   pageSize: number,
 *   minSitelinks: number,
 *   maxSitelinks?: number | null,
 *   delayMs: number,
 *   dryRun: boolean,
 *   depth?: number,
 * }} options
 * @returns {Promise<{ fetched: number, upserted: number, pages: number, tileErrors: string[] }>}
 */
async function seedCountryTilesFanout({
    country,
    bounds,
    pageSize,
    minSitelinks,
    maxSitelinks = null,
    delayMs,
    dryRun,
    depth = 0,
}) {
    const tiles = splitBounds(bounds);
    console.log(
        `[seed] ${country.name} force-tiled depth=${depth} into ${tiles.length} tiles ` +
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
            const sub = await seedCountryTile({
                country,
                bounds: tile,
                pageSize,
                minSitelinks,
                maxSitelinks,
                delayMs,
                dryRun,
                depth: depth + 1,
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
            console.error(`[seed] ${country.name} ${label}`);
        }
    }

    if (upserted === 0 && tileErrors.length > 0) {
        const err = new Error(
            `All tiles failed for ${country.name}: ${tileErrors[0]}` +
                (tileErrors.length > 1 ? ` (+${tileErrors.length - 1} more)` : ""),
        );
        err.tileErrors = tileErrors;
        throw err;
    }

    return { fetched, upserted, pages, tileErrors };
}

/**
 * @param {{
 *   country: import("./european-cities-config.mjs").EuropeanCountry,
 *   bounds: { minLon: number, maxLon: number, minLat: number, maxLat: number } | null,
 *   pageSize: number,
 *   minSitelinks: number,
 *   maxSitelinks?: number | null,
 *   delayMs: number,
 *   dryRun: boolean,
 *   depth?: number,
 * }} options
 * @returns {Promise<{ fetched: number, upserted: number, pages: number, tileErrors?: string[] }>}
 */
async function seedCountryTile({
    country,
    bounds,
    pageSize,
    minSitelinks,
    maxSitelinks = null,
    delayMs,
    dryRun,
    depth = 0,
}) {
    let offset = 0;
    let fetched = 0;
    let upserted = 0;
    let pages = 0;
    /** @type {Map<string, Record<string, unknown>>} */
    const seen = new Map();
    const rowBoundsFilter =
        COUNTRY_SIGHTSEEING_BOUNDS[String(country.wikidataId || "").replace(/^wd:/, "")] ??
        country.bounds ??
        null;

    while (true) {
        const sparql = buildCountrySightseeingSparql({
            countryQid: country.wikidataId,
            minSitelinks,
            maxSitelinks,
            pageSize,
            offset,
            bounds,
        });

        console.log(
            `[seed] ${country.name} depth=${depth} offset=${offset}` +
                (bounds
                    ? ` bbox=[${bounds.minLon},${bounds.minLat}..${bounds.maxLon},${bounds.maxLat}]`
                    : ""),
        );

        let bindings;
        try {
            bindings = await runWikidataSparql(sparql, fetch, {
                timeoutMs: SPARQL_TIMEOUT_MS,
                maxAttempts: 3,
                extra: `country=${country.name} offset=${offset}`,
            });
        } catch (error) {
            if (depth < MAX_TILE_DEPTH) {
                const tileBounds = bounds ?? countrySightseeingBounds(country);
                console.warn(
                    `[seed] ${country.name} SPARQL failed at depth=${depth}; subdividing: ${error?.message || error}`,
                );
                return seedCountryTilesFanout({
                    country,
                    bounds: tileBounds,
                    pageSize,
                    minSitelinks,
                    maxSitelinks,
                    delayMs,
                    dryRun,
                    depth,
                });
            }
            throw error;
        }

        pages++;
        if (!bindings.length) break;

        // First unbounded page is full — switch to bbox tiles for complete coverage.
        if (!bounds && offset === 0 && bindings.length >= pageSize && depth === 0) {
            console.log(`[seed] ${country.name} large result set; switching to bbox tiles`);
            await sleep(delayMs);
            return seedCountryTilesFanout({
                country,
                bounds: countrySightseeingBounds(country),
                pageSize,
                minSitelinks,
                maxSitelinks,
                delayMs,
                dryRun,
                depth: 0,
            });
        }

        for (const binding of bindings) {
            const row = bindingToSightseeingRow(binding, rowBoundsFilter);
            if (!row) continue;
            seen.set(String(row.wikidata_id), row);
        }

        fetched += bindings.length;
        offset += pageSize;
        await sleep(delayMs);

        if (bindings.length < pageSize) break;
    }

    const rows = [...seen.values()];
    if (!dryRun) {
        upserted = await upsertSightseeingRows(rows);
    } else {
        upserted = rows.length;
        console.log(`[seed] dry-run would upsert ${rows.length} rows for ${country.name}`);
    }

    return { fetched: rows.length, upserted, pages, tileErrors: [] };
}

async function applySchema() {
    const sql = readFileSync(SCHEMA_PATH, "utf8");
    await sightseeingQuery(sql);
    console.log("[seed] applied schema %s", SCHEMA_PATH);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.databaseUrl) {
        process.env.DATABASE_URL = opts.databaseUrl;
    }

    let countries = selectCountries(opts.country);
    if (opts.offset > 0) countries = countries.slice(opts.offset);
    if (opts.limit > 0) countries = countries.slice(0, opts.limit);

    console.log(
        `[seed] countries=${countries.length} dryRun=${opts.dryRun} pageSize=${opts.pageSize}` +
            ` sitelinks=[${opts.minSitelinks}, ${opts.maxSitelinks ?? "∞"})` +
            ` forceTiles=${opts.forceTiles}`,
    );

    if (!opts.dryRun) {
        getSightseeingPool({ max: 2 });
        if (!opts.skipMigrate) {
            await applySchema();
        }
    }

    const report = {
        startedAt: new Date().toISOString(),
        dryRun: opts.dryRun,
        countries: /** @type {Array<Record<string, unknown>>} */ ([]),
        totals: { fetched: 0, upserted: 0, failed: 0 },
    };

    for (const country of countries) {
        const forceTiles = shouldForceTileSeed(country, opts.forceTiles);
        try {
            const result = forceTiles
                ? await seedCountryTilesFanout({
                      country,
                      bounds: countrySightseeingBounds(country),
                      pageSize: opts.pageSize,
                      minSitelinks: opts.minSitelinks,
                      maxSitelinks: opts.maxSitelinks,
                      delayMs: opts.delayMs,
                      dryRun: opts.dryRun,
                      depth: 0,
                  })
                : await seedCountryTile({
                      country,
                      bounds: null,
                      pageSize: opts.pageSize,
                      minSitelinks: opts.minSitelinks,
                      maxSitelinks: opts.maxSitelinks,
                      delayMs: opts.delayMs,
                      dryRun: opts.dryRun,
                  });

            const tileErrors = Array.isArray(result.tileErrors) ? result.tileErrors : [];
            const ok = result.upserted > 0 || tileErrors.length === 0;
            report.countries.push({
                name: country.name,
                wikidataId: country.wikidataId,
                fetched: result.fetched,
                upserted: result.upserted,
                pages: result.pages,
                forceTiles,
                tileErrors: tileErrors.length ? tileErrors : undefined,
                ok,
                ...(ok
                    ? {}
                    : { error: tileErrors[0] || "no places upserted" }),
            });
            report.totals.fetched += result.fetched;
            report.totals.upserted += result.upserted;
            if (!ok) report.totals.failed += 1;
            console.log(
                `[seed] done ${country.name}: fetched=${result.fetched} upserted=${result.upserted} ` +
                    `pages=${result.pages} forceTiles=${forceTiles}` +
                    (tileErrors.length ? ` tileErrors=${tileErrors.length}` : ""),
            );
        } catch (error) {
            report.totals.failed += 1;
            report.countries.push({
                name: country.name,
                wikidataId: country.wikidataId,
                forceTiles,
                ok: false,
                error: error?.message || String(error),
                tileErrors: error?.tileErrors,
            });
            console.error(`[seed] failed ${country.name}:`, error?.message || error);
        }
        await sleep(opts.delayMs);
    }

    report.finishedAt = new Date().toISOString();
    const reportPath = writeTimestampedReport(
        opts.reportDir,
        "seed-europe-sightseeing",
        report,
    );
    console.log("[seed] report %s", reportPath);
    console.log("[seed] totals", report.totals);

    await closeSightseeingPool();
    if (report.totals.failed > 0) process.exitCode = 1;
}

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main().catch(async (error) => {
        console.error("[seed] fatal:", error);
        await closeSightseeingPool();
        process.exit(1);
    });
}
