#!/usr/bin/env node
/**
 * Admin helper: ensure sightseeing rows exist for an explicit list of Wikidata QIDs.
 *
 * Default mode calls the deployed Cloud Function `ensureSightseeingByQid` (no local
 * Postgres / private-IP access required). Optional `--direct` talks to the DB
 * in-process (needs Cloud SQL Auth Proxy or a reachable DATABASE_URL).
 *
 * Prerequisites (API mode — default)
 * ----------------------------------
 *   scripts/guidex-afc30-*.json     (auto-picked; newest if several)
 *   mobile-app/.env API key/URL    (FIREBASE_API_KEY_ANDROID + BACKEND_URL)
 *
 * Usage
 * -----
 *   node scripts/seed-sightseeing-from-qids.mjs --file scripts/qids.txt
 *   node scripts/seed-sightseeing-from-qids.mjs --qid Q243 --qid Q1054070
 *   node scripts/seed-sightseeing-from-qids.mjs Q243 Q1054070 --dry-run
 *   node scripts/seed-sightseeing-from-qids.mjs --file scripts/qids.txt --direct
 *
 * Input file formats
 * ------------------
 *   - JSON array:           ["Q243", "Q1054070"]
 *   - JSON object:          { "qids": ["Q243"] }  or  [{ "wikidataId": "Q243" }]
 *   - Plain text / CSV:     one QID per line (# comments and blank lines ignored)
 *
 * Flags
 * -----
 *   --file PATH         Read QIDs from a file
 *   --qid QID           Add a QID (repeatable)
 *   --dry-run           Check / fetch only; do not write
 *   --delay-ms N        Pause between QIDs (default: 500)
 *   --backend-url URL   Cloud Functions base (default: BACKEND_URL or project URL)
 *   --credentials PATH  Override auto-picked scripts/guidex-afc30-*.json
 *   --api-key KEY       Firebase API key (or FIREBASE_API_KEY)
 *   --uid UID           Auth uid for the minted ID token (default: seed-sightseeing-admin)
 *   --direct            Call Postgres directly instead of the HTTP API
 *   --database-url URL  Only with --direct
 *   --report-dir PATH   Report output dir (default: scripts/reports)
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
    ensureSightseeingByQid,
    parseWikidataQid,
} from "../services/ensure-sightseeing-by-qid.mjs";
import { closeSightseeingPool } from "../services/sightseeing-db.mjs";
import {
    loadCredential,
    resolveBackendUrl,
    resolveExistingPath,
    resolveFirebaseApiKey,
    sleep,
    writeTimestampedReport,
} from "./script-common.mjs";

const DEFAULT_DELAY_MS = 500;
const DEFAULT_BACKEND_URL = "https://europe-west3-guidex-afc30.cloudfunctions.net";
const DEFAULT_ADMIN_UID = "seed-sightseeing-admin";
const SCRIPT_LABEL = "seed-sightseeing-from-qids";

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    const opts = {
        file: "",
        qids: /** @type {string[]} */ ([]),
        dryRun: false,
        delayMs: DEFAULT_DELAY_MS,
        databaseUrl: "",
        reportDir: "reports",
        direct: false,
        backendUrl: "",
        credentials: "",
        apiKey: "",
        uid: DEFAULT_ADMIN_UID,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--direct") opts.direct = true;
        else if ((arg === "--file" || arg === "-f") && next) {
            opts.file = next;
            i++;
        } else if (arg.startsWith("--file=")) {
            opts.file = arg.slice("--file=".length);
        } else if (arg === "--qid" && next) {
            opts.qids.push(next);
            i++;
        } else if (arg.startsWith("--qid=")) {
            opts.qids.push(arg.slice("--qid=".length));
        } else if (arg === "--delay-ms" && next) {
            opts.delayMs = Number.parseInt(next, 10) || DEFAULT_DELAY_MS;
            i++;
        } else if (arg === "--database-url" && next) {
            opts.databaseUrl = next;
            i++;
        } else if (arg.startsWith("--database-url=")) {
            opts.databaseUrl = arg.slice("--database-url=".length);
        } else if (arg === "--backend-url" && next) {
            opts.backendUrl = next;
            i++;
        } else if (arg.startsWith("--backend-url=")) {
            opts.backendUrl = arg.slice("--backend-url=".length);
        } else if (arg === "--credentials" && next) {
            opts.credentials = next;
            i++;
        } else if (arg === "--api-key" && next) {
            opts.apiKey = next;
            i++;
        } else if (arg === "--uid" && next) {
            opts.uid = next;
            i++;
        } else if (arg === "--report-dir" && next) {
            opts.reportDir = next;
            i++;
        } else if (arg === "--help" || arg === "-h") {
            console.log(`Usage: node scripts/seed-sightseeing-from-qids.mjs [--file PATH] [--qid Q…] [Q…]

Default: POST each QID to ensureSightseeingByQid (Cloud Function).
Optional --direct: talk to Postgres in-process (needs a reachable DATABASE_URL).

  --file PATH         JSON array / { qids } / line-based QIDs
  --qid QID           Repeatable CLI QID
  --dry-run           No DB writes
  --delay-ms N        Pause between QIDs (default ${DEFAULT_DELAY_MS})
  --backend-url URL   Functions base URL
  --credentials PATH  Override auto-picked scripts/guidex-afc30-*.json
  --api-key KEY       Firebase API key (or FIREBASE_API_KEY)
  --direct            Use local/direct Postgres instead of the API
  --database-url URL  Only with --direct
  --report-dir PATH   Where to write the JSON report`);
            process.exit(0);
        } else if (arg.startsWith("-")) {
            throw new Error(`Unknown flag: ${arg}`);
        } else {
            opts.qids.push(arg);
        }
    }
    return opts;
}

