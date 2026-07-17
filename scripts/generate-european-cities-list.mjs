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
 * When the output file already exists, existing cities are kept and only new
 * Wikidata ids are appended (use --fresh to rebuild from scratch).
 *
 * Flags
 * -----
 *   --output PATH          Output JSON path (default: scripts/data/european-cities-100k.json)
 *   --input PATH           Existing city list to merge (default: --output when present)
 *   --fresh                Ignore existing file; replace the full list
 *   --min-population N     Minimum population (default: 100000)
 *   --delay-ms N           Pause between country queries (default: 1500)
 *   --sparql-retries N     Wikidata SPARQL retries per country (default: 4)
 *   --country NAME         Only fetch one country (repeatable)
 *   --backfill-id QID      Fetch and merge explicit Wikidata ids (repeatable)
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
    readJsonFile,
    resolveExistingPath,
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

/** Extra settlement P31 types for capitals / municipalities missing plain "city". */
export const ADDITIONAL_SETTLEMENT_INSTANCE_TYPES = [
    "Q200250", // metropolis
    "Q174844", // megacity
    "Q108178728", // national capital
    "Q257391", // federal capital
    "Q133442", // city-state
    "Q89487741", // city in Bulgaria
    "Q2074737", // municipality of Spain
    "Q13218690", // town in Hungary
    "Q51929311", // largest city
    "Q1901835", // seat of government
    "Q208511", // global city
    "Q22923920", // territorial collectivity of France with special status
    "Q15344922", // oblast seat
    "Q15303838", // municipality seat
    "Q15974307", // unitary municipality in Germany
    "Q42744322", // urban municipality in Germany
    "Q114401982", // independent city in Berlin
    "Q262882", // statutory city of Austria
    "Q667509", // municipality of Austria
    "Q707813", // Hanseatic city
    "Q13539802", // place with town rights and privileges
];

export const SETTLEMENT_INSTANCE_TYPES = [
    ...new Set([...CITY_INSTANCE_TYPES, ...ADDITIONAL_SETTLEMENT_INSTANCE_TYPES]),
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
    const cityTypes = SETTLEMENT_INSTANCE_TYPES.map((id) => `wd:${id}`).join(" ");
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

/** @param {string[]} wikidataIds */
export const buildEuropeanCitiesByIdsSparql = (wikidataIds) => {
    const values = wikidataIds
        .map((id) => String(id).trim().replace(/^wd:/, ""))
        .filter(Boolean)
        .map((id) => `wd:${id}`)
        .join(" ");
    return `
SELECT ?city ?cityLabel ?lat ?lon ?country (MAX(?population) AS ?maxPopulation) WHERE {
  VALUES ?city { ${values} }
  ?city wdt:P625 ?coord .
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  ?city wdt:P17 ?country .
  ?city p:P1082 ?popStatement .
  ?popStatement ps:P1082 ?population .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?city ?cityLabel ?lat ?lon ?country
`.trim();
};

const countryNameByWikidataId = new Map(
    EUROPEAN_COUNTRIES.map((country) => [country.wikidataId, country.name]),
);

/**
 * Fetches city rows for explicit Wikidata ids (used to backfill known gaps).
 *
 * @param {string[]} wikidataIds
 * @param {{ sparqlRetries?: number }} [opts]
 */
export const fetchEuropeanCitiesByWikidataIds = async (wikidataIds, opts = {}) => {
    const sparqlRetries = opts.sparqlRetries ?? 4;
    const ids = [
        ...new Set(
            wikidataIds
                .map((id) => String(id).trim().replace(/^wd:/, ""))
                .filter(Boolean),
        ),
    ];
    if (ids.length === 0) return [];

    /** @type {Array<Record<string, unknown>>} */
    const rows = [];
    const chunkSize = 40;

    for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize);
        const query = buildEuropeanCitiesByIdsSparql(chunk);
        let lastError = null;

        for (let attempt = 0; attempt < sparqlRetries; attempt++) {
            if (attempt > 0) {
                const delay = exponentialBackoffMs(attempt - 1, 800);
                console.warn(
                    `[generate-cities] retry wikidata-id batch in ${delay}ms (attempt ${attempt + 1}/${sparqlRetries})`,
                );
                await sleep(delay);
            }
            try {
                const bindings = await runWikidataSparql(query, fetch, {
                    extra: `generate-cities ids=${chunk.length}`,
                    timeoutMs: 60_000,
                    maxAttempts: 2,
                });
                rows.push(
                    ...bindings.map((row) => {
                        const wikidataId = wikidataIdFromUri(row.city?.value);
                        const countryId = wikidataIdFromUri(row.country?.value);
                        const country =
                            countryNameByWikidataId.get(countryId) ||
                            normalizeCityLabel(row.countryLabel?.value) ||
                            countryId;
                        const name = normalizeCityLabel(row.cityLabel?.value);
                        const lat = Number(row.lat?.value);
                        const lon = Number(row.lon?.value);
                        const population = Number(row.maxPopulation?.value);
                        return {
                            name,
                            country,
                            searchQuery: `${name}, ${country}`,
                            wikidataId,
                            lat,
                            lon,
                            population,
                        };
                    }),
                );
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                console.error(
                    `[generate-cities] wikidata-id batch failed: ${error?.message || error}`,
                );
            }
        }

        if (lastError) {
            throw lastError;
        }
    }

    return filterSeedableCityRows(rows);
};

