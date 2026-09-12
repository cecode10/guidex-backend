import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { newlyBlockedUserIds } from "../utils/blocked-users-utils.mjs";

/**
 * When a user blocks someone, drop follow edges both ways so the blocked
 * person is treated like Privacy → No one (cannot follow or keep following).
 */
export const onBlockedUsersUpdated = onDocumentUpdated(
    {
        document: "users/{uid}",
        region: "europe-west3",
    },
    async (event) => {
        const blockerId = event.params.uid;
        const added = newlyBlockedUserIds(
            event.data?.before.data(),
            event.data?.after.data(),
        );
        if (added.length === 0) return null;

        const db = getFirestore();
        const batch = db.batch();
        let ops = 0;

        for (const blockedId of added) {
            if (!blockedId || blockedId === blockerId) continue;
            batch.delete(
                db.collection("users").doc(blockerId).collection("friends").doc(blockedId),
            );
            batch.delete(
                db.collection("users").doc(blockedId).collection("friends").doc(blockerId),
            );
            ops += 2;
        }

        if (ops === 0) return null;
        await batch.commit();
        console.log(
            "onBlockedUsersUpdated: blockerId=%s removedFollowEdges=%d newlyBlocked=%s",
            blockerId,
            ops,
            added.join(","),
        );
        return null;
    },
);
