#!/usr/bin/env node
/**
 * Pre-populates Firestore `geo-location/{lat}_{lng}_r10` cache entries for
 * European cities with 100k+ inhabitants (see scripts/data/european-cities-100k.json).
 *
 * Mirrors production `resolveGlobalSearchPopular` geocoding + Wikidata SPARQL flow.
 * Designed for slow, resilient batch runs — skips failures and writes a report.
 *
 * Prerequisites
 * -------------
 *   cd backend && npm install
 *   export GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
 *   export GOOGLE_MAPS_API_KEY=your-key
 *   node scripts/generate-european-cities-list.mjs   # if the city list is missing
 *
 * Usage
 * -----
 *   node scripts/seed-european-city-search-cache.mjs --dry-run --limit 5
 *   node scripts/seed-european-city-search-cache.mjs \\
 *     --credentials scripts/guidex-afc30-2758ce305a68.json \\
 *     --input scripts/data/european-cities-100k.json
 *
 * Flags
 * -----
 *   --dry-run              Geocode + log only; no Firestore writes
 *   --input PATH           City list JSON (default: scripts/data/european-cities-100k.json)
 *   --limit N              Process at most N cities
 *   --offset N             Skip first N cities
 *   --force-refresh        Re-fetch even when cache exists
 *   --delay-ms N           Pause between cities (default: 5000)
 *   --geocode-retries N    Google geocode retries (default: 3)
 *   --sparql-retries N     Outer Wikidata SPARQL retries per city (default: 5)
 *   --report-dir PATH      Report output dir (default: scripts/reports)
 *   --project ID           Firebase project id (default: guidex-afc30)
 *   --credentials PATH     Service account JSON
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { popularSearchRadiusKmFromGeocodeTypes } from "../geocode-anchor-utils.mjs";
import {
    fetchGoogleGeocode,
    fetchGoogleReverseGeocode,
    forwardGeocodeHasLocalityMetadata,
    geoLocationPopularKeyFromCoords,
    geoMetadataFromGeocodeResult,
    resolveExplorePopularPlaces,
} from "../explore-popular-core.mjs";
import { COLLECTION, GEO_LOCATION_CACHE_SOURCE } from "../geo-location-utils.mjs";
import { DEFAULT_CITIES_FILE } from "./european-cities-config.mjs";
import {
    exponentialBackoffMs,
    loadCredential,
    readJsonFile,
    sleep,
    writeTimestampedReport,
} from "./script-common.mjs";

const FUNCTION_NAME = "seedEuropeanCitySearchCache";
const TARGET_RADIUS_KM = 10;

/**
 * @typedef {"cached_skip" | "seeded" | "dry_run" | "geocode_failed" | "sparql_failed" | "empty_results" | "wrong_radius" | "error"} SeedStatus
 */

/**
 * @typedef {{
 *   index: number,
 *   name: string,
 *   country: string,
 *   searchQuery: string,
 *   status: SeedStatus,
 *   key?: string,
 *   places?: number,
 *   radiusKm?: number,
 *   attempts?: number,
 *   message?: string,
 *   durationMs?: number,
 * }} SeedResultRow
 */

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        dryRun: false,
        input: DEFAULT_CITIES_FILE,
        limit: Infinity,
        offset: 0,
        forceRefresh: false,
        delayMs: 5000,
        geocodeRetries: 3,
        sparqlRetries: 5,
        reportDir: "scripts/reports",
        projectId: "guidex-afc30",
        credentials: "",
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--input") opts.input = String(argv[++i] ?? opts.input);
        else if (arg === "--limit") opts.limit = Number(argv[++i] ?? "0") || Infinity;
        else if (arg === "--offset") opts.offset = Number(argv[++i] ?? "0") || 0;
        else if (arg === "--force-refresh") opts.forceRefresh = true;
        else if (arg === "--delay-ms") opts.delayMs = Number(argv[++i] ?? opts.delayMs);
        else if (arg === "--geocode-retries") {
            opts.geocodeRetries = Number(argv[++i] ?? opts.geocodeRetries);
        } else if (arg === "--sparql-retries") {
            opts.sparqlRetries = Number(argv[++i] ?? opts.sparqlRetries);
        } else if (arg === "--report-dir") opts.reportDir = String(argv[++i] ?? opts.reportDir);
        else if (arg === "--project") opts.projectId = String(argv[++i] ?? opts.projectId);
        else if (arg === "--credentials") opts.credentials = String(argv[++i] ?? "");
        else if (arg === "--help" || arg === "-h") {
            console.log(`Usage: node scripts/seed-european-city-search-cache.mjs [options]

See script header for flags.`);
            process.exit(0);
        }
    }
    return opts;
}

/**
 * @param {string} query
 * @param {string} apiKey
 * @param {number} maxAttempts
 */
export async function geocodeCityQuery(query, apiKey, maxAttempts) {
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            const delay = exponentialBackoffMs(attempt - 1, 600);
            console.warn(
                `[${FUNCTION_NAME}] geocode retry "${query}" in ${delay}ms (${attempt + 1}/${maxAttempts})`,
            );
            await sleep(delay);
        }
        try {
            const forward = await fetchGoogleGeocode(query, "en", apiKey);
            if (forward.status === "OK" && forward.results?.length) {
                return forward;
            }
            lastError = new Error(`Google Geocoding status=${forward.status}`);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new Error(`Geocoding failed for "${query}"`);
}

