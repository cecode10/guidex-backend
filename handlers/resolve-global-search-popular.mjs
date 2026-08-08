import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAuth } from "../utils/auth.mjs";
import { validateMandatoryFields } from "../utils/event-utils.mjs";
import {
    geocodingLanguageFromAppLanguage,
    popularSearchRadiusKmFromGeocodeTypes,
} from "../utils/geocode-anchor-utils.mjs";
import {
    fetchGoogleGeocode,
    fetchGoogleReverseGeocode,
    forwardGeocodeHasLocalityMetadata,
    geoLocationPopularKeyFromCoords,
    geoMetadataFromGeocodeResult,
    explorePopularHttpStatus,
} from "../services/explore-popular-core.mjs";
import { sightseeingHttpsOptions } from "../utils/sightseeing-function-options.mjs";
import { resolveExplorePopularPlacesFromDb } from "../services/sightseeing-query.mjs";

const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");
const FUNCTION_NAME = "resolveGlobalSearchPopular";
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;

/**
 * Cloud Function: free-form Explore search (geocode query, then PostGIS radius).
 */
export const resolveGlobalSearchPopular = onRequest(
    sightseeingHttpsOptions({
        timeoutSeconds: 60,
        memory: "512MiB",
        secrets: [googleMapsApiKey],
    }),
    async (req, res) => {
        const start = Date.now();
        try {
            await requireAuth(req);
            const payload = req.body || {};
            validateMandatoryFields(payload, ["query"]);

            const query = String(payload.query).trim();
            if (query.length < MIN_QUERY_LEN || query.length > MAX_QUERY_LEN) {
                const err = new Error(`query must be ${MIN_QUERY_LEN}-${MAX_QUERY_LEN} characters`);
                err.statusCode = 400;
                throw err;
            }

            const language = geocodingLanguageFromAppLanguage(payload.language);
            const apiKey = googleMapsApiKey.value();

            const forwardGeocode = await fetchGoogleGeocode(query, language, apiKey);
            if (forwardGeocode.status !== "OK" || !forwardGeocode.results?.length) {
                const elapsed = Date.now() - start;
                console.log(
                    `[${FUNCTION_NAME}] notFound query="${query}" (${forwardGeocode.status}) in ${elapsed}ms`,
                );
                return res.status(200).json({
                    key: null,
                    label: "",
                    lat: null,
                    lon: null,
                    places: [],
                    radiusKm: null,
                    cached: false,
                });
            }

            const best = forwardGeocode.results[0];
            const geometry = /** @type {{ location?: { lat?: number, lng?: number } }} */ (
                best.geometry ?? {}
            );
            const lat = geometry.location?.lat;
            const lng = geometry.location?.lng;
            if (typeof lat !== "number" || typeof lng !== "number") {
                const err = new Error("Google Geocoding returned no coordinates");
                err.statusCode = 502;
                throw err;
            }

            const radiusKm = popularSearchRadiusKmFromGeocodeTypes(
                Array.isArray(best.types) ? best.types.map((value) => String(value)) : [],
            );
            const key = geoLocationPopularKeyFromCoords(lat, lng, radiusKm);
            if (!key) {
                const err = new Error("Could not derive geo-location key");
                err.statusCode = 400;
                throw err;
            }

            const reverseGeocode = forwardGeocodeHasLocalityMetadata(best, lat, lng)
                ? null
                : await fetchGoogleReverseGeocode(lat, lng, language, apiKey);
            if (reverseGeocode === null) {
                console.log(
                    `[${FUNCTION_NAME}] skip reverse-geocode query="${query}"; ` +
                        "forward result has locality+country",
                );
            }
            const geocodeBest =
                reverseGeocode?.status === "OK" && reverseGeocode.results?.length
                    ? reverseGeocode.results[0]
                    : best;
            const { label, city, countryCode, countryFlag, resolvedLat, resolvedLng } =
                geoMetadataFromGeocodeResult(geocodeBest, lat, lng);

            const result = await resolveExplorePopularPlacesFromDb({
                functionName: FUNCTION_NAME,
                key,
                lat,
                lng,
                radiusKm,
                label,
                city,
                countryCode,
                countryFlag,
                resolvedLat,
                resolvedLng,
            });

            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] query="${query}" key=${key} count=${result.places.length} cached=${result.cached} in ${elapsed}ms`,
            );
            return res.status(200).json(result);
        } catch (error) {
            const elapsed = Date.now() - start;
            const statusCode = explorePopularHttpStatus(error);
            console.error(`[${FUNCTION_NAME}] error after ${elapsed}ms:`, error?.message || error);
            return res
                .status(statusCode)
                .json({ error: statusCode === 401 ? "unauthorized" : error?.message || "failed" });
        }
    },
);
