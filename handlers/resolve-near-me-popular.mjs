import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import { geocodingLanguageFromAppLanguage } from "../geocode-anchor-utils.mjs";
import {
    NEARBY_RADIUS_KM,
    explorePopularHttpStatus,
    fetchGoogleReverseGeocode,
    geoLocationKeyFromCoords,
    geoMetadataFromGeocodeResult,
    resolveExplorePopularPlaces,
} from "../explore-popular-core.mjs";

const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");
const FUNCTION_NAME = "resolveNearMePopular";

/**
 * Cloud Function: popular places around the user's coordinates.
 * Reads/writes `geo-location/{lat}_{lng}/popularAroundList/*`.
 */
export const resolveNearMePopular = onRequest(
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
            const { label, city, countryCode, countryFlag, resolvedLat, resolvedLng } =
                geoMetadataFromGeocodeResult(best, lat, lng);

            const result = await resolveExplorePopularPlaces({
                functionName: FUNCTION_NAME,
                key,
                lat,
                lng,
                radiusKm: NEARBY_RADIUS_KM,
                label,
                city,
                countryCode,
                countryFlag,
                resolvedLat,
                resolvedLng,
                forceRefresh,
                language,
                apiKey,
            });

            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] ${key} count=${result.places.length} cached=${result.cached} in ${elapsed}ms`,
            );
            return res.status(200).json(result);
        } catch (error) {
            const elapsed = Date.now() - start;
            const statusCode = explorePopularHttpStatus(error);
            console.error(`[${FUNCTION_NAME}] error after ${elapsed}ms:`, error?.message || error);
            if (error?.extra) {
                console.error(`[${FUNCTION_NAME}] sparql context: ${error.extra}`);
            }
            return res
                .status(statusCode)
                .json({ error: statusCode === 401 ? "unauthorized" : error?.message || "failed" });
        }
    },
);
