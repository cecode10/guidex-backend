#!/usr/bin/env node
/**
 * One-off migration: convert place cover images to WebP (1200px long edge).
 *
 * Storage layout (default Firebase bucket, NOT a bucket named "place-images"):
 *
 *   gs://{project}.firebasestorage.app/place-images/Q1017385/cover.jpg
 *   gs://{project}.firebasestorage.app/place-images/Q10333940/cover.jpg
 *   …
 *
 * Each place folder contains a single file always named `cover.jpg` (legacy).
 * The script writes `cover.webp` alongside, updates Firestore `place-images/{key}`,
 * patches check-ins that reference the old URL, then deletes `cover.jpg`.
 *
 * Prerequisites
 * -------------
 * - Service account JSON with Storage + Firestore access
 * - `npm install` in backend/ (firebase-admin + sharp)
 *
 * Usage
 * -----
 *   cd backend
 *   export GOOGLE_APPLICATION_CREDENTIALS=scripts/guidex-afc30-….json
 *   node scripts/migrate-images-to-webp.mjs --dry-run --limit 3
 *   node scripts/migrate-images-to-webp.mjs --credentials scripts/guidex-afc30-….json
 *
 * Flags
 * -----
 *   --dry-run              Log only; no writes
 *   --limit N              Process at most N covers (default: unlimited)
 *   --prefix PATH          Storage prefix (default: place-images/)
 *   --place-key KEY        Migrate one place only (e.g. Q1017385)
 *   --bucket NAME          GCS bucket (default: {project}.firebasestorage.app)
 *   --project ID           Firebase project id (default: guidex-afc30)
 *   --credentials PATH     Service account JSON (overrides GOOGLE_APPLICATION_CREDENTIALS)
 *   --skip-firestore       Convert Storage only; write --manifest for a later pass
 *   --manifest PATH        JSONL log of conversions (default when --skip-firestore)
 *   --firestore-only       Apply Firestore updates from --manifest (no Storage writes)
 */
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomUUID } from "node:crypto";
import { cert, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLACE_COVER_PRESET = { maxDimension: 1200, quality: 80 };

const PRESETS = {
    checkin: { maxDimension: 1200, quality: 80 },
    post: { maxDimension: 1200, quality: 80 },
    avatar: { maxDimension: 320, quality: 80 },
    placeCover: PLACE_COVER_PRESET,
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);
const CHECKIN_FILENAME =
    /^(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([^.]+)$/i;

/** Legacy place cover: place-images/{placeKey}/cover.jpg */
const PLACE_COVER_PATH =
    /^place-images\/([^/]+)\/cover\.(jpg|jpeg|png|webp|heic|heif)$/i;

/** @typedef {'checkin' | 'post' | 'avatar' | 'placeCover' | null} ImageKind */

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        dryRun: false,
        limit: Infinity,
        prefix: "place-images/",
        placeKey: "",
        keepOld: false,
        projectId: "guidex-afc30",
        bucket: "",
        credentials: "",
        scope: "place-covers",
        skipFirestore: false,
        firestoreOnly: false,
        manifest: "",
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--keep-old") opts.keepOld = true;
        else if (arg === "--skip-firestore") opts.skipFirestore = true;
        else if (arg === "--firestore-only") opts.firestoreOnly = true;
        else if (arg === "--manifest") opts.manifest = String(argv[++i] ?? "");
        else if (arg === "--limit") opts.limit = Number(argv[++i] ?? "0") || Infinity;
        else if (arg === "--prefix") opts.prefix = String(argv[++i] ?? opts.prefix);
        else if (arg === "--place-key") opts.placeKey = String(argv[++i] ?? "");
        else if (arg === "--project") opts.projectId = String(argv[++i] ?? opts.projectId);
        else if (arg === "--bucket") opts.bucket = String(argv[++i] ?? "");
        else if (arg === "--credentials") opts.credentials = String(argv[++i] ?? "");
        else if (arg === "--scope") opts.scope = String(argv[++i] ?? opts.scope);
        else if (arg === "--help" || arg === "-h") {
            console.log(`Usage: node scripts/migrate-images-to-webp.mjs [options]

Place covers (default): migrates place-images/{QID}/cover.jpg → cover.webp

  --dry-run --limit N --place-key Q1017385
  --credentials scripts/your-service-account.json
  --bucket guidex-afc30.firebasestorage.app`);
            process.exit(0);
        }
    }
    if (!opts.bucket) {
        opts.bucket = `${opts.projectId}.firebasestorage.app`;
    }
    if (opts.placeKey) {
        opts.prefix = `place-images/${opts.placeKey}/`;
    }
    if (opts.skipFirestore && !opts.manifest) {
        opts.manifest = join(__dirname, "migration-manifest.jsonl");
    }
    return opts;
}

