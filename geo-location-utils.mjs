import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
    logExternalApiRequestUrl,
    logExternalApiResponseUrl,
} from "./external-api-debug.mjs";

export const COLLECTION = "geo-location";
export const POPULAR_AROUND_SUBCOLLECTION = "popularAroundList";
export const MAX_NEARBY_RESULTS = 30;
export const DEFAULT_RADIUS_KM = 10;
/** Max distance to treat a nearby row as the searched POI when promoting it. */
export const SEARCH_ANCHOR_MATCH_RADIUS_METERS = 250;
/** Decimal places for `geo-location/{lat}_{lng}` cache doc ids (~11 m). */
export const GEO_LOCATION_COORD_DECIMALS = 4;

/**
 * Stable Firestore doc id from rounded coordinates.
 * Example: (41.9030632, 12.466276) -> "41.9031_12.4663"
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} [decimals]
 * @returns {string}
 */
export const geoLocationKeyFromCoords = (
    lat,
    lng,
    decimals = GEO_LOCATION_COORD_DECIMALS,
) => {
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "";
    return `${latitude.toFixed(decimals)}_${longitude.toFixed(decimals)}`;
};

/**
 * Turns a free-form label into snake_case (legacy helper).
 *
 * @param {string} label
 * @returns {string}
 */
export const geoLocationKeyFromLabel = (label) => {
    const snake = String(label || "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");
    if (snake) return snake;
    const trimmed = String(label || "").trim().toLowerCase();
    if (!trimmed) return "";
    const digest = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 40);
    return `h:${digest}`;
};

/**
 * Builds a stable locality label from a Google reverse-geocode result.
 *
 * @param {Record<string, unknown> | undefined | null} result
 * @returns {string}
 */
export const deriveGeoLocationLabel = (result) => {
    if (!result) return "";

    const components = Array.isArray(result.address_components)
        ? result.address_components
        : [];

    /** @param {string[]} types */
    const findComponent = (...types) => {
        for (const component of components) {
            const componentTypes = Array.isArray(component?.types) ? component.types : [];
            if (types.some((type) => componentTypes.includes(type))) {
                return String(component?.long_name || component?.short_name || "").trim();
            }
        }
        return "";
    };

    const locality = findComponent(
        "locality",
        "postal_town",
        "administrative_area_level_2",
        "administrative_area_level_1",
    );
    const country = findComponent("country");
    if (locality && country) {
        return `${locality}, ${country}`;
    }

    const formatted =
        typeof result.formatted_address === "string" ? result.formatted_address.trim() : "";
    if (formatted) {
        const parts = formatted
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        if (parts.length >= 2) {
            return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
        }
        return formatted;
    }

    return "";
};

/**
 * @param {Record<string, unknown> | undefined | null} result
 * @returns {string | null}
 */
export const countryCodeFromGeocodeResult = (result) => {
    const components = Array.isArray(result?.address_components)
        ? result.address_components
        : [];
    for (const component of components) {
        const types = Array.isArray(component?.types) ? component.types : [];
        if (types.includes("country")) {
            const code = String(component?.short_name || component?.long_name || "")
                .trim()
                .toUpperCase();
            return code || null;
        }
    }
    return null;
};

/**
 * @param {string} name
 * @returns {string}
 */
export const normalizePlaceNameForMatch = (name) =>
    String(name || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export const placeNamesLikelyMatch = (a, b) => {
    const left = normalizePlaceNameForMatch(a);
    const right = normalizePlaceNameForMatch(b);
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.includes(right) || right.includes(left)) return true;

    const leftTokens = left.split(" ").filter((token) => token.length > 2);
    const rightTokens = new Set(right.split(" ").filter((token) => token.length > 2));
    if (leftTokens.length === 0 || rightTokens.size === 0) return false;

    let overlap = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) overlap++;
    }
    return overlap >= Math.min(leftTokens.length, rightTokens.size) && overlap >= 1;
};

/**
 * @param {Array<Record<string, unknown>>} places
 * @returns {Array<Record<string, unknown>>}
 */
export const reindexPopularPlaces = (places) =>
    places.map((place, index) => ({ ...place, order: index }));

/**
 * @param {string} query
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ qid: string, label: string } | null>}
 */
