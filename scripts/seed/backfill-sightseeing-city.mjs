#!/usr/bin/env node
/**
 * Fill empty `sightseeing.city` values from `lat` / `lng`.
 *
 * Country and continent seeds insert `city` as null. Only a `--city` seed
 * copies the region name onto each row (`bindingToSightseeingRow` always
 * starts from null). Explore area reads `sightseeing.city` directly, so those
 * rows have no city label.
 *
 * Reverse geocoding uses Nominatim (OpenStreetMap), the same service as
 * `reverseGeocodeNominatim` in `utils/places-lookup-utils.mjs` (zoom 10,
 * English labels). The public instance allows at most one request per second
 * and is not a bulk geocoder: https://operations.osmfoundation.org/policies/nominatim/
 * Nearby rows share one lookup (coordinates rounded to a grid), and results
 * are cached so a re-run does not repeat them. Point `--nominatim-url` at
 * your own Nominatim if you host one.
 *
 *   export DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/sightseeing
 *   npm run script:sightseeing:backfill-city:dry-run
 *   npm run script:sightseeing:backfill-city
 *   npm run script:sightseeing:backfill-city -- --country-code FR
 *
 * Re-running is safe. Rows that already have a city are left unchanged.
 * On macOS the process re-launches under caffeinate -dims unless --no-caffeinate.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { closeSightseeingPool, sightseeingQuery } from "../../services/sightseeing-db.mjs";
import { NOMINATIM_TIMEOUT_MS } from "../../utils/places-lookup-utils.mjs";
import { sleep, writeTimestampedReport } from "./script-common.mjs";
import {
    ensureCaffeinate,
    logProgress,
    resolveReportDir,
} from "./seed-sightseeing-engine.mjs";

export const PUBLIC_NOMINATIM_URL = "https://nominatim.openstreetmap.org";
export const CACHE_FILE = "backfill-sightseeing-city-cache.json";
const PROGRESS_LOG_FILE = "backfill-sightseeing-city-progress.log";
const REPORT_PREFIX = "backfill-sightseeing-city";
const PUBLIC_MIN_DELAY_MS = 1100;
const UPDATE_CHUNK = 500;

/**
 * Locality keys, in the same order as `LOCALITY_KEYS` in places-lookup-utils.
 * Display-name fallback is intentionally omitted so a street or country is
 * not stored as a city.
 */
const LOCALITY_KEYS = [
    "city",
    "town",
    "village",
    "municipality",
    "borough",
    "city_district",
    "suburb",
    "district",
    "county",
    "state_district",
];

const LOCALITY_TYPES = new Set(["city", "town", "village", "municipality", "borough"]);

const USER_AGENT = "Ramblex-mobile (https://ramblex.app)";

export const UPDATE_CITY_SQL = `
UPDATE sightseeing
SET city = $1, updated_at = now()
WHERE id = ANY($2::bigint[])
  AND (city IS NULL OR trim(city) = '')
`.trim();

export const ADD_CITY_COLUMN_SQL =
    "ALTER TABLE sightseeing ADD COLUMN IF NOT EXISTS city TEXT";

const USAGE = `Usage: node scripts/seed/backfill-sightseeing-city.mjs [flags]

Fill empty sightseeing.city values from lat/lng via Nominatim reverse geocoding.

Examples:
  node scripts/seed/backfill-sightseeing-city.mjs --dry-run --limit 20 --no-caffeinate
  node scripts/seed/backfill-sightseeing-city.mjs
  node scripts/seed/backfill-sightseeing-city.mjs --country-code FR

Flags:
  --dry-run              Geocode and print; do not UPDATE (still calls Nominatim)
  --limit N              Stop after N empty-city rows (default: all)
  --delay-ms N           Pause after each Nominatim request (default: 1100).
                         Public nominatim.openstreetmap.org is floored at 1100.
  --batch-size N         Rows read per page (default: 400)
  --grid-decimals N      Coordinate cell size, 1-4 (default: 2, about 1.1 km)
  --country-code XX      Only rows with this ISO country code
  --max-attempts N       Tries per cell on network errors (default: 3)
  --retry-unresolved     Ask Nominatim again for cells that previously failed
  --nominatim-url URL    Nominatim server origin (default: public instance)
  --database-url URL     Override DATABASE_URL / SIGHTSEEING_DATABASE_URL
  --report-dir PATH      Cache, progress log, and report directory
  --no-caffeinate        Do not re-launch under macOS caffeinate
  --help                 Show this help

Cache: scripts/seed/reports/${CACHE_FILE}
Rows that already have a city are skipped. Ctrl+C saves the cache and stops
after the current lookup; run the same command again to continue.`;

