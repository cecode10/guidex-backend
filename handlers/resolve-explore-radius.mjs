import { onRequest } from "firebase-functions/v2/https";
import { requireAuth } from "../utils/auth.mjs";
import { validateMandatoryFields } from "../utils/event-utils.mjs";
import { explorePopularHttpStatus } from "../services/explore-popular-core.mjs";
import { sightseeingHttpsOptions } from "../utils/sightseeing-function-options.mjs";
import { findNearbySightseeing } from "../services/sightseeing-query.mjs";

const FUNCTION_NAME = "resolveExploreRadius";

/** Default Explore map radius (city search / zoom ≥ 10). */
export const EXPLORE_MAP_RADIUS_KM = 10;

/** Places returned per Explore radius request (popularity order). */
export const EXPLORE_RADIUS_MAX_RESULTS = 150;

/**
 * Cloud Function: Explore places within a radius of the map center.
 * Body: `{ lat, lng, radiusKm?, countryCode? }`. Defaults to 10 km.
 * Returns the most popular sightseeing rows inside the circle (PostGIS).
 */
export const resolveExploreRadius = onRequest(
    sightseeingHttpsOptions({
        timeoutSeconds: 30,
        memory: "512MiB",
    }),
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
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                const err = new Error("lat/lng out of range");
                err.statusCode = 400;
                throw err;
            }

            const radiusRaw = payload.radiusKm;
            const radiusKm =
                radiusRaw == null || radiusRaw === ""
                    ? EXPLORE_MAP_RADIUS_KM
                    : Number(radiusRaw);
            if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 50) {
                const err = new Error("radiusKm must be within (0, 50]");
                err.statusCode = 400;
                throw err;
            }

            let countryCode = null;
            if (payload.countryCode != null && String(payload.countryCode).trim()) {
                countryCode = String(payload.countryCode).trim().toUpperCase();
                if (!/^[A-Z]{2}$/.test(countryCode)) {
                    const err = new Error("countryCode must be a 2-letter ISO code");
                    err.statusCode = 400;
                    throw err;
                }
            }

            const { places } = await findNearbySightseeing(lat, lng, {
                radiusKm,
                limit: EXPLORE_RADIUS_MAX_RESULTS,
                offset: 0,
                orderBy: "sitelinks",
                countryCode,
                maxLimit: EXPLORE_RADIUS_MAX_RESULTS,
            });

            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] lat=${lat} lng=${lng} radiusKm=${radiusKm} ` +
                    `country=${countryCode ?? "-"} places=${places.length} in ${elapsed}ms`,
            );
            return res.status(200).json({
                lat,
                lng,
                radiusKm,
                places,
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