/**
 * @param {string} credentialsPath
 * @returns {{ credential: import("firebase-admin/app").Credential, clientEmail?: string }}
 */
function loadCredentialBundle(credentialsPath) {
    if (credentialsPath) {
        const abs = credentialsPath.startsWith("/")
            ? credentialsPath
            : join(process.cwd(), credentialsPath);
        const json = JSON.parse(readFileSync(abs, "utf8"));
        return { credential: cert(json), clientEmail: json.client_email };
    }
    return { credential: applicationDefault(), clientEmail: undefined };
}

/** @param {string} credentialsPath */
function loadCredential(credentialsPath) {
    return loadCredentialBundle(credentialsPath).credential;
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string | undefined} clientEmail
 */
async function assertFirestoreAccess(db, clientEmail) {
    try {
        await db.collection("place-images").limit(1).get();
    } catch (err) {
        if (err?.code !== 7) throw err;
        const who = clientEmail ?? "your service account";
        console.error(`
Firestore PERMISSION_DENIED — Storage may work but Firestore reads/writes do not.

Grant this principal the IAM role "Cloud Datastore User" (roles/datastore.user):
  ${who}

Google Cloud Console → IAM → find the service account → Edit → Add role
  → Cloud Datastore User

Also ensure Storage access:
  → Storage Object Admin (roles/storage.objectAdmin)

Then re-run without --skip-firestore.

Workaround (Storage first, Firestore later):
  node scripts/migrate-images-to-webp.mjs --skip-firestore --manifest scripts/migration-manifest.jsonl ...
  # after IAM fix:
  node scripts/migrate-images-to-webp.mjs --firestore-only --manifest scripts/migration-manifest.jsonl ...
`);
        process.exit(1);
    }
}

/**
 * @param {string} manifestPath
 * @param {Record<string, unknown>} record
 */
