import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cert } from "firebase-admin/app";

export const WIKI_HEADERS = {
    "User-Agent": "rambleX-mobile (https://ramblex.app)",
    Accept: "application/json",
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @param {number} ms
 */
export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * @param {number} attempt 0-based
 * @param {number} baseMs
 */
export const exponentialBackoffMs = (attempt, baseMs = 400) => baseMs * 2 ** attempt;

/**
 * @param {string} rawPath
 * @returns {string | null}
 */
export function resolveExistingPath(rawPath) {
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
 * Parse a simple KEY=VALUE .env file (supports optional quotes).
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function parseEnvFile(filePath) {
    if (!existsSync(filePath)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
            (value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))
        ) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

/**
 * Load `mobile-app/.env` when present (repo layout: backend/../mobile-app/.env).
 * @returns {Record<string, string>}
 */
export function loadMobileAppEnv() {
    const candidates = [
        join(__dirname, "..", "..", "mobile-app", ".env"),
        join(process.cwd(), "..", "mobile-app", ".env"),
        join(process.cwd(), "mobile-app", ".env"),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return parseEnvFile(candidate);
    }
    return {};
}

/**
 * Firebase Web/Android API key for Identity Toolkit custom-token exchange.
 * Order: explicit → FIREBASE_API_KEY* env → mobile-app/.env
 *
 * @param {string} [explicit]
 * @returns {string}
 */
export function resolveFirebaseApiKey(explicit = "") {
    const fromExplicit = String(explicit ?? "").trim();
    if (fromExplicit) return fromExplicit;

    for (const key of [
        "FIREBASE_API_KEY",
        "FIREBASE_API_KEY_ANDROID",
        "FIREBASE_API_KEY_IOS",
    ]) {
        const value = String(process.env[key] ?? "").trim();
        if (value) return value;
    }

    const mobileEnv = loadMobileAppEnv();
    for (const key of [
        "FIREBASE_API_KEY",
        "FIREBASE_API_KEY_ANDROID",
        "FIREBASE_API_KEY_IOS",
    ]) {
        const value = String(mobileEnv[key] ?? "").trim();
        if (value) return value;
    }
    return "";
}

/**
 * Cloud Functions base URL. Order: explicit → BACKEND_URL env → mobile-app/.env
 *
 * @param {string} [explicit]
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveBackendUrl(explicit = "", fallback = "") {
    const fromExplicit = String(explicit ?? "").trim();
    if (fromExplicit) return fromExplicit;
    const fromEnv = String(process.env.BACKEND_URL ?? "").trim();
    if (fromEnv) return fromEnv;
    const fromMobile = String(loadMobileAppEnv().BACKEND_URL ?? "").trim();
    if (fromMobile) return fromMobile;
    return String(fallback ?? "").trim();
}

/**
 * Newest `scripts/guidex-afc30-*.json`, or null if none.
 * @returns {string | null}
 */
export function findAutoCredentialsPath() {
    /** @type {Array<{ path: string, mtimeMs: number }>} */
    const matches = [];
    for (const name of readdirSync(__dirname)) {
        if (!/^guidex-afc30-.*\.json$/i.test(name)) continue;
        const path = join(__dirname, name);
        try {
            matches.push({ path, mtimeMs: statSync(path).mtimeMs });
        } catch {
            // ignore unreadable entries
        }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matches[0].path;
}

/**
 * @param {string} explicitPath
 * @param {string} scriptLabel
 * @returns {string}
 */
export function resolveCredentialsPath(explicitPath, scriptLabel = "script") {
    const fromFlag = resolveExistingPath(explicitPath);
    if (fromFlag) return fromFlag;

    const auto = findAutoCredentialsPath();
    if (auto) return auto;

    const fromEnv = resolveExistingPath(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "");
    if (fromEnv) return fromEnv;

    const envRaw = String(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
    if (envRaw) {
        const basename = envRaw.split(/[/\\]/).pop() ?? envRaw;
        const inScripts = join(__dirname, basename);
        if (existsSync(inScripts)) return inScripts;
    }

    console.error(`
Could not find Firebase service account credentials for ${scriptLabel}.

Place a service account JSON in scripts/ matching:

  scripts/guidex-afc30-*.json

Or pass --credentials PATH / set GOOGLE_APPLICATION_CREDENTIALS.
`);
    process.exit(1);
}

/** @param {string} credentialsPath @param {string} [scriptLabel] */
export function loadCredential(credentialsPath, scriptLabel = "script") {
    const abs = resolveCredentialsPath(credentialsPath, scriptLabel);
    const json = JSON.parse(readFileSync(abs, "utf8"));
    console.log("using credentials %s", abs);
    return cert(json);
}

/**
 * @param {string} outputPath
 * @param {unknown} payload
 */
export function writeJsonFile(outputPath, payload) {
    const abs = resolveExistingPath(outputPath) ?? resolve(process.cwd(), outputPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return abs;
}

/**
 * @param {string} outputPath
 * @returns {unknown}
 */
export function readJsonFile(outputPath) {
    const abs = resolveExistingPath(outputPath);
    if (!abs) {
        throw new Error(`JSON file not found: ${outputPath}`);
    }
    return JSON.parse(readFileSync(abs, "utf8"));
}

/**
 * @param {string} reportDir
 * @param {string} prefix
 * @param {unknown} report
 */
export function writeTimestampedReport(reportDir, prefix, report) {
    const dir = resolveExistingPath(reportDir) ?? join(__dirname, reportDir);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const abs = join(dir, `${prefix}-${stamp}.json`);
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return abs;
}