/**
 * @param {unknown} payload
 * @returns {string[]}
 */
export function extractQidsFromJson(payload) {
    if (Array.isArray(payload)) {
        const out = [];
        for (const item of payload) {
            if (typeof item === "string" || typeof item === "number") {
                out.push(String(item));
            } else if (item && typeof item === "object") {
                const row = /** @type {Record<string, unknown>} */ (item);
                const raw =
                    row.wikidataId ?? row.wikidata_id ?? row.qid ?? row.id ?? row.Q;
                if (raw != null) out.push(String(raw));
            }
        }
        return out;
    }
    if (payload && typeof payload === "object") {
        const obj = /** @type {Record<string, unknown>} */ (payload);
        if (Array.isArray(obj.qids)) return extractQidsFromJson(obj.qids);
        if (Array.isArray(obj.wikidataIds)) return extractQidsFromJson(obj.wikidataIds);
    }
    throw new Error("JSON must be a QID array, { qids: [...] }, or [{ wikidataId }]");
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractQidsFromText(text) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const token = trimmed.split(/[\s,;]+/)[0] ?? "";
        if (token) out.push(token);
    }
    return out;
}

/**
 * @param {string} filePath
 * @returns {string[]}
 */
export function loadQidsFromFile(filePath) {
    const abs = resolveExistingPath(filePath);
    if (!abs) throw new Error(`File not found: ${filePath}`);
    const raw = readFileSync(abs, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        return extractQidsFromJson(JSON.parse(trimmed));
    }
    return extractQidsFromText(raw);
}

/**
 * @param {string[]} rawQids
 * @returns {{ qids: string[], invalid: string[] }}
 */
export function normalizeQidList(rawQids) {
    /** @type {string[]} */
    const qids = [];
    /** @type {string[]} */
    const invalid = [];
    const seen = new Set();
    for (const raw of rawQids) {
        const qid = parseWikidataQid(raw);
        if (!qid) {
            invalid.push(String(raw));
            continue;
        }
        if (seen.has(qid)) continue;
        seen.add(qid);
        qids.push(qid);
    }
    return { qids, invalid };
}

/**
 * @param {{ credentials: string, uid: string, apiKey: string }} opts
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function mintFirebaseIdToken(opts, fetchImpl = fetch) {
    const fromEnv = String(process.env.FIREBASE_ID_TOKEN ?? "").trim();
    if (fromEnv) return fromEnv;

    const apiKey = resolveFirebaseApiKey(opts.apiKey);
    if (!apiKey) {
        throw new Error(
            "No Firebase API key found. Set FIREBASE_API_KEY, pass --api-key, " +
                "or keep FIREBASE_API_KEY_ANDROID in mobile-app/.env.",
        );
    }

    if (getApps().length === 0) {
        initializeApp({
            credential: loadCredential(opts.credentials, SCRIPT_LABEL),
            projectId: "guidex-afc30",
        });
    }
    const customToken = await getAuth().createCustomToken(opts.uid || DEFAULT_ADMIN_UID);

    const url =
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`;
    const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    const body = /** @type {{ idToken?: string, error?: { message?: string } }} */ (
        await response.json()
    );
    if (!response.ok || !body.idToken) {
        throw new Error(
            `Failed to mint Firebase ID token: ${body.error?.message || response.status}`,
        );
    }
    return body.idToken;
}

/**
 * @param {{
 *   backendUrl: string,
 *   idToken: string,
 *   wikidataId: string,
 *   dryRun: boolean,
 * }} args
 * @param {typeof fetch} [fetchImpl]
 */