export const resolveWikidataEntityForSearchQuery = async (query, fetchImpl = fetch) => {
    const trimmed = String(query || "").trim();
    if (trimmed.length < 2) return null;

    const url =
        "https://www.wikidata.org/w/api.php?action=wbsearchentities" +
        `&search=${encodeURIComponent(trimmed)}` +
        "&language=en&format=json&origin=*";
    logExternalApiRequestUrl(url, { extra: `wbsearchentities query="${trimmed}"` });
    const response = await fetchImpl(url, { headers: WIKI_HEADERS });
    logExternalApiResponseUrl(url, response.status, {
        extra: `wbsearchentities query="${trimmed}"`,
    });
    if (!response.ok) return null;

    const body = /** @type {{ search?: Array<Record<string, unknown>> }} */ (
        await response.json()
    );
    const hit = body.search?.[0];
    const qid = String(hit?.id ?? "").trim();
    if (!/^Q\d+$/.test(qid)) return null;
    const label = String(hit?.label ?? "").trim();
    const details = await resolveWikidataEntityImageHints(qid, fetchImpl);
    return { qid, label: label || trimmed, ...details };
};

/**
 * @param {string} wikidataId
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ wikipediaUrl: string | null, image: string | null }>}
 */
export const resolveWikidataEntityImageHints = async (wikidataId, fetchImpl = fetch) => {
    const qid = String(wikidataId || "").trim();
    if (!/^Q\d+$/.test(qid)) return { wikipediaUrl: null, image: null };

    const url =
        `https://www.wikidata.org/w/api.php?action=wbgetentities` +
        `&props=sitelinks|claims&ids=${encodeURIComponent(qid)}` +
        `&sitefilter=enwiki&format=json&origin=*`;
    logExternalApiRequestUrl(url, {
        extra: `entity image hints wikidataId=${qid}`,
    });
    const response = await fetchImpl(url, { headers: WIKI_HEADERS });
    logExternalApiResponseUrl(url, response.status, {
        extra: `entity image hints wikidataId=${qid}`,
    });
    if (!response.ok) return { wikipediaUrl: null, image: null };

    const body = await response.json();
    const entity = body?.entities?.[qid];
    const title = String(entity?.sitelinks?.enwiki?.title ?? "").trim();
    const imageFile = String(
        entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value ?? "",
    ).trim();

    return {
        wikipediaUrl: title
            ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`
            : null,
        image: imageFile
            ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}`
            : null,
    };
};

/**
 * @param {Array<Record<string, unknown>>} places
 * @param {{
 *   searchQuery: string,
 *   anchorLat: number,
 *   anchorLng: number,
 *   anchorWikidataId?: string | null,
 * }} context
 * @returns {number}
 */
export const findSearchAnchorPlaceIndex = (
    places,
    { searchQuery, anchorLat, anchorLng, anchorWikidataId },
) => {
    for (let index = 0; index < places.length; index++) {
        const place = places[index];
        const qid = String(place?.wikidataId ?? "").trim();
        if (anchorWikidataId && qid === anchorWikidataId) return index;

        const placeLat = typeof place?.lat === "number" ? place.lat : Number.NaN;
        const placeLng = typeof place?.lng === "number" ? place.lng : Number.NaN;
        if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng)) continue;
        if (!placeNamesLikelyMatch(String(place?.name ?? ""), searchQuery)) continue;

        const distanceM = haversineDistanceMeters(anchorLat, anchorLng, placeLat, placeLng);
        if (distanceM <= SEARCH_ANCHOR_MATCH_RADIUS_METERS) return index;
    }
    return -1;
};

