import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
    logExternalApiRequest,
    logExternalApiResponse,
    logExternalApiCacheHit,
} from "./external-api-debug.mjs";
import {
    COLLECTION,
    MAX_NEARBY_RESULTS,
    POPULAR_AROUND_SUBCOLLECTION,
    countryCodeFromGeocodeResult,
    deriveGeoLocationLabel,
    enrichPlacesWithWikidataIds,
    flagFromIsoCode,
    geoLocationPopularKeyFromCoords,
    isPopularPlaceImageCached,
    isValidWikidataId,
    mostPopularAroundFromPlaces,
    patchPopularPlaceImage,
    patchPopularPlaceWikidataId,
    geoLocationCacheSourceForWrite,
    popularPlaceDocFromPlace,
    popularPlaceFromDoc,
} from "./geo-location-utils.mjs";
import {
    NEARBY_RADIUS_KM,
    fetchWikidataNearbyPopularPlaces,
} from "./wikidata-nearby-utils.mjs";
import {
    TransientUpstreamError,
    ensurePlaceImageInFirestore,
    isWikimediaImageUrl,
} from "./handlers/resolve-place-image.mjs";

export const GOOGLE_GEOCODE_TIMEOUT_MS = 12_000;
export const GOOGLE_REVERSE_GEOCODE_TIMEOUT_MS = 12_000;

/**
 * @param {string} address
 * @param {string} language
 * @param {string} apiKey
 * @returns {Promise<{ status: string, results?: Array<Record<string, unknown>> }>}
 */
