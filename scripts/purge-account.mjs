#!/usr/bin/env node
/**
 * Permanently removes test accounts: Auth user, `users/{uid}` and all its
 * subcollections, Storage under `users/{uid}/`, plus every reference other
 * users' data holds (likes, follow edges, block lists, posts, feedback,
 * reports and their evidence, `accountDeletions/{uid}`). No tombstone.
 *
 * Dry run by default — it only prints what would be removed.
 *
 *   node scripts/purge-account.mjs <uid|email> [more...]
 *   node scripts/purge-account.mjs <uid|email> [more...] --execute
 *   node scripts/purge-account.mjs <uid|email> --execute --yes   # no prompt
 *
 * Options:
 *   --execute            Actually delete. Without it nothing is changed.
 *   --yes                Skip the confirmation prompt (with --execute).
 *   --credentials PATH   Service account JSON (default: scripts/guidex-afc30-*.json).
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { loadCredential } from "./seed/script-common.mjs";
import { createAccountPurger } from "../services/account-purge.mjs";

const SCRIPT_LABEL = "purge-account";
const PROJECT_ID = "guidex-afc30";
const STORAGE_BUCKET = "guidex-afc30.firebasestorage.app";

const USAGE = "usage: node scripts/purge-account.mjs <uid|email> [more...] [--execute] [--yes] [--credentials PATH]";

/**
 * @param {Record<string, number>} counts
 */
const formatCounts = (counts) =>
    Object.entries(counts)
        .map(([key, count]) => `    ${key.padEnd(14)} ${count}`)
        .join("\n");

/**
 * @param {string} question
 */
const ask = async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
};

const main = async () => {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            execute: { type: "boolean", default: false },
            yes: { type: "boolean", default: false },
            credentials: { type: "string", default: "" },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help || positionals.length === 0) {
        console.log(USAGE);
        process.exit(values.help ? 0 : 1);
    }

    initializeApp({
        credential: loadCredential(values.credentials, SCRIPT_LABEL),
        projectId: PROJECT_ID,
        storageBucket: STORAGE_BUCKET,
    });
    const purger = createAccountPurger(getFirestore(), getStorage().bucket(), getAuth());

    const uids = new Set();
    for (const identifier of positionals) {
        const resolved = await purger.resolveUids(identifier);
        if (resolved.length === 0) {
            console.error(`no account found for ${identifier}`);
            process.exitCode = 1;
        }
        for (const uid of resolved) uids.add(uid);
    }
    if (uids.size === 0) return;

    console.log(`\n${values.execute ? "PURGE" : "DRY RUN"} — project ${PROJECT_ID}\n`);
    const targets = [];
    for (const uid of uids) {
        const found = await purger.inspect(uid);
        const counts = purger.summarize(found);
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        console.log(`  ${uid}  ${found.email ?? "(no email)"}`);
        console.log(total === 0 ? "    nothing left to remove" : formatCounts(counts));
        console.log("");
        if (total > 0) targets.push(uid);
    }

    if (!values.execute) {
        console.log("Dry run only. Re-run with --execute to delete.");
        return;
    }
    if (targets.length === 0) {
        console.log("Nothing to purge.");
        return;
    }

    if (!values.yes) {
        const expected = targets.length === 1 ? targets[0] : String(targets.length);
        const prompt = targets.length === 1
            ? `Type the uid to permanently delete it: `
            : `Type ${targets.length} to permanently delete these accounts: `;
        if ((await ask(prompt)) !== expected) {
            console.log("Aborted, nothing deleted.");
            process.exitCode = 1;
            return;
        }
    }

    for (const uid of targets) {
        console.log(`\npurging ${uid}`);
        try {
            await purger.purge(uid, { log: (message) => console.log(`  ${message}`) });
        } catch (error) {
            console.error(`  FAILED: ${error?.message || error}`);
            console.error("  Re-run the same command to finish the purge.");
            process.exitCode = 1;
            continue;
        }

        const remaining = await purger.leftovers(uid);
        if (Object.keys(remaining).length === 0) {
            console.log("  verified: nothing left");
        } else {
            console.error(`  LEFTOVERS (re-run to finish):\n${formatCounts(remaining)}`);
            process.exitCode = 1;
        }
    }
};

const isDirectRun =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
    main().catch((error) => {
        console.error(error?.stack || error);
        process.exit(1);
    });
}