function appendManifest(manifestPath, record) {
    appendFileSync(manifestPath, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} manifestPath
 */
async function applyManifestFirestore(db, manifestPath) {
    const abs = manifestPath.startsWith("/") ? manifestPath : join(process.cwd(), manifestPath);
    const lines = readFileSync(abs, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    let updated = 0;
    let errors = 0;
    for (const line of lines) {
        const row = JSON.parse(line);
        try {
            const count = await updatePlaceCoverFirestore(
                db,
                row.placeKey,
                row.oldUrl ?? null,
                row.newUrl,
                row.newPath,
                row.oldPath,
            );
            updated += count;
            console.log(`Firestore OK [${row.placeKey}] (${count} doc(s))`);
        } catch (err) {
            errors++;
            console.error(`Firestore ERROR [${row.placeKey}]:`, err);
        }
    }
    console.log(`\nManifest applied: ${lines.length} row(s), ${updated} doc update(s), ${errors} error(s).`);
}

/**
 * @param {string} storagePath
 * @returns {{ kind: ImageKind, userId?: string, placeKey?: string, fileBase?: string }}
 */
function classifyStoragePath(storagePath) {
    const place = storagePath.match(PLACE_COVER_PATH);
    if (place) {
        return { kind: "placeCover", placeKey: place[1], fileBase: `cover.${place[2]}` };
    }

    const checkin = storagePath.match(/^users\/([^/]+)\/checkins\/([^/]+)$/);
    if (checkin) {
        return { kind: "checkin", userId: checkin[1], fileBase: checkin[2] };
    }
    const post = storagePath.match(/^users\/([^/]+)\/posts\/([^/]+)$/);
    if (post) {
        return { kind: "post", userId: post[1], fileBase: post[2] };
    }
    const avatar = storagePath.match(/^users\/([^/]+)\/avatar\/([^/]+)$/);
    if (avatar) {
        return { kind: "avatar", userId: avatar[1], fileBase: avatar[2] };
    }
    return { kind: null };
}

/**
 * @param {string} storagePath
 * @param {string} placeKey
 */
function placeCoverPaths(storagePath, placeKey) {
    return {
        oldPath: storagePath,
        newPath: `place-images/${placeKey}/cover.webp`,
    };
}

/**
 * @param {string} fileBase
 */
function extensionOf(fileBase) {
    const dot = fileBase.lastIndexOf(".");
    if (dot < 0) return "";
    return fileBase.slice(dot + 1).toLowerCase();
}

/**
 * @param {string} fileBase
 */
function webpFileBase(fileBase) {
    const dot = fileBase.lastIndexOf(".");
    const stem = dot >= 0 ? fileBase.slice(0, dot) : fileBase;
    return `${stem}.webp`;
}

/**
 * @param {string} bucketName
 * @param {string} storagePath
 * @param {string} token
 */
function buildDownloadUrl(bucketName, storagePath, token) {
    return (
        `https://firebasestorage.googleapis.com/v0/b/${bucketName}` +
        `/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`
    );
}

/**
 * @param {import("firebase-admin/storage").File} file
 */
async function getExistingDownloadUrl(file) {
    const [metadata] = await file.getMetadata();
    const token = metadata.metadata?.firebaseStorageDownloadTokens;
    if (!token) return null;
    return buildDownloadUrl(file.bucket.name, file.name, token.split(",")[0]);
}

/**
 * @param {Buffer} input
 * @param {{ maxDimension: number, quality: number }} preset
 */
async function encodeWebp(input, preset) {
    return sharp(input)
        .rotate()
        .resize(preset.maxDimension, preset.maxDimension, {
            fit: "inside",
            withoutEnlargement: true,
        })
        .webp({ quality: preset.quality })
        .toBuffer({ resolveWithObject: true });
}

/**
 * @param {Buffer} input
 * @param {{ maxDimension: number, quality: number }} preset
 */
async function shouldSkip(input, preset) {
    const meta = await sharp(input).metadata();
    const format = (meta.format ?? "").toLowerCase();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const longEdge = Math.max(w, h);
    return format === "webp" && longEdge > 0 && longEdge <= preset.maxDimension;
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} oldUrl
 * @param {string} newUrl
 */
async function patchCheckInsWithImageUrl(db, oldUrl, newUrl) {
    const snap = await db.collectionGroup("checkins").where("imageUrl", "==", oldUrl).get();
    if (snap.empty) return 0;
    const batch = db.batch();
    for (const doc of snap.docs) batch.update(doc.ref, { imageUrl: newUrl });
    await batch.commit();
    return snap.size;
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} placeKey
 * @param {string} oldUrl
 * @param {string} newUrl
 * @param {string} newPath
 * @param {string} oldPath
 */
async function updatePlaceCoverFirestore(db, placeKey, oldUrl, newUrl, newPath, oldPath) {
    const ref = db.collection("place-images").doc(placeKey);
    const doc = await ref.get();
    if (!doc.exists) {
        console.warn(`WARN no Firestore doc place-images/${placeKey}`);
        return 0;
    }

    const data = doc.data() ?? {};
    const urlMatches = oldUrl != null && data.storageUrl === oldUrl;
    const pathMatches =
        data.storagePath === oldPath ||
        data.storagePath === `place-images/${placeKey}/cover.jpg` ||
        data.storagePath == null;

    if (!urlMatches && !pathMatches) {
        console.warn(
            `WARN place-images/${placeKey} storageUrl/path mismatch; skipping Firestore update`,
        );
        return 0;
    }

    await ref.update({
        storageUrl: newUrl,
        storagePath: newPath,
        mime: "image/webp",
        migratedAt: FieldValue.serverTimestamp(),
    });

    let total = 1;
    if (oldUrl) {
        total += await patchCheckInsWithImageUrl(db, oldUrl, newUrl);
    }
    return total;
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {ImageKind} kind
 * @param {string} oldUrl
 * @param {string} newUrl
 * @param {{ userId?: string, placeKey?: string, fileBase?: string, oldPath?: string, newPath?: string }} ctx
 */
async function updateFirestore(db, kind, oldUrl, newUrl, ctx) {
    if (kind === "placeCover" && ctx.placeKey && ctx.newPath && ctx.oldPath) {
        return updatePlaceCoverFirestore(
            db,
            ctx.placeKey,
            oldUrl,
            newUrl,
            ctx.newPath,
            ctx.oldPath,
        );
    }

    if (kind === "checkin" && ctx.userId && ctx.fileBase) {
        const match = ctx.fileBase.match(CHECKIN_FILENAME);
        if (match) {
            const checkInId = match[1];
            const ref = db
                .collection("users")
                .doc(ctx.userId)
                .collection("checkins")
                .doc(checkInId);
            const doc = await ref.get();
            if (doc.exists && doc.data()?.imageUrl === oldUrl) {
                await ref.update({ imageUrl: newUrl });
                return 1;
            }
        }
        return patchCheckInsWithImageUrl(db, oldUrl, newUrl);
    }

    if (kind === "avatar" && ctx.userId) {
        const ref = db.collection("users").doc(ctx.userId);
        const doc = await ref.get();
        if (!doc.exists) return 0;
        const data = doc.data() ?? {};
        const patch = {};
        if (data.photoUrl === oldUrl) patch.photoUrl = newUrl;
        if (data.photoURL === oldUrl) patch.photoURL = newUrl;
        if (Object.keys(patch).length === 0) return 0;
        await ref.set(patch, { merge: true });
        return 1;
    }

    if (kind === "post") {
        const snap = await db.collection("posts").where("imageUrl", "==", oldUrl).get();
        const docs =
            ctx.userId != null
                ? snap.docs.filter((doc) => doc.data()?.authorId === ctx.userId)
                : snap.docs;
        if (docs.length === 0) return 0;
        const batch = db.batch();
        for (const doc of docs) batch.update(doc.ref, { imageUrl: newUrl });
        await batch.commit();
        return docs.length;
    }

    return 0;
}

/**
 * @param {import("@google-cloud/storage").File} file
 * @param {ReturnType<typeof parseArgs>} opts
 */
function isCandidate(file, opts) {
    if (opts.scope === "place-covers") {
        return PLACE_COVER_PATH.test(file.name);
    }
    const { kind, fileBase } = classifyStoragePath(file.name);
    if (!kind || !fileBase) return false;
    return IMAGE_EXTENSIONS.has(extensionOf(fileBase));
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { credential, clientEmail } = loadCredentialBundle(opts.credentials);

    initializeApp({
        credential,
        projectId: opts.projectId,
        storageBucket: opts.bucket,
    });

    const db = getFirestore();

    if (opts.firestoreOnly) {
        if (!opts.manifest) {
            console.error("--firestore-only requires --manifest PATH");
            process.exit(1);
        }
        await assertFirestoreAccess(db, clientEmail);
        await applyManifestFirestore(db, opts.manifest);
        return;
    }

    const bucket = getStorage().bucket(opts.bucket);

    console.log(
        `Bucket: gs://${opts.bucket}/` +
            (opts.prefix ? `\nPrefix: ${opts.prefix}` : "") +
            (opts.scope === "place-covers" ? "\nScope: place cover.jpg → cover.webp" : `\nScope: ${opts.scope}`) +
            (opts.skipFirestore ? "\nFirestore: skipped (Storage only)" : "") +
            (opts.manifest ? `\nManifest: ${opts.manifest}` : "") +
            (opts.dryRun ? "\nMode: dry-run" : "") +
            (clientEmail ? `\nCredentials: ${clientEmail}` : ""),
    );

    if (!opts.dryRun && !opts.skipFirestore) {
        await assertFirestoreAccess(db, clientEmail);
    }

    if (!opts.dryRun) {
        const rl = createInterface({ input, output });
        const answer = await rl.question(`Proceed with migration on "${opts.projectId}"? [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("Aborted.");
            process.exit(0);
        }
    }

    const stats = {
        scanned: 0,
        skipped: 0,
        converted: 0,
        firestoreDocs: 0,
        deleted: 0,
        errors: 0,
        bytesBefore: 0,
        bytesAfter: 0,
    };

    /** @type {import("@google-cloud/storage").File[]} */
    const candidates = [];
    const [files] = await bucket.getFiles({ prefix: opts.prefix || undefined });
    for (const file of files) {
        if (!isCandidate(file, opts)) continue;
        candidates.push(file);
    }

    console.log(`Found ${candidates.length} cover image(s) to evaluate.`);

    for (const file of candidates) {
        if (stats.converted >= opts.limit) break;
        stats.scanned++;

        const ctx = classifyStoragePath(file.name);
        if (!ctx.kind) continue;

        const preset = PRESETS[ctx.kind];
        const oldPath = file.name;
        const newPath =
            ctx.kind === "placeCover" && ctx.placeKey
                ? placeCoverPaths(oldPath, ctx.placeKey).newPath
                : oldPath.includes("/checkins/")
                  ? oldPath.replace(/\/([^/]+)$/, (_, base) => `/${webpFileBase(base)}`)
                  : oldPath.includes("/posts/")
                    ? oldPath.replace(/\/([^/]+)$/, (_, base) => `/${webpFileBase(base)}`)
                    : oldPath.includes("/avatar/")
                      ? oldPath.replace(/\/([^/]+)$/, (_, base) => `/${webpFileBase(base)}`)
                      : oldPath;

        try {
            const [original] = await file.download();
            stats.bytesBefore += original.length;

            if (await shouldSkip(original, preset)) {
                stats.skipped++;
                console.log(`SKIP (already optimal) ${oldPath}`);
                continue;
            }

            const { data: webp, info } = await encodeWebp(original, preset);
            stats.bytesAfter += webp.length;

            const oldUrl = await getExistingDownloadUrl(file);
            if (!oldUrl && ctx.kind === "placeCover") {
                console.warn(
                    `WARN no download token on ${oldPath}; Firestore update uses storagePath match`,
                );
            }

            const savedPct =
                original.length > 0
                    ? (((original.length - webp.length) / original.length) * 100).toFixed(1)
                    : "0.0";

            if (opts.dryRun) {
                stats.converted++;
                console.log(
                    `DRY-RUN ${oldPath} → ${newPath} ` +
                        `(${original.length} → ${webp.length} bytes, -${savedPct}%, ` +
                        `${info.width}x${info.height} webp)` +
                        (ctx.placeKey ? ` [${ctx.placeKey}]` : ""),
                );
                continue;
            }

            const token = randomUUID();
            const newFile = bucket.file(newPath);
            await newFile.save(webp, {
                resumable: false,
                contentType: "image/webp",
                metadata: {
                    cacheControl: "public, max-age=31536000, immutable",
                    metadata: { firebaseStorageDownloadTokens: token },
                },
            });

            const newUrl = buildDownloadUrl(bucket.name, newPath, token);

            let docsUpdated = 0;
            if (opts.skipFirestore) {
                if (opts.manifest) {
                    appendManifest(opts.manifest, {
                        placeKey: ctx.placeKey,
                        oldPath,
                        newPath,
                        oldUrl,
                        newUrl,
                    });
                }
            } else {
                docsUpdated = await updateFirestore(db, ctx.kind, oldUrl, newUrl, {
                    ...ctx,
                    oldPath,
                    newPath,
                });
            }
            stats.firestoreDocs += docsUpdated;

            if (!opts.keepOld && newPath !== oldPath && (docsUpdated > 0 || opts.skipFirestore)) {
                await file.delete();
                stats.deleted++;
            }

            stats.converted++;
            const fsNote = opts.skipFirestore ? " (manifest written)" : ` (${docsUpdated} doc(s) updated)`;
            console.log(
                `OK ${oldPath} → ${newPath} (-${savedPct}%)${fsNote}` +
                    (ctx.placeKey ? ` [${ctx.placeKey}]` : ""),
            );
        } catch (err) {
            stats.errors++;
            if (err?.code === 7) {
                console.error(
                    `ERROR ${oldPath}: Firestore PERMISSION_DENIED — ` +
                        `fix IAM (roles/datastore.user) or re-run with --skip-firestore`,
                );
            } else {
                console.error(`ERROR ${oldPath}:`, err);
            }
        }
    }

    const totalSaved = stats.bytesBefore - stats.bytesAfter;
    console.log("\n--- Summary ---");
    console.log(`Scanned:        ${stats.scanned}`);
    console.log(`Converted:      ${stats.converted}`);
    console.log(`Skipped:        ${stats.skipped}`);
    console.log(`Firestore docs: ${stats.firestoreDocs}`);
    console.log(`Deleted old:    ${stats.deleted}`);
    console.log(`Errors:         ${stats.errors}`);
    if (stats.converted > 0 && !opts.dryRun) {
        console.log(
            `Storage saved:  ${totalSaved} bytes (${(totalSaved / 1024 / 1024).toFixed(2)} MiB)`,
        );
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
