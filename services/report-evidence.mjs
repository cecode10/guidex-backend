import { placeKeyFor } from "../utils/place-key-utils.mjs";

export const REPORT_EVIDENCE_RETENTION_DAYS = 365;
export const EVIDENCE_STORAGE_PREFIX = "evidence";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILE_FIELDS = ["username", "displayName", "about", "photoUrl", "photoURL", "moderation"];

/**
 * Decodes the object path from a Firebase Storage download URL
 * (`https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?...`).
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export const storagePathFromFirebaseUrl = (url) => {
    if (typeof url !== "string" || !url) return null;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.hostname !== "firebasestorage.googleapis.com") return null;
    const marker = "/o/";
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return null;
    try {
        const path = decodeURIComponent(parsed.pathname.slice(index + marker.length));
        return path || null;
    } catch {
        return null;
    }
};

/**
 * @param {string | null} storagePath
 * @returns {string | null}
 */
export const placeKeyFromStoragePath = (storagePath) => {
    if (!storagePath?.startsWith("place-images/")) return null;
    const key = storagePath.split("/")[1];
    return key || null;
};

/**
 * Only the reported user's own uploads and the shared place-image cache are
 * copied; anything else is recorded by URL only.
 *
 * @param {string | null} storagePath
 * @param {string} ownerId
 * @returns {"user_upload" | "place_image" | null}
 */
export const storageImageKind = (storagePath, ownerId) => {
    if (!storagePath || storagePath.includes("..")) return null;
    if (ownerId && storagePath.startsWith(`users/${ownerId}/`)) return "user_upload";
    if (storagePath.startsWith("place-images/")) return "place_image";
    return null;
};

/**
 * @param {string} reportId
 * @returns {string}
 */
export const evidenceFolder = (reportId) => `${EVIDENCE_STORAGE_PREFIX}/${reportId}/`;

/**
 * @param {string} reportId
 * @param {string} baseName e.g. `post-image`
 * @param {string} sourcePath
 * @returns {string}
 */
export const evidenceFilePath = (reportId, baseName, sourcePath) => {
    const fileName = sourcePath.split("/").pop() || "";
    const dot = fileName.lastIndexOf(".");
    const extension = dot > 0 ? fileName.slice(dot).toLowerCase() : "";
    return `${evidenceFolder(reportId)}${baseName}${extension}`;
};

/**
 * @param {Record<string, unknown> | null} placeImage `place-images/{placeKey}` data.
 * @param {string} placeKey
 */
const creditsFromPlaceImage = (placeImage, placeKey) => {
    if (!placeImage || placeImage.status !== "ready") return null;
    const attribution = placeImage.attribution && typeof placeImage.attribution === "object"
        ? placeImage.attribution
        : {};
    return {
        ...attribution,
        source: typeof placeImage.source === "string" ? placeImage.source : null,
        placeKey,
        wikidataId: typeof placeImage.wikidataId === "string" ? placeImage.wikidataId : null,
    };
};

const trimmedString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Records where an image came from and copies it into the report's evidence folder.
 *
 * @param {{
 *   store: { copyFile: (sourcePath: string, destinationPath: string) => Promise<boolean> },
 *   reportId: string,
 *   ownerId: string,
 *   originalUrl: string | null,
 *   declaredStoragePath: string | null,
 *   baseName: string,
 * }} input
 */
const captureImage = async ({ store, reportId, ownerId, originalUrl, declaredStoragePath, baseName }) => {
    const originalStoragePath = declaredStoragePath || storagePathFromFirebaseUrl(originalUrl);
    if (!originalUrl && !originalStoragePath) return null;

    const storageKind = storageImageKind(originalStoragePath, ownerId);
    const image = {
        kind: storageKind || "external",
        originalUrl,
        originalStoragePath: storageKind ? originalStoragePath : null,
        copyStoragePath: null,
        copySkippedReason: null,
    };
    if (!storageKind) {
        image.copySkippedReason = "external_url";
        return image;
    }

    const destination = evidenceFilePath(reportId, baseName, originalStoragePath);
    try {
        const copied = await store.copyFile(originalStoragePath, destination);
        if (copied) {
            image.copyStoragePath = destination;
        } else {
            image.copySkippedReason = "original_missing";
        }
    } catch (error) {
        console.error(
            "report-evidence: image copy failed reportId=%s path=%s error=%s",
            reportId,
            originalStoragePath,
            error?.message || error,
        );
        image.copySkippedReason = "copy_failed";
    }
    return image;
};

