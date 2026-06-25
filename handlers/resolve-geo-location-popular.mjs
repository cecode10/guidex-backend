import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import { geocodingLanguageFromAppLanguage } from "../geocode-anchor-utils.mjs";
import {
    logExternalApiRequest,
    logExternalApiResponse,
} from "../external-api-debug.mjs";
import {
    COLLECTION,
    MAX_NEARBY_RESULTS,
    POPULAR_AROUND_SUBCOLLECTION,
    countryCodeFromGeocodeResult,
    deriveGeoLocationLabel,
    enrichPlacesWithWikidataIds,
    ensureSearchAnchorInPopularPlaces,
    flagFromIsoCode,
    geoLocationKeyFromCoords,
    isPopularPlaceImageCached,
    isValidWikidataId,
    mostPopularAroundFromPlaces,
    patchPopularPlaceImage,
    patchPopularPlaceWikidataId,
    popularPlaceDocFromPlace,
    popularPlaceFromDoc,
} from "../geo-location-utils.mjs";
import { fetchWikidataNearbyPopularPlaces } from "../wikidata-nearby-utils.mjs";
import {
    TransientUpstreamError,
    ensurePlaceImageInFirestore,
    isWikimediaImageUrl,
} from "./resolve-place-image.mjs";

const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");
const FUNCTION_NAME = "resolveGeoLocationPopular";
const GOOGLE_TIMEOUT_MS = 12_000;

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
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
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
 * Backfills missing Wikidata IDs and images for cached `popularAroundList` rows
 * that were stored before enrichment ran.
 *
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
    if (missingQidOrders.size === 0) return places;

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
                    `[${FUNCTION_NAME}] reconcile image transient for order ${place.order}: ${error.message}`,
                );
                continue;
            }
            throw error;
        }
    }

    return updated;
};

/**
 * Cloud Function: keys `geo-location/{lat}_{lng}` from rounded coordinates,
 * reverse-geocodes via Google for display metadata, looks up Firestore, and
 * on a miss loads Wikidata nearby POIs into `popularAroundList/*`.
 */
export const resolveGeoLocationPopular = onRequest(
    {
        cors: true,
        region: "europe-west3",
        timeoutSeconds: 60,
        memory: "512MiB",
        secrets: [googleMapsApiKey],
    },
    async (req, res) => {
        const start = Date.now();
        try {
            await requireAuth(req);
            const payload = req.body || {};
            validateMandatoryFields(payload, ["lat", "lng"]);

            const lat = Number(payload.lat);
            const lng = Number(payload.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                const err = new Error("lat and lng must be finite numbers");
                err.statusCode = 400;
                throw err;
            }

            const forceRefresh = payload.forceRefresh === true;
            const searchQuery = String(payload.searchQuery || "").trim();
            const language = geocodingLanguageFromAppLanguage(payload.language);
            const apiKey = googleMapsApiKey.value();

            const geocode = await fetchGoogleReverseGeocode(lat, lng, language, apiKey);
            if (geocode.status !== "OK" || !geocode.results?.length) {
                const err = new Error(`Google reverse geocode failed (${geocode.status})`);
                err.statusCode = 502;
                throw err;
            }

            const key = geoLocationKeyFromCoords(lat, lng);
            if (!key) {
                const err = new Error("Could not derive geo-location key");
                err.statusCode = 400;
                throw err;
            }

            const best = geocode.results[0];
            const label = deriveGeoLocationLabel(best);

            const geometry = /** @type {{ location?: { lat?: number, lng?: number } }} */ (
                best.geometry ?? {}
            );
            const resolvedLat = geometry.location?.lat ?? lat;
            const resolvedLng = geometry.location?.lng ?? lng;
            const city =
                label.split(",").map((part) => part.trim()).filter(Boolean)[0] ?? label;
            const countryCode = countryCodeFromGeocodeResult(best);
            const countryFlag = flagFromIsoCode(countryCode ?? "");

            const db = getFirestore();
            const docRef = db.collection(COLLECTION).doc(key);
            const existing = await docRef.get();

            if (!forceRefresh && existing.exists) {
                const cachedPlaces = await readPopularAroundList(db, key);
                if (cachedPlaces.length > 0) {
                    let places = await reconcileCachedPopularPlaces(db, key, cachedPlaces);
                    if (searchQuery) {
                        places = await ensureSearchAnchorInPopularPlaces(places, {
                            searchQuery,
                            lat,
                            lng,
                            city,
                            countryCode,
                            countryFlag,
                        });
                    }
                    const elapsed = Date.now() - start;
                    console.log(`[${FUNCTION_NAME}] cache hit ${key} in ${elapsed}ms`);
                    return res.status(200).json({
                        key,
                        label,
                        lat: existing.data()?.lat ?? resolvedLat,
                        lon: existing.data()?.lon ?? resolvedLng,
                        places,
                        cached: true,
                    });
                }
            }

            let places = await fetchWikidataNearbyPopularPlaces(
                lat,
                lng,
                {
                    city,
                    countryCode,
                    countryFlag,
                    limit: MAX_NEARBY_RESULTS,
                },
            );
            if (searchQuery) {
                places = await ensureSearchAnchorInPopularPlaces(places, {
                    searchQuery,
                    lat,
                    lng,
                    city,
                    countryCode,
                    countryFlag,
                });
            }
            const now = FieldValue.serverTimestamp();

            await docRef.set(
                {
                    key,
                    label,
                    lat: resolvedLat,
                    lon: resolvedLng,
                    mostPopularAround: mostPopularAroundFromPlaces(places),
                    createdAt: existing.exists ? existing.data()?.createdAt ?? now : now,
                    updatedAt: now,
                },
                { merge: true },
            );
            await writePopularAroundList(docRef, places, now);

            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] resolved ${key} (${places.length} places) in ${elapsed}ms`);
            return res.status(200).json({
                key,
                label,
                lat: resolvedLat,
                lon: resolvedLng,
                places,
                cached: false,
            });
        } catch (error) {
            const elapsed = Date.now() - start;
            const statusCode = error?.statusCode || 500;
            console.error(`[${FUNCTION_NAME}] error after ${elapsed}ms:`, error?.message || error);
            return res
                .status(statusCode)
                .json({ error: statusCode === 401 ? "unauthorized" : error?.message || "failed" });
        }
    },
);