/**
 * @param {string} outputPath
 * @param {string[]} wikidataIds
 * @param {{ sparqlRetries?: number }} [opts]
 */
export async function mergeEuropeanCitiesByWikidataIds(outputPath, wikidataIds, opts = {}) {
    const existingCities = loadExistingEuropeanCities(outputPath);
    const existingIds = new Set(
        existingCities.map((city) => String(city.wikidataId ?? "").trim()).filter(Boolean),
    );
    const missingIds = wikidataIds.filter((id) => !existingIds.has(String(id).replace(/^wd:/, "")));
    console.log(
        "backfill wikidata ids: %d requested, %d already in file, %d to fetch",
        wikidataIds.length,
        wikidataIds.length - missingIds.length,
        missingIds.length,
    );
    if (missingIds.length === 0) {
        return { added: 0, skipped: wikidataIds.length, count: existingCities.length };
    }

    const fetched = await fetchEuropeanCitiesByWikidataIds(missingIds, opts);
    const merged = mergeEuropeanCityRows(existingCities, fetched);
    const payload = {
        generatedAt: new Date().toISOString(),
        source: "wikidata-sparql",
        minPopulation: DEFAULT_MIN_POPULATION,
        countryCount: EUROPEAN_COUNTRIES.length,
        count: merged.cities.length,
        cities: merged.cities,
        merge: {
            previousCount: merged.previousCount,
            fetchedNew: merged.added,
            fetchedSkipped: merged.skipped,
            backfillIds: missingIds.length,
        },
    };
    writeJsonFile(outputPath, payload);
    console.log("merged %d new cities (%d total)", merged.added, payload.count);
    return { added: merged.added, skipped: merged.skipped, count: payload.count };
};

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
 * @param {Array<Record<string, unknown>>} cities
 */
export const sortEuropeanCities = (cities) =>
    [...cities].sort((a, b) => {
        const byCountry = String(a.country).localeCompare(String(b.country));
        if (byCountry !== 0) return byCountry;
        return String(a.name).localeCompare(String(b.name));
    });

/**
 * @param {string} outputPath
 * @returns {Array<Record<string, unknown>>}
 */
export const loadExistingEuropeanCities = (outputPath) => {
    const abs = resolveExistingPath(outputPath);
    if (!abs) return [];
    const data = /** @type {{ cities?: Array<Record<string, unknown>> }} */ (readJsonFile(abs));
    return Array.isArray(data?.cities) ? data.cities : [];
};

/**
 * Keeps existing rows unchanged; adds fetched rows only for new wikidata ids.
 *
 * @param {Array<Record<string, unknown>>} existing
 * @param {Array<Record<string, unknown>>} fetched
 */