const capturePost = async ({ store, reportId, reportedUserId, postId }) => {
    const sourcePath = `users/${reportedUserId}/checkins/${postId}`;
    const data = await store.getCheckIn(reportedUserId, postId);
    if (!data) {
        return { status: "post_not_found", sourcePath, data: null, image: null };
    }

    const image = await captureImage({
        store,
        reportId,
        ownerId: reportedUserId,
        originalUrl: trimmedString(data.imageUrl),
        declaredStoragePath: trimmedString(data.moderation?.storagePath),
        baseName: "post-image",
    });
    if (image) {
        image.credits = null;
        if (image.kind !== "user_upload") {
            const placeKey = placeKeyFromStoragePath(image.originalStoragePath)
                ?? placeKeyFor(data.wikidataId, data.locationName);
            image.credits = creditsFromPlaceImage(await store.getPlaceImage(placeKey), placeKey);
        }
    }
    return { status: "captured", sourcePath, data, image };
};

const captureProfile = async ({ store, reportId, reportedUserId, toTimestamp }) => {
    const sourcePath = `users/${reportedUserId}`;
    const [profile, accountCreatedAtMs] = await Promise.all([
        store.getUserProfile(reportedUserId),
        store.getAccountCreatedAtMs(reportedUserId),
    ]);
    const accountCreatedAt = accountCreatedAtMs == null ? null : toTimestamp(accountCreatedAtMs);
    if (!profile) {
        return { status: "profile_not_found", sourcePath, data: null, avatar: null, accountCreatedAt };
    }

    const data = {};
    for (const field of PROFILE_FIELDS) {
        if (profile[field] !== undefined) data[field] = profile[field];
    }
    const avatar = await captureImage({
        store,
        reportId,
        ownerId: reportedUserId,
        originalUrl: trimmedString(profile.photoUrl) || trimmedString(profile.photoURL),
        declaredStoragePath: null,
        baseName: "profile-avatar",
    });
    return { status: "captured", sourcePath, data, avatar, accountCreatedAt };
};

/**
 * Builds the evidence stored on `user-reports/{reportId}.evidence`: a copy of
 * the reported post (when the report came from a post) and of the reported
 * user's profile. Copied images go to `evidence/{reportId}/` in Storage.
 *
 * @param {{
 *   store: {
 *     getCheckIn: (uid: string, id: string) => Promise<Record<string, unknown> | null>,
 *     getUserProfile: (uid: string) => Promise<Record<string, unknown> | null>,
 *     getAccountCreatedAtMs: (uid: string) => Promise<number | null>,
 *     getPlaceImage: (placeKey: string) => Promise<Record<string, unknown> | null>,
 *     copyFile: (sourcePath: string, destinationPath: string) => Promise<boolean>,
 *   },
 *   reportId: string,
 *   reportedUserId: string,
 *   postId?: string,
 *   nowMs: number,
 *   capturedAt: unknown,
 *   toTimestamp: (ms: number) => unknown,
 * }} input
 * @returns {Promise<Record<string, unknown> | null>} `null` when no user was reported.
 */
export const captureReportEvidence = async ({
    store,
    reportId,
    reportedUserId,
    postId = "",
    nowMs,
    capturedAt,
    toTimestamp,
}) => {
    if (!reportedUserId || reportedUserId.includes("/")) return null;
    const hasPost = Boolean(postId) && !postId.includes("/");

    const [post, profile] = await Promise.all([
        hasPost ? capturePost({ store, reportId, reportedUserId, postId }) : null,
        captureProfile({ store, reportId, reportedUserId, toTimestamp }),
    ]);
    return {
        capturedAt,
        expiresAt: toTimestamp(nowMs + REPORT_EVIDENCE_RETENTION_DAYS * DAY_MS),
        storageFolder: evidenceFolder(reportId),
        post,
        profile,
    };
};

/**
 * Removes evidence whose retention period has ended. The report itself is kept.
 *
 * @param {{
 *   store: {
 *     listExpiredEvidence: (nowMs: number, limit: number) => Promise<string[]>,
 *     deleteFolder: (prefix: string) => Promise<void>,
 *     purgeEvidence: (reportId: string) => Promise<void>,
 *   },
 *   nowMs: number,
 *   limit?: number,
 * }} input
 * @returns {Promise<number>} Number of reports whose evidence was purged.
 */
export const purgeExpiredReportEvidence = async ({ store, nowMs, limit = 200 }) => {
    const reportIds = await store.listExpiredEvidence(nowMs, limit);
    let purged = 0;
    for (const reportId of reportIds) {
        try {
            await store.deleteFolder(evidenceFolder(reportId));
            await store.purgeEvidence(reportId);
            purged += 1;
        } catch (error) {
            console.error(
                "report-evidence: purge failed reportId=%s error=%s",
                reportId,
                error?.message || error,
            );
        }
    }
    return purged;
};
