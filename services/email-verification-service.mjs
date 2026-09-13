import { getAuth } from "firebase-admin/auth";
import { sendMail } from "./mail-service.mjs";
import { buildEmailVerificationMail } from "../utils/email-verification-email-utils.mjs";
import { normalizeEmail } from "../utils/email-utils.mjs";

/** After the Firebase action handler verifies the address, the browser lands here. */
export const EMAIL_VERIFICATION_CONTINUE_URL = "https://guidex-afc30.firebaseapp.com";

/**
 * @param {unknown} error
 * @returns {never}
 */
const rethrowAuthLinkError = (error) => {
    const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "auth/too-many-requests") {
        const err = new Error("too-many-requests");
        err.statusCode = 429;
        throw err;
    }
    throw error;
};

/**
 * Builds a Firebase verification link and sends the branded sign-up mail.
 *
 * @param {{ uid: string, email?: string | null }} input
 * @param {{
 *   auth?: import("firebase-admin/auth").Auth,
 *   send?: typeof sendMail,
 * }} [deps]
 * @returns {Promise<{ ok: true, alreadyVerified: boolean, messageId?: string }>}
 */
export const sendSignupEmailVerification = async (
    { uid, email },
    { auth = getAuth(), send = sendMail } = {},
) => {
    if (!uid || typeof uid !== "string") {
        const err = new Error("uid is required");
        err.statusCode = 400;
        throw err;
    }

    const user = await auth.getUser(uid);
    if (user.emailVerified) {
        return { ok: true, alreadyVerified: true };
    }

    const userEmail = normalizeEmail(user.email) || normalizeEmail(email);
    if (!userEmail) {
        const err = new Error("email is required");
        err.statusCode = 400;
        throw err;
    }

    let verificationUrl;
    try {
        verificationUrl = await auth.generateEmailVerificationLink(userEmail, {
            url: EMAIL_VERIFICATION_CONTINUE_URL,
        });
    } catch (error) {
        rethrowAuthLinkError(error);
    }

    const mail = await send(buildEmailVerificationMail({
        email: userEmail,
        verificationUrl,
    }));
    if (!mail.ok) {
        const err = new Error(mail.error || "send failed");
        err.statusCode = 502;
        throw err;
    }

    return { ok: true, alreadyVerified: false, messageId: mail.messageId };
};