/**
 * Ensures the user's searched POI appears first in Explore search results.
 * GeoNames nearby Wikipedia often omits the exact establishment at the anchor.
 *
 * @param {Array<Record<string, unknown>>} places
 * @param {{
 *   searchQuery: string,
 *   lat: number,
 *   lng: number,
 *   city?: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 * }} context
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const ensureSearchAnchorInPopularPlaces = async (
    places,
    { searchQuery, lat, lng, city, countryCode, countryFlag },
    fetchImpl = fetch,
) => {
    const query = String(searchQuery || "").trim();
    if (!query || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reindexPopularPlaces(places);
    }

    let anchorWikidataId = null;
    let anchorImage = null;
    let anchorWikipediaUrl = null;
    try {
        const entity = await resolveWikidataEntityForSearchQuery(query, fetchImpl);
        anchorWikidataId = entity?.qid ?? null;
        anchorImage = entity?.image ?? null;
        anchorWikipediaUrl = entity?.wikipediaUrl ?? null;
    } catch {
        anchorWikidataId = null;
        anchorImage = null;
        anchorWikipediaUrl = null;
    }

    if (!anchorWikidataId) {
        const [enriched] = await enrichPlacesWithWikidataIds([{ name: query }], fetchImpl);
        anchorWikidataId = enriched?.wikidataId ?? null;
    }

    const cc = countryCode ?? null;
    const flag = countryFlag ?? flagFromIsoCode(cc ?? "");
    let updated = places.map((place) => ({ ...place }));

    const matchIdx = findSearchAnchorPlaceIndex(updated, {
        searchQuery: query,
        anchorLat: lat,
        anchorLng: lng,
        anchorWikidataId,
    });

    /** @type {Record<string, unknown>} */
    let anchorPlace;
    if (matchIdx >= 0) {
        const matched = updated[matchIdx];
        updated.splice(matchIdx, 1);
        anchorPlace = {
            ...matched,
            name: query,
            distance: 0,
            lat,
            lng,
            wikidataId: anchorWikidataId ?? matched.wikidataId ?? null,
            sitelinks:
                typeof matched.sitelinks === "number" && matched.sitelinks > 0
                    ? matched.sitelinks
                    : 9999,
        };
    } else {
        anchorPlace = {
            name: query,
            type: "LANDMARK",
            distance: 0,
            city: city ?? "",
            countryCode: cc,
            countryFlag: flag,
            image: anchorImage,
            wikipediaUrl: anchorWikipediaUrl ?? wikipediaUrlFromGeoNamesRow({}, query),
            wikidataId: anchorWikidataId,
            storageUrl: null,
            imageStatus: null,
            isSearchAnchor: true,
            lat,
            lng,
            sitelinks: 9999,
        };
        if (!anchorPlace.wikidataId) {
            const [enriched] = await enrichPlacesWithWikidataIds([anchorPlace], fetchImpl);
            anchorPlace = enriched ?? anchorPlace;
        }
    }

    updated.unshift(anchorPlace);
    if (updated.length > MAX_NEARBY_RESULTS) {
        updated = updated.slice(0, MAX_NEARBY_RESULTS);
    }
    return reindexPopularPlaces(updated);
};

/**
 * @param {string} feature
 * @returns {string}
 */
export const classifyPopularPlaceType = (feature) => {
    const normalized = String(feature || "")
        .trim()
        .toLowerCase();
    if (!normalized) return "LANDMARK";
    if (
        normalized.includes("historic") ||
        normalized.includes("archaeolog") ||
        normalized.includes("ruin") ||
        normalized.includes("castle") ||
        normalized.includes("fort")
    ) {
        return "HISTORICAL";
    }
    return "LANDMARK";
};

/**
 * @param {string} iso
 * @returns {string}
 */
export const flagFromIsoCode = (iso) => {
    const code = String(iso || "").trim();
    if (code.length !== 2) return "📍";
    const upper = code.toUpperCase();
    const base = 0x1f1e6 - "A".charCodeAt(0);
    const cps = [upper.codePointAt(0) + base, upper.codePointAt(1) + base];
    if (cps.some((cp) => cp < 0x1f1e6 || cp > 0x1f1ff)) return "📍";
    return String.fromCodePoint(...cps);
};

const WIKI_HEADERS = {
    "User-Agent": "guideX-mobile (https://guidex.app)",
    Accept: "application/json",
};

/**
 * GeoNames documents the field as `thumbnailImg`; some payloads use `thumbnail`.
 *
 * @param {Record<string, unknown>} raw
 * @returns {string | null}
 */
export const thumbnailFromGeoNamesRow = (raw) => {
    const img = String(raw?.thumbnailImg ?? raw?.thumbnail ?? "").trim();
    return img || null;
};

/**
 * @param {Record<string, unknown>} raw
 * @param {string} title
 * @returns {string | null}
 */
