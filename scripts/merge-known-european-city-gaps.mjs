#!/usr/bin/env node
/**
 * One-shot backfill for known Wikidata gaps (instance-type + admin-type).
 */
import { DEFAULT_CITIES_FILE } from "./european-cities-config.mjs";
import { KNOWN_GAP_WIKIDATA_IDS } from "./european-cities-known-gaps.mjs";
import { mergeEuropeanCitiesByWikidataIds } from "./generate-european-cities-list.mjs";

const output = process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : DEFAULT_CITIES_FILE;

try {
    const result = await mergeEuropeanCitiesByWikidataIds(output, KNOWN_GAP_WIKIDATA_IDS);
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error("fatal:", error?.message || error);
    process.exit(1);
}
