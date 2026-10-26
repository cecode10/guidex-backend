/**
 * Hard purge of a user account, intended for test accounts.
 *
 * Unlike `deleteUserAccount` (account-deletion-service.mjs) this leaves no
 * tombstone and no `accountDeletions` audit record: it removes the profile
 * tree, every Storage object, the Auth user, and every reference other users'
 * data holds to the account (likes, follow edges, block lists, reports).
 *
 * Every step is idempotent, so a partially failed purge is finished by
 * running it again.
 */
import { FieldValue } from "firebase-admin/firestore";
import { evidenceFolder } from "./report-evidence.mjs";

const BATCH_SIZE = 400;

/**
 * @param {FirebaseFirestore.DocumentReference} ref
 * @param {string} uid
 */
const isInUserTree = (ref, uid) => ref.path.startsWith(`users/${uid}/`);

/**
 * @param {FirebaseFirestore.QuerySnapshot} snapshot
 * @param {string} uid
 * @returns {FirebaseFirestore.DocumentReference[]}
 */
const refsOutsideUserTree = (snapshot, uid) =>
    snapshot.docs.map((doc) => doc.ref).filter((ref) => !isInUserTree(ref, uid));

/**
 * Counts [ref] (when it exists) and every document below it, including
 * subcollections of documents that do not exist themselves.
 *
 * @param {FirebaseFirestore.DocumentReference} ref
 * @returns {Promise<number>}
 */
const countDocumentTree = async (ref) => {
    let count = (await ref.get()).exists ? 1 : 0;
    for (const collection of await ref.listCollections()) {
        for (const child of await collection.listDocuments()) {
            count += await countDocumentTree(child);
        }
    }
    return count;
};

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {FirebaseFirestore.DocumentReference[]} refs
 * @param {(batch: FirebaseFirestore.WriteBatch, ref: FirebaseFirestore.DocumentReference) => void} apply
 */
const commitInBatches = async (db, refs, apply) => {
    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const ref of refs.slice(i, i + BATCH_SIZE)) {
            apply(batch, ref);
        }
        await batch.commit();
    }
};

/**
 * @param {import("@google-cloud/storage").Bucket} bucket
 * @param {string} prefix
 * @returns {Promise<number>}
 */
const countFiles = async (bucket, prefix) => {
    const [files] = await bucket.getFiles({ prefix });
    return files.length;
};

/**
 * @param {import("firebase-admin/auth").Auth} auth
 * @param {string} uid
 * @returns {Promise<import("firebase-admin/auth").UserRecord | null>}
 */
const getAuthUser = async (auth, uid) => {
    try {
        return await auth.getUser(uid);
    } catch (error) {
        if (error?.code === "auth/user-not-found") return null;
        throw error;
    }
};

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {import("@google-cloud/storage").Bucket} bucket
 * @param {import("firebase-admin/auth").Auth} auth
 */
