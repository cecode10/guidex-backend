import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";

const FUNCTION_NAME = "resolvePlaceImage";
const COLLECTION = "place-images";

/** Days a genuine "no image" result is trusted before the cascade re-runs. */
const HARD_NEGATIVE_TTL_DAYS = 30;
/** Server-resized thumbnail width we persist as the place cover. */
const COVER_WIDTH = 1200;
const COVER_WEBP_QUALITY = 80;
/** Upstream request timeout (Wikimedia/Wikidata can be slow under load). */
const UPSTREAM_TIMEOUT_MS = 12000;
/** Total attempts for retryable upstream failures (timeout / 5xx / 429). */
const UPSTREAM_MAX_ATTEMPTS = 3;

const WIKI_HEADERS = {
    "User-Agent": "guideX-mobile (https://guidex.app)",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

/** Raised when an upstream failure must NOT be cached as a hard negative. */
export class TransientUpstreamError extends Error {
    constructor(message) {
        super(message);
        this.name = "TransientUpstreamError";
    }
}

/**
 * Normalizes a place name into a slug used for the name-fallback cache key.
 * Mirrors the Dart `PlaceImageService` implementation so both ends agree.
 */
export const slugifyName = (name) =>
    String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

/**
 * Stable Firestore doc id for a place. Wikidata QIDs are authoritative;
 * everything else falls back to a normalized-name key.
 */
export const placeKeyFor = (wikidataId, name) => {
    const qid = String(wikidataId || "").trim();
    if (/^Q\d+$/.test(qid)) return qid;
    return `name:${slugifyName(name)}`;
};

/**
 * Coerces a raw Wikimedia image URL to an https, CDN-friendly, server-resized
 * thumbnail. Non-Wikimedia URLs are returned unchanged (https-forced).
 * Mirrors `wiki_image.dart::wikiImageThumbUrl`.
 */
export const normalizeWikiImageUrl = (raw, width) => {
    if (!raw) return null;
    let uri;
    try {
        uri = new URL(raw);
    } catch {
        return null;
    }
    const host = uri.hostname.toLowerCase();
    const isWikimedia =
        host.endsWith("wikimedia.org") || host.endsWith("wikipedia.org");
    if (uri.protocol !== "https:") uri.protocol = "https:";
    if (!isWikimedia) return uri.toString();

    const isFilePath = uri.pathname.includes("/Special:FilePath/");
    if (!isFilePath) return uri.toString();
    uri.searchParams.set("width", String(width));
    return uri.toString();
};

/** Exponential backoff (ms) for retry [attempt] (0-based). */
const backoffMs = (attempt) => 400 * 2 ** attempt;

/** Cap on how long we'll wait for a `Retry-After` before giving up a slot. */
const MAX_RETRY_AFTER_MS = 5000;

/** Parses a `Retry-After` header (seconds or HTTP-date) into ms, or null. */
const retryAfterMs = (res) => {
    const raw = res?.headers?.get?.("retry-after");
    if (!raw) return null;
    const secs = Number.parseInt(raw, 10);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) {
        return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_AFTER_MS);
    }
    return null;
};

/**
 * HTTP GET with the project's retry policy:
 * - timeout / 5xx: retried up to [UPSTREAM_MAX_ATTEMPTS] total, then transient.
 * - 429: retried with backoff (honouring `Retry-After`) then transient. We
 *   retry rather than fail fast because Wikimedia's per-IP limit is hit
 *   precisely because every client funnels through this function — and a
 *   single successful fetch caches the image for everyone, after which the
 *   upstream is never touched again for that place.
 * - everything else (2xx, 404, ...): returned to the caller as-is.
 */