export async function ensureSightseeingByQidViaApi(args, fetchImpl = fetch) {
    const base = args.backendUrl.replace(/\/$/, "");
    const response = await fetchImpl(`${base}/ensureSightseeingByQid`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${args.idToken}`,
        },
        body: JSON.stringify({
            wikidataId: args.wikidataId,
            dryRun: args.dryRun,
        }),
    });
    const body = /** @type {Record<string, unknown>} */ (await response.json().catch(() => ({})));
    if (!response.ok) {
        const err = new Error(
            typeof body.error === "string"
                ? body.error
                : `ensureSightseeingByQid HTTP ${response.status}`,
        );
        err.statusCode = response.status;
        throw err;
    }
    return {
        status: String(body.status ?? ""),
        wikidataId: String(body.wikidataId ?? args.wikidataId),
        name: body.name != null ? String(body.name) : undefined,
    };
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {{ fetchImpl?: typeof fetch }} [runtime]
 */
export async function runSeedSightseeingFromQids(opts, { fetchImpl = fetch } = {}) {
    if (opts.databaseUrl) {
        process.env.DATABASE_URL = opts.databaseUrl;
    }

    /** @type {string[]} */
    const raw = [...opts.qids];
    if (opts.file) {
        raw.push(...loadQidsFromFile(opts.file));
    }
    const { qids, invalid } = normalizeQidList(raw);
    if (qids.length === 0) {
        throw new Error("No valid QIDs provided. Pass --file PATH, --qid Q…, or positional QIDs.");
    }

    const mode = opts.direct ? "direct" : "api";
    console.log(
        `[seed-qids] ${qids.length} QID(s) via ${mode}` +
            (invalid.length ? `, ${invalid.length} invalid skipped` : "") +
            (opts.dryRun ? " (dry-run)" : ""),
    );

    /** @type {string | null} */
    let idToken = null;
    /** @type {string} */
    let backendUrl = "";
    if (!opts.direct) {
        backendUrl = resolveBackendUrl(opts.backendUrl, DEFAULT_BACKEND_URL);
        idToken = await mintFirebaseIdToken(
            {
                credentials: opts.credentials,
                uid: opts.uid,
                apiKey: opts.apiKey,
            },
            fetchImpl,
        );
    }

    const report = {
        startedAt: new Date().toISOString(),
        finishedAt: /** @type {string | null} */ (null),
        dryRun: opts.dryRun,
        mode,
        totals: {
            input: qids.length,
            invalid: invalid.length,
            exists: 0,
            added: 0,
            wouldAdd: 0,
            failed: 0,
        },
        invalid,
        results: /** @type {Array<Record<string, unknown>>} */ ([]),
    };

    for (let i = 0; i < qids.length; i++) {
        const qid = qids[i];
        try {
            const result = opts.direct
                ? await ensureSightseeingByQid(qid, {
                      fetchImpl,
                      dryRun: opts.dryRun,
                      hiddenOnly: false,
                  })
                : await ensureSightseeingByQidViaApi(
                      {
                          backendUrl,
                          idToken: /** @type {string} */ (idToken),
                          wikidataId: qid,
                          dryRun: opts.dryRun,
                      },
                      fetchImpl,
                  );

            report.results.push({ ...result });
            if (result.status === "exists") report.totals.exists++;
            else if (result.status === "added") report.totals.added++;
            else if (result.status === "would_add") report.totals.wouldAdd++;

            const label = result.name ? ` "${result.name}"` : "";
            console.log(
                `[seed-qids] ${i + 1}/${qids.length} ${result.status} ${qid}${label}`,
            );
        } catch (error) {
            report.totals.failed++;
            report.results.push({
                status: "failed",
                wikidataId: qid,
                error: error?.message || String(error),
            });
            console.error(
                `[seed-qids] ${i + 1}/${qids.length} failed ${qid}:`,
                error?.message || error,
            );
        }

        if (i < qids.length - 1 && opts.delayMs > 0) {
            await sleep(opts.delayMs);
        }
    }

    report.finishedAt = new Date().toISOString();
    const reportPath = writeTimestampedReport(
        opts.reportDir,
        "seed-sightseeing-from-qids",
        report,
    );
    console.log("[seed-qids] report %s", reportPath);
    console.log("[seed-qids] totals", report.totals);
    return report;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    try {
        const report = await runSeedSightseeingFromQids(opts);
        if (report.totals.failed > 0) process.exitCode = 1;
    } finally {
        if (opts.direct) await closeSightseeingPool();
    }
}

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main().catch(async (error) => {
        console.error("[seed-qids] fatal:", error?.message || error);
        await closeSightseeingPool().catch(() => {});
        process.exit(1);
    });
}
