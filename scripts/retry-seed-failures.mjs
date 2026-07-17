#!/usr/bin/env node
/**
 * Re-runs cities that failed in prior seed-european-city-search-cache reports.
 *
 * Usage:
 *   node scripts/retry-seed-failures.mjs \\
 *     --credentials scripts/guidex-afc30-cb8e866de06c.json \\
 *     --reports scripts/reports/seed-european-city-search-cache-2026-07-12T13-11-45-581Z.json \\
 *     --reports scripts/reports/seed-european-city-search-cache-2026-07-13T13-09-50-722Z.json
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import {
    loadCredential,
    readJsonFile,
    writeTimestampedReport,
} from "./script-common.mjs";
import { DEFAULT_CITIES_FILE } from "./european-cities-config.mjs";
import { seedOneCity, summarizeSeedReport } from "./seed-european-city-search-cache.mjs";

const FAILURE_STATUSES = new Set(["sparql_failed", "empty_results", "geocode_failed", "error"]);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        input: DEFAULT_CITIES_FILE,
        reports: [],
        reportDir: "reports",
        projectId: "guidex-afc30",
        credentials: "",
        sparqlRetries: 8,
        sparqlTimeoutMs: 180_000,
        delayMs: 15_000,
        dryRun: false,
        includeThin: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--reports") opts.reports.push(String(argv[++i] ?? ""));
        else if (arg === "--all-reports") {
            opts.reports = readdirSync(resolve("scripts/reports"))
                .filter((name) => name.startsWith("seed-european-city-search-cache-") && name.endsWith(".json"))
                .map((name) => `scripts/reports/${name}`);
        } else if (arg === "--input") opts.input = String(argv[++i] ?? opts.input);
        else if (arg === "--credentials") opts.credentials = String(argv[++i] ?? "");
        else if (arg === "--project") opts.projectId = String(argv[++i] ?? opts.projectId);
        else if (arg === "--sparql-retries") opts.sparqlRetries = Number(argv[++i] ?? opts.sparqlRetries);
        else if (arg === "--sparql-timeout-ms") {
            opts.sparqlTimeoutMs = Number(argv[++i] ?? opts.sparqlTimeoutMs);
        } else if (arg === "--delay-ms") opts.delayMs = Number(argv[++i] ?? opts.delayMs);
        else if (arg === "--include-thin") opts.includeThin = true;
        else if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--report-dir") opts.reportDir = String(argv[++i] ?? opts.reportDir);
        else if (arg === "--help" || arg === "-h") {
            console.log(`Usage: node scripts/retry-seed-failures.mjs --credentials PATH [--all-reports | --reports PATH ...]

Re-runs failed (and optionally thin) cities from prior seed reports.`);
            process.exit(0);
        }
    }
    return opts;
}

/**
 * @param {string[]} reportPaths
 */
