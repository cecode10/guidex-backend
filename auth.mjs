/**
 * Firebase ID token verification using the Admin SDK.
 * Requires initializeApp() to have been called (see index.mjs).
 */
import { getAuth } from "firebase-admin/auth";
import { checkNewUser } from "./analytics.mjs";

/**
 * Extracts the Bearer token from Authorization header.
 * @param {Object} headers - Request headers
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
 * @returns {Promise<{uid: string, email?: string, ...}>} Decoded token payload
 * @throws {Error} On invalid/missing/expired token (error.statusCode = 401)
 */
export const verifyFirebaseToken = async (idToken) => {
    if (!idToken || typeof idToken !== "string") {
        const err = new Error("unauthorized");
        err.statusCode = 401;
        throw err;
    }
    try {
        return await getAuth().verifyIdToken(idToken);
    } catch (verifyError) {
        const err = new Error("unauthorized");
        err.statusCode = 401;
        err.cause = verifyError;
        throw err;
    }
};

/**
 * Parses Authorization header and verifies Firebase token.
 * @param {Object} req - Express-like request (with headers)
 * @returns {Promise<{uid: string, email?: string, ...}>}
 * @throws {Error} error.statusCode = 401 if missing or invalid
 */
export const requireAuth = async (req) => {
    const authHeader = getAuthHeader(req?.headers);
    if (!authHeader) {
        const err = new Error("unauthorized");
        err.statusCode = 401;
        throw err;
    }
    const decoded = await verifyFirebaseToken(authHeader);
    checkNewUser(decoded.uid);
    return decoded;
};
