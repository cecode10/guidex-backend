#!/usr/bin/env node
/**
 * Builds `scripts/data/european-cities-100k.json` from Wikidata — human
 * settlements in Europe with population >= 100,000 (configurable).
 *
 * Prerequisites
 * -------------
 *   cd backend && npm install
 *
 * Usage
 * -----
 *   node scripts/generate-european-cities-list.mjs
 *   node scripts/generate-european-cities-list.mjs --output scripts/data/european-cities-100k.json
 *   node scripts/generate-european-cities-list.mjs --min-population 100000 --delay-ms 1500
 *
 * Flags
 * -----
 *   --output PATH          Output JSON path (default: scripts/data/european-cities-100k.json)
 *   --min-population N     Minimum population (default: 100000)
 *   --delay-ms N           Pause between country queries (default: 1500)
 *   --sparql-retries N     Wikidata SPARQL retries per country (default: 4)
 *   --country NAME         Only fetch one country (repeatable)
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runWikidataSparql } from "../places-lookup-utils.mjs";
import {
    DEFAULT_CITIES_FILE,
    DEFAULT_MIN_POPULATION,
    EUROPEAN_COUNTRIES,
} from "./european-cities-config.mjs";
import {
    exponentialBackoffMs,
    sleep,
    writeJsonFile,
} from "./script-common.mjs";

/**
 * @param {string} countryId e.g. Q183
 * @param {number} minPopulation
 * @param {{ maxLon?: number, minLon?: number, maxLat?: number, minLat?: number }} [bounds]
 */
/** Wikidata instance types treated as seedable cities/towns. */
export const CITY_INSTANCE_TYPES = [
    "Q515", // city
    "Q3957", // town
    "Q1549591", // big city
    "Q7930989", // urban municipality
    "Q11950912", // municipal corporation
    "Q702492", // commune (France etc.)
    "Q5119", // capital city
    "Q129676344", // large city
];

/** Instance types excluded even when population is high. */
export const EXCLUDED_INSTANCE_TYPES = [
    "Q6256", // country
    "Q35657", // administrative territorial entity
    "Q10864048", // first-level administrative division
    "Q56061", // second-level administrative division
    "Q15313643", // third-level administrative division
    "Q82794", // region
    "Q104251", // county of Albania (pattern for counties)
    "Q123266", // district of Albania
    "Q768307", // municipality of Albania (prefer city item)
    "Q1431554", // apostolic administration
    "Q465613", // people's republic
    "Q3024240", // historical country
    "Q3624078", // sovereign state
];

/** @param {string} label */
export const isLikelyAdminDivisionLabel = (label) =>
    /\b(county|district|region|oblast|governorate|province|department|voivodeship|municipality|administration|prefecture|autonomous|republic|territory|area|division|department|land|state|country|europe|slavs)\b/i.test(
        String(label ?? ""),
    );

