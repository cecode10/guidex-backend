import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAuth } from "../utils/auth.mjs";
import { validateMandatoryFields } from "../utils/event-utils.mjs";
import { geocodingLanguageFromAppLanguage } from "../utils/geocode-anchor-utils.mjs";
import { deriveGeoLocationLabel } from "../utils/geo-location-utils.mjs";
import {
    explorePopularHttpStatus,
    exploreSearchTargetFromGeocode,
    fetchGoogleGeocode,
} from "../services/explore-popular-core.mjs";

const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");
const FUNCTION_NAME = "geocodeExploreSearch";
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;

/**
 * Cloud Function: resolves an Explore search ("Rome", "Eiffel Tower") to the
 * point and viewport the map should fly to. Places are then loaded for that
 * viewport by `resolveExploreArea`.
 */
export const geocodeExploreSearch = onRequest(
    {
        cors: true,
        region: "europe-west3",
        timeoutSeconds: 30,
        memory: "256MiB",
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
            const geocode = await fetchGoogleGeocode(query, language, googleMapsApiKey.value());
            const best = geocode.status === "OK" ? geocode.results?.[0] : undefined;
            const target = best ? exploreSearchTargetFromGeocode(best) : null;

            const elapsed = Date.now() - start;
            if (!best || !target) {
                console.log(
                    `[${FUNCTION_NAME}] notFound query="${query}" (${geocode.status}) in ${elapsed}ms`,
                );
                return res.status(200).json({ found: false });
            }

            console.log(
                `[${FUNCTION_NAME}] query="${query}" lat=${target.lat} lng=${target.lng} ` +
                    `viewport=${target.viewport ? "yes" : "no"} in ${elapsed}ms`,
            );
            return res.status(200).json({
                found: true,
                label: deriveGeoLocationLabel(best),
                lat: target.lat,
                lng: target.lng,
                viewport: target.viewport,
            });
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
