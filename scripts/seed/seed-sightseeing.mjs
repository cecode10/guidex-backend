#!/usr/bin/env node
/**
 * Seed sightseeing rows (Postgres + PostGIS) from Wikidata for one city or country.
 *
 * Wikidata filters match the Europe seed exactly: `SPARQL_POI_CATEGORIES` +
 * `SPARQL_INSTANCE_OF_CLAUSE` from `utils/places-lookup-utils.mjs`.
 *
 * Prerequisites
 * -------------
 *   export DATABASE_URL=postgresql://postgres:PASSWORD@127.0.0.1:5432/sightseeing
 *   # (use Cloud SQL Auth Proxy for private IP)
 *   cd backend
 *   psql "$DATABASE_URL" -f db/001_sightseeing.sql
 *
 * Usage
 * -----
 *   npm run script:sightseeing:seed -- --city "San Francisco" --dry-run
 *   npm run script:sightseeing:seed -- --country USA
 *   npm run script:sightseeing:seed -- --city Paris --country France
 *   npm run script:sightseeing:seed -- --city Q62 --radius-km 25
 *   npm run script:sightseeing:seed -- --country Q30 --min-sitelinks=15 --migrate-db
 *
 * Flags
 * -----
 *   --city NAME|QID     City / town (Wikidata search, or Q-id)
 *   --country NAME|QID  Country (name, ISO-2/3, or Q-id). With --city, disambiguates.
 *   --dry-run           Fetch Wikidata only; no DB writes
 *   --radius-km N       City bbox radius when Wikidata has no extremes (default: 20)
 *   --resume            Skip regions already marked ok in the checkpoint file
 *   --update-existing   Overwrite rows that already exist (default: skip them)
 *   --delay-ms N        Pause between SPARQL requests (default: 1500)
 *   --page-size N       SPARQL page size (default: 2000)
 *   --min-sitelinks N   Keep POIs with sitelinks >= N (default: 1)
 *   --max-sitelinks N   Keep POIs with sitelinks < N (exclusive upper bound)
 *   --force-tiles       Always start with a bbox split into tiles
 *   --region-retries N  Outer retries per city/country on transient failures (default: 2)
 *   --migrate-db        Apply db/001_sightseeing.sql before seeding (default: off)
 *   --no-caffeinate     Do not re-launch under macOS caffeinate
 *   --report-dir PATH   Report/checkpoint/progress dir (default: scripts/seed/reports)
 *   --database-url URL  Override DATABASE_URL / SIGHTSEEING_DATABASE_URL
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closeSightseeingPool } from "../../services/sightseeing-db.mjs";
import { writeTimestampedReport } from "./script-common.mjs";
import {
    ensureCaffeinate,
    logProgress,
    parseSharedSeedOpts,
    resolveSeedPlace,
    runSightseeingSeed,
} from "./seed-sightseeing-engine.mjs";

const CHECKPOINT_FILE = "seed-sightseeing-checkpoint.json";
const PROGRESS_LOG_FILE = "seed-sightseeing-progress.log";

const USAGE = `Usage: node scripts/seed/seed-sightseeing.mjs --city NAME|QID | --country NAME|QID

Examples:
  node scripts/seed/seed-sightseeing.mjs --city "San Francisco" --dry-run
  node scripts/seed/seed-sightseeing.mjs --country USA
  node scripts/seed/seed-sightseeing.mjs --city Paris --country France

Same Wikidata quality filters as the Europe seed (SPARQL_POI_CATEGORIES + P31).
On macOS the process re-launches under caffeinate -dims unless --no-caffeinate.`;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    return parseSharedSeedOpts(argv);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(USAGE);
        process.exit(0);
    }
    if (!opts.city && !opts.country) {
        console.error(USAGE);
        throw new Error("Pass --city NAME|QID and/or --country NAME|QID|ISO");
    }

    ensureCaffeinate(opts);

    const kind = opts.city ? "city" : "country";
    const needle = opts.city || opts.country;
    const region = await resolveSeedPlace({
        needle,
        kind,
        countryNeedle: opts.city ? opts.country : "",
        radiusKm: opts.radiusKm,
    });

    console.log(
        `[seed] resolved ${kind} "${needle}" → ${region.name} (${region.wikidataId})` +
            (region.countryQid && region.kind === "city"
                ? ` country=${region.countryQid}`
                : "") +
            (region.bounds
                ? ` bbox=[${region.bounds.minLon.toFixed(2)},${region.bounds.minLat.toFixed(2)}` +
                  `..${region.bounds.maxLon.toFixed(2)},${region.bounds.maxLat.toFixed(2)}]`
                : ""),
    );

    const { report, reportDir, completed } = await runSightseeingSeed({
        regions: [region],
        opts,
        reportPrefix: "seed-sightseeing",
        checkpointFile: CHECKPOINT_FILE,
        progressLogFile: PROGRESS_LOG_FILE,
    });

    const reportPath = writeTimestampedReport(reportDir, "seed-sightseeing", report);
    logProgress(reportDir, PROGRESS_LOG_FILE, `[seed] report ${reportPath}`);
    logProgress(reportDir, PROGRESS_LOG_FILE, `[seed] totals ${JSON.stringify(report.totals)}`);
    logProgress(
        reportDir,
        PROGRESS_LOG_FILE,
        `[seed] checkpoint ${join(reportDir, CHECKPOINT_FILE)} ` +
            `(${completed.size} completed QIDs) — re-run with --resume to continue`,
    );

    await closeSightseeingPool();
    if (report.totals.failed > 0) process.exitCode = 1;
}

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main().catch(async (error) => {
        console.error("[seed] fatal:", error?.message || error);
        await closeSightseeingPool().catch(() => {});
        process.exit(1);
    });
}
