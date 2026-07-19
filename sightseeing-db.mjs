import pg from "pg";

const { Pool } = pg;

/** @type {import("pg").Pool | null} */
let pool = null;

/**
 * Resolves the sightseeing Postgres connection string.
 * Prefer the Firebase secret env var; fall back to DATABASE_URL for local/seed.
 *
 * @returns {string}
 */
export const resolveSightseeingDatabaseUrl = () => {
    const fromSecret = String(process.env.SIGHTSEEING_DATABASE_URL ?? "").trim();
    if (fromSecret) return fromSecret;
    const fromEnv = String(process.env.DATABASE_URL ?? "").trim();
    if (fromEnv) return fromEnv;
    return "";
};

/**
 * Shared pg pool for Cloud Functions + seed scripts.
 * Uses max=1 in production-style runtimes to avoid exhausting Cloud SQL connections
 * across concurrent function instances.
 *
 * @param {{ connectionString?: string, max?: number }} [options]
 * @returns {import("pg").Pool}
 */
export const getSightseeingPool = (options = {}) => {
    if (pool) return pool;

    const connectionString = options.connectionString ?? resolveSightseeingDatabaseUrl();
    if (!connectionString) {
        const err = new Error(
            "Missing SIGHTSEEING_DATABASE_URL (or DATABASE_URL for local/seed)",
        );
        err.statusCode = 503;
        throw err;
    }

    pool = new Pool({
        connectionString,
        max: options.max ?? 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
        ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
            ? false
            : { rejectUnauthorized: false },
    });

    pool.on("error", (error) => {
        console.error("[sightseeing-db] idle client error:", error?.message || error);
    });

    return pool;
};

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<import("pg").QueryResult>}
 */
export const sightseeingQuery = async (text, params = []) => {
    const client = getSightseeingPool();
    return client.query(text, params);
};

/**
 * Closes the shared pool (seed scripts / tests).
 * @returns {Promise<void>}
 */
export const closeSightseeingPool = async () => {
    if (!pool) return;
    const current = pool;
    pool = null;
    await current.end();
};

/**
 * Reset the module pool (tests only).
 */
export const resetSightseeingPoolForTests = () => {
    pool = null;
};
