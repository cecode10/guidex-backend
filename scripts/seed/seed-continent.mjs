/**
 * Shared continent bulk-seed runner.
 *
 * Each continent wrapper passes a country list; SPARQL filters, tiling,
 * retries, and upserts live in `seed-sightseeing-engine.mjs`.
 */
import { join } from "node:path";
import { closeSightseeingPool } from "../../services/sightseeing-db.mjs";
import { writeTimestampedReport } from "./script-common.mjs";
import {
    ensureCaffeinate,
    logProgress,
    parseSharedSeedOpts,
    runSightseeingSeed,
} from "./seed-sightseeing-engine.mjs";

/**
 * @typedef {{
 *   name: string,
 *   wikidataId: string,
 *   iso2?: string,
 *   aliases?: string[],
 *   bounds?: { minLon?: number, maxLon?: number, minLat?: number, maxLat?: number },
 * }} ContinentCountry
 */

/**
 * @param {ContinentCountry} country
 * @param {string} needle
 * @returns {"exact" | "partial" | null}
 */
export function countryMatchKind(country, needle) {
    const q = needle.trim().toLowerCase();
    if (!q) return null;
    const qidNeedle = q.startsWith("q") ? q : `q${q}`;
    const name = country.name.toLowerCase();
    if (name === q) return "exact";
    if (country.wikidataId.toLowerCase() === q || country.wikidataId.toLowerCase() === qidNeedle) {
        return "exact";
    }
    if (country.iso2 && country.iso2.toLowerCase() === q) return "exact";
    if ((country.aliases ?? []).some((alias) => alias.toLowerCase() === q)) return "exact";
    if (q.length >= 4 && name.includes(q)) return "partial";
    return null;
}

/**
 * @param {ContinentCountry[]} countries
 * @param {string} needle
 * @param {string} label
 * @returns {ContinentCountry[]}
 */
export function selectCountries(countries, needle, label) {
    if (!needle) return [...countries];
    const ranked = countries
        .map((country) => ({ country, kind: countryMatchKind(country, needle) }))
        .filter((row) => row.kind);
    const exact = ranked.filter((row) => row.kind === "exact").map((row) => row.country);
    const matched = exact.length > 0 ? exact : ranked.map((row) => row.country);
    if (matched.length === 0) {
        throw new Error(`No ${label} country matched --country=${needle}`);
    }
    return matched;
}

/**
 * @param {ContinentCountry} country
 */
export function toSeedRegion(country) {
    return {
        name: country.name,
        wikidataId: country.wikidataId,
        kind: /** @type {const} */ ("country"),
        countryQid: country.wikidataId,
        city: null,
        bounds: country.bounds ?? null,
    };
}

/**
 * @param {{
 *   slug: string,
 *   label: string,
 *   countries: ContinentCountry[],
 *   argv?: string[],
 * }} options
 */
export async function runContinentSeed({
    slug,
    label,
    countries,
    argv = process.argv.slice(2),
}) {
    const opts = parseSharedSeedOpts(argv);
    if (opts.help) {
        console.log(`Usage: node scripts/seed/seed-${slug}-sightseeing.mjs [--country NAME] [--dry-run]

${label} bulk seed from a fixed country list.
Existing sightseeing QIDs are skipped unless you pass --update-existing.
For an arbitrary city or country use: node scripts/seed/seed-sightseeing.mjs --city|--country`);
        process.exit(0);
    }
    if (opts.city) {
        throw new Error(
            "This wrapper is country-list only. Use scripts/seed/seed-sightseeing.mjs --city ...",
        );
    }

    ensureCaffeinate(opts);

    const regions = selectCountries(countries, opts.country, label).map(toSeedRegion);
    const checkpointFile = `seed-${slug}-checkpoint.json`;
    const progressLogFile = `seed-${slug}-progress.log`;
    const reportPrefix = `seed-${slug}-sightseeing`;

    const { report, reportDir, completed } = await runSightseeingSeed({
        regions,
        opts,
        reportPrefix,
        checkpointFile,
        progressLogFile,
    });

    const reportPath = writeTimestampedReport(reportDir, reportPrefix, report);
    logProgress(reportDir, progressLogFile, `[seed] report ${reportPath}`);
    logProgress(
        reportDir,
        progressLogFile,
        `[seed] totals ${JSON.stringify(report.totals)}`,
    );
    logProgress(
        reportDir,
        progressLogFile,
        `[seed] checkpoint ${join(reportDir, checkpointFile)} ` +
            `(${completed.size} completed QIDs) — re-run with --resume to continue`,
    );

    await closeSightseeingPool();
    if (report.totals.failed > 0) process.exitCode = 1;
    return report;
}

/**
 * @param {() => Promise<unknown>} run
 */
export function runContinentMain(run) {
    run().catch(async (error) => {
        console.error("[seed] fatal:", error?.message || error);
        await closeSightseeingPool().catch(() => {});
        process.exit(1);
    });
}
