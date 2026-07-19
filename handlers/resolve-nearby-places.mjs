import { onRequest } from "firebase-functions/v2/https";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import {
    CHECKIN_NEARBY_DEFAULT_LIMIT,
    NEARBY_RADIUS_KM,
    reverseGeocodeNominatim,
} from "../places-lookup-utils.mjs";
import { sightseeingHttpsOptions } from "../sightseeing-function-options.mjs";
import { findNearbySightseeing } from "../sightseeing-query.mjs";

const FUNCTION_NAME = "resolveNearbyPlaces";
const MAX_LIMIT = 50;

/**
 * Cloud Function: paginated nearby POIs sorted by distance (check-in picker).
 * Backed by PostGIS Europe sightseeing table.
 */
export const resolveNearbyPlaces = onRequest(
    sightseeingHttpsOptions({
        timeoutSeconds: 45,
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

            const limit = Math.min(
                Math.max(
                    Number.parseInt(String(payload.limit ?? CHECKIN_NEARBY_DEFAULT_LIMIT), 10) ||
                        CHECKIN_NEARBY_DEFAULT_LIMIT,
                    1,
                ),
                MAX_LIMIT,
            );
            const offset = Math.max(Number.parseInt(String(payload.offset ?? 0), 10) || 0, 0);
            const radiusKm = Number.isFinite(Number(payload.radiusKm))
                ? Math.max(Number(payload.radiusKm), 0.1)
                : NEARBY_RADIUS_KM;

            const existingCity = String(payload.city ?? "").trim();
            const geo = existingCity
                ? {
                      city: existingCity,
                      country: String(payload.country ?? ""),
                      countryCode: payload.countryCode ?? null,
                      countryFlag: payload.countryFlag,
                  }
                : await reverseGeocodeNominatim(lat, lng);

            const { places, hasMore } = await findNearbySightseeing(lat, lng, {
                radiusKm,
                limit,
                offset,
                orderBy: "distance",
                city: geo.city,
                country: geo.country,
                countryCode: geo.countryCode,
                countryFlag: geo.countryFlag,
            });

            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] resolved lat=${lat} lng=${lng} ` +
                    `limit=${limit} offset=${offset} count=${places.length} in ${elapsed}ms`,
            );
            return res.status(200).json({ places, hasMore });
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
