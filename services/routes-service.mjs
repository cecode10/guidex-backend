import { haversineMeters } from "./trip-generation.mjs";
import { logExternalApiRequest, logExternalApiResponse } from "../utils/external-api-debug.mjs";

export const ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * Only these fields: anything beyond them can move the request to a pricier
 * Routes SKU (Essentials is distance, duration and the polyline).
 */
export const ROUTES_FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline";

/** Walking routes longer than this (straight line) are rejected. */
export const MAX_WALKING_ROUTE_METERS = 50000;

const ROUTES_TIMEOUT_MS = 15000;

/**
 * Decodes a Google encoded polyline (precision 5).
 *
 * @param {string} encoded
 * @returns {Array<{ lat: number, lng: number }>}
 */
export const decodePolyline = (encoded) => {
    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    while (index < encoded.length) {
        for (const axis of ["lat", "lng"]) {
            let result = 0;
            let shift = 0;
            let byte;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < encoded.length);
            const delta = result & 1 ? ~(result >> 1) : result >> 1;
            if (axis === "lat") lat += delta;
            else lng += delta;
        }
        points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
};

/**
 * Routes API returns durations like "1234s".
 *
 * @param {unknown} raw
 * @returns {number}
 */
export const parseDurationSeconds = (raw) => {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(String(raw ?? ""));
    return match ? Math.round(Number(match[1])) : 0;
};

/**
 * @param {{ lat: number, lng: number }} origin
 * @param {{ lat: number, lng: number }} destination
 */
export const buildWalkingRouteRequest = (origin, destination) => ({
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: {
        location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
    },
    travelMode: "WALK",
    polylineQuality: "HIGH_QUALITY",
});

/**
 * @param {Record<string, unknown>} body Routes API response body.
 * @returns {{ distanceMeters: number, durationSeconds: number, points: Array<{ lat: number, lng: number }> } | null}
 */
export const parseWalkingRouteResponse = (body) => {
    const route = Array.isArray(body?.routes) ? body.routes[0] : null;
    const encoded = route?.polyline?.encodedPolyline;
    if (!route || typeof encoded !== "string" || encoded.length === 0) return null;
    const points = decodePolyline(encoded);
    if (points.length < 2) return null;
    return {
        distanceMeters: Math.round(Number(route.distanceMeters) || 0),
        durationSeconds: parseDurationSeconds(route.duration),
        points,
    };
};

/**
 * Walking route between two points via Google Routes API (computeRoutes).
 *
 * @param {{ origin: { lat: number, lng: number }, destination: { lat: number, lng: number }, apiKey: string }} args
 */
export const computeWalkingRoute = async ({ origin, destination, apiKey }) => {
    const key = String(apiKey || "").trim();
    if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not configured");

    const straight = haversineMeters(origin.lat, origin.lng, destination.lat, destination.lng);
    if (straight > MAX_WALKING_ROUTE_METERS) {
        const err = new Error("destination is too far for a walking route");
        err.statusCode = 400;
        throw err;
    }

    const detail =
        `walk ${origin.lat.toFixed(5)},${origin.lng.toFixed(5)} -> ` +
        `${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROUTES_TIMEOUT_MS);
    try {
        logExternalApiRequest("google-routes", detail);
        const response = await fetch(ROUTES_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": ROUTES_FIELD_MASK,
            },
            body: JSON.stringify(buildWalkingRouteRequest(origin, destination)),
            signal: controller.signal,
        });
        logExternalApiResponse("google-routes", `HTTP ${response.status} ${detail}`);
        if (!response.ok) {
            // Google's reason (API not enabled, key restricted, ...) stays in
            // the function log; the client only gets the status.
            const reason = await response.text().catch(() => "");
            console.error(`[google-routes] HTTP ${response.status}: ${reason.slice(0, 1000)}`);
            throw new Error(`Google Routes HTTP ${response.status}`);
        }
        const route = parseWalkingRouteResponse(await response.json());
        if (!route) {
            const err = new Error("no walking route found");
            err.statusCode = 404;
            throw err;
        }
        return route;
    } finally {
        clearTimeout(timer);
    }
};
