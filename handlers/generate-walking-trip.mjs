import { randomUUID } from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import { answerToPromptPlain } from "../open-ai-service.mjs";
import { reverseGeocodeNominatim } from "../places-lookup-utils.mjs";
import { sightseeingHttpsOptions } from "../sightseeing-function-options.mjs";
import { findNearbySightseeing } from "../sightseeing-query.mjs";
import {
    buildTripPrompts,
    groundTripStops,
    normalizeStopCount,
    normalizeTripRadiusKm,
    parseTripJsonFromModel,
    routeLengthMeters,
    tripSearchRadiusKm,
} from "../trip-generation.mjs";
import { createAndStoreTripMapImage } from "../trip-map.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");
const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");

const FUNCTION_NAME = "generateWalkingTrip";
const CANDIDATE_FETCH_LIMIT = 80;
const CANDIDATE_PROMPT_LIMIT = 40;

/**
 * Cloud Function: plan a walking trip from highest-rated nearby places + OpenAI.
 *
 * Request: { lat, lng, stopCount, radiusMeters|radiusKm, preference?, language? }
 * Response: { title, summary, stops[], radiusKm, candidateCount, mapImageUrl?, startLat, startLng }
 */
export const generateWalkingTrip = onRequest(
    sightseeingHttpsOptions({
        timeoutSeconds: 120,
        memory: "512MiB",
        secrets: [openaiApiKey, googleMapsApiKey],
    }),
    async (req, res) => {
        const start = Date.now();
        try {
            const decoded = await requireAuth(req);
            const uid = decoded.uid;
            const payload = req.body || {};
            validateMandatoryFields(payload, ["lat", "lng", "stopCount"]);

            const lat = Number(payload.lat);
            const lng = Number(payload.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                const err = new Error("lat and lng must be finite numbers");
                err.statusCode = 400;
                throw err;
            }

            const stopCount = normalizeStopCount(payload.stopCount);
            if (stopCount == null) {
                const err = new Error("stopCount must be one of 3, 5, 7, 8, or 10");
                err.statusCode = 400;
                throw err;
            }

            const radiusKm = normalizeTripRadiusKm(
                payload.radiusMeters,
                payload.radiusKm,
            );
            if (radiusKm == null) {
                const err = new Error(
                    "radiusMeters must be between 2000 and 15000 (or radiusKm 2–15)",
                );
                err.statusCode = 400;
                throw err;
            }

            const preference = String(payload.preference ?? "").trim().slice(0, 120);
            const language = String(payload.language ?? "english").trim() || "english";

            const geo = await reverseGeocodeNominatim(lat, lng);
            const searchRadiusKm = tripSearchRadiusKm(radiusKm);
            // orderBy sitelinks = highest-rated / most notable first
            const { places } = await findNearbySightseeing(lat, lng, {
                radiusKm: searchRadiusKm,
                limit: CANDIDATE_FETCH_LIMIT,
                offset: 0,
                orderBy: "sitelinks",
                city: geo.city,
                country: geo.country,
                countryCode: geo.countryCode,
                countryFlag: geo.countryFlag,
            });

            const candidates = places.slice(0, CANDIDATE_PROMPT_LIMIT);

            if (candidates.length === 0) {
                const err = new Error("no places found nearby for this trip length");
                err.statusCode = 404;
                throw err;
            }

            const { systemPrompt, userPrompt } = buildTripPrompts({
                stopCount,
                radiusKm,
                searchRadiusKm,
                preference,
                language,
                userLat: lat,
                userLng: lng,
                candidates,
            });

            const modelText = await answerToPromptPlain(systemPrompt, userPrompt);
            const modelJson = parseTripJsonFromModel(modelText);
            const maxMeters = Math.round(searchRadiusKm * 1000);
            const trip = groundTripStops(modelJson, candidates, stopCount, {
                userLat: lat,
                userLng: lng,
                maxMeters,
            });

            const routeMeters = Math.round(
                routeLengthMeters(lat, lng, trip.stops),
            );
            if (routeMeters > maxMeters) {
                console.error(
                    `[${FUNCTION_NAME}] over-budget route ${routeMeters}m > ${maxMeters}m — rejecting`,
                );
                const err = new Error(
                    `generated route ${routeMeters}m exceeds trip length ${maxMeters}m`,
                );
                err.statusCode = 422;
                throw err;
            }

            let mapImageUrl = null;
            const tripId = randomUUID();
            try {
                const map = await createAndStoreTripMapImage({
                    uid,
                    tripId,
                    stops: trip.stops,
                    apiKey: googleMapsApiKey.value(),
                });
                mapImageUrl = map?.mapImageUrl ?? null;
            } catch (mapError) {
                console.error(
                    `[${FUNCTION_NAME}] map image failed:`,
                    mapError?.message || mapError,
                );
            }

            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] lat=${lat} lng=${lng} radiusKm=${radiusKm} ` +
                    `searchRadiusKm=${searchRadiusKm} ` +
                    `stopCount=${stopCount} candidates=${candidates.length} ` +
                    `stops=${trip.stops.length} routeMeters=${routeMeters} ` +
                    `map=${mapImageUrl ? "yes" : "no"} ` +
                    `in ${elapsed}ms`,
            );

            return res.status(200).json({
                title: trip.title,
                summary: trip.summary,
                stops: trip.stops,
                radiusKm,
                candidateCount: candidates.length,
                mapImageUrl,
                startLat: lat,
                startLng: lng,
            });
        } catch (error) {
            const elapsed = Date.now() - start;
            const statusCode = error?.statusCode || error?.status || 500;
            console.error(
                `[${FUNCTION_NAME}] error after ${elapsed}ms:`,
                error?.message || error,
            );
            return res.status(statusCode).json({
                error: statusCode === 401 ? "unauthorized" : error?.message || "failed",
            });
        }
    },
);