export const httpGet = async (url, { fetchImpl = fetch, headers } = {}) => {
    let lastError;
    let delay = 0;
    for (let attempt = 0; attempt < UPSTREAM_MAX_ATTEMPTS; attempt++) {
        if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
        try {
            const res = await fetchImpl(url, {
                headers,
                signal: controller.signal,
            });
            if (res.status === 429) {
                lastError = new TransientUpstreamError(`429 from ${url}`);
                delay = retryAfterMs(res) ?? backoffMs(attempt);
                continue;
            }
            if (res.status >= 500) {
                lastError = new TransientUpstreamError(`${res.status} from ${url}`);
                delay = backoffMs(attempt);
                continue;
            }
            return res;
        } catch (err) {
            if (err instanceof TransientUpstreamError) throw err;
            // AbortError / network error → retryable.
            lastError = new TransientUpstreamError(err?.message || "network error");
            delay = backoffMs(attempt);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError ?? new TransientUpstreamError(`GET failed for ${url}`);
};

/**
 * Resolves the en-Wikipedia article title for a Wikidata QID via its sitelink.
 * Returns null when the entity has no enwiki page.
 */
const resolveWikipediaTitle = async (wikidataId, fetchImpl) => {
    const url =
        `https://www.wikidata.org/w/api.php?action=wbgetentities` +
        `&props=sitelinks&ids=${encodeURIComponent(wikidataId)}` +
        `&sitefilter=enwiki&format=json&origin=*`;
    const res = await httpGet(url, { fetchImpl });
    if (!res.ok) return null;
    const body = await res.json();
    const entity = body?.entities?.[wikidataId];
    return entity?.sitelinks?.enwiki?.title || null;
};

/** Wikidata `P18` raw Commons file name (e.g. `Eiffel Tower.jpg`), or null. */
const resolveWikidataImageFile = async (wikidataId, fetchImpl) => {
    const url =
        `https://www.wikidata.org/w/api.php?action=wbgetentities` +
        `&props=claims&ids=${encodeURIComponent(wikidataId)}` +
        `&format=json&origin=*`;
    const res = await httpGet(url, { fetchImpl });
    if (!res.ok) return null;
    const body = await res.json();
    const claims = body?.entities?.[wikidataId]?.claims?.P18;
    return claims?.[0]?.mainsnak?.datavalue?.value || null;
};

/**
 * Extracts the Commons file name from a `Special:FilePath/<File>` URL, or null
 * when [raw] is not such a URL.
 */
export const commonsFileFromFilePath = (raw) => {
    if (!raw) return null;
    let uri;
    try {
        uri = new URL(raw);
    } catch {
        return null;
    }
    const marker = "/Special:FilePath/";
    const idx = uri.pathname.indexOf(marker);
    if (idx === -1) return null;
    const enc = uri.pathname.slice(idx + marker.length);
    try {
        return decodeURIComponent(enc);
    } catch {
        return enc;
    }
};

/**
 * Extracts a Commons file name from an `upload.wikimedia.org` thumbnail or
 * direct file URL, or null when [raw] is not such a URL.
 */
export const commonsFileFromUploadUrl = (raw) => {
    if (!raw) return null;
    let uri;
    try {
        uri = new URL(raw);
    } catch {
        return null;
    }
    const path = uri.pathname;
    const thumb = path.match(/\/([^/]+\.[a-zA-Z0-9]+)\/\d+px-/);
    if (thumb) {
        try {
            return decodeURIComponent(thumb[1]);
        } catch {
            return thumb[1];
        }
    }
    if (!path.includes("/wikipedia/commons/")) return null;
    const direct = path.match(/\/([^/]+\.[a-zA-Z0-9]+)$/);
    if (!direct) return null;
    try {
        return decodeURIComponent(direct[1]);
    } catch {
        return direct[1];
    }
};

/** Strips HTML from Commons `extmetadata` values (Artist, etc.). */
export const stripHtml = (raw) => {
    if (!raw) return null;
    const text = String(raw)
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .trim();
    return text || null;
};

const commonsFilePageUrl = (fileName) =>
    `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`;

const extMetaValue = (ext, key) => stripHtml(ext?.[key]?.value);

const normalizeAttribution = (attribution, sourceUrl) => ({
    author: attribution?.author ?? null,
    license: attribution?.license ?? null,
    licenseUrl: attribution?.licenseUrl ?? null,
    filePageUrl: attribution?.filePageUrl ?? sourceUrl ?? null,
    sourceUrl: sourceUrl ?? null,
});

const buildCandidate = ({ url, source, sourceUrl, attribution }) => ({
    url,
    source,
    sourceUrl,
    attribution: normalizeAttribution(attribution, sourceUrl),
});

/**
 * Resolves a Commons file name to a direct `upload.wikimedia.org` thumbnail
 * URL and licensing metadata via the `imageinfo` API. This CDN path has far
 * higher rate limits than `Special:FilePath` (which redirects and is
 * aggressively throttled per-IP — exactly the path that 429s when every client
 * funnels through this function).
 */
const resolveCommonsImage = async (fileName, width, fetchImpl) => {
    const title = `File:${fileName}`;
    const url =
        `https://commons.wikimedia.org/w/api.php?action=query` +
        `&titles=${encodeURIComponent(title)}` +
        `&prop=imageinfo` +
        `&iiprop=url|extmetadata` +
        `&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl` +
        `&iiurlwidth=${width}` +
        `&format=json&origin=*`;
    const res = await httpGet(url, { fetchImpl, headers: WIKI_HEADERS });
    if (!res.ok) return null;
    const body = await res.json();
    const pages = body?.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    const info = page?.imageinfo?.[0];
    const thumbUrl = info?.thumburl || info?.url || null;
    if (!thumbUrl) return null;
    const ext = info?.extmetadata ?? {};
    return {
        url: thumbUrl,
        attribution: {
            author: extMetaValue(ext, "Artist"),
            license: extMetaValue(ext, "LicenseShortName"),
            licenseUrl: extMetaValue(ext, "LicenseUrl"),
            filePageUrl: commonsFilePageUrl(fileName),
        },
    };
};

/** Best-effort Commons metadata for a CDN thumbnail URL. */
const enrichFromUploadUrl = async (rawUrl, source, sourceUrl, fetchImpl) => {
    const file = commonsFileFromUploadUrl(rawUrl);
    if (file) {
        const commons = await resolveCommonsImage(file, COVER_WIDTH, fetchImpl);
        if (commons) {
            return buildCandidate({
                url: commons.url,
                source,
                sourceUrl,
                attribution: commons.attribution,
            });
        }
    }
    return buildCandidate({
        url: normalizeWikiImageUrl(rawUrl, COVER_WIDTH),
        source,
        sourceUrl,
        attribution: { filePageUrl: sourceUrl },
    });
};

/** Wikipedia REST summary thumbnail for a page title, or null. */
const resolveWikipediaThumb = async (title, fetchImpl) => {
    const encoded = encodeURIComponent(String(title).replace(/ /g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
    const res = await httpGet(url, {
        fetchImpl,
        headers: { Accept: "application/json", ...WIKI_HEADERS },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.originalimage?.source || body?.thumbnail?.source || null;
};

/**
 * Runs the Wikidata→Wikipedia cascade and returns a candidate
 * `{ url, source, sourceUrl, attribution }`, or null when no image exists
 * anywhere. Throws [TransientUpstreamError] when a lookup fails in a way that
 * must not be cached as a hard negative.
 */
export const resolveImageCandidate = async ({
    wikidataId,
    name,
    hintImageUrl,
    fetchImpl = fetch,
}) => {
    if (hintImageUrl && /^https?:\/\//i.test(hintImageUrl)) {
        // Hints are typically Wikidata P18 `Special:FilePath` URLs. Resolve the
        // underlying file to a CDN thumbnail instead of hitting FilePath.
        const file = commonsFileFromFilePath(hintImageUrl);
        if (file) {
            const commons = await resolveCommonsImage(file, COVER_WIDTH, fetchImpl);
            if (commons) {
                return buildCandidate({
                    url: commons.url,
                    source: "wikidata",
                    sourceUrl: hintImageUrl,
                    attribution: commons.attribution,
                });
            }
        }
        return enrichFromUploadUrl(hintImageUrl, "wikidata", hintImageUrl, fetchImpl);
    }

    const qid = String(wikidataId || "").trim();
    if (/^Q\d+$/.test(qid)) {
        const file = await resolveWikidataImageFile(qid, fetchImpl);
        if (file) {
            const sourceUrl =
                `https://commons.wikimedia.org/wiki/Special:FilePath/` +
                encodeURIComponent(file);
            const commons = await resolveCommonsImage(file, COVER_WIDTH, fetchImpl);
            if (commons) {
                return buildCandidate({
                    url: commons.url,
                    source: "wikidata",
                    sourceUrl,
                    attribution: commons.attribution,
                });
            }
        }
        const title = await resolveWikipediaTitle(qid, fetchImpl);
        if (title) {
            const thumb = await resolveWikipediaThumb(title, fetchImpl);
            if (thumb) {
                const sourceUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
                return enrichFromUploadUrl(thumb, "wikipedia", sourceUrl, fetchImpl);
            }
        }
    }

    if (name) {
        const thumb = await resolveWikipediaThumb(name, fetchImpl);
        if (thumb) {
            const sourceUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`;
            return enrichFromUploadUrl(thumb, "wikipedia", sourceUrl, fetchImpl);
        }
    }

    return null;
};

const isFreshNegative = (data, now) => {
    const expires = data?.officialExpiresAt;
    if (!expires) return false;
    const expiresMs =
        typeof expires.toMillis === "function" ? expires.toMillis() : 0;
    return expiresMs > now;
};

/**
 * Cloud Function: resolves (and caches) the cover image for a place.
 *
 * The client reads `place-images/{placeKey}` directly and only calls this on a
 * miss or an expired negative. The function runs the Wikidata→Wikipedia
 * cascade, copies the winning image into our own Storage bucket, and persists
 * a cache document. Genuine misses are cached as 30-day hard negatives;
 * transient upstream failures are never persisted.
 */
export const resolvePlaceImage = onRequest(
    { cors: true, region: "europe-west3", timeoutSeconds: 60, memory: "512MiB" },
    async (req, res) => {
        const start = Date.now();
        try {
            await requireAuth(req);
            const payload = req.body || {};
            validateMandatoryFields(payload, ["name"]);

            const wikidataId = String(payload.wikidataId || "").trim();
            const name = String(payload.name).trim();
            const hintImageUrl = payload.hintImageUrl
                ? String(payload.hintImageUrl).trim()
                : null;
            const placeKey = placeKeyFor(wikidataId, name);

            const db = getFirestore();
            const docRef = db.collection(COLLECTION).doc(placeKey);
            const now = Date.now();

            const existing = await docRef.get();
            if (existing.exists) {
                const data = existing.data();
                if (data.status === "ready" && data.storageUrl) {
                    return res.status(200).json({
                        status: "ready",
                        source: data.source,
                        storageUrl: data.storageUrl,
                        attribution: data.attribution ?? null,
                    });
                }
                if (data.status === "notFound" && isFreshNegative(data, now)) {
                    return res.status(200).json({
                        status: "notFound",
                        reason: "hard",
                        officialExpiresAt: data.officialExpiresAt.toMillis(),
                    });
                }
            }

            const candidate = await resolveImageCandidate({
                wikidataId,
                name,
                hintImageUrl,
            });

            if (!candidate || !candidate.url) {
                const expiresAt = Timestamp.fromMillis(
                    now + HARD_NEGATIVE_TTL_DAYS * 24 * 60 * 60 * 1000,
                );
                await docRef.set({
                    schemaVersion: 1,
                    placeKey,
                    wikidataId: wikidataId || null,
                    status: "notFound",
                    source: null,
                    reason: "hard",
                    officialExpiresAt: expiresAt,
                    resolvedAt: FieldValue.serverTimestamp(),
                });
                return res.status(200).json({
                    status: "notFound",
                    reason: "hard",
                    officialExpiresAt: expiresAt.toMillis(),
                });
            }

            const imgRes = await httpGet(candidate.url, { headers: WIKI_HEADERS });
            if (!imgRes.ok) {
                // Candidate vanished (e.g. 404) — treat as a hard negative.
                const expiresAt = Timestamp.fromMillis(
                    now + HARD_NEGATIVE_TTL_DAYS * 24 * 60 * 60 * 1000,
                );
                await docRef.set({
                    schemaVersion: 1,
                    placeKey,
                    wikidataId: wikidataId || null,
                    status: "notFound",
                    source: null,
                    reason: "hard",
                    officialExpiresAt: expiresAt,
                    resolvedAt: FieldValue.serverTimestamp(),
                });
                return res.status(200).json({
                    status: "notFound",
                    reason: "hard",
                    officialExpiresAt: expiresAt.toMillis(),
                });
            }

            const bytes = Buffer.from(await imgRes.arrayBuffer());
            const webpBytes = await sharp(bytes)
                .resize(COVER_WIDTH, COVER_WIDTH, {
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .webp({ quality: COVER_WEBP_QUALITY })
                .toBuffer();

            const bucket = getStorage().bucket();
            const storagePath = `place-images/${placeKey}/cover.webp`;
            const token = randomUUID();
            const mime = "image/webp";
            await bucket.file(storagePath).save(webpBytes, {
                resumable: false,
                contentType: mime,
                metadata: {
                    cacheControl: "public, max-age=604800",
                    metadata: { firebaseStorageDownloadTokens: token },
                },
            });
            const storageUrl =
                `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
                `/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

            const attribution = candidate.attribution ?? normalizeAttribution(null, candidate.sourceUrl);

            await docRef.set({
                schemaVersion: 2,
                placeKey,
                wikidataId: wikidataId || null,
                status: "ready",
                source: candidate.source,
                storageUrl,
                storagePath,
                mime,
                attribution,
                officialExpiresAt: null,
                resolvedAt: FieldValue.serverTimestamp(),
            });

            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] resolved ${placeKey} (${candidate.source}) in ${elapsed}ms`);
            return res.status(200).json({
                status: "ready",
                source: candidate.source,
                storageUrl,
                attribution,
            });
        } catch (error) {
            const elapsed = Date.now() - start;
            if (error instanceof TransientUpstreamError) {
                // Soft negative: do not persist; let the client retry later.
                console.warn(`[${FUNCTION_NAME}] transient after ${elapsed}ms: ${error.message}`);
                return res.status(503).json({ error: "transient" });
            }
            const statusCode = error?.statusCode || 500;
            console.error(`[${FUNCTION_NAME}] error after ${elapsed}ms:`, error?.message || error);
            return res
                .status(statusCode)
                .json({ error: statusCode === 401 ? "unauthorized" : error?.message || "failed" });
        }
    },
);
