import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * @param {string} explicitPath
 * @param {string} scriptLabel
 * @returns {string}
 */
export function resolveCredentialsPath(explicitPath, scriptLabel = "script") {
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
Could not find Firebase service account credentials for ${scriptLabel}.

Run from backend/ and pass the JSON in scripts/:

  cd backend
  node scripts/${scriptLabel}.mjs --credentials scripts/guidex-afc30-2758ce305a68.json

Or set:

  export GOOGLE_APPLICATION_CREDENTIALS="$PWD/scripts/guidex-afc30-2758ce305a68.json"
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
