/** Hosted handler that applies the verification code and shows one confirmation screen. */
export const EMAIL_VERIFICATION_HANDLER_URL =
    "https://guidex-afc30.web.app/email-confirmed";

/**
 * Firebase's default `/__/auth/action` page always shows Continue. Point the
 * mail link at our handler instead, keeping `mode`, `oobCode`, and `apiKey`.
 *
 * @param {string} generatedUrl
 * @returns {string}
 */
export const toCustomEmailVerificationUrl = (generatedUrl) => {
    let source;
    try {
        source = new URL(generatedUrl);
    } catch {
        return generatedUrl;
    }

    const dest = new URL(EMAIL_VERIFICATION_HANDLER_URL);
    dest.search = source.search;
    dest.searchParams.delete("continueUrl");
    return dest.toString();
};
