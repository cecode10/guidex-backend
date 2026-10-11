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
 * Decode a userinfo part once. Raw passwords are kept as-is so characters
 * such as `&`, `(`, `>`, and `<` are not dropped by the URL parser.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeUserinfo(value) {
    if (!value.includes("%")) return value;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Split a Postgres URL into pool fields.
 * `pg` parses `connectionString` with `new URL()`, which drops a password that
 * contains reserved characters and then SCRAM fails with
 * "client password must be a string".
 *
 * @param {string} connectionString
 * @returns {{
 *   user: string,
 *   password: string,
 *   host: string,
 *   port?: number,
 *   database?: string,
 * }}
 */
export function parseSightseeingDatabaseUrl(connectionString) {
    const raw = String(connectionString ?? "").trim();
    const scheme = raw.match(/^postgres(?:ql)?:\/\/(.*)$/i);
    if (!scheme) {
        throw new Error("DATABASE_URL must start with postgresql://");
    }
    const afterScheme = scheme[1];
    const at = afterScheme.lastIndexOf("@");
    if (at < 0) {
        throw new Error("DATABASE_URL is missing a host");
    }
    const userinfo = afterScheme.slice(0, at);
    const colon = userinfo.indexOf(":");
    if (colon <= 0) {
        throw new Error("DATABASE_URL must include a user and password");
    }
    const user = decodeUserinfo(userinfo.slice(0, colon));
    const password = decodeUserinfo(userinfo.slice(colon + 1));
    if (!password) {
        throw new Error(
            "DATABASE_URL has an empty password. Set it in single quotes so the shell keeps characters such as & ( ) > < ;",
        );
    }

    const hostAndPath = afterScheme.slice(at + 1);
    const queryStart = hostAndPath.indexOf("?");
    const pathPart = queryStart === -1 ? hostAndPath : hostAndPath.slice(0, queryStart);
    const query = queryStart === -1 ? "" : hostAndPath.slice(queryStart + 1);
    const slash = pathPart.indexOf("/");
    const hostPort = slash === -1 ? pathPart : pathPart.slice(0, slash);
    const databaseName = slash === -1 ? "" : pathPart.slice(slash + 1);
    const params = new URLSearchParams(query);
    const socketHost = params.get("host");

    let host = hostPort;
    /** @type {number | undefined} */
    let port = 5432;
    if (!socketHost && hostPort.startsWith("[")) {
        const end = hostPort.indexOf("]");
        host = end === -1 ? hostPort : hostPort.slice(1, end);
        const portPart = end === -1 ? "" : hostPort.slice(end + 1);
        if (portPart.startsWith(":")) port = Number(portPart.slice(1)) || 5432;
    } else if (!socketHost && hostPort.includes(":")) {
        const split = hostPort.lastIndexOf(":");
        host = hostPort.slice(0, split);
        port = Number(hostPort.slice(split + 1)) || 5432;
    }
    if (socketHost) {
        host = socketHost;
        port = undefined;
    }

    const database = decodeUserinfo(databaseName) || params.get("db") || undefined;
    return {
        user,
        password,
        host,
        ...(port === undefined ? {} : { port }),
        ...(database ? { database } : {}),
    };
}

/**
 * @param {string} connectionString
 * @param {number} [max]
 * @returns {import("pg").PoolConfig}
 */
export function poolConfigFromDatabaseUrl(connectionString, max = 1) {
    const parsed = parseSightseeingDatabaseUrl(connectionString);
    const local =
        parsed.host === "localhost" || parsed.host === "127.0.0.1" || parsed.host === "::1";
    return {
        user: parsed.user,
        password: parsed.password,
        host: parsed.host,
        ...(parsed.port === undefined ? {} : { port: parsed.port }),
        ...(parsed.database ? { database: parsed.database } : {}),
        max,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
        ssl: local ? false : { rejectUnauthorized: false },
    };
}

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

    pool = new Pool(poolConfigFromDatabaseUrl(connectionString, options.max ?? 1));

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