/**
 * @param {Record<string, unknown>} city
 */
export function citySearchQuery(city) {
    const explicit = String(city.searchQuery ?? "").trim();
    if (explicit) return explicit;
    const name = String(city.name ?? "").trim();
    const country = String(city.country ?? "").trim();
    return country ? `${name}, ${country}` : name;
}

/**
 * @param {{
 *   city: Record<string, unknown>,
 *   index: number,
 *   apiKey: string,
 *   opts: ReturnType<typeof parseArgs>,
 * }} params
 * @returns {Promise<SeedResultRow>}
 */
export async function seedOneCity({ city, index, apiKey, opts }) {
    const started = Date.now();
    const name = String(city.name ?? "").trim();
    const country = String(city.country ?? "").trim();
    const searchQuery = citySearchQuery(city);
    /** @type {SeedResultRow} */
    const base = { index, name, country, searchQuery, status: "error" };

    try {
        const forward = await geocodeCityQuery(searchQuery, apiKey, opts.geocodeRetries);
        const best = forward.results[0];
        const geometry = /** @type {{ location?: { lat?: number, lng?: number } }} */ (
            best.geometry ?? {}
        );
        const lat = geometry.location?.lat;
        const lng = geometry.location?.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
            return {
                ...base,
                status: "geocode_failed",
                message: "Google Geocoding returned no coordinates",
                durationMs: Date.now() - started,
            };
        }

        const types = Array.isArray(best.types) ? best.types.map((value) => String(value)) : [];
        const radiusKm = popularSearchRadiusKmFromGeocodeTypes(types);
        const key = geoLocationPopularKeyFromCoords(lat, lng, radiusKm);
        if (!key) {
            return {
                ...base,
                status: "error",
                message: "Could not derive geo-location key",
                durationMs: Date.now() - started,
            };
        }

        if (radiusKm !== TARGET_RADIUS_KM) {
            console.warn(
                `[${FUNCTION_NAME}] WARN ${searchQuery} radiusKm=${radiusKm} (expected ${TARGET_RADIUS_KM}) types=${types.join(",")}`,
            );
        }

        if (opts.dryRun) {
            return {
                ...base,
                status: "dry_run",
                key,
                radiusKm,
                message: `Would seed ${key}`,
                durationMs: Date.now() - started,
            };
        }

        if (!opts.forceRefresh) {
            const db = getFirestore();
            const existing = await db.collection(COLLECTION).doc(key).get();
            if (existing.exists) {
                const sub = await db
                    .collection(COLLECTION)
                    .doc(key)
                    .collection("popularAroundList")
                    .limit(1)
                    .get();
                if (!sub.empty) {
                    return {
                        ...base,
                        status: "cached_skip",
                        key,
                        radiusKm,
                        places: sub.size,
                        message: "Cache already populated",
                        durationMs: Date.now() - started,
                    };
                }
            }
        }

        const reverseGeocode = forwardGeocodeHasLocalityMetadata(best, lat, lng)
            ? null
            : await fetchGoogleReverseGeocode(lat, lng, "en", apiKey);
        const geocodeBest =
            reverseGeocode?.status === "OK" && reverseGeocode.results?.length
                ? reverseGeocode.results[0]
                : best;
        const { label, city: cityLabel, countryCode, countryFlag, resolvedLat, resolvedLng } =
            geoMetadataFromGeocodeResult(geocodeBest, lat, lng);

        let lastPartial = null;
        for (let attempt = 0; attempt < opts.sparqlRetries; attempt++) {
            if (attempt > 0) {
                const delay = exponentialBackoffMs(attempt - 1, 2000);
                console.warn(
                    `[${FUNCTION_NAME}] SPARQL retry "${searchQuery}" in ${delay}ms (${attempt + 1}/${opts.sparqlRetries})`,
                );
                await sleep(delay);
            }

            try {
                const result = await resolveExplorePopularPlaces({
                    functionName: FUNCTION_NAME,
                    key,
                    lat,
                    lng,
                    radiusKm,
                    searchQuery,
                    label,
                    city: cityLabel,
                    countryCode,
                    countryFlag,
                    resolvedLat,
                    resolvedLng,
                    forceRefresh: opts.forceRefresh,
                    language: "en",
                    apiKey,
                    cacheSource: GEO_LOCATION_CACHE_SOURCE.BATCH_SEED,
                });

                if (result.cached && result.places.length > 0) {
                    return {
                        ...base,
                        status: "cached_skip",
                        key,
                        radiusKm,
                        places: result.places.length,
                        attempts: attempt + 1,
                        durationMs: Date.now() - started,
                    };
                }

                if (result.places.length > 0) {
                    return {
                        ...base,
                        status: "seeded",
                        key,
                        radiusKm,
                        places: result.places.length,
                        attempts: attempt + 1,
                        durationMs: Date.now() - started,
                    };
                }

                if (result.partial) {
                    lastPartial = "Wikidata SPARQL failed (transient)";
                    continue;
                }

                return {
                    ...base,
                    status: "empty_results",
                    key,
                    radiusKm,
                    places: 0,
                    attempts: attempt + 1,
                    message: "SPARQL returned no places",
                    durationMs: Date.now() - started,
                };
            } catch (error) {
                lastPartial = error?.message || String(error);
                if (error?.name === "WikidataSparqlTransientError") {
                    continue;
                }
                return {
                    ...base,
                    status: "error",
                    key,
                    radiusKm,
                    attempts: attempt + 1,
                    message: lastPartial,
                    durationMs: Date.now() - started,
                };
            }
        }

        return {
            ...base,
            status: "sparql_failed",
            key,
            radiusKm,
            attempts: opts.sparqlRetries,
            message: lastPartial ?? "Wikidata SPARQL exhausted retries",
            durationMs: Date.now() - started,
        };
    } catch (error) {
        const message = error?.message || String(error);
        const status = /geocod/i.test(message) ? "geocode_failed" : "error";
        return {
            ...base,
            status,
            message,
            durationMs: Date.now() - started,
        };
    }
}

