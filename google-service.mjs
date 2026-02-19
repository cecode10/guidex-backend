/**
 * Google Identity Toolkit service for Firebase Auth admin operations.
 * Uses jose (already a project dependency) to sign JWTs for service-account auth,
 * avoiding the heavy firebase-admin SDK.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  – JSON string of a GCP service-account key
 *   FIREBASE_PROJECT_ID         – Firebase project ID
 */
import { SignJWT, importPKCS8 } from "jose";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const IDENTITY_TOOLKIT_URL = "https://identitytoolkit.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/identitytoolkit";

let cachedAccessToken = null;
let tokenExpiresAt = 0;

const getServiceAccountCredentials = () => {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!raw) {
        const err = new Error("missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable");
        err.statusCode = 500;
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch {
        const err = new Error("invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON");
        err.statusCode = 500;
        throw err;
    }
};

/**
 * Obtains (and caches) an OAuth2 access token for the service account.
 * The token is reused until 60 s before expiry.
 */
const getAccessToken = async () => {
    const now = Math.floor(Date.now() / 1000);
    if (cachedAccessToken && now < tokenExpiresAt - 60) {
        return cachedAccessToken;
    }

    const credentials = getServiceAccountCredentials();
    const privateKey = await importPKCS8(credentials.private_key, "RS256");

    const jwt = await new SignJWT({ scope: SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(credentials.client_email)
        .setSubject(credentials.client_email)
        .setAudience(TOKEN_URL)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!res.ok) {
        const body = await res.text();
        console.error("google-service: token exchange failed status=%d body=%s", res.status, body);
        const err = new Error(`failed to obtain access token: ${body}`);
        err.statusCode = 502;
        throw err;
    }

    const data = await res.json();
    cachedAccessToken = data.access_token;
    tokenExpiresAt = now + (data.expires_in || 3600);
    return cachedAccessToken;
};

/**
 * Permanently deletes a user from Firebase Authentication.
 *
 * @param {string} uid - Firebase user UID to delete
 * @returns {Promise<{ deleted: true }>}
 * @throws {{ statusCode: number, message: string }}
 */
export const deleteFirebaseUser = async (uid) => {
    if (!uid || typeof uid !== "string") {
        const err = new Error("uid is required");
        err.statusCode = 400;
        throw err;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
        const err = new Error("missing FIREBASE_PROJECT_ID");
        err.statusCode = 500;
        throw err;
    }

    const accessToken = await getAccessToken();
    const url = `${IDENTITY_TOOLKIT_URL}/projects/${projectId}/accounts:delete`;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ localId: uid }),
    });

    if (!res.ok) {
        const body = await res.text();
        console.error("google-service: delete-user failed status=%d body=%s", res.status, body);
        const err = new Error(`failed to delete firebase user: ${body}`);
        err.statusCode = res.status >= 500 ? 502 : res.status;
        throw err;
    }

    console.log("google-service: user %s deleted", uid);
    return { deleted: true };
};
