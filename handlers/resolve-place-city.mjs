import { onRequest } from "firebase-functions/v2/https";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import { logExternalApiCacheHit } from "../external-api-debug.mjs";
import { reverseGeocodeNominatim } from "../places-lookup-utils.mjs";

const FUNCTION_NAME = "resolvePlaceCity";

/**
 * Cloud Function: resolves a human-readable city label for coordinates.
 */
export const resolvePlaceCity = onRequest(
    {
        cors: true,
        region: "europe-west3",
        timeoutSeconds: 20,
        memory: "256MiB",
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

            const existingCity = String(payload.city ?? "").trim();
            if (existingCity && existingCity !== "Nearby") {
                const elapsed = Date.now() - start;
                logExternalApiCacheHit("place-city-payload", {
                    detail: `city="${existingCity}" elapsedMs=${elapsed}`,
                    skippedProviders: ["nominatim"],
                });
                return res.status(200).json({ city: existingCity, cached: true });
            }

            const geo = await reverseGeocodeNominatim(lat, lng);
            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] resolved city="${geo.city}" in ${elapsed}ms`);
            return res.status(200).json({ city: geo.city });
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
