/**
 * Firebase ID token verification for Lambda handlers.
 * Validates JWT using Firebase's published X.509 certs (no service account required).
 */
import { jwtVerify, importX509 } from "jose";

const FIREBASE_CERTS_URL =
    "https://www.googleapis.com/service_accounts/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let cachedPublicKeys = null;

const getPublicKeys = async () => {
    if (cachedPublicKeys) {
        return cachedPublicKeys;
    }
    const res = await fetch(FIREBASE_CERTS_URL);
    cachedPublicKeys = await res.json();
    return cachedPublicKeys;
};

/**
 * Extracts the Bearer token from Authorization header.
 * @param {Object} headers - Request headers (can be lowercase keys or capitalized)
 * @returns {string|null} The raw token or null if missing
 */
export const getAuthHeader = (headers) => {
    if (!headers || typeof headers !== "object") {
        return null;
    }
    const auth = headers.Authorization || headers.authorization;
    if (!auth || typeof auth !== "string" || !auth.toLowerCase().startsWith("bearer ")) {
        return null;
    }
    return auth.slice(7).trim();
};

/**
 * Verifies a Firebase ID token and returns the decoded payload.
 * @param {string} idToken - The raw Bearer token (without "Bearer " prefix)
 * @param {Object} options
 * @param {string} options.projectId - Firebase project ID (from FIREBASE_PROJECT_ID env)
 * @returns {Promise<{uid: string, email?: string, ...}>} Decoded token payload
 * @throws {Error} On invalid/missing/expired token (error.statusCode = 401)
 */
export const verifyFirebaseToken = async (idToken, options = {}) => {
    const projectId = options.projectId || process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
        const err = new Error("missing-firebase-project-id");
        err.statusCode = 500;
        throw err;
    }

    if (!idToken || typeof idToken !== "string") {
        const err = new Error("unauthorized");
        err.statusCode = 401;
        throw err;
    }

    try {
        const publicKeys = await getPublicKeys();
        const decoded = await jwtVerify(
            idToken,
            async (header) => {
                const x509Cert = publicKeys[header.kid];
                if (!x509Cert) {
                    throw new Error("unknown-key-id");
                }
                return importX509(x509Cert, "RS256");
            },
            {
                issuer: `https://securetoken.google.com/${projectId}`,
                audience: projectId,
                algorithms: ["RS256"],
            },
        );
        const payload = decoded.payload;
        // Firebase JWT uses "sub" for user ID; Admin SDK adds "uid" as alias.
        // When using raw JWT verification, ensure uid is available for consistency.
        return { ...payload, uid: payload.uid ?? payload.sub };
    } catch (verifyError) {
        const err = new Error("unauthorized");
        err.statusCode = 401;
        err.cause = verifyError;
        throw err;
    }
};

/**
 * Parses Authorization header and verifies Firebase token.
 * @param {Object} event - Lambda event (with headers)
 * @returns {Promise<{uid: string, email?: string, ...}>}
 * @throws {Error} error.statusCode = 401 if missing or invalid
 */
export const requireAuth = async (event) => {
    const authHeader = getAuthHeader(event?.headers || event?.rawHeaders);
    if (!authHeader) {
        const err = new Error("unauthorized");
        err.statusCode = 401;
        throw err;
    }
    return verifyFirebaseToken(authHeader);
};
