import { FieldValue } from "firebase-admin/firestore";
import {
    DELETE_FIELD,
    imageDataUrlFromBuffer,
    isAllowedProfilePhotoUrl,
    ModerationHttpError,
} from "./content-moderation.mjs";

const fetchAllowedProfileImage = async (url) => {
    const first = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
    });
    if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get("location");
        let next = "";
        try {
            next = new URL(location || "", url).toString();
        } catch {
            next = "";
        }
        if (!isAllowedProfilePhotoUrl(next)) {
            throw new ModerationHttpError(400, "photoUrl is invalid");
        }
        const second = await fetch(next, {
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
        });
        if (!second.ok) {
            throw new ModerationHttpError(503, "photo fetch failed");
        }
        return second;
    }
    if (!first.ok) {
        throw new ModerationHttpError(503, "photo fetch failed");
    }
    return first;
};

const mapFieldDeletes = (data) => {
    const mapped = {};
    for (const [key, value] of Object.entries(data)) {
        mapped[key] = value === DELETE_FIELD ? FieldValue.delete() : value;
    }
    return mapped;
};

export const createModerationStore = (db, bucket) => ({
    async getUser(uid) {
        const snap = await db.collection("users").doc(uid).get();
        return snap.exists ? (snap.data() || null) : null;
    },

    async mergeUser(uid, data) {
        await db.collection("users").doc(uid).set(mapFieldDeletes(data), { merge: true });
    },

    async setCheckIn(uid, id, data) {
        await db.collection("users").doc(uid).collection("checkins").doc(id).set(data);
    },

    async deleteCheckIn(uid, id) {
        await db.collection("users").doc(uid).collection("checkins").doc(id).delete();
    },

    async addReview(uid, data) {
        await db.collection("users").doc(uid).collection("contentReviews").add(data);
    },

    async loadStorageImage(storagePath) {
        const file = bucket.file(storagePath);
        const [exists] = await file.exists();
        if (!exists) {
            throw new ModerationHttpError(400, "image not found");
        }
        const [metadata] = await file.getMetadata();
        const [buffer] = await file.download();
        return imageDataUrlFromBuffer(metadata?.contentType, buffer);
    },

    async deleteStorageImage(storagePath) {
        if (!storagePath) return;
        await bucket.file(storagePath).delete({ ignoreNotFound: true });
    },

    async loadRemoteImage(url) {
        if (!isAllowedProfilePhotoUrl(url)) {
            throw new ModerationHttpError(400, "photoUrl is invalid");
        }
        const response = await fetchAllowedProfileImage(url);
        const buffer = Buffer.from(await response.arrayBuffer());
        return imageDataUrlFromBuffer(response.headers.get("content-type"), buffer);
    },

    async listPendingCheckIns(limit) {
        const snap = await db.collectionGroup("checkins")
            .where("moderation.status", "==", "pending")
            .limit(limit)
            .get();
        return snap.docs.map((doc) => ({
            uid: doc.ref.parent.parent?.id,
            id: doc.id,
            data: doc.data(),
        }));
    },

    async listPendingProfiles(limit) {
        const snap = await db.collection("users")
            .where("moderation.status", "==", "pending")
            .limit(limit)
            .get();
        return snap.docs.map((doc) => ({
            uid: doc.id,
            data: doc.data(),
        }));
    },
});