/**
 * @typedef {object} BackfillCityOpts
 * @property {boolean} dryRun
 * @property {number} limit
 * @property {number} delayMs
 * @property {number} batchSize
 * @property {number} gridDecimals
 * @property {string} countryCode
 * @property {number} maxAttempts
 * @property {boolean} retryUnresolved
 * @property {string} nominatimUrl
 * @property {string} databaseUrl
 * @property {string} reportDir
 * @property {boolean} noCaffeinate
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {BackfillCityOpts}
 */
export function parseArgs(argv) {
    /** @type {BackfillCityOpts} */
    const opts = {
        dryRun: false,
        limit: 0,
        delayMs: PUBLIC_MIN_DELAY_MS,
        batchSize: 400,
        gridDecimals: 2,
        countryCode: "",
        maxAttempts: 3,
        retryUnresolved: false,
        nominatimUrl: PUBLIC_NOMINATIM_URL,
        databaseUrl: "",
        reportDir: "reports",
        noCaffeinate: false,
        help: false,
    };

    const requireValue = (flag, index) => {
        const next = argv[index + 1];
        if (next == null || next.startsWith("--")) {
            throw new Error(`Missing value for ${flag}`);
        }
        return next;
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf("=");
        const flag = eq === -1 ? arg : arg.slice(0, eq);
        const inline = eq === -1 ? null : arg.slice(eq + 1);
        const value = () => {
            if (inline != null) return inline;
            const next = requireValue(flag, i);
            i += 1;
            return next;
        };

        if (flag === "--dry-run") opts.dryRun = true;
        else if (flag === "--retry-unresolved") opts.retryUnresolved = true;
        else if (flag === "--no-caffeinate") opts.noCaffeinate = true;
        else if (flag === "--help" || flag === "-h") opts.help = true;
        else if (flag === "--limit") opts.limit = parseNonNegativeInt(value(), "--limit");
        else if (flag === "--delay-ms") opts.delayMs = parseNonNegativeInt(value(), "--delay-ms");
        else if (flag === "--batch-size") {
            opts.batchSize = parseNonNegativeInt(value(), "--batch-size");
        } else if (flag === "--grid-decimals") {
            opts.gridDecimals = parseNonNegativeInt(value(), "--grid-decimals");
        } else if (flag === "--country-code") opts.countryCode = value().trim();
        else if (flag === "--max-attempts") {
            opts.maxAttempts = parseNonNegativeInt(value(), "--max-attempts");
        } else if (flag === "--nominatim-url") opts.nominatimUrl = value().trim();
        else if (flag === "--database-url") opts.databaseUrl = value();
        else if (flag === "--report-dir") opts.reportDir = value().trim();
        else if (flag.startsWith("-")) throw new Error(`Unknown flag: ${flag}`);
        else throw new Error(`Unexpected argument: ${arg}`);
    }

    if (opts.batchSize < 1 || opts.batchSize > 5000) {
        throw new Error("--batch-size must be between 1 and 5000");
    }
    if (opts.gridDecimals < 1 || opts.gridDecimals > 4) {
        throw new Error("--grid-decimals must be between 1 and 4");
    }
    if (opts.maxAttempts < 1 || opts.maxAttempts > 5) {
        throw new Error("--max-attempts must be between 1 and 5");
    }
    if (opts.countryCode && !/^[A-Za-z]{2}$/.test(opts.countryCode)) {
        throw new Error("--country-code must be a 2-letter ISO code");
    }
    opts.countryCode = opts.countryCode.toUpperCase();
    if (!opts.nominatimUrl) throw new Error("Missing value for --nominatim-url");
    let nominatim;
    try {
        nominatim = new URL(opts.nominatimUrl);
    } catch {
        throw new Error(`Invalid --nominatim-url: ${opts.nominatimUrl}`);
    }
    if (nominatim.protocol !== "https:" && nominatim.protocol !== "http:") {
        throw new Error("--nominatim-url must be an http(s) URL");
    }
    if (nominatim.search || nominatim.hash) {
        throw new Error("--nominatim-url must be the server origin, without a query string");
    }
    opts.nominatimUrl = opts.nominatimUrl.replace(/\/$/, "").replace(/\/reverse$/, "");
    if (!opts.reportDir) throw new Error("Missing value for --report-dir");
    return opts;
}

/**
 * @param {string} raw
 * @param {string} flag
 * @returns {number}
 */