export const mergeEuropeanCityRows = (existing, fetched) => {
    /** @type {Map<string, Record<string, unknown>>} */
    const byId = new Map();
    for (const row of existing) {
        const id = String(row.wikidataId ?? "").trim();
        if (id) byId.set(id, row);
    }
    let added = 0;
    for (const row of fetched) {
        const id = String(row.wikidataId ?? "").trim();
        if (!id || byId.has(id)) continue;
        byId.set(id, row);
        added++;
    }
    return {
        cities: sortEuropeanCities([...byId.values()]),
        added,
        skipped: fetched.length - added,
        previousCount: existing.length,
    };
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
    const cities = sortEuropeanCities([...byId.values()]);
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
        input: "",
        fresh: false,
        minPopulation: DEFAULT_MIN_POPULATION,
        delayMs: 1500,
        sparqlRetries: 4,
        countries: /** @type {string[]} */ ([]),
        backfillIds: /** @type {string[]} */ ([]),
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--output") opts.output = String(argv[++i] ?? opts.output);
        else if (arg === "--input") opts.input = String(argv[++i] ?? "");
        else if (arg === "--fresh") opts.fresh = true;
        else if (arg === "--min-population") {
            opts.minPopulation = Number(argv[++i] ?? opts.minPopulation);
        } else if (arg === "--delay-ms") opts.delayMs = Number(argv[++i] ?? opts.delayMs);
        else if (arg === "--sparql-retries") {
            opts.sparqlRetries = Number(argv[++i] ?? opts.sparqlRetries);
        } else if (arg === "--country") opts.countries.push(String(argv[++i] ?? "").trim());
        else if (arg === "--backfill-id") {
            opts.backfillIds.push(String(argv[++i] ?? "").trim().replace(/^wd:/, ""));
        }
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

    const mergeInputPath = opts.fresh ? "" : opts.input || opts.output;
    const existingCities = mergeInputPath ? loadExistingEuropeanCities(mergeInputPath) : [];
    const existingIds = new Set(
        existingCities.map((city) => String(city.wikidataId ?? "").trim()).filter(Boolean),
    );

    if (existingCities.length > 0) {
        console.log(
            "merging with %d existing cities from %s",
            existingCities.length,
            mergeInputPath,
        );
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
            const newRows = rows.filter((row) => !existingIds.has(String(row.wikidataId ?? "").trim()));
            console.log(
                "  -> %d cities (%d new, %d already in file)",
                rows.length,
                newRows.length,
                rows.length - newRows.length,
            );
            allRows.push(...newRows);
        } catch (error) {
            const message = error?.message || String(error);
            failures.push({ country: country.name, error: message });
            console.error("  -> FAILED: %s", message);
        }
        if (index < selectedCountries.length - 1 && opts.delayMs > 0) {
            await sleep(opts.delayMs);
        }
    }

    const merged = mergeEuropeanCityRows(existingCities, allRows);
    const payload = {
        generatedAt: new Date().toISOString(),
        source: "wikidata-sparql",
        minPopulation: opts.minPopulation,
        countryCount: selectedCountries.length,
        count: merged.cities.length,
        cities: merged.cities,
        merge: {
            previousCount: merged.previousCount,
            fetchedNew: merged.added,
            fetchedSkipped: merged.skipped,
        },
        failures,
    };

    const abs = writeJsonFile(opts.output, payload);
    console.log(
        "wrote %d cities to %s (+%d new, failures=%d)",
        payload.count,
        abs,
        merged.added,
        failures.length,
    );
    return { abs, payload, failures };
}

const isMain =
    process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
    const opts = parseArgs(process.argv.slice(2));
    try {
        if (opts.backfillIds.length > 0) {
            const result = await mergeEuropeanCitiesByWikidataIds(opts.output, opts.backfillIds, {
                sparqlRetries: opts.sparqlRetries,
            });
            if (result.count === 0) {
                console.error("No cities were merged.");
                process.exitCode = 1;
            }
            process.exit();
        }

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
