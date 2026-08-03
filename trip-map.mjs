import { randomUUID } from "node:crypto";
import { getStorage } from "firebase-admin/storage";

/** Brand pink used for markers + path (#DD0E72). */
export const TRIP_MAP_ACCENT = "0xDD0E72";

/** 4:3 overview (Static Maps free max dimension is 640). */
export const TRIP_MAP_SIZE = "640x480";

/**
 * @param {Array<{ lat?: unknown, lng?: unknown }>} stops
 * @returns {Array<{ lat: number, lng: number }>}
 */
export const extractTripCoordinates = (stops) => {
    if (!Array.isArray(stops)) return [];
    /** @type {Array<{ lat: number, lng: number }>} */
    const coords = [];
    for (const stop of stops) {
        const lat = Number(stop?.lat);
        const lng = Number(stop?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        coords.push({ lat, lng });
    }
    return coords;
};

/**
 * Builds a Google Static Maps URL for a walking-trip overview (4:3).
 *
 * @param {Array<{ lat?: unknown, lng?: unknown }>} stops
 * @param {string} apiKey
 * @returns {string | null}
 */
export const buildTripStaticMapUrl = (stops, apiKey) => {
    const key = String(apiKey || "").trim();
    if (!key) return null;
    const coords = extractTripCoordinates(stops);
    if (coords.length === 0) return null;

    const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
    url.searchParams.set("size", TRIP_MAP_SIZE);
    url.searchParams.set("scale", "2");
    url.searchParams.set("maptype", "roadmap");
    url.searchParams.set("key", key);

    coords.forEach((point, index) => {
        const label = String((index % 9) + 1); // Static Maps labels are 0-9
        url.searchParams.append(
            "markers",
            `color:${TRIP_MAP_ACCENT}|label:${label}|${point.lat},${point.lng}`,
        );
    });

    if (coords.length >= 2) {
        const pathPoints = coords.map((p) => `${p.lat},${p.lng}`).join("|");
        url.searchParams.set(
            "path",
            `color:${TRIP_MAP_ACCENT}ff|weight:4|${pathPoints}`,
        );
    }

    return url.toString();
};

/**
 * @param {string} staticMapUrl
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Buffer>}
 */
export const fetchTripStaticMapPng = async (staticMapUrl, options = {}) => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(staticMapUrl);
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        const err = new Error(
            `static map request failed: ${response.status} ${body.slice(0, 200)}`,
        );
        err.statusCode = 502;
        throw err;
    }
    const contentType = String(response.headers.get("content-type") || "");
    if (!contentType.includes("image")) {
        const body = await response.text().catch(() => "");
        const err = new Error(
            `static map returned non-image content-type=${contentType} body=${body.slice(0, 200)}`,
        );
        err.statusCode = 502;
        throw err;
    }
    return Buffer.from(await response.arrayBuffer());
};

/**
 * Uploads a trip overview PNG and returns a tokenized download URL.
 *
 * @param {{
 *   uid: string,
 *   tripId: string,
 *   pngBytes: Buffer,
 * }} options
 * @returns {Promise<{ mapImageUrl: string, storagePath: string }>}
 */
export const uploadTripMapImage = async ({ uid, tripId, pngBytes }) => {
    const safeUid = String(uid || "").trim();
    const safeTripId = String(tripId || "").trim();
    if (!safeUid || !safeTripId) {
        throw new Error("uid and tripId are required to upload trip map");
    }
    if (!pngBytes?.length) {
        throw new Error("pngBytes is required");
    }

    const bucket = getStorage().bucket();
    const storagePath = `users/${safeUid}/trips/${safeTripId}/map.png`;
    const token = randomUUID();
    await bucket.file(storagePath).save(pngBytes, {
        resumable: false,
        contentType: "image/png",
        metadata: {
            cacheControl: "public, max-age=604800",
            metadata: { firebaseStorageDownloadTokens: token },
        },
    });

    const mapImageUrl =
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
        `/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

    return { mapImageUrl, storagePath };
};

/**
 * Builds Static Map, downloads PNG, uploads to Storage.
 * Returns null when map generation is skipped/fails at the caller level.
 *
 * @param {{
 *   uid: string,
 *   tripId: string,
 *   stops: Array<Record<string, unknown>>,
 *   apiKey: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ mapImageUrl: string, storagePath: string } | null>}
 */
export const createAndStoreTripMapImage = async ({
    uid,
    tripId,
    stops,
    apiKey,
    fetchImpl,
}) => {
    const staticMapUrl = buildTripStaticMapUrl(stops, apiKey);
    if (!staticMapUrl) return null;
    const pngBytes = await fetchTripStaticMapPng(staticMapUrl, { fetchImpl });
    return uploadTripMapImage({ uid, tripId, pngBytes });
};