export const fetchGoogleGeocode = async (address, language, apiKey) => {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("language", language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_GEOCODE_TIMEOUT_MS);
    try {
        logExternalApiRequest(
            "google-geocoding",
            `forward-geocode query="${address}" language=${language}`,
        );
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            logExternalApiResponse(
                "google-geocoding",
                `HTTP ${response.status} forward-geocode query="${address}"`,
            );
            throw new Error(`Google Geocoding HTTP ${response.status}`);
        }
        const body = /** @type {{ status: string, results?: Array<Record<string, unknown>> }} */ (
            await response.json()
        );
        logExternalApiResponse(
            "google-geocoding",
            `status=${body.status} forward-geocode query="${address}"`,
        );
        return body;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {string} language
 * @param {string} apiKey
 * @returns {Promise<{ status: string, results?: Array<Record<string, unknown>> }>}
 */
export const fetchGoogleReverseGeocode = async (lat, lng, language, apiKey) => {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${lat},${lng}`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("language", language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_REVERSE_GEOCODE_TIMEOUT_MS);
    try {
        logExternalApiRequest(
            "google-geocoding",
            `reverse-geocode lat=${lat} lng=${lng} language=${language}`,
        );
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            logExternalApiResponse(
                "google-geocoding",
                `HTTP ${response.status} reverse-geocode lat=${lat} lng=${lng}`,
            );
            throw new Error(`Google reverse geocode HTTP ${response.status}`);
        }
        const body = /** @type {{ status: string, results?: Array<Record<string, unknown>> }} */ (
            await response.json()
        );
        logExternalApiResponse(
            "google-geocoding",
            `status=${body.status} reverse-geocode lat=${lat} lng=${lng}`,
        );
        return body;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} key
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const readPopularAroundList = async (db, key) => {
    const snap = await db
        .collection(COLLECTION)
        .doc(key)
        .collection(POPULAR_AROUND_SUBCOLLECTION)
        .orderBy("order")
        .get();

    return snap.docs.map((doc) => popularPlaceFromDoc(doc.data()));
};

/**
 * @param {import("firebase-admin/firestore").DocumentReference} docRef
 * @param {Array<Record<string, unknown>>} places
 * @param {import("firebase-admin/firestore").FieldValue} now
 */
export const writePopularAroundList = async (docRef, places, now) => {
    const subRef = docRef.collection(POPULAR_AROUND_SUBCOLLECTION);
    const existing = await subRef.get();
    const batch = docRef.firestore.batch();

    for (const doc of existing.docs) {
        batch.delete(doc.ref);
    }

    places.forEach((place, index) => {
        const id = String(index).padStart(3, "0");
        batch.set(subRef.doc(id), {
            ...popularPlaceDocFromPlace(place, index),
            updatedAt: now,
        });
    });

    await batch.commit();
};

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} geoLocationKey
 * @param {Array<Record<string, unknown>>} places
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const reconcileCachedPopularPlaces = async (
    db,
    geoLocationKey,
    places,
    fetchImpl = fetch,
) => {
    if (!places.length) return places;

    const missingQidOrders = new Set(
        places
            .filter((place) => !isValidWikidataId(place.wikidataId))
            .map((place) => place.order)
            .filter((order) => Number.isInteger(order)),
    );
    if (missingQidOrders.size === 0) {
        logExternalApiCacheHit("geo-location-popular-enrichment", {
            key: geoLocationKey,
            detail: `places=${places.length} all wikidataIds present`,
            skippedProviders: ["wikidata", "wikipedia", "wikimedia"],
        });
        return places;
    }

    let updated = places.map((place) => ({ ...place }));
    const toEnrich = updated.filter((place) => missingQidOrders.has(place.order));
    const enriched = await enrichPlacesWithWikidataIds(toEnrich, fetchImpl);

    for (let i = 0; i < toEnrich.length; i++) {
        const order = toEnrich[i].order;
        const qid = enriched[i]?.wikidataId;
        if (!Number.isInteger(order) || !isValidWikidataId(qid)) continue;

        const idx = updated.findIndex((place) => place.order === order);
        if (idx >= 0) {
            updated[idx] = { ...updated[idx], wikidataId: qid };
        }
    }

    for (const place of updated) {
        if (!missingQidOrders.has(place.order) || !Number.isInteger(place.order)) continue;

        const original = places.find((entry) => entry.order === place.order) ?? place;
        const resolvedQid = isValidWikidataId(place.wikidataId)
            ? String(place.wikidataId).trim()
            : null;

        if (resolvedQid && resolvedQid !== original.wikidataId) {
            await patchPopularPlaceWikidataId(db, {
                geoLocationKey,
                popularPlaceOrder: place.order,
                wikidataId: resolvedQid,
            });
        }

        if (!resolvedQid || isPopularPlaceImageCached(place)) continue;

        const name = String(place.name ?? "").trim();
        if (!name) continue;

        const hintImageUrl =
            typeof place.image === "string" &&
            place.image.trim() &&
            !place.storageUrl &&
            isWikimediaImageUrl(place.image)
                ? place.image.trim()
                : null;
        const wikipediaUrl =
            typeof place.wikipediaUrl === "string" && place.wikipediaUrl.trim()
                ? place.wikipediaUrl.trim()
                : null;

        try {
            const imageResult = await ensurePlaceImageInFirestore(
                db,
                {
                    wikidataId: resolvedQid,
                    name,
                    hintImageUrl,
                    wikipediaUrl,
                },
                fetchImpl,
            );

            await patchPopularPlaceImage(db, {
                geoLocationKey,
                popularPlaceOrder: place.order,
                wikidataId: imageResult.wikidataId ?? resolvedQid,
                storageUrl: imageResult.storageUrl ?? null,
                imageStatus: imageResult.imageStatus,
            });

            const idx = updated.findIndex((entry) => entry.order === place.order);
            if (idx >= 0) {
                updated[idx] = {
                    ...updated[idx],
                    wikidataId: imageResult.wikidataId ?? resolvedQid,
                    storageUrl: imageResult.storageUrl ?? null,
                    imageStatus: imageResult.imageStatus,
                    image: imageResult.storageUrl ?? updated[idx].image,
                };
            }
        } catch (error) {
            if (error instanceof TransientUpstreamError) {
                console.warn(
                    `[explore-popular] reconcile image transient for order ${place.order}: ${error.message}`,
                );
                continue;
            }
            throw error;
        }
    }

    return updated;
};

/**
 * @param {Record<string, unknown>} best
 * @returns {{
 *   label: string,
 *   city: string,
 *   countryCode: string | null,
 *   countryFlag: string,
 *   resolvedLat: number,
 *   resolvedLng: number,
 * }}
 */
export const geoMetadataFromGeocodeResult = (best, fallbackLat, fallbackLng) => {
    const label = deriveGeoLocationLabel(best);
    const geometry = /** @type {{ location?: { lat?: number, lng?: number } }} */ (
        best.geometry ?? {}
    );
    const resolvedLat = geometry.location?.lat ?? fallbackLat;
    const resolvedLng = geometry.location?.lng ?? fallbackLng;
    const city =
        label.split(",").map((part) => part.trim()).filter(Boolean)[0] ?? label;
    const countryCode = countryCodeFromGeocodeResult(best);
    const countryFlag = flagFromIsoCode(countryCode ?? "");
    return { label, city, countryCode, countryFlag, resolvedLat, resolvedLng };
};

/**
 * True when a forward Google geocode result already has city + country metadata,
 * so a reverse-geocode round trip can be skipped.
 *
 * @param {Record<string, unknown>} geocodeResult
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean}
 */
export const forwardGeocodeHasLocalityMetadata = (geocodeResult, lat, lng) => {
    const { city, countryCode } = geoMetadataFromGeocodeResult(geocodeResult, lat, lng);
    return Boolean(city.trim() && countryCode && String(countryCode).length === 2);
};

/**
 * @param {unknown} error
 * @returns {number}
 */
export const explorePopularHttpStatus = (error) => {
    if (typeof /** @type {{ statusCode?: number }} */ (error)?.statusCode === "number") {
        return /** @type {{ statusCode: number }} */ (error).statusCode;
    }
    if (/** @type {{ name?: string }} */ (error)?.name === "WikidataSparqlTransientError") {
        return 504;
    }
    return 500;
};

/**
 * Loads or resolves popular places for a geo-location cache key.
 *
 * @param {{
 *   functionName: string,
 *   key: string,
 *   lat: number,
 *   lng: number,
 *   radiusKm: number,
 *   searchQuery?: string,
 *   label: string,
 *   city: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 *   resolvedLat: number,
 *   resolvedLng: number,
 *   forceRefresh?: boolean,
 *   language: string,
 *   apiKey: string,
 *   cacheSource?: string,
 * }} options
 * @returns {Promise<{ key: string, label: string, lat: number, lon: number, places: Array<Record<string, unknown>>, radiusKm: number, cached: boolean }>}
 */
export const resolveExplorePopularPlaces = async ({
    functionName,
    key,
    lat,
    lng,
    radiusKm,
    searchQuery = "",
    label,
    city,
    countryCode = null,
    countryFlag,
    resolvedLat,
    resolvedLng,
    forceRefresh = false,
    language,
    apiKey,
    cacheSource,
}) => {
    const db = getFirestore();
    const docRef = db.collection(COLLECTION).doc(key);
    const existing = await docRef.get();
    const existingData = existing.exists ? existing.data() : null;
    const trimmedSearchQuery = String(searchQuery || "").trim();
    const flag = countryFlag ?? flagFromIsoCode(countryCode ?? "");

    if (!forceRefresh && existing.exists) {
        const cachedPlaces = await readPopularAroundList(db, key);
        if (cachedPlaces.length > 0) {
            const places = await reconcileCachedPopularPlaces(db, key, cachedPlaces);
            logExternalApiCacheHit("geo-location-popular", {
                key,
                detail:
                    `places=${places.length}` +
                    (trimmedSearchQuery ? ` searchQuery="${trimmedSearchQuery}"` : "") +
                    ` radiusKm=${radiusKm}`,
                skippedProviders: trimmedSearchQuery
                    ? ["wikidata-sparql"]
                    : ["wikidata", "wikipedia", "wikimedia"],
            });
            console.log(`[${functionName}] cache hit ${key} (${places.length} places)`);
            return {
                key,
                label,
                lat: existing.data()?.lat ?? resolvedLat,
                lon: existing.data()?.lon ?? resolvedLng,
                places,
                radiusKm,
                cached: true,
            };
        }
    }

    console.log(
        `[${functionName}] cache miss ${key} lat=${lat} lng=${lng} radiusKm=${radiusKm}` +
            (trimmedSearchQuery ? ` searchQuery="${trimmedSearchQuery}"` : ""),
    );

    let sparqlFailed = false;
    let places;
    try {
        places = await fetchWikidataNearbyPopularPlaces(lat, lng, {
            city,
            countryCode,
            countryFlag: flag,
            limit: MAX_NEARBY_RESULTS,
            radiusKm,
            globalSearch: Boolean(trimmedSearchQuery),
        });
    } catch (error) {
        if (trimmedSearchQuery && error?.name === "WikidataSparqlTransientError") {
            sparqlFailed = true;
            places = [];
            console.warn(
                `[${functionName}] SPARQL failed for ${key}, returning empty search results`,
            );
        } else {
            throw error;
        }
    }
    if (trimmedSearchQuery && sparqlFailed && places.length === 0) {
        console.log(
            `[${functionName}] empty search fallback ${key} (SPARQL failed, not cached)`,
        );
        return {
            key,
            label,
            lat: resolvedLat,
            lon: resolvedLng,
            places,
            radiusKm,
            cached: false,
            partial: true,
        };
    }

    const now = FieldValue.serverTimestamp();
    const resolvedCacheSource = geoLocationCacheSourceForWrite(existingData, cacheSource);
    /** @type {Record<string, unknown>} */
    const parentDoc = {
        key,
        label,
        lat: resolvedLat,
        lon: resolvedLng,
        mostPopularAround: mostPopularAroundFromPlaces(places),
        createdAt: existing.exists ? existingData?.createdAt ?? now : now,
        updatedAt: now,
    };
    if (resolvedCacheSource) {
        parentDoc.cacheSource = resolvedCacheSource;
    }
    await docRef.set(parentDoc, { merge: true });
    await writePopularAroundList(docRef, places, now);

    console.log(`[${functionName}] resolved ${key} (${places.length} places)`);
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

export {
    geoLocationPopularKeyFromCoords,
    NEARBY_RADIUS_KM,
};
