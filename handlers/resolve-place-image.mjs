import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";

const FUNCTION_NAME = "resolvePlaceImage";
const COLLECTION = "placeImages";

/** Days a genuine "no image" result is trusted before the cascade re-runs. */
const HARD_NEGATIVE_TTL_DAYS = 30;
/** Server-resized thumbnail width we persist as the place cover. */
const COVER_WIDTH = 1600;
/** Upstream request timeout (Wikimedia/Wikidata can be slow under load). */
const UPSTREAM_TIMEOUT_MS = 12000;
/** Total attempts for retryable upstream failures (timeout / 5xx). */
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

/**
 * HTTP GET with the project's retry policy:
 * - timeout / 5xx: retried up to [UPSTREAM_MAX_ATTEMPTS] total, then transient.
 * - 429: fail fast as transient (never retried, never cached).
 * - everything else (2xx, 404, ...): returned to the caller as-is.
 */
export const httpGet = async (url, { fetchImpl = fetch, headers } = {}) => {
    let lastError;
    for (let attempt = 0; attempt < UPSTREAM_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
        try {
            const res = await fetchImpl(url, {
                headers,
                signal: controller.signal,
            });
            if (res.status === 429) {
                throw new TransientUpstreamError(`429 from ${url}`);
            }
            if (res.status >= 500) {
                lastError = new TransientUpstreamError(`${res.status} from ${url}`);
                continue;
            }
            return res;
        } catch (err) {
            if (err instanceof TransientUpstreamError) throw err;
            // AbortError / network error → retryable.
            lastError = new TransientUpstreamError(err?.message || "network error");
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

/** Wikidata `P18` image filename → Commons file URL, or null. */
const resolveWikidataImage = async (wikidataId, fetchImpl) => {
    const url =
        `https://www.wikidata.org/w/api.php?action=wbgetentities` +
        `&props=claims&ids=${encodeURIComponent(wikidataId)}` +
        `&format=json&origin=*`;
    const res = await httpGet(url, { fetchImpl });
    if (!res.ok) return null;
    const body = await res.json();
    const claims = body?.entities?.[wikidataId]?.claims?.P18;
    const file = claims?.[0]?.mainsnak?.datavalue?.value;
    if (!file) return null;
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(
        file,
    )}`;
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
 * `{ url, source, sourceUrl }`, or null when no image exists anywhere.
 * Throws [TransientUpstreamError] when a lookup fails in a way that must not
 * be cached as a hard negative.
 */
export const resolveImageCandidate = async ({
    wikidataId,
    name,
    hintImageUrl,
    fetchImpl = fetch,
}) => {
    if (hintImageUrl && /^https?:\/\//i.test(hintImageUrl)) {
        return {
            url: normalizeWikiImageUrl(hintImageUrl, COVER_WIDTH),
            source: "wikidata",
            sourceUrl: hintImageUrl,
        };
    }

    const qid = String(wikidataId || "").trim();
    if (/^Q\d+$/.test(qid)) {
        const p18 = await resolveWikidataImage(qid, fetchImpl);
        if (p18) {
            return {
                url: normalizeWikiImageUrl(p18, COVER_WIDTH),
                source: "wikidata",
                sourceUrl: p18,
            };
        }
        const title = await resolveWikipediaTitle(qid, fetchImpl);
        if (title) {
            const thumb = await resolveWikipediaThumb(title, fetchImpl);
            if (thumb) {
                return {
                    url: normalizeWikiImageUrl(thumb, COVER_WIDTH),
                    source: "wikipedia",
                    sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
                };
            }
        }
    }

    if (name) {
        const thumb = await resolveWikipediaThumb(name, fetchImpl);
        if (thumb) {
            return {
                url: normalizeWikiImageUrl(thumb, COVER_WIDTH),
                source: "wikipedia",
                sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`,
            };
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
 * The client reads `placeImages/{placeKey}` directly and only calls this on a
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
                    return res
                        .status(200)
                        .json({ status: "ready", source: data.source, storageUrl: data.storageUrl });
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

            const mime = imgRes.headers.get("content-type") || "image/jpeg";
            const bytes = Buffer.from(await imgRes.arrayBuffer());

            const bucket = getStorage().bucket();
            const storagePath = `place-images/${placeKey}/cover.jpg`;
            const token = randomUUID();
            await bucket.file(storagePath).save(bytes, {
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

            await docRef.set({
                schemaVersion: 1,
                placeKey,
                wikidataId: wikidataId || null,
                status: "ready",
                source: candidate.source,
                storageUrl,
                storagePath,
                mime,
                attribution: { sourceUrl: candidate.sourceUrl || null },
                officialExpiresAt: null,
                resolvedAt: FieldValue.serverTimestamp(),
            });

            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] resolved ${placeKey} (${candidate.source}) in ${elapsed}ms`);
            return res
                .status(200)
                .json({ status: "ready", source: candidate.source, storageUrl });
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