export const buildEuropeanCitiesSparql = (countryId, minPopulation, bounds = {}) => {
    const filters = [`?population >= ${minPopulation}`, "?population < 20000000"];
    if (typeof bounds.maxLon === "number") {
        filters.push(`?lon < ${bounds.maxLon}`);
    }
    if (typeof bounds.minLon === "number") {
        filters.push(`?lon >= ${bounds.minLon}`);
    }
    if (typeof bounds.maxLat === "number") {
        filters.push(`?lat < ${bounds.maxLat}`);
    }
    if (typeof bounds.minLat === "number") {
        filters.push(`?lat >= ${bounds.minLat}`);
    }
    const filterBlock = filters.map((line) => `  FILTER(${line})`).join("\n");
    const cityTypes = CITY_INSTANCE_TYPES.map((id) => `wd:${id}`).join(" ");
    const excludedTypes = EXCLUDED_INSTANCE_TYPES.map((id) => `wd:${id}`).join(" ");

    return `
SELECT ?city ?cityLabel ?lat ?lon (MAX(?population) AS ?maxPopulation) WHERE {
  ?city wdt:P17 wd:${countryId} .
  ?city wdt:P625 ?coord .
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  ?city p:P1082 ?popStatement .
  ?popStatement ps:P1082 ?population .
  ?city wdt:P31 ?instanceType .
  VALUES ?instanceType { ${cityTypes} }
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

/**
 * @param {Array<Record<string, unknown>>} rows
 */
export const filterSeedableCityRows = (rows) =>
    rows.filter((row) => {
        const name = normalizeCityLabel(row.name);
        if (!name || isLikelyAdminDivisionLabel(name)) return false;
        const population = Number(row.population);
        if (!Number.isFinite(population) || population < DEFAULT_MIN_POPULATION) return false;
        return true;
    });

/**
 * @param {string} uri
 */
export const wikidataIdFromUri = (uri) => {
    const match = String(uri ?? "").match(/(Q\d+)$/);
    return match?.[1] ?? "";
};

/**
 * @param {string} label
 */
export const normalizeCityLabel = (label) =>
    String(label ?? "")
        .replace(/\s*\(.*?\)\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * @param {import("./european-cities-config.mjs").EuropeanCountry} country
 * @param {number} minPopulation
 * @param {{ sparqlRetries: number }} opts
 */
export const fetchCitiesForCountry = async (country, minPopulation, { sparqlRetries }) => {
    const query = buildEuropeanCitiesSparql(country.wikidataId, minPopulation, country.bounds);
    let lastError = null;

    for (let attempt = 0; attempt < sparqlRetries; attempt++) {
        if (attempt > 0) {
            const delay = exponentialBackoffMs(attempt - 1, 800);
            console.warn(
                `[generate-cities] retry ${country.name} in ${delay}ms (attempt ${attempt + 1}/${sparqlRetries})`,
            );
            await sleep(delay);
        }
        try {
            const bindings = await runWikidataSparql(query, fetch, {
                extra: `generate-cities country=${country.name}`,
                timeoutMs: 60_000,
                maxAttempts: 2,
            });
            return filterSeedableCityRows(
                bindings.map((row) => {
                    const wikidataId = wikidataIdFromUri(row.city?.value);
                    const name = normalizeCityLabel(row.cityLabel?.value);
                    const lat = Number(row.lat?.value);
                    const lon = Number(row.lon?.value);
                    const population = Number(row.maxPopulation?.value);
                    return {
                        name,
                        country: country.name,
                        searchQuery: `${name}, ${country.name}`,
                        wikidataId,
                        lat,
                        lon,
                        population,
                    };
                }),
            );
        } catch (error) {
            lastError = error;
            console.error(
                `[generate-cities] ${country.name} failed: ${error?.message || error}`,
            );
        }
    }

    throw lastError ?? new Error(`Failed to fetch cities for ${country.name}`);
};

/**
 * @param {typeof EUROPEAN_COUNTRIES} countries
 * @param {Array<Record<string, unknown>>} rows
 */
export const dedupeEuropeanCities = (countries, rows) => {
    /** @type {Map<string, Record<string, unknown>>} */
    const byId = new Map();
    for (const row of rows) {
        const id = String(row.wikidataId ?? "").trim();
        if (!id) continue;
        const existing = byId.get(id);
        if (!existing || Number(row.population) > Number(existing.population)) {
            byId.set(id, row);
        }
    }
    const cities = [...byId.values()].sort((a, b) => {
        const byCountry = String(a.country).localeCompare(String(b.country));
        if (byCountry !== 0) return byCountry;
        return String(a.name).localeCompare(String(b.name));
    });
    return {
        generatedAt: new Date().toISOString(),
        source: "wikidata-sparql",
        minPopulation: DEFAULT_MIN_POPULATION,
        countryCount: countries.length,
        count: cities.length,
        cities,
    };
};

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        output: DEFAULT_CITIES_FILE,
        minPopulation: DEFAULT_MIN_POPULATION,
        delayMs: 1500,
        sparqlRetries: 4,
        countries: /** @type {string[]} */ ([]),
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--output") opts.output = String(argv[++i] ?? opts.output);
        else if (arg === "--min-population") {
            opts.minPopulation = Number(argv[++i] ?? opts.minPopulation);
        } else if (arg === "--delay-ms") opts.delayMs = Number(argv[++i] ?? opts.delayMs);
        else if (arg === "--sparql-retries") {
            opts.sparqlRetries = Number(argv[++i] ?? opts.sparqlRetries);
        } else if (arg === "--country") opts.countries.push(String(argv[++i] ?? "").trim());
        else if (arg === "--help" || arg === "-h") {
            console.log(`Usage: node scripts/generate-european-cities-list.mjs [options]

See script header for flags.`);
            process.exit(0);
        }
    }
    return opts;
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 */
export async function generateEuropeanCitiesList(opts) {
    const selectedCountries =
        opts.countries.length > 0
            ? EUROPEAN_COUNTRIES.filter((country) =>
                  opts.countries.some(
                      (name) => name.toLowerCase() === country.name.toLowerCase(),
                  ),
              )
            : EUROPEAN_COUNTRIES;

    if (selectedCountries.length === 0) {
        throw new Error("No countries matched --country filters");
    }

    /** @type {Array<Record<string, unknown>>} */
    const allRows = [];
    /** @type {Array<{ country: string, error: string }>} */
    const failures = [];

    console.log(
        "fetching cities minPopulation=%d countries=%d delayMs=%d",
        opts.minPopulation,
        selectedCountries.length,
        opts.delayMs,
    );

    for (let index = 0; index < selectedCountries.length; index++) {
        const country = selectedCountries[index];
        console.log(
            `[${index + 1}/${selectedCountries.length}] ${country.name} (${country.wikidataId})`,
        );
        try {
            const rows = await fetchCitiesForCountry(country, opts.minPopulation, {
                sparqlRetries: opts.sparqlRetries,
            });
            console.log("  -> %d cities", rows.length);
            allRows.push(...rows);
        } catch (error) {
            const message = error?.message || String(error);
            failures.push({ country: country.name, error: message });
            console.error("  -> FAILED: %s", message);
        }
        if (index < selectedCountries.length - 1 && opts.delayMs > 0) {
            await sleep(opts.delayMs);
        }
    }

    const payload = dedupeEuropeanCities(selectedCountries, allRows);
    payload.minPopulation = opts.minPopulation;
    payload.failures = failures;

    const abs = writeJsonFile(opts.output, payload);
    console.log("wrote %d cities to %s (failures=%d)", payload.count, abs, failures.length);
    return { abs, payload, failures };
}

const isMain =
    process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
    const opts = parseArgs(process.argv.slice(2));
    try {
        const { payload, failures } = await generateEuropeanCitiesList(opts);
        if (failures.length > 0) {
            process.exitCode = 1;
        } else if (payload.count === 0) {
            console.error("No cities were generated.");
            process.exitCode = 1;
        }
    } catch (error) {
        console.error("fatal:", error?.message || error);
        process.exit(1);
    }
}
