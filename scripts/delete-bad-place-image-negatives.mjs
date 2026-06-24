#!/usr/bin/env node
/**
 * Deletes stale `place-images` hard-negative cache entries that block Explore
 * tiles from re-resolving (Phase A cleanup).
 *
 * A document is treated as a "bad negative" when:
 *   - status === "notFound", and
 *   - the place key or stored wikidataId is a Wikidata QID (Q…), or
 *   - schemaVersion < 3 with a Wikidata QID (legacy retryable negatives)
 *
 * Optional `--verify-p18` keeps only negatives whose Wikidata entity has P18
 * (slower; uses the Wikidata API). Without it, all Wikidata-backed notFound
 * docs are removed so the resolver can run again.
 *
 * Prerequisites
 * -------------
 *   cd backend && npm install
 *   export GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
 *
 * Usage
 * -----
 *   node scripts/delete-bad-place-image-negatives.mjs --dry-run
 *   node scripts/delete-bad-place-image-negatives.mjs --credentials scripts/guidex-afc30-2758ce305a68.json
 *   node scripts/delete-bad-place-image-negatives.mjs --clear-explore
 *   node scripts/delete-bad-place-image-negatives.mjs --credentials path/to/sa.json
 *
 * Flags
 * -----
 *   --dry-run              List targets only; no writes
 *   --verify-p18           Delete only when Wikidata P18 exists (API check)
 *   --clear-explore        Clear imageStatus=notFound on matching popularAroundList rows
 *   --include-name-keys    Also delete name:… slug notFound docs
 *   --limit N              Process at most N place-images docs (scan cap)
 *   --project ID           Firebase project id (default: guidex-afc30)
 *   --credentials PATH     Service account JSON (overrides env var)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import {
    COLLECTION as GEO_COLLECTION,
    POPULAR_AROUND_SUBCOLLECTION,
} from "../geo-location-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLACE_IMAGES_COLLECTION = "place-images";
const NEGATIVE_SCHEMA_VERSION = 3;
const QID_RE = /^Q\d+$/;
const WIKI_HEADERS = {
    "User-Agent": "guideX-mobile (https://guidex.app)",
    Accept: "application/json",
};

/** @param {unknown} value */
const isValidQid = (value) => QID_RE.test(String(value ?? "").trim());

/**
 * @param {string} docId
 * @param {Record<string, unknown>} data
 * @param {{ includeNameKeys: boolean }} opts
 */
export const isBadPlaceImageNegative = (docId, data, { includeNameKeys = false } = {}) => {
    if (data?.status !== "notFound") return false;

    const qid = String(data?.wikidataId ?? "").trim();
    const placeKey = String(data?.placeKey ?? docId).trim();

    if (isValidQid(qid) || isValidQid(placeKey)) {
        if (Number(data?.schemaVersion ?? 1) < NEGATIVE_SCHEMA_VERSION) {
            return true;
        }
        return true;
    }

    if (includeNameKeys && placeKey.startsWith("name:")) {
        return true;
    }

    return false;
};

/**
 * @param {string} qid
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean | null>} true/false, or null when unknown
 */
export const wikidataHasP18 = async (qid, fetchImpl = fetch) => {
    if (!isValidQid(qid)) return false;
    const url =
        `https://www.wikidata.org/w/api.php?action=wbgetentities` +
        `&props=claims&ids=${encodeURIComponent(qid)}&format=json&origin=*`;
    try {
        const res = await fetchImpl(url, { headers: WIKI_HEADERS });
        if (!res.ok) return null;
        const body = await res.json();
        const file = body?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        return Boolean(file);
    } catch {
        return null;
    }
};

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        dryRun: false,
        verifyP18: false,
        clearExplore: false,
        includeNameKeys: false,
        limit: Infinity,
        projectId: "guidex-afc30",
        credentials: "",
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--verify-p18") opts.verifyP18 = true;
        else if (arg === "--clear-explore") opts.clearExplore = true;
        else if (arg === "--include-name-keys") opts.includeNameKeys = true;
        else if (arg === "--limit") opts.limit = Number(argv[++i] ?? "0") || Infinity;
        else if (arg === "--project") opts.projectId = String(argv[++i] ?? opts.projectId);
        else if (arg === "--credentials") opts.credentials = String(argv[++i] ?? "");
        else if (arg === "--help" || arg === "-h") {
            console.log(`Usage: node scripts/delete-bad-place-image-negatives.mjs [options]

See script header for --dry-run, --verify-p18, --clear-explore, etc.`);
            process.exit(0);
        }
    }
    return opts;
}