export const wikipediaUrlFromGeoNamesRow = (raw, title) => {
    const url = String(raw?.wikipediaUrl ?? "").trim();
    if (url) {
        if (/^https?:\/\//i.test(url)) return url;
        return `https://${url.replace(/^\/\//, "")}`;
    }
    if (title) {
        return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    }
    return null;
};

/**
 * Resolves English Wikipedia titles to Wikidata QIDs via `pageprops`.
 *
 * @param {string[]} titles
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Map<string, string>>}
 */
export const resolveWikidataIdsForTitles = async (titles, fetchImpl = fetch) => {
    const unique = [...new Set(titles.map((title) => String(title || "").trim()).filter(Boolean))];
    const qidByTitleLower = new Map();
    if (unique.length === 0) return qidByTitleLower;

    const chunkSize = 50;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
        const chunk = unique.slice(offset, offset + chunkSize);
        const url =
            "https://en.wikipedia.org/w/api.php?action=query" +
            "&prop=pageprops&ppprop=wikibase_item&format=json&origin=*" +
            `&titles=${encodeURIComponent(chunk.join("|"))}`;
        logExternalApiRequestUrl(url, {
            extra: `pageprops titles=${chunk.length} offset=${offset}`,
        });
        const response = await fetchImpl(url, { headers: WIKI_HEADERS });
        logExternalApiResponseUrl(url, response.status, {
            extra: `pageprops titles=${chunk.length}`,
        });
        if (!response.ok) continue;
        const body = /** @type {{ query?: { pages?: Record<string, Record<string, unknown>> } }} */ (
            await response.json()
        );
        const pages = body?.query?.pages ?? {};
        for (const page of Object.values(pages)) {
            const pageTitle = String(page?.title ?? "").trim();
            const qid = String(
                /** @type {{ wikibase_item?: string }} */ (page?.pageprops ?? {}).wikibase_item ?? "",
            ).trim();
            if (pageTitle && /^Q\d+$/.test(qid)) {
                qidByTitleLower.set(pageTitle.toLowerCase(), qid);
            }
        }
    }

    return qidByTitleLower;
};

/**
 * @param {unknown} raw
 * @returns {number | null} distance in kilometres when present
 */
export const distanceKmFromGeoNamesRow = (raw) => {
    const value = raw?.distance;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
};

/**
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} great-circle distance in metres
 */
export const haversineDistanceMeters = (lat1, lng1, lat2, lng2) => {
    const earthRadiusM = 6_371_000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

/**
 * @param {number | string | unknown} value
 * @param {number} fallback
 * @returns {number}
 */
const coordinateFromRow = (value, fallback) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
};

/**
 * @param {Array<Record<string, unknown>>} places
 * @returns {string | null}
 */
export const mostPopularAroundFromPlaces = (places) => {
    const name = String(places?.[0]?.name ?? "").trim();
    return name || null;
};

/**
 * Adds `wikidataId` to mapped places when the English Wikipedia article exists.
 *
 * @param {Array<Record<string, unknown>>} places
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const enrichPlacesWithWikidataIds = async (places, fetchImpl = fetch) => {
    try {
        const qidByTitleLower = await resolveWikidataIdsForTitles(
            places.map((place) => String(place.name ?? "")),
            fetchImpl,
        );
        return places.map((place) => {
            const name = String(place.name ?? "");
            const qid = qidByTitleLower.get(name.toLowerCase());
            return qid ? { ...place, wikidataId: qid } : place;
        });
    } catch {
        return places;
    }
};

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {{ lat: number, lng: number, city: string, limit?: number }} context
 * @returns {Array<Record<string, unknown>>}
 */
export const mapGeoNamesRowsToPlaces = (
    rows,
    { lat, lng, city, limit = MAX_NEARBY_RESULTS },
) => {
    const seen = new Set();
    const out = [];

    for (const raw of rows) {
        if (out.length >= limit) break;
        const name = String(raw?.title || "").trim();
        if (!name || seen.has(name.toLowerCase())) continue;

        const placeLat = coordinateFromRow(raw?.lat, lat);
        const placeLng = coordinateFromRow(raw?.lng, lng);
        const countryCode = String(raw?.countryCode || "").trim().toUpperCase();
        const distanceKmFromApi = distanceKmFromGeoNamesRow(raw);
        const distanceKm =
            distanceKmFromApi != null && distanceKmFromApi > 0
                ? distanceKmFromApi
                : haversineDistanceMeters(lat, lng, placeLat, placeLng) / 1000;
        const rank = typeof raw?.rank === "number" ? raw.rank : 0;
        const feature = String(raw?.feature || "");

        seen.add(name.toLowerCase());
        out.push({
            name,
            type: classifyPopularPlaceType(feature),
            distance: Math.round(distanceKm * 1000),
            city,
            countryCode: countryCode || null,
            countryFlag: flagFromIsoCode(countryCode),
            image: thumbnailFromGeoNamesRow(raw),
            wikipediaUrl: wikipediaUrlFromGeoNamesRow(raw, name),
            lat: placeLat,
            lng: placeLng,
            sitelinks: rank,
        });
    }

    return out;
};