/**
 * @param {SeedResultRow[]} rows
 */
export function summarizeSeedReport(rows) {
    /** @type {Record<SeedStatus, number>} */
    const byStatus = {
        cached_skip: 0,
        seeded: 0,
        dry_run: 0,
        geocode_failed: 0,
        sparql_failed: 0,
        empty_results: 0,
        wrong_radius: 0,
        error: 0,
    };
    for (const row of rows) {
        byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }
    return byStatus;
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 */
export async function runSeedEuropeanCitySearchCache(opts) {
    const apiKey = String(process.env.GOOGLE_MAPS_API_KEY ?? "").trim();
    if (!apiKey) {
        throw new Error("GOOGLE_MAPS_API_KEY is required");
    }

    const payload = /** @type {{ cities?: Array<Record<string, unknown>>, count?: number }} */ (
        readJsonFile(opts.input)
    );
    const cities = Array.isArray(payload.cities) ? payload.cities : [];
    if (cities.length === 0) {
        throw new Error(`No cities in ${opts.input}. Run generate-european-cities-list.mjs first.`);
    }

    const slice = cities.slice(opts.offset, opts.offset + opts.limit);
    console.log(
        "starting seed totalInFile=%d processing=%d offset=%d dryRun=%s forceRefresh=%s delayMs=%d",
        cities.length,
        slice.length,
        opts.offset,
        opts.dryRun,
        opts.forceRefresh,
        opts.delayMs,
    );

    /** @type {SeedResultRow[]} */
    const results = [];
    const runStarted = Date.now();

    for (let i = 0; i < slice.length; i++) {
        const city = slice[i];
        const globalIndex = opts.offset + i;
        const searchQuery = citySearchQuery(city);
        console.log(
            `\n[${i + 1}/${slice.length}] (#${globalIndex + 1}) ${searchQuery}`,
        );

        const row = await seedOneCity({
            city,
            index: globalIndex,
            apiKey,
            opts,
        });
        results.push(row);

        console.log(
            `[${FUNCTION_NAME}] ${row.status} key=${row.key ?? "—"} places=${row.places ?? "—"} ${row.message ?? ""}`.trim(),
        );

        if (i < slice.length - 1 && opts.delayMs > 0) {
            await sleep(opts.delayMs);
        }
    }

    const summary = summarizeSeedReport(results);
    const report = {
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - runStarted,
        input: opts.input,
        offset: opts.offset,
        limit: Number.isFinite(opts.limit) ? opts.limit : null,
        dryRun: opts.dryRun,
        forceRefresh: opts.forceRefresh,
        totals: {
            processed: results.length,
            ...summary,
        },
        failures: results.filter((row) =>
            ["geocode_failed", "sparql_failed", "empty_results", "error"].includes(row.status),
        ),
        results,
    };

    const reportPath = writeTimestampedReport(
        opts.reportDir,
        "seed-european-city-search-cache",
        report,
    );

    console.log("\n=== Seed report ===");
    console.log("processed: %d", results.length);
    console.log("seeded: %d", summary.seeded);
    console.log("cached_skip: %d", summary.cached_skip);
    console.log("geocode_failed: %d", summary.geocode_failed);
    console.log("sparql_failed: %d", summary.sparql_failed);
    console.log("empty_results: %d", summary.empty_results);
    console.log("errors: %d", summary.error);
    console.log("dry_run: %d", summary.dry_run);
    console.log("duration: %ds", Math.round(report.durationMs / 1000));
    console.log("report: %s", reportPath);

    return { report, reportPath };
}

const isMain =
    process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
    const opts = parseArgs(process.argv.slice(2));
    initializeApp({
        credential: loadCredential(opts.credentials, "seed-european-city-search-cache.mjs"),
        projectId: opts.projectId,
    });

    try {
        await runSeedEuropeanCitySearchCache(opts);
    } catch (error) {
        console.error("fatal:", error?.message || error);
        process.exit(1);
    }
}
