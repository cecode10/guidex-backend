#!/usr/bin/env node
/**
 * Cities missing because they lack CITY_INSTANCE_TYPES matches but are still
 * settlements via broader Wikidata types (Paris / Sofia pattern).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runWikidataSparql } from "../places-lookup-utils.mjs";
import {
    CITY_INSTANCE_TYPES,
    ADDITIONAL_SETTLEMENT_INSTANCE_TYPES,
    SETTLEMENT_INSTANCE_TYPES,
    EXCLUDED_INSTANCE_TYPES,
    filterSeedableCityRows,
    normalizeCityLabel,
    wikidataIdFromUri,
} from "./generate-european-cities-list.mjs";
import {
    DEFAULT_CITIES_FILE,
    DEFAULT_MIN_POPULATION,
    EUROPEAN_COUNTRIES,
} from "./european-cities-config.mjs";
import { sleep } from "./script-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @param {"current" | "gap"} mode */
export const buildInstanceTypeGapQuery = (countryId, minPopulation, bounds = {}, mode = "current") => {
    const filters = [`?population >= ${minPopulation}`, "?population < 20000000"];
    if (typeof bounds.maxLon === "number") filters.push(`?lon < ${bounds.maxLon}`);
    if (typeof bounds.minLon === "number") filters.push(`?lon >= ${bounds.minLon}`);
    if (typeof bounds.maxLat === "number") filters.push(`?lat < ${bounds.maxLat}`);
    if (typeof bounds.minLat === "number") filters.push(`?lat >= ${bounds.minLat}`);
    const filterBlock = filters.map((line) => `  FILTER(${line})`).join("\n");
    const currentTypes = CITY_INSTANCE_TYPES.map((id) => `wd:${id}`).join(" ");
    const broadTypes = SETTLEMENT_INSTANCE_TYPES.map((id) => `wd:${id}`).join(" ");
    const excludedTypes = EXCLUDED_INSTANCE_TYPES.map((id) => `wd:${id}`).join(" ");

    const typeBlock =
        mode === "current"
            ? `
  ?city wdt:P31 ?instanceType .
  VALUES ?instanceType { ${currentTypes} }`
            : `
  ?city wdt:P31 ?broadType .
  VALUES ?broadType { ${broadTypes} }
  FILTER NOT EXISTS {
    ?city wdt:P31 ?currentType .
    VALUES ?currentType { ${currentTypes} }
  }`;

    return `
SELECT ?city ?cityLabel ?lat ?lon (MAX(?population) AS ?maxPopulation) WHERE {
  ?city wdt:P17 wd:${countryId} .
  ?city wdt:P625 ?coord .
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  ?city p:P1082 ?popStatement .
  ?popStatement ps:P1082 ?population .
${typeBlock}
  FILTER NOT EXISTS {
    ?city wdt:P31 ?excludedType .
    VALUES ?excludedType { ${excludedTypes} }
  }
${filterBlock}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?city ?cityLabel ?lat ?lon
ORDER BY DESC(?maxPopulation)
`.trim();
};

/** @param {Array<Record<string, unknown>>} bindings */
const mapRows = (bindings, countryName) =>
    filterSeedableCityRows(
        bindings.map((row) => ({
            name: normalizeCityLabel(row.cityLabel?.value),
            country: countryName,
            searchQuery: "",
            wikidataId: wikidataIdFromUri(row.city?.value),
            lat: Number(row.lat?.value),
            lon: Number(row.lon?.value),
            population: Number(row.maxPopulation?.value),
        })),
    );

/** @param {typeof EUROPEAN_COUNTRIES[number]} country */
async function fetchRows(country, mode) {
    const query = buildInstanceTypeGapQuery(
        country.wikidataId,
        DEFAULT_MIN_POPULATION,
        country.bounds,
        mode,
    );
    const bindings = await runWikidataSparql(query, fetch, {
        extra: `instance-gap-v2 ${country.name} mode=${mode}`,
        timeoutMs: 60_000,
        maxAttempts: 3,
    });
    return mapRows(bindings, country.name);
}

const existingPath = resolve(__dirname, "..", DEFAULT_CITIES_FILE);
const existing = JSON.parse(readFileSync(existingPath, "utf8"));
const existingIds = new Set(existing.cities.map((c) => c.wikidataId));

/** @type {Map<string, Record<string, unknown>>} */
const currentById = new Map();
/** @type {Map<string, Record<string, unknown>>} */
const gapById = new Map();
/** @type {Array<{ country: string, error: string }>} */
const failures = [];

for (let i = 0; i < EUROPEAN_COUNTRIES.length; i++) {
    const country = EUROPEAN_COUNTRIES[i];
    process.stdout.write(`[${i + 1}/${EUROPEAN_COUNTRIES.length}] ${country.name}... `);
    try {
        const currentRows = await fetchRows(country, "current");
        await sleep(500);
        const gapRows = await fetchRows(country, "gap");
        for (const row of currentRows) currentById.set(row.wikidataId, row);
        for (const row of gapRows) gapById.set(row.wikidataId, row);
        console.log(`current=${currentRows.length} gap=${gapRows.length}`);
    } catch (error) {
        const message = error?.message || String(error);
        failures.push({ country: country.name, error: message });
        console.log(`FAILED: ${message}`);
    }
    if (i < EUROPEAN_COUNTRIES.length - 1) await sleep(800);
}

const missing = [...gapById.values()].sort((a, b) => Number(b.population) - Number(a.population));
const notInJson = missing.filter((row) => !existingIds.has(row.wikidataId));
const broadTotal = currentById.size + gapById.size;

console.log("\n=== SUMMARY ===");
console.log(
    JSON.stringify(
        {
            existingJsonCount: existing.count,
            currentWhitelistCount: currentById.size,
            broadSettlementCount: broadTotal,
            missingDueToInstanceTypeWhitelist: missing.length,
            missingFromJsonDueToInstanceTypeGap: notInJson.length,
            failureCount: failures.length,
        },
        null,
        2,
    ),
);

console.log("\n=== MISSING (Paris/Sofia reason) ===");
for (const row of missing) {
    console.log(
        `${row.name} (${row.country}) pop=${row.population} ${row.wikidataId}` +
            (existingIds.has(row.wikidataId) ? " [already in JSON]" : ""),
    );
}
