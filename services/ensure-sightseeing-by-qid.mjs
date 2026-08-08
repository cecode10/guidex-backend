/**
 * Hidden Explore admin path: ensure a single Wikidata QID exists in sightseeing.
 * Fetches a Wikidata entity and upserts it into the sightseeing table.
 */
import {
    classifyPlaceTypeFromCategory,
    parseWktPoint,
    readSparqlBinding,
    runWikidataSparql,
    wikidataIdFromItemUri,
    WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS,
} from "./places-lookup-utils.mjs";
import { sightseeingQuery } from "./sightseeing-db.mjs";

/** Upper/lowercase q + at least two digits; trailing junk is ignored (Explore hidden path). */
export const HIDDEN_QID_RE = /^[Qq](\d{2,})/;

/** Strict Wikidata QID (admin / seed scripts). */
export const WIKIDATA_QID_RE = /^Q(\d+)$/i;

/**
 * @param {string} input
 * @returns {string | null} Normalized QID (e.g. "Q243") or null
 */
export const parseHiddenQid = (input) => {
    const match = HIDDEN_QID_RE.exec(String(input ?? "").trim());
    if (!match) return null;
    return `Q${match[1]}`;
};

/**
 * Normalize a Wikidata QID for admin scripts (`Q243`, `q243`, `wd:Q243`).
 *
 * @param {string} input
 * @returns {string | null}
 */
export const parseWikidataQid = (input) => {
    const trimmed = String(input ?? "").trim().replace(/^wd:/i, "");
    const match = WIKIDATA_QID_RE.exec(trimmed);
    if (!match) return null;
    return `Q${match[1]}`;
};

/**
 * @param {string} qid
 * @returns {string}
 */
export const buildSightseeingByQidSparql = (qid) => {
    const safe = String(qid).replace(/^wd:/, "");
    if (!/^Q\d+$/.test(safe)) {
        throw new Error(`Invalid Wikidata QID: ${qid}`);
    }
    return `
SELECT DISTINCT ?item ?itemLabel ?image ?location ?categoryLabel ?sitelinks ?countryLabel ?countryCode WHERE {
  BIND(wd:${safe} AS ?item)
  ?item wdt:P625 ?location .
  OPTIONAL {
    ?item p:P31 ?p31Statement .
    ?p31Statement ps:P31 ?category .
  }
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    ?country wdt:P297 ?countryCode .
  }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 5
`.trim();
};

/**
 * @param {Record<string, unknown>} binding
 * @returns {Record<string, unknown> | null}
 */
export const bindingToSightseeingRowForQid = (binding) => {
    const itemUri = readSparqlBinding(binding, "item") ?? "";
    const wikidataId = wikidataIdFromItemUri(itemUri);
    const name = readSparqlBinding(binding, "itemLabel") ?? "";
    if (!wikidataId || !name || /^Q\d+$/.test(name) || name === "Unknown Place") {
        return null;
    }

    const coords = parseWktPoint(readSparqlBinding(binding, "location") ?? "");
    if (!coords) return null;

    const categoryLabel = readSparqlBinding(binding, "categoryLabel") ?? "Point of Interest";
    const countryCode = (readSparqlBinding(binding, "countryCode") ?? "")
        .toUpperCase()
        .slice(0, 2);
    const country = readSparqlBinding(binding, "countryLabel") ?? "";
    const sitelinks = Number.parseInt(readSparqlBinding(binding, "sitelinks") ?? "0", 10) || 0;
    const image = readSparqlBinding(binding, "image");

    return {
        wikidata_id: wikidataId,
        name,
        type: classifyPlaceTypeFromCategory(categoryLabel),
        category_label: categoryLabel,
        country_code: countryCode || null,
        country: country || null,
        city: null,
        sitelinks,
        image_url: image || null,
        wikipedia_url: null,
        lat: coords.lat,
        lng: coords.lng,
    };
};

/**
 * @param {string} qid
 * @returns {Promise<boolean>}
 */
export const sightseeingExistsByQid = async (qid) => {
    const result = await sightseeingQuery(
        `SELECT 1 FROM sightseeing WHERE wikidata_id = $1 LIMIT 1`,
        [qid],
    );
    return (result.rows?.length ?? 0) > 0;
};

/**
 * @param {Record<string, unknown>} row
 * @returns {Promise<void>}
 */
export const upsertSightseeingRow = async (row) => {
    await sightseeingQuery(
        `
INSERT INTO sightseeing (
  wikidata_id, name, type, category_label, country_code, country, city,
  sitelinks, image_url, wikipedia_url, lat, lng, location, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11, $12,
  ST_SetSRID(ST_MakePoint($12, $11), 4326)::geography,
  now()
)
ON CONFLICT (wikidata_id) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  category_label = EXCLUDED.category_label,
  country_code = EXCLUDED.country_code,
  country = EXCLUDED.country,
  city = EXCLUDED.city,
  sitelinks = EXCLUDED.sitelinks,
  image_url = EXCLUDED.image_url,
  wikipedia_url = EXCLUDED.wikipedia_url,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  location = EXCLUDED.location,
  updated_at = now()
`.trim(),
        [
            row.wikidata_id,
            row.name,
            row.type,
            row.category_label,
            row.country_code,
            row.country,
            row.city,
            row.sitelinks,
            row.image_url,
            row.wikipedia_url,
            row.lat,
            row.lng,
        ],
    );
};

/**
 * @param {string} qid
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Record<string, unknown>>}
 */
export const fetchSightseeingRowFromWikidata = async (qid, fetchImpl = fetch) => {
    const bindings = await runWikidataSparql(buildSightseeingByQidSparql(qid), fetchImpl, {
        extra: `ensure-sightseeing-by-qid ${qid}`,
        timeoutMs: WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS,
    });
    for (const binding of bindings) {
        const row = bindingToSightseeingRowForQid(binding);
        if (row) return row;
    }
    const err = new Error(
        `Wikidata entity ${qid} not found or missing coordinates/label`,
    );
    err.statusCode = 404;
    throw err;
};

/**
 * @param {string} rawInput
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   dryRun?: boolean,
 *   hiddenOnly?: boolean,
 * }} [options] `hiddenOnly` (default true) requires Explore pattern Q/q + ≥2 digits.
 * @returns {Promise<{
 *   status: "exists" | "added" | "would_add",
 *   wikidataId: string,
 *   name?: string,
 * }>}
 */
export const ensureSightseeingByQid = async (
    rawInput,
    { fetchImpl = fetch, dryRun = false, hiddenOnly = true } = {},
) => {
    const wikidataId = hiddenOnly
        ? parseHiddenQid(rawInput)
        : parseWikidataQid(rawInput) ?? parseHiddenQid(rawInput);
    if (!wikidataId) {
        const err = new Error(
            hiddenOnly
                ? 'wikidataId must start with "Q" or "q" followed by at least 2 digits'
                : "wikidataId must be a Wikidata QID (e.g. Q243)",
        );
        err.statusCode = 400;
        throw err;
    }

    if (await sightseeingExistsByQid(wikidataId)) {
        return { status: "exists", wikidataId };
    }

    const row = await fetchSightseeingRowFromWikidata(wikidataId, fetchImpl);
    if (dryRun) {
        return {
            status: "would_add",
            wikidataId,
            name: String(row.name ?? ""),
        };
    }
    await upsertSightseeingRow(row);
    return {
        status: "added",
        wikidataId,
        name: String(row.name ?? ""),
    };
};
