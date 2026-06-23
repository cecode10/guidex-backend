#!/usr/bin/env node
/**
 * One-off migration: tombstone Firestore user profiles whose Auth account
 * no longer exists (orphaned before profile cleanup shipped).
 *
 * Usage:
 *   cd backend
 *   export GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
 *   node scripts/tombstone-orphaned-user-profiles.mjs --dry-run
 *   node scripts/tombstone-orphaned-user-profiles.mjs
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { removeUserFromFollowGraph, tombstoneUserProfile } from "../account-deletion-service.mjs";

const dryRun = process.argv.includes("--dry-run");

initializeApp();

const db = getFirestore();
const auth = getAuth();

const snapshot = await db.collection("users").get();
let scanned = 0;
let tombstoned = 0;
let skipped = 0;

for (const doc of snapshot.docs) {
    scanned += 1;
    const data = doc.data() ?? {};
    if (data.accountDeleted === true) {
        skipped += 1;
        continue;
    }

    try {
        await auth.getUser(doc.id);
        continue;
    } catch (error) {
        if (error?.code !== "auth/user-not-found") {
            throw error;
        }
    }

    if (dryRun) {
        console.log("[dry-run] would clean up users/%s", doc.id);
    } else {
        await removeUserFromFollowGraph(doc.id);
        await tombstoneUserProfile(doc.id);
        console.log("cleaned up users/%s", doc.id);
    }
    tombstoned += 1;
}

console.log(
    "done scanned=%d cleaned=%d skippedAlreadyDeleted=%d dryRun=%s",
    scanned,
    tombstoned,
    skipped,
    dryRun,
);
