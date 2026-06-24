import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import {
    deriveRadiusKm,
    geocodingLanguageFromAppLanguage,
    geocodeAnchorCacheKey,
} from "../geocode-anchor-utils.mjs";
import {
    logExternalApiRequest,
    logExternalApiResponse,
} from "../external-api-debug.mjs";

const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");
const FUNCTION_NAME = "resolveSearchAnchor";
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;
const GOOGLE_TIMEOUT_MS = 12_000;

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
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
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
 * Cloud Function: resolves a geocode search anchor via Google Geocoding so
 * the API key stays server-side.
 */
export const resolveSearchAnchor = onRequest(
    {
        cors: true,
        region: "europe-west3",
        timeoutSeconds: 15,
        memory: "256MiB",
        secrets: [googleMapsApiKey],
    },
    async (req, res) => {
        const start = Date.now();
        try {
            await requireAuth(req);
            const payload = req.body || {};
            validateMandatoryFields(payload, ["query"]);

            const rawQuery = String(payload.query).trim();
            if (rawQuery.length < MIN_QUERY_LEN || rawQuery.length > MAX_QUERY_LEN) {
                const err = new Error(`query must be ${MIN_QUERY_LEN}-${MAX_QUERY_LEN} characters`);
                err.statusCode = 400;
                throw err;
            }

            const key = geocodeAnchorCacheKey(rawQuery);
            if (!key) {
                const err = new Error("query is empty");
                err.statusCode = 400;
                throw err;
            }

            const language = geocodingLanguageFromAppLanguage(payload.language);
            const apiKey = googleMapsApiKey.value();
            const geocode = await fetchGoogleGeocode(rawQuery, language, apiKey);

            if (geocode.status !== "OK" || !geocode.results?.length) {
                const elapsed = Date.now() - start;
                console.log(`[${FUNCTION_NAME}] notFound ${key} (${geocode.status}) in ${elapsed}ms`);
                return res.status(200).json({ status: "notFound" });
            }

            const best = geocode.results[0];
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

            const types = Array.isArray(best.types)
                ? best.types.map((value) => String(value))
                : [];
            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] resolved ${key} in ${elapsed}ms`);
            return res.status(200).json({
                status: "ready",
                lat,
                lng,
                label: typeof best.formatted_address === "string" ? best.formatted_address : "",
                types,
                radiusKm: deriveRadiusKm(types),
                source: "google",
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