function collectRetryRows(reportPaths) {
    /** @type {Map<number, Record<string, unknown>>} */
    const byIndex = new Map();
    for (const reportPath of reportPaths) {
        const report = /** @type {{ results?: Array<Record<string, unknown>> }} */ (
            readJsonFile(reportPath)
        );
        for (const row of report.results ?? []) {
            const index = Number(row.index);
            if (!Number.isInteger(index)) continue;
            byIndex.set(index, row);
        }
    }
    return [...byIndex.values()];
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 */
export async function runRetrySeedFailures(opts) {
    const apiKey = String(process.env.GOOGLE_MAPS_API_KEY ?? "").trim();
    if (!apiKey) {
        throw new Error("GOOGLE_MAPS_API_KEY is required");
    }
    if (opts.reports.length === 0) {
        throw new Error("Pass --reports PATH or --all-reports");
    }

    const payload = /** @type {{ cities?: Array<Record<string, unknown>> }} */ (
        readJsonFile(opts.input)
    );
    const cities = Array.isArray(payload.cities) ? payload.cities : [];
    const rows = collectRetryRows(opts.reports);
    const toRetry = rows.filter((row) => {
        if (FAILURE_STATUSES.has(String(row.status))) return true;
        return opts.includeThin && row.thinResult === true;
    });

    /** @type {Map<number, Record<string, unknown>>} */
    const unique = new Map();
    for (const row of toRetry) {
        unique.set(Number(row.index), row);
    }
    const queue = [...unique.values()].sort((a, b) => Number(a.index) - Number(b.index));

    console.log(
        "retry queue=%d fromReports=%d dryRun=%s sparqlRetries=%d timeoutMs=%d",
        queue.length,
        opts.reports.length,
        opts.dryRun,
        opts.sparqlRetries,
        opts.sparqlTimeoutMs,
    );

    const seedOpts = {
        dryRun: opts.dryRun,
        input: opts.input,
        limit: Infinity,
        offset: 0,
        forceRefresh: true,
        sparqlProfile: "quality",
        sparqlTimeoutMs: opts.sparqlTimeoutMs,
        delayMs: opts.delayMs,
        geocodeRetries: 3,
        sparqlRetries: opts.sparqlRetries,
        minPlacesWarn: 10,
        reportDir: opts.reportDir,
        projectId: opts.projectId,
        credentials: opts.credentials,
    };

    /** @type {Array<Record<string, unknown>>} */
    const results = [];
    const started = Date.now();

    for (let i = 0; i < queue.length; i++) {
        const prior = queue[i];
        const index = Number(prior.index);
        const city = cities[index];
        if (!city) {
            results.push({
                index,
                name: String(prior.name ?? "?"),
                country: String(prior.country ?? ""),
                searchQuery: String(prior.searchQuery ?? ""),
                status: "error",
                message: "City index missing from input list",
            });
            continue;
        }

        console.log(
            `\n[${i + 1}/${queue.length}] retry #${index} ${citySearchQuery(city)} ` +
                `(was ${prior.status}${prior.places != null ? ` places=${prior.places}` : ""})`,
        );

        const row = await seedOneCity({
            city,
            index,
            apiKey,
            opts: seedOpts,
        });
        results.push({
            ...row,
            priorStatus: prior.status,
            priorKey: prior.key,
            priorPlaces: prior.places,
        });

        console.log(
            `[retry] ${row.status} key=${row.key ?? "—"} places=${row.places ?? "—"} ${row.message ?? ""}`.trim(),
        );

        if (i < queue.length - 1 && seedOpts.delayMs > 0) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, seedOpts.delayMs));
        }
    }

    const summary = summarizeSeedReport(results);
    const report = {
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        sourceReports: opts.reports,
        totals: {
            processed: results.length,
            recovered: results.filter((row) => row.status === "seeded" && row.places > 0).length,
            stillFailed: results.filter((row) => FAILURE_STATUSES.has(String(row.status))).length,
            ...summary,
        },
        results,
    };

    const reportPath = writeTimestampedReport(opts.reportDir, "retry-seed-failures", report);
    console.log("\n=== Retry report ===");
    console.log("processed: %d", results.length);
    console.log("recovered: %d", report.totals.recovered);
    console.log("stillFailed: %d", report.totals.stillFailed);
    console.log("seeded: %d", summary.seeded);
    console.log("sparql_failed: %d", summary.sparql_failed);
    console.log("empty_results: %d", summary.empty_results);
    console.log("report: %s", reportPath);

    return { report, reportPath };
}

function citySearchQuery(city) {
    const explicit = String(city.searchQuery ?? "").trim();
    if (explicit) return explicit;
    const name = String(city.name ?? "").trim();
    const country = String(city.country ?? "").trim();
    return country ? `${name}, ${country}` : name;
}

const isMain =
    process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
    const opts = parseArgs(process.argv.slice(2));
    initializeApp({
        credential: loadCredential(opts.credentials, "retry-seed-failures.mjs"),
        projectId: opts.projectId,
    });

    try {
        await runRetrySeedFailures(opts);
    } catch (error) {
        console.error("fatal:", error?.message || error);
        process.exit(1);
    }
}