function parseNonNegativeInt(raw, flag) {
    if (!/^\d+$/.test(String(raw))) {
        throw new Error(`${flag} must be a non-negative integer`);
    }
    return Number(raw);
}

/**
 * Public Nominatim is capped at one request per second. A self-hosted
 * server (`--nominatim-url`) keeps the requested delay.
 *
 * @param {string} nominatimUrl
 * @param {number} delayMs
 * @returns {number}
 */
export function resolveRequestDelayMs(nominatimUrl, delayMs) {
    const host = new URL(nominatimUrl).host;
    const requested = Number(delayMs);
    if (!Number.isFinite(requested) || requested < 0) {
        throw new Error("--delay-ms must be a non-negative number");
    }
    if (host === "nominatim.openstreetmap.org") {
        return Math.max(PUBLIC_MIN_DELAY_MS, requested);
    }
    return requested;
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} decimals
 * @returns {string}
 */
export function coordCellKey(lat, lng, decimals) {
    const factor = 10 ** decimals;
    const roundedLat = Math.round(lat * factor) / factor;
    const roundedLng = Math.round(lng * factor) / factor;
    return `${roundedLat.toFixed(decimals)},${roundedLng.toFixed(decimals)}`;
}

/**
 * @param {Array<{ id: unknown, lat: unknown, lng: unknown }>} rows
 * @param {number} decimals
 * @returns {{ groups: Map<string, { lat: number, lng: number, ids: string[] }>, invalid: number }}
 */
export function groupRowsByCell(rows, decimals) {
    /** @type {Map<string, { lat: number, lng: number, ids: string[] }>} */
    const groups = new Map();
    let invalid = 0;
    for (const row of rows) {
        const lat = Number(row.lat);
        const lng = Number(row.lng);
        const coordsOk =
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            lat >= -90 &&
            lat <= 90 &&
            lng >= -180 &&
            lng <= 180;
        if (!coordsOk) {
            invalid += 1;
            continue;
        }
        const key = coordCellKey(lat, lng, decimals);
        let group = groups.get(key);
        if (!group) {
            group = { lat: 0, lng: 0, ids: [] };
            groups.set(key, group);
        }
        group.ids.push(String(row.id));
        group.lat += lat;
        group.lng += lng;
    }
    for (const group of groups.values()) {
        group.lat /= group.ids.length;
        group.lng /= group.ids.length;
    }
    return { groups, invalid };
}

/**
 * City / town / village label from a Nominatim reverse body, or null.
 *
 * @param {unknown} body
 * @returns {string | null}
 */
export function cityLabelFromNominatimBody(body) {
    if (!body || typeof body !== "object") return null;
    const record = /** @type {Record<string, unknown>} */ (body);
    if (record.error) return null;
    const address =
        record.address && typeof record.address === "object"
            ? /** @type {Record<string, unknown>} */ (record.address)
            : {};
    for (const key of LOCALITY_KEYS) {
        const label = String(address[key] ?? "").trim();
        if (label) return label.slice(0, 120);
    }
    const addresstype = String(record.addresstype ?? "");
    const name = String(record.name ?? "").trim();
    if (LOCALITY_TYPES.has(addresstype) && name) return name.slice(0, 120);
    return null;
}

/**
 * @param {string} nominatimUrl
 * @param {number} lat
 * @param {number} lng
 * @returns {URL}
 */
export function nominatimReverseUrl(nominatimUrl, lat, lng) {
    const url = new URL(`${nominatimUrl.replace(/\/$/, "")}/reverse`);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("zoom", "10");
    return url;
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{ fetchImpl?: typeof fetch, nominatimUrl?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ city: string | null, retryable: boolean, status: number, reason: string }>}
 */
