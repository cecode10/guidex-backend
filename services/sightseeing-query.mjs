import { flagFromIsoCode, MAX_NEARBY_RESULTS } from "../utils/geo-location-utils.mjs";
import { NEARBY_RADIUS_KM } from "../utils/places-lookup-utils.mjs";
import { sightseeingQuery } from "./sightseeing-db.mjs";

/** @typedef {"sitelinks" | "distance"} SightseeingOrderBy */

/**
 * @param {Record<string, unknown>} row
 * @param {{
 *   city?: string,
 *   country?: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 *   order?: number,
 * }} [context]
 * @returns {Record<string, unknown>}
 */
export const mapSightseeingRowToPlace = (row, context = {}) => {
    const countryCodeRaw = row.country_code ?? context.countryCode ?? null;
    const countryCode =
        countryCodeRaw != null && String(countryCodeRaw).trim()
            ? String(countryCodeRaw).trim().toUpperCase().slice(0, 2)
            : null;
    const distanceMeters = Math.round(Number(row.distance_m) || 0);
    const imageUrl =
        typeof row.image_url === "string" && row.image_url.trim()
            ? row.image_url.trim()
            : null;
    const wikipediaUrl =
        typeof row.wikipedia_url === "string" && row.wikipedia_url.trim()
            ? row.wikipedia_url.trim()
            : null;

    const rowCity = row.city != null ? String(row.city).trim() : "";
    const rowCountry = row.country != null ? String(row.country).trim() : "";
    const contextCity = context.city != null ? String(context.city).trim() : "";
    const contextCountry =
        context.country != null ? String(context.country).trim() : "";

    const categoryLabel =
        row.category_label != null && String(row.category_label).trim()
            ? String(row.category_label).trim()
            : null;

    return {
        name: String(row.name ?? ""),
        type: String(row.type ?? "Point of Interest"),
        categoryLabel,
        distance: distanceMeters,
        city: contextCity || rowCity || "Nearby",
        country: contextCountry || rowCountry,
        countryCode,
        countryFlag:
            countryCode != null
                ? flagFromIsoCode(countryCode)
                : (context.countryFlag ?? "📍"),
        image: imageUrl,
        wikipediaUrl,
        wikidataId: row.wikidata_id != null ? String(row.wikidata_id) : null,
        lat: Number(row.lat),
        lng: Number(row.lng),
        sitelinks: Number.parseInt(String(row.sitelinks ?? 0), 10) || 0,
        ...(Number.isInteger(context.order) ? { order: context.order } : {}),
    };
};

/**
 * Radius query against the Europe sightseeing table.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {{
 *   radiusKm?: number,
 *   limit?: number,
 *   offset?: number,
 *   orderBy?: SightseeingOrderBy,
 *   city?: string,
 *   country?: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 * }} [options]
 * @returns {Promise<{ places: Array<Record<string, unknown>>, hasMore: boolean }>}
 */
export const findNearbySightseeing = async (
    lat,
    lng,
    {
        radiusKm = NEARBY_RADIUS_KM,
        limit = MAX_NEARBY_RESULTS,
        offset = 0,
        orderBy = "sitelinks",
        city,
        country = "",
        countryCode = null,
        countryFlag,
    } = {},
) => {
    const radiusM = Math.max(Number(radiusKm) || NEARBY_RADIUS_KM, 0.1) * 1000;
    const safeLimit = Math.max(1, Math.min(Number(limit) || MAX_NEARBY_RESULTS, 100));
    const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
    const orderClause =
        orderBy === "distance"
            ? "distance_m ASC, sitelinks DESC"
            : "sitelinks DESC, distance_m ASC";

    // Fetch one extra row to detect hasMore without a separate COUNT.
    const fetchLimit = safeLimit + 1;

    const result = await sightseeingQuery(
        `
SELECT
  wikidata_id,
  name,
  type,
  category_label,
  country_code,
  country,
  city,
  sitelinks,
  image_url,
  wikipedia_url,
  lat,
  lng,
  ST_Distance(
    location,
    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
  ) AS distance_m
FROM sightseeing
WHERE ST_DWithin(
  location,
  ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
  $3
)
ORDER BY ${orderClause}
LIMIT $4 OFFSET $5
`.trim(),
        [lng, lat, radiusM, fetchLimit, safeOffset],
    );

    const rows = result.rows ?? [];
    const hasMore = rows.length > safeLimit;
    const sliced = hasMore ? rows.slice(0, safeLimit) : rows;
    const flag = countryFlag ?? flagFromIsoCode(countryCode ?? "");

    const places = sliced.map((row, index) =>
        mapSightseeingRowToPlace(row, {
            city,
            country,
            countryCode,
            countryFlag: flag,
            order: safeOffset + index,
        }),
    );

    return { places, hasMore };
};

/**
 * Explore popular places from PostGIS (replaces Firestore + Wikidata SPARQL).
 *
 * @param {{
 *   functionName: string,
 *   key: string,
 *   lat: number,
 *   lng: number,
 *   radiusKm: number,
 *   label: string,
 *   city: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 *   resolvedLat: number,
 *   resolvedLng: number,
 * }} options
 * @returns {Promise<{
 *   key: string,
 *   label: string,
 *   lat: number,
 *   lon: number,
 *   places: Array<Record<string, unknown>>,
 *   radiusKm: number,
 *   cached: boolean,
 * }>}
 */
export const resolveExplorePopularPlacesFromDb = async ({
    functionName,
    key,
    lat,
    lng,
    radiusKm,
    label,
    city,
    countryCode = null,
    countryFlag,
    resolvedLat,
    resolvedLng,
}) => {
    const flag = countryFlag ?? flagFromIsoCode(countryCode ?? "");
    const { places } = await findNearbySightseeing(lat, lng, {
        radiusKm,
        limit: MAX_NEARBY_RESULTS,
        offset: 0,
        orderBy: "sitelinks",
        city,
        countryCode,
        countryFlag: flag,
    });

    console.log(
        `[${functionName}] postgis ${key} lat=${lat} lng=${lng} ` +
            `radiusKm=${radiusKm} places=${places.length}`,
    );

    return {
        key,
        label,
        lat: resolvedLat,
        lon: resolvedLng,
        places,
        radiusKm,
        cached: false,
    };
};
