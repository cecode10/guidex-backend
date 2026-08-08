import { FieldValue } from "firebase-admin/firestore";
import {
    logExternalApiRequestUrl,
    logExternalApiResponseUrl,
} from "./external-api-debug.mjs";

export const COLLECTION = "geo-location";
export const POPULAR_AROUND_SUBCOLLECTION = "popularAroundList";
export const MAX_NEARBY_RESULTS = 30;

/** How a geo-location parent doc was first populated. */
export const GEO_LOCATION_CACHE_SOURCE = {
    /** Pre-populated by a historical batch seed (legacy cache docs). */
    BATCH_SEED: "batch_seed",
    /** Created on cache miss via Cloud Functions (user Explore search / near-me). */
    USER: "user",
};

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export const isValidGeoLocationCacheSource = (value) =>
    value === GEO_LOCATION_CACHE_SOURCE.BATCH_SEED ||
    value === GEO_LOCATION_CACHE_SOURCE.USER;

/**
 * Preserves the original cache provenance once set (including legacy docs without it).
 *
 * @param {Record<string, unknown> | undefined | null} existingData
 * @param {string | undefined} requestedSource
 * @returns {string | null}
 */
export const geoLocationCacheSourceForWrite = (existingData, requestedSource) => {
    const existing = existingData?.cacheSource;
    if (isValidGeoLocationCacheSource(existing)) {
        return existing;
    }
    if (isValidGeoLocationCacheSource(requestedSource)) {
        return requestedSource;
    }
    return null;
};

/** Decimal places for `geo-location/{lat}_{lng}_r*` cache doc ids (~111 m). */
export const GEO_LOCATION_COORD_DECIMALS = 3;

/**
 * Stable Firestore doc id from rounded coordinates.
 * Example: (41.9030632, 12.466276) -> "41.903_12.466"
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
 * Stable Firestore doc id for Explore popular places at a radius.
 * Near-me and global search share the same key when radius matches (e.g. r3).
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @param {number} [decimals]
 * @returns {string}
 */
export const geoLocationPopularKeyFromCoords = (
    lat,
    lng,
    radiusKm,
    decimals = GEO_LOCATION_COORD_DECIMALS,
) => {
    const base = geoLocationKeyFromCoords(lat, lng, decimals);
    const radius = Number(radiusKm);
    if (!base || !Number.isFinite(radius) || radius <= 0) return "";
    return `${base}_r${radius}`;
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
    "User-Agent": "rambleX-mobile (https://ramblex.app)",
    Accept: "application/json",
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