export async function reverseCityFromNominatim(lat, lng, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const nominatimUrl = options.nominatimUrl ?? PUBLIC_NOMINATIM_URL;
    const timeoutMs = options.timeoutMs ?? NOMINATIM_TIMEOUT_MS;
    const url = nominatimReverseUrl(nominatimUrl, lat, lng);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            headers: {
                "User-Agent": USER_AGENT,
                "Accept-Language": "en",
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        if (response.status === 429 || response.status === 408 || response.status >= 500) {
            return {
                city: null,
                retryable: true,
                status: response.status,
                reason: `http-${response.status}`,
            };
        }
        if (!response.ok) {
            return {
                city: null,
                retryable: false,
                status: response.status,
                reason: `http-${response.status}`,
            };
        }
        let body;
        try {
            body = await response.json();
        } catch {
            return { city: null, retryable: true, status: response.status, reason: "invalid-json" };
        }
        if (body && typeof body === "object" && "error" in body && body.error) {
            return {
                city: null,
                retryable: false,
                status: response.status,
                reason: String(body.error),
            };
        }
        const city = cityLabelFromNominatimBody(body);
        if (!city) {
            return { city: null, retryable: false, status: response.status, reason: "no-locality" };
        }
        return { city, retryable: false, status: response.status, reason: "" };
    } catch (error) {
        const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
        const reason = name === "AbortError" ? "timeout" : "network";
        return { city: null, retryable: true, status: 0, reason };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {string | null | undefined} countryCode
 * @param {string | number | null} [afterId]
 * @returns {{ where: string, params: string[] }}
 */
export function missingCityFilter(countryCode, afterId = null) {
    /** @type {string[]} */
    const params = [];
    const clauses = ["(city IS NULL OR trim(city) = '')"];
    if (afterId != null) {
        params.push(String(afterId));
        clauses.push(`id > $${params.length}::bigint`);
    }
    if (countryCode) {
        params.push(countryCode);
        clauses.push(`country_code = $${params.length}`);
    }
    return { where: clauses.join(" AND "), params };
}

/**
 * @param {string} cachePath
 * @param {BackfillCityOpts} opts
 * @returns {{ cache: ReturnType<typeof emptyCityCache>, resetReason: string }}
 */
export function loadCityCache(cachePath, opts) {
    const empty = emptyCityCache(opts);
    try {
        const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
        if (!parsed || parsed.version !== 1) {
            return { cache: empty, resetReason: "unreadable" };
        }
        if (parsed.gridDecimals !== opts.gridDecimals || parsed.nominatimUrl !== opts.nominatimUrl) {
            return { cache: empty, resetReason: "grid or nominatim URL changed" };
        }
        return {
            cache: {
                version: 1,
                gridDecimals: opts.gridDecimals,
                nominatimUrl: opts.nominatimUrl,
                cells: parsed.cells && typeof parsed.cells === "object" ? parsed.cells : {},
                unresolved:
                    parsed.unresolved && typeof parsed.unresolved === "object"
                        ? parsed.unresolved
                        : {},
            },
            resetReason: "",
        };
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : "";
        if (code === "ENOENT") return { cache: empty, resetReason: "" };
        return { cache: empty, resetReason: "unreadable" };
    }
}

/**
 * @param {BackfillCityOpts} opts
 */
function emptyCityCache(opts) {
    return {
        version: 1,
        gridDecimals: opts.gridDecimals,
        nominatimUrl: opts.nominatimUrl,
        cells: {},
        unresolved: {},
    };
}

/**
 * @param {string} cachePath
 * @param {ReturnType<typeof emptyCityCache>} cache
 */
export function saveCityCache(cachePath, cache) {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, "utf8");
    renameSync(tmp, cachePath);
}

/**
 * @param {Array<{ city: string, ids: string[] }>} entries
 * @param {{ dryRun: boolean, query: typeof sightseeingQuery }} options
 * @returns {Promise<number>}
 */
export async function applyCityUpdates(entries, { dryRun, query }) {
    /** @type {Map<string, string[]>} */
    const byCity = new Map();
    for (const entry of entries) {
        const city = String(entry.city ?? "").trim();
        if (!city) continue;
        const ids = byCity.get(city) ?? [];
        for (const id of entry.ids) ids.push(String(id));
        byCity.set(city, ids);
    }

    let updated = 0;
    for (const [city, ids] of byCity) {
        for (let start = 0; start < ids.length; start += UPDATE_CHUNK) {
            const chunk = ids.slice(start, start + UPDATE_CHUNK);
            if (dryRun) {
                updated += chunk.length;
                continue;
            }
            const result = await query(UPDATE_CITY_SQL, [city, chunk]);
            updated += result.rowCount ?? 0;
        }
    }
    return updated;
}

/**
 * @param {BackfillCityOpts} opts
 * @param {{
 *   query?: typeof sightseeingQuery,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   cachePath: string,
 *   shouldStop?: () => boolean,
 *   log?: (message: string) => void,
 * }} deps
 */
export async function runBackfill(opts, deps) {
    const query = deps.query ?? sightseeingQuery;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const sleepImpl = deps.sleepImpl ?? sleep;
    const shouldStop = deps.shouldStop ?? (() => false);
    const log = deps.log ?? ((message) => console.log(`[seed] backfill-city ${message}`));
    const delayMs = resolveRequestDelayMs(opts.nominatimUrl, opts.delayMs);

    const column = await query(
        `
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'sightseeing'
  AND column_name = 'city'
`.trim(),
    );
    let columnAdded = false;
    if ((column.rows ?? []).length === 0) {
        if (opts.dryRun) {
            log("sightseeing.city is missing; a real run would add the column");
            return {
                columnMissing: true,
                columnAdded: false,
                missing: 0,
                examined: 0,
                updated: 0,
                unresolved: 0,
                failed: 0,
                lookups: 0,
                cacheHits: 0,
                invalidCoords: 0,
                stopped: false,
                stopReason: "",
            };
        }
        await query(ADD_CITY_COLUMN_SQL);
        columnAdded = true;
        log("added sightseeing.city");
    }

    const countFilter = missingCityFilter(opts.countryCode || null);
    log("counting rows with an empty city");
    const countResult = await query(
        `SELECT count(*)::bigint AS missing FROM sightseeing WHERE ${countFilter.where}`,
        countFilter.params,
    );
    const missing = Number(countResult.rows?.[0]?.missing ?? 0);
    log(
        `start missing=${missing} delayMs=${delayMs} gridDecimals=${opts.gridDecimals} ` +
            `dryRun=${opts.dryRun} nominatim=${opts.nominatimUrl}` +
            (opts.countryCode ? ` country=${opts.countryCode}` : ""),
    );

    const loaded = loadCityCache(deps.cachePath, opts);
    const cache = loaded.cache;
    if (loaded.resetReason) {
        log(`ignoring saved lookups (${loaded.resetReason})`);
    }
    let examined = 0;
    let updated = 0;
    let unresolved = 0;
    let failed = 0;
    let lookups = 0;
    let cacheHits = 0;
    let invalidCoords = 0;
    let afterId = "0";
    let stopped = false;
    let stopReason = "";
    let consecutiveRateLimits = 0;

    const finish = () => ({
        columnMissing: false,
        columnAdded,
        missing,
        examined,
        updated,
        unresolved,
        failed,
        lookups,
        cacheHits,
        invalidCoords,
        stopped,
        stopReason,
    });

    try {
        while (!stopped && !shouldStop()) {
            const remaining = opts.limit > 0 ? opts.limit - examined : opts.batchSize;
            if (opts.limit > 0 && remaining <= 0) break;
            const pageSize = opts.limit > 0 ? Math.min(opts.batchSize, remaining) : opts.batchSize;
            const pageFilter = missingCityFilter(opts.countryCode || null, afterId);
            pageFilter.params.push(String(pageSize));
            const page = await query(
                `
SELECT id, lat, lng
FROM sightseeing
WHERE ${pageFilter.where}
ORDER BY id
LIMIT $${pageFilter.params.length}::int
`.trim(),
                pageFilter.params,
            );
            const rows = page.rows ?? [];
            if (rows.length === 0) break;
            afterId = String(rows[rows.length - 1].id);
            examined += rows.length;

            const { groups, invalid } = groupRowsByCell(rows, opts.gridDecimals);
            invalidCoords += invalid;
            /** @type {Array<{ city: string, ids: string[] }>} */
            const pending = [];
            let pageCacheHits = 0;
            let pageLookups = 0;

            for (const [key, group] of groups) {
                if (shouldStop()) {
                    stopped = true;
                    stopReason = "signal";
                    break;
                }
                const cached = cache.cells[key];
                if (cached && typeof cached.city === "string" && cached.city.trim()) {
                    cacheHits += 1;
                    pageCacheHits += 1;
                    pending.push({ city: cached.city.trim(), ids: group.ids });
                    continue;
                }
                const blocked = cache.unresolved[key];
                if (blocked && !opts.retryUnresolved) {
                    const attempts = Number(blocked.attempts) || 0;
                    if (!blocked.retryable || attempts >= opts.maxAttempts) {
                        if (blocked.retryable) failed += group.ids.length;
                        else unresolved += group.ids.length;
                        continue;
                    }
                }

                /** @type {{ city: string | null, retryable: boolean, status: number, reason: string } | null} */
                let result = null;
                for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
                    if (shouldStop()) {
                        stopped = true;
                        stopReason = "signal";
                        break;
                    }
                    result = await reverseCityFromNominatim(group.lat, group.lng, {
                        fetchImpl,
                        nominatimUrl: opts.nominatimUrl,
                    });
                    lookups += 1;
                    pageLookups += 1;
                    if (result.status === 429) consecutiveRateLimits += 1;
                    else consecutiveRateLimits = 0;
                    const waitMs = result.status === 429 ? Math.max(delayMs, 5_000) : delayMs;
                    await sleepImpl(waitMs);
                    if (consecutiveRateLimits >= 3) {
                        log(
                            "Nominatim returned HTTP 429 three times; stopping to respect the usage policy. Re-run later.",
                        );
                        stopped = true;
                        stopReason = "rate-limit";
                        break;
                    }
                    if (result.status === 403) {
                        log("Nominatim returned HTTP 403; stopping.");
                        stopped = true;
                        stopReason = "forbidden";
                        break;
                    }
                    if (!result.retryable) break;
                }
                if (stopped && stopReason === "signal") break;
                if (stopped) break;

                if (result?.city) {
                    cache.cells[key] = {
                        city: result.city,
                        lat: group.lat,
                        lng: group.lng,
                        at: new Date().toISOString(),
                    };
                    delete cache.unresolved[key];
                    pending.push({ city: result.city, ids: group.ids });
                    log(`lookup ${group.lat.toFixed(5)},${group.lng.toFixed(5)} → ${result.city} (${group.ids.length} rows)`);
                } else if (result && !result.retryable) {
                    cache.unresolved[key] = {
                        retryable: false,
                        attempts: 1,
                        status: result.status,
                        reason: result.reason,
                        at: new Date().toISOString(),
                    };
                    unresolved += group.ids.length;
                    log(
                        `lookup ${group.lat.toFixed(5)},${group.lng.toFixed(5)} unresolved (${result.reason}, ${group.ids.length} rows)`,
                    );
                } else {
                    const previous = Number(cache.unresolved[key]?.attempts) || 0;
                    cache.unresolved[key] = {
                        retryable: true,
                        attempts: previous + opts.maxAttempts,
                        status: result?.status ?? 0,
                        reason: result?.reason || "request-failed",
                        at: new Date().toISOString(),
                    };
                    failed += group.ids.length;
                    log(
                        `lookup ${group.lat.toFixed(5)},${group.lng.toFixed(5)} failed (${result?.reason || "request-failed"}, ${group.ids.length} rows)`,
                    );
                }
                saveCityCache(deps.cachePath, cache);
            }

            const pageUpdated = await applyCityUpdates(pending, { dryRun: opts.dryRun, query });
            updated += pageUpdated;
            log(
                `page through id ${afterId} rows=${rows.length} cells=${groups.size} ` +
                    `cacheHits=${pageCacheHits} lookups=${pageLookups} updated=${pageUpdated}`,
            );
            if (shouldStop() && !stopped) {
                stopped = true;
                stopReason = "signal";
            }
        }
        return finish();
    } finally {
        saveCityCache(deps.cachePath, cache);
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(USAGE);
        return;
    }
    if (opts.databaseUrl) process.env.DATABASE_URL = opts.databaseUrl;
    ensureCaffeinate(opts);

    const reportDir = resolveReportDir(opts.reportDir);
    let stopRequested = false;
    process.on("SIGINT", () => {
        if (stopRequested) process.exit(130);
        stopRequested = true;
        console.log("[seed] backfill-city stopping after the current lookup…");
    });

    const result = await runBackfill(opts, {
        cachePath: join(reportDir, CACHE_FILE),
        shouldStop: () => stopRequested,
        log: (message) => logProgress(reportDir, PROGRESS_LOG_FILE, `backfill-city ${message}`),
    });

    const reportPath = writeTimestampedReport(reportDir, REPORT_PREFIX, {
        finishedAt: new Date().toISOString(),
        options: {
            dryRun: opts.dryRun,
            limit: opts.limit,
            delayMs: opts.delayMs,
            batchSize: opts.batchSize,
            gridDecimals: opts.gridDecimals,
            countryCode: opts.countryCode,
            nominatimUrl: opts.nominatimUrl,
        },
        result,
    });
    logProgress(reportDir, PROGRESS_LOG_FILE, `backfill-city report ${reportPath}`);
    logProgress(reportDir, PROGRESS_LOG_FILE, `backfill-city totals ${JSON.stringify(result)}`);
    if (stopRequested) process.exitCode = 130;
    else if (result.stopReason) process.exitCode = 2;
}

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main().catch(async (error) => {
        console.error("[seed] backfill-city fatal:", error?.message || error);
        await closeSightseeingPool().catch(() => {});
        process.exit(1);
    });
}
