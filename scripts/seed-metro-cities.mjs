#!/usr/bin/env node
/**
 * LEGACY — Firestore metro geo-location seeder.
 *
 * Prefer `scripts/seed-europe-sightseeing.mjs` (PostGIS) for Explore/check-in.
 *
 * Seeds dense metro cities with a lighter Wikidata query:
 * - SPARQL radius: 5 km (metro fallback)
 * - fetchLimit: 75
 * - Firestore cache key: still r10 from Google geocode (matches live Explore search)
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { initializeApp } from "firebase-admin/app";
import { DEFAULT_CITIES_FILE } from "./european-cities-config.mjs";
import {
    METRO_FALLBACK_SPARQL_RADIUS_KM,
    SPARQL_METRO_FETCH_LIMIT,
    SPARQL_PROFILE,
    WIKIDATA_SPARQL_QUALITY_TIMEOUT_MS,
} from "../wikidata-nearby-utils.mjs";
import { seedOneCity } from "./seed-european-city-search-cache.mjs";
import {
    loadCredential,
    readJsonFile,
    sleep,
    writeTimestampedReport,
} from "./script-common.mjs";

/** @type {Array<{ index: number, searchQuery?: string }>} */
export const DEFAULT_METRO_CITIES = [
    { index: 83, searchQuery: "Boulogne-Billancourt, France" },
    { index: 108, searchQuery: "Paris, France" },
    { index: 113, searchQuery: "Saint-Denis, Seine-Saint-Denis, France" },
    { index: 128, searchQuery: "Berlin, Germany" },
    { index: 736, searchQuery: "London, United Kingdom" },
];

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        input: DEFAULT_CITIES_FILE,
        credentials: "",
        projectId: "guidex-afc30",
        reportDir: "reports",
        dryRun: false,
        forceRefresh: true,
        delayMs: 30_000,
        sparqlRetries: 2,
        sparqlMaxAttempts: 2,
        sparqlTimeoutMs: WIKIDATA_SPARQL_QUALITY_TIMEOUT_MS,
        metroSparqlRadiusKm: METRO_FALLBACK_SPARQL_RADIUS_KM,
        metroFetchLimit: SPARQL_METRO_FETCH_LIMIT,
        cities: DEFAULT_METRO_CITIES,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--credentials") opts.credentials = String(argv[++i] ?? "");
        else if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--delay-ms") opts.delayMs = Number(argv[++i] ?? opts.delayMs);
        else if (arg === "--sparql-retries") opts.sparqlRetries = Number(argv[++i] ?? opts.sparqlRetries);
        else if (arg === "--sparql-max-attempts") {
            opts.sparqlMaxAttempts = Number(argv[++i] ?? opts.sparqlMaxAttempts);
        } else if (arg === "--metro-fetch-limit") {
            opts.metroFetchLimit = Number(argv[++i] ?? opts.metroFetchLimit);
        } else if (arg === "--help" || arg === "-h") {
            console.log(`Usage: node scripts/seed-metro-cities.mjs --credentials PATH`);
            process.exit(0);
        }
    }
    return opts;
}

const isMain =
    process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
    const opts = parseArgs(process.argv.slice(2));
    const apiKey = String(process.env.GOOGLE_MAPS_API_KEY ?? "").trim();
    if (!apiKey) {
        console.error("GOOGLE_MAPS_API_KEY is required");
        process.exit(1);
    }

    initializeApp({
        credential: loadCredential(opts.credentials, "seed-metro-cities.mjs"),
        projectId: opts.projectId,
    });

    const payload = /** @type {{ cities?: Array<Record<string, unknown>> }} */ (
        readJsonFile(opts.input)
    );
    const cities = Array.isArray(payload.cities) ? payload.cities : [];

    const seedOpts = {
        dryRun: opts.dryRun,
        input: opts.input,
        limit: Infinity,
        offset: 0,
        forceRefresh: opts.forceRefresh,
        sparqlProfile: SPARQL_PROFILE.QUALITY,
        sparqlTimeoutMs: opts.sparqlTimeoutMs,
        delayMs: opts.delayMs,
        geocodeRetries: 3,
        sparqlRetries: opts.sparqlRetries,
        sparqlMaxAttempts: opts.sparqlMaxAttempts,
        minPlacesWarn: 10,
        reportDir: opts.reportDir,
        projectId: opts.projectId,
        credentials: opts.credentials,
        metroFallback: true,
        metroSparqlRadiusKm: opts.metroSparqlRadiusKm,
        metroFetchLimit: opts.metroFetchLimit,
    };

    console.log(
        "metro seed cities=%d sparqlRadiusKm=%d fetchLimit=%d forceRefresh=%s",
        opts.cities.length,
        opts.metroSparqlRadiusKm,
        opts.metroFetchLimit,
        opts.forceRefresh,
    );

    const started = Date.now();
    const results = [];

    for (let i = 0; i < opts.cities.length; i++) {
        const entry = opts.cities[i];
        const index = entry.index;
        const source = cities[index];
        if (!source) {
            console.error(`missing city index ${index}`);
            continue;
        }
        const city = {
            ...source,
            ...(entry.searchQuery ? { searchQuery: entry.searchQuery } : {}),
        };

        console.log(
            `\n[${i + 1}/${opts.cities.length}] metro #${index} ${city.searchQuery || source.name}`,
        );

        const row = await seedOneCity({ city, index, apiKey, opts: seedOpts });
        results.push(row);
        console.log(
            `[metro] ${row.status} key=${row.key ?? "—"} places=${row.places ?? "—"} ${row.message ?? ""}`.trim(),
        );

        if (i < opts.cities.length - 1 && seedOpts.delayMs > 0) {
            await sleep(seedOpts.delayMs);
        }
    }

    const report = {
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        metroSparqlRadiusKm: opts.metroSparqlRadiusKm,
        metroFetchLimit: opts.metroFetchLimit,
        results,
    };
    const reportPath = writeTimestampedReport(opts.reportDir, "seed-metro-cities", report);
    console.log("\n=== Metro seed report ===");
    for (const row of results) {
        console.log(`${row.name}: ${row.status} places=${row.places ?? 0} key=${row.key ?? "—"}`);
    }
    console.log("report:", reportPath);
}
