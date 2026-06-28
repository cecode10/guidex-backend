import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import {
    deriveRadiusKm,
    geocodingLanguageFromAppLanguage,
} from "../geocode-anchor-utils.mjs";
import { fetchGlobalPlacesSearch } from "../places-lookup-utils.mjs";
import { fetchGoogleGeocode } from "./resolve-search-anchor.mjs";

const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");
const FUNCTION_NAME = "resolveGlobalPlacesSearch";
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;

/**
 * Cloud Function: free-form place search via geocode anchor, with Wikidata
 * entity fallback when geocoding does not yield nearby POIs.
 */
export const resolveGlobalPlacesSearch = onRequest(
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
            validateMandatoryFields(payload, ["query"]);

            const query = String(payload.query).trim();
            if (query.length < MIN_QUERY_LEN || query.length > MAX_QUERY_LEN) {
                const err = new Error(`query must be ${MIN_QUERY_LEN}-${MAX_QUERY_LEN} characters`);
                err.statusCode = 400;
                throw err;
            }

            const language = geocodingLanguageFromAppLanguage(payload.language);
            const apiKey = googleMapsApiKey.value();

            const { places, lat, lng } = await fetchGlobalPlacesSearch(
                query,
                {
                    resolveGeocodeAnchor: async (searchQuery) => {
                        const geocode = await fetchGoogleGeocode(searchQuery, language, apiKey);
                        if (geocode.status !== "OK" || !geocode.results?.length) {
                            return null;
                        }
                        const best = geocode.results[0];
                        const geometry = /** @type {{ location?: { lat?: number, lng?: number } }} */ (
                            best.geometry ?? {}
                        );
                        const anchorLat = geometry.location?.lat;
                        const anchorLng = geometry.location?.lng;
                        if (typeof anchorLat !== "number" || typeof anchorLng !== "number") {
                            return null;
                        }
                        const types = Array.isArray(best.types)
                            ? best.types.map((value) => String(value))
                            : [];
                        return {
                            lat: anchorLat,
                            lng: anchorLng,
                            label:
                                typeof best.formatted_address === "string"
                                    ? best.formatted_address
                                    : "",
                            radiusKm: deriveRadiusKm(types),
                        };
                    },
                },
            );

            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] query="${query}" count=${places.length} in ${elapsed}ms`,
            );
            return res.status(200).json({
                places,
                lat,
                lng,
                hasMore: false,
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