/**
 * @param {Record<string, unknown>} place
 * @param {number} index
 * @returns {Record<string, unknown>}
 */
export const popularPlaceDocFromPlace = (place, index) => ({
    order: index,
    name: place.name,
    type: place.type,
    distance: place.distance,
    city: place.city,
    countryCode: place.countryCode ?? null,
    countryFlag: place.countryFlag,
    image: place.image ?? null,
    wikipediaUrl: place.wikipediaUrl ?? null,
    wikidataId: place.wikidataId ?? null,
    storageUrl: place.storageUrl ?? null,
    imageStatus: place.imageStatus ?? null,
    isSearchAnchor: place.isSearchAnchor === true,
    lat: place.lat,
    lng: place.lng,
    sitelinks: place.sitelinks ?? 0,
});

/**
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
export const popularPlaceFromDoc = (data) => ({
    order: typeof data.order === "number" ? data.order : null,
    name: String(data.name ?? ""),
    type: String(data.type ?? "LANDMARK"),
    distance: typeof data.distance === "number" ? data.distance : 0,
    city: String(data.city ?? ""),
    countryCode: typeof data.countryCode === "string" ? data.countryCode : null,
    countryFlag: String(data.countryFlag ?? "📍"),
    image:
        typeof data.storageUrl === "string" && data.storageUrl
            ? data.storageUrl
            : typeof data.image === "string"
              ? data.image
              : null,
    storageUrl: typeof data.storageUrl === "string" ? data.storageUrl : null,
    wikipediaUrl: typeof data.wikipediaUrl === "string" ? data.wikipediaUrl : null,
    wikidataId: typeof data.wikidataId === "string" ? data.wikidataId : null,
    imageStatus: typeof data.imageStatus === "string" ? data.imageStatus : null,
    isSearchAnchor: data.isSearchAnchor === true,
    lat: typeof data.lat === "number" ? data.lat : 0,
    lng: typeof data.lng === "number" ? data.lng : 0,
    sitelinks: typeof data.sitelinks === "number" ? data.sitelinks : 0,
});

/**
 * Persists lazy image resolution results back into `popularAroundList`.
 *
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{
 *   geoLocationKey?: string,
 *   popularPlaceOrder?: number,
 *   wikidataId?: string | null,
 *   storageUrl?: string | null,
 *   imageStatus: "ready" | "notFound",
 * }} patch
 */
/** @param {unknown} wikidataId */
export const isValidWikidataId = (wikidataId) =>
    /^Q\d+$/.test(String(wikidataId ?? "").trim());

/**
 * @param {Record<string, unknown>} place
 * @returns {boolean}
 */
export const isPopularPlaceImageCached = (place) => {
    if (place.imageStatus === "ready") return true;
    if (typeof place.storageUrl === "string" && place.storageUrl.trim()) return true;
    return false;
};

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{
 *   geoLocationKey?: string,
 *   popularPlaceOrder?: number,
 *   wikidataId: string,
 * }} patch
 */
export const patchPopularPlaceWikidataId = async (
    db,
    { geoLocationKey, popularPlaceOrder, wikidataId },
) => {
    const key = String(geoLocationKey || "").trim();
    const order = Number(popularPlaceOrder);
    const qid = String(wikidataId || "").trim();
    if (!key || !Number.isInteger(order) || order < 0 || !isValidWikidataId(qid)) return;

    await db
        .collection(COLLECTION)
        .doc(key)
        .collection(POPULAR_AROUND_SUBCOLLECTION)
        .doc(String(order).padStart(3, "0"))
        .set(
            {
                wikidataId: qid,
                updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
        );
};

export const patchPopularPlaceImage = async (
    db,
    { geoLocationKey, popularPlaceOrder, wikidataId, storageUrl, imageStatus },
) => {
    const key = String(geoLocationKey || "").trim();
    const order = Number(popularPlaceOrder);
    if (!key || !Number.isInteger(order) || order < 0) return;

    /** @type {Record<string, unknown>} */
    const payload = {
        imageStatus,
        updatedAt: FieldValue.serverTimestamp(),
    };
    if (wikidataId) payload.wikidataId = wikidataId;
    if (storageUrl) {
        payload.storageUrl = storageUrl;
        payload.image = storageUrl;
    }

    await db
        .collection(COLLECTION)
        .doc(key)
        .collection(POPULAR_AROUND_SUBCOLLECTION)
        .doc(String(order).padStart(3, "0"))
        .set(payload, { merge: true });
};