export const createAccountPurger = (db, bucket, auth) => {
    const userRef = (uid) => db.collection("users").doc(uid);
    const userStoragePrefix = (uid) => `users/${uid}/`;

    /**
     * Resolves a uid or email to the uids it names. Email lookups check Auth
     * first, then `users.email`, so profiles whose Auth user is already gone
     * are still found.
     *
     * @param {string} identifier
     * @returns {Promise<string[]>}
     */
    const resolveUids = async (identifier) => {
        const value = String(identifier ?? "").trim();
        if (!value) return [];
        if (!value.includes("@")) {
            if (value.includes("/")) throw new Error(`invalid uid: ${value}`);
            return [value];
        }

        const uids = new Set();
        try {
            uids.add((await auth.getUserByEmail(value)).uid);
        } catch (error) {
            if (error?.code !== "auth/user-not-found") throw error;
        }
        for (const email of new Set([value, value.toLowerCase()])) {
            const snap = await db.collection("users").where("email", "==", email).get();
            for (const doc of snap.docs) uids.add(doc.id);
        }
        return [...uids];
    };

    /**
     * Collects everything that belongs to or references [uid]. Read-only.
     *
     * @param {string} uid
     */
    const inspect = async (uid) => {
        if (!uid || uid.includes("/")) throw new Error(`invalid uid: ${uid}`);

        const [
            authUser,
            profileSnap,
            profileDocCount,
            storageFileCount,
            followerSnap,
            likeSnap,
            postSnap,
            blockedBySnap,
            feedbackSnap,
            reportedBySnap,
            reportedSnap,
            deletionAuditSnap,
        ] = await Promise.all([
            getAuthUser(auth, uid),
            userRef(uid).get(),
            countDocumentTree(userRef(uid)),
            countFiles(bucket, userStoragePrefix(uid)),
            db.collectionGroup("friends").where("friendId", "==", uid).get(),
            db.collectionGroup("likes").where("userId", "==", uid).get(),
            db.collection("posts").where("authorId", "==", uid).get(),
            db.collection("users").where("blockedUserIds", "array-contains", uid).get(),
            db.collection("customer-feedback").where("customerId", "==", uid).get(),
            db.collection("user-reports").where("reporterId", "==", uid).get(),
            db.collection("user-reports").where("reportedUserId", "==", uid).get(),
            db.collection("accountDeletions").doc(uid).get(),
        ]);

        const reportRefs = new Map();
        for (const doc of [...reportedBySnap.docs, ...reportedSnap.docs]) {
            reportRefs.set(doc.id, doc.ref);
        }
        const evidenceFileCounts = await Promise.all(
            [...reportRefs.keys()].map((reportId) => countFiles(bucket, evidenceFolder(reportId))),
        );

        return {
            uid,
            email: authUser?.email || profileSnap.data()?.email || null,
            authUser: Boolean(authUser),
            profileDocCount,
            storageFileCount,
            followerEdges: refsOutsideUserTree(followerSnap, uid),
            likesGiven: refsOutsideUserTree(likeSnap, uid),
            posts: postSnap.docs.map((doc) => doc.ref),
            blockedBy: blockedBySnap.docs.map((doc) => doc.ref).filter((ref) => ref.id !== uid),
            feedback: feedbackSnap.docs.map((doc) => doc.ref),
            reports: [...reportRefs.values()],
            evidenceFileCount: evidenceFileCounts.reduce((sum, n) => sum + n, 0),
            deletionAudit: deletionAuditSnap.exists,
        };
    };

    /**
     * @param {Awaited<ReturnType<typeof inspect>>} found
     * @returns {Record<string, number>}
     */
    const summarize = (found) => ({
        authUser: found.authUser ? 1 : 0,
        profileDocs: found.profileDocCount,
        storageFiles: found.storageFileCount,
        followerEdges: found.followerEdges.length,
        likesGiven: found.likesGiven.length,
        posts: found.posts.length,
        blockedBy: found.blockedBy.length,
        feedback: found.feedback.length,
        reports: found.reports.length,
        evidenceFiles: found.evidenceFileCount,
        deletionAudit: found.deletionAudit ? 1 : 0,
    });

    /**
     * Removes a like and decrements the parent's `likeCount`. The like is
     * re-read inside the transaction so a re-run never double-decrements.
     *
     * @param {FirebaseFirestore.DocumentReference} likeRef
     */
    const removeLike = (likeRef) =>
        db.runTransaction(async (tx) => {
            const parentRef = likeRef.parent.parent;
            const [likeSnap, parentSnap] = await Promise.all([
                tx.get(likeRef),
                parentRef ? tx.get(parentRef) : null,
            ]);
            if (!likeSnap.exists) return;
            tx.delete(likeRef);
            const likeCount = parentSnap?.exists ? parentSnap.get("likeCount") : null;
            if (typeof likeCount === "number" && likeCount > 0) {
                tx.update(parentRef, { likeCount: FieldValue.increment(-1) });
            }
        });

    /**
     * Deletes everything [inspect] found. References held by other users go
     * first and the Auth user goes last, so an interrupted run can still be
     * resumed by email.
     *
     * @param {string} uid
     * @param {{ log?: (message: string) => void }} [options]
     * @returns {Promise<Record<string, number>>} What was removed.
     */
    const purge = async (uid, { log = () => {} } = {}) => {
        const found = await inspect(uid);

        for (const likeRef of found.likesGiven) {
            await removeLike(likeRef);
        }
        log(`likes removed: ${found.likesGiven.length}`);

        await commitInBatches(db, found.followerEdges, (batch, ref) => batch.delete(ref));
        log(`follower edges removed: ${found.followerEdges.length}`);

        await commitInBatches(db, found.blockedBy, (batch, ref) =>
            batch.update(ref, { blockedUserIds: FieldValue.arrayRemove(uid) }));
        log(`removed from block lists: ${found.blockedBy.length}`);

        for (const postRef of found.posts) {
            await db.recursiveDelete(postRef);
        }
        log(`posts removed: ${found.posts.length}`);

        await commitInBatches(db, found.feedback, (batch, ref) => batch.delete(ref));
        log(`feedback removed: ${found.feedback.length}`);

        for (const reportRef of found.reports) {
            await bucket.deleteFiles({ prefix: evidenceFolder(reportRef.id) });
            await db.recursiveDelete(reportRef);
        }
        log(`reports removed: ${found.reports.length} (evidence files: ${found.evidenceFileCount})`);

        await db.collection("accountDeletions").doc(uid).delete();

        await bucket.deleteFiles({ prefix: userStoragePrefix(uid) });
        log(`storage files removed: ${found.storageFileCount}`);

        await db.recursiveDelete(userRef(uid));
        log(`profile documents removed: ${found.profileDocCount}`);

        if (found.authUser) {
            try {
                await auth.deleteUser(uid);
            } catch (error) {
                if (error?.code !== "auth/user-not-found") throw error;
            }
        }
        log(`auth user removed: ${found.authUser ? "yes" : "no (already gone)"}`);

        return summarize(found);
    };

    /**
     * Re-inspects [uid] after a purge.
     *
     * @param {string} uid
     * @returns {Promise<Record<string, number>>} Only the categories with leftovers.
     */
    const leftovers = async (uid) =>
        Object.fromEntries(
            Object.entries(summarize(await inspect(uid))).filter(([, count]) => count > 0),
        );

    return { resolveUids, inspect, summarize, purge, leftovers };
};
