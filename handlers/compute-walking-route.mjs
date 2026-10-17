import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAuth } from "../utils/auth.mjs";
import { validateMandatoryFields } from "../utils/event-utils.mjs";
import { computeWalkingRoute } from "../services/routes-service.mjs";

const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");

const FUNCTION_NAME = "computeWalkingRoute";

/**
 * @param {Record<string, unknown>} payload
 * @param {string} latKey
 * @param {string} lngKey
 */
const pointFrom = (payload, latKey, lngKey) => {
    const lat = Number(payload[latKey]);
    const lng = Number(payload[lngKey]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        const err = new Error(`${latKey} and ${lngKey} must be valid coordinates`);
        err.statusCode = 400;
        throw err;
    }
    return { lat, lng };
};

/**
 * Cloud Function: walking route between the user and a place (Google Routes API).
 *
 * Request: { originLat, originLng, destLat, destLng }
 * Response: { distanceMeters, durationSeconds, points: [{ lat, lng }] }
 */
export const computeWalkingRouteFn = onRequest(
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
            validateMandatoryFields(payload, ["originLat", "originLng", "destLat", "destLng"]);

            const route = await computeWalkingRoute({
                origin: pointFrom(payload, "originLat", "originLng"),
                destination: pointFrom(payload, "destLat", "destLng"),
                apiKey: googleMapsApiKey.value(),
            });
            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] ${route.distanceMeters}m ${route.points.length} points in ${elapsed}ms`,
            );
            return res.status(200).json(route);
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
