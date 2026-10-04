import { FieldValue, Timestamp } from "firebase-admin/firestore";

const REPORTS_COLLECTION = "user-reports";

/**
 * Download token left on a Storage object, or an empty string when the object
 * cannot be fetched by a public Firebase download URL.
 *
 * @param {{ metadata?: { firebaseStorageDownloadTokens?: unknown } } | null | undefined} metadata
 * @returns {string}
 */
export const evidenceDownloadToken = (metadata) => {
    const token = metadata?.metadata?.firebaseStorageDownloadTokens;
    return typeof token === "string" ? token.trim() : "";
};

export const createReportEvidenceStore = (db, bucket, auth) => ({
    async getCheckIn(uid, id) {
        const snap = await db.collection("users").doc(uid).collection("checkins").doc(id).get();
        return snap.exists ? (snap.data() || {}) : null;
    },

    async getUserProfile(uid) {
        const snap = await db.collection("users").doc(uid).get();
        return snap.exists ? (snap.data() || {}) : null;
    },

    async getAccountCreatedAtMs(uid) {
        try {
            const user = await auth.getUser(uid);
            const ms = Date.parse(user.metadata?.creationTime || "");
            return Number.isFinite(ms) ? ms : null;
        } catch (error) {
            if (error?.code === "auth/user-not-found") return null;
            throw error;
        }
    },

    async getPlaceImage(placeKey) {
        const snap = await db.collection("place-images").doc(placeKey).get();
        return snap.exists ? (snap.data() || null) : null;
    },

    async copyFile(sourcePath, destinationPath) {
        const source = bucket.file(sourcePath);
        const [exists] = await source.exists();
        if (!exists) return false;
        const destination = bucket.file(destinationPath);
        await source.copy(destination);
        try {
            // copy() keeps the source download token, and that URL bypasses Storage rules.
            await destination.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
            const [metadata] = await destination.getMetadata();
            if (evidenceDownloadToken(metadata)) {
                throw new Error("evidence copy kept a download token");
            }
        } catch (error) {
            await destination.delete({ ignoreNotFound: true }).catch(() => {});
            throw error;
        }
        return true;
    },

    async saveEvidence(reportId, evidence) {
        await db.collection(REPORTS_COLLECTION).doc(reportId).update({ evidence });
    },

    async listExpiredEvidence(nowMs, limit) {
        const snap = await db.collection(REPORTS_COLLECTION)
            .where("evidence.expiresAt", "<=", Timestamp.fromMillis(nowMs))
            .limit(limit)
            .get();
        return snap.docs.map((doc) => doc.id);
    },

    async deleteFolder(prefix) {
        await bucket.deleteFiles({ prefix });
    },

    async purgeEvidence(reportId) {
        await db.collection(REPORTS_COLLECTION).doc(reportId).update({
            evidence: FieldValue.delete(),
            evidencePurgedAt: FieldValue.serverTimestamp(),
        });
    },
});