/**
 * @param {string} rawPath
 * @returns {string | null}
 */
function resolveExistingPath(rawPath) {
    const trimmed = String(rawPath ?? "").trim();
    if (!trimmed) return null;
    const candidates = trimmed.startsWith("/")
        ? [trimmed]
        : [join(process.cwd(), trimmed), join(__dirname, trimmed), join(__dirname, "..", trimmed)];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * @param {string} explicitPath
 * @returns {string}
 */
function resolveCredentialsPath(explicitPath) {
    const fromFlag = resolveExistingPath(explicitPath);
    if (fromFlag) return fromFlag;

    const fromEnv = resolveExistingPath(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "");
    if (fromEnv) return fromEnv;

    const envRaw = String(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
    if (envRaw) {
        const basename = envRaw.split(/[/\\]/).pop() ?? envRaw;
        const inScripts = join(__dirname, basename);
        if (existsSync(inScripts)) return inScripts;
    }

    const defaults = readdirSync(__dirname)
        .filter((name) => /^guidex-afc30-.*\.json$/i.test(name))
        .sort();
    if (defaults.length === 1) {
        return join(__dirname, defaults[0]);
    }

    console.error(`
Could not find Firebase service account credentials.

Run from backend/ and pass the JSON in scripts/:

  cd backend
  node scripts/delete-bad-place-image-negatives.mjs --dry-run \\
    --credentials scripts/guidex-afc30-2758ce305a68.json

Or set an absolute path:

  export GOOGLE_APPLICATION_CREDENTIALS="$PWD/scripts/guidex-afc30-2758ce305a68.json"
`);
    process.exit(1);
}

/** @param {string} credentialsPath */
function loadCredential(credentialsPath) {
    const abs = resolveCredentialsPath(credentialsPath);
    const json = JSON.parse(readFileSync(abs, "utf8"));
    console.log("using credentials %s", abs);
    return cert(json);
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {Set<string>} qids
 * @param {boolean} dryRun
 */
async function clearExploreNotFoundStatuses(db, qids, dryRun) {
    if (qids.size === 0) return { geoDocs: 0, rowsCleared: 0 };

    let geoDocs = 0;
    let rowsCleared = 0;
    const geoSnap = await db.collection(GEO_COLLECTION).get();

    for (const geoDoc of geoSnap.docs) {
        const subSnap = await geoDoc.ref.collection(POPULAR_AROUND_SUBCOLLECTION).get();
        if (subSnap.empty) continue;

        /** @type {import("firebase-admin/firestore").WriteBatch | null} */
        let batch = null;
        let batchOps = 0;

        const flush = async () => {
            if (!batch || batchOps === 0) return;
            if (!dryRun) await batch.commit();
            batch = null;
            batchOps = 0;
        };

        for (const row of subSnap.docs) {
            const data = row.data() ?? {};
            if (data.imageStatus !== "notFound") continue;
            const rowQid = String(data.wikidataId ?? "").trim();
            if (!isValidQid(rowQid) || !qids.has(rowQid)) continue;

            geoDocs += 1;
            rowsCleared += 1;
            console.log(
                `${dryRun ? "[dry-run] would clear" : "clearing"} ` +
                    `${GEO_COLLECTION}/${geoDoc.id}/${POPULAR_AROUND_SUBCOLLECTION}/${row.id} ` +
                    `(wikidataId=${rowQid})`,
            );

            if (dryRun) continue;

            if (!batch) batch = db.batch();
            batch.set(
                row.ref,
                {
                    imageStatus: FieldValue.delete(),
                    updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true },
            );
            batchOps += 1;
            if (batchOps >= 400) await flush();
        }
        await flush();
    }

    return { geoDocs, rowsCleared };
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {ReturnType<typeof parseArgs>} opts
 */
async function deleteBadNegatives(db, opts) {
    const snap = await db.collection(PLACE_IMAGES_COLLECTION).get();
    const candidates = [];
    let scanned = 0;

    for (const doc of snap.docs) {
        if (scanned >= opts.limit) break;
        scanned += 1;
        const data = doc.data() ?? {};
        if (
            !isBadPlaceImageNegative(doc.id, data, {
                includeNameKeys: opts.includeNameKeys,
            })
        ) {
            continue;
        }
        const qid = isValidQid(data.wikidataId)
            ? String(data.wikidataId).trim()
            : isValidQid(doc.id)
              ? doc.id
              : null;
        candidates.push({ ref: doc.ref, id: doc.id, qid, data });
    }

    /** @type {typeof candidates} */
    const toDelete = [];
    let skippedNoP18 = 0;
    let skippedUnknownP18 = 0;

    if (opts.verifyP18) {
        for (const item of candidates) {
            if (!item.qid) {
                toDelete.push(item);
                continue;
            }
            const hasP18 = await wikidataHasP18(item.qid);
            if (hasP18 === true) {
                toDelete.push(item);
            } else if (hasP18 === false) {
                skippedNoP18 += 1;
            } else {
                skippedUnknownP18 += 1;
                console.warn(`WARN skip ${item.id}: Wikidata P18 check failed`);
            }
            await new Promise((r) => setTimeout(r, 120));
        }
    } else {
        toDelete.push(...candidates);
    }

    console.log(
        "scan place-images=%d badNegativeCandidates=%d toDelete=%d skippedNoP18=%d skippedUnknownP18=%d dryRun=%s",
        snap.size,
        candidates.length,
        toDelete.length,
        skippedNoP18,
        skippedUnknownP18,
        opts.dryRun,
    );

    let deleted = 0;
    /** @type {import("firebase-admin/firestore").WriteBatch | null} */
    let batch = null;
    let batchOps = 0;

    const flush = async () => {
        if (!batch || batchOps === 0) return;
        if (!opts.dryRun) await batch.commit();
        batch = null;
        batchOps = 0;
    };

    const deletedQids = new Set();

    for (const item of toDelete) {
        const schema = item.data?.schemaVersion ?? "?";
        const reason = item.data?.reason ?? "?";
        console.log(
            `${opts.dryRun ? "[dry-run] would delete" : "deleting"} ` +
                `${PLACE_IMAGES_COLLECTION}/${item.id} ` +
                `(wikidataId=${item.qid ?? "—"} schemaVersion=${schema} reason=${reason})`,
        );
        if (item.qid) deletedQids.add(item.qid);
        if (opts.dryRun) {
            deleted += 1;
            continue;
        }
        if (!batch) batch = db.batch();
        batch.delete(item.ref);
        batchOps += 1;
        deleted += 1;
        if (batchOps >= 400) await flush();
    }
    await flush();

    let explore = { geoDocs: 0, rowsCleared: 0 };
    if (opts.clearExplore && deletedQids.size > 0) {
        explore = await clearExploreNotFoundStatuses(db, deletedQids, opts.dryRun);
    }

    console.log(
        "done deleted=%d exploreRowsCleared=%d exploreGeoDocsTouched=%d dryRun=%s",
        deleted,
        explore.rowsCleared,
        explore.geoDocs,
        opts.dryRun,
    );
}

const isMain =
    process.argv[1] &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
    const opts = parseArgs(process.argv.slice(2));
    initializeApp({
        credential: loadCredential(opts.credentials),
        projectId: opts.projectId,
    });
    const db = getFirestore();

    try {
        await db.collection(PLACE_IMAGES_COLLECTION).limit(1).get();
    } catch (err) {
        if (err?.code === 7) {
            console.error(`
Firestore PERMISSION_DENIED. Grant the service account "Cloud Datastore User"
(roles/datastore.user), then re-run.`);
            process.exit(1);
        }
        throw err;
    }

    await deleteBadNegatives(db, opts);
}
