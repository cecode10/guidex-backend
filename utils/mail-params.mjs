import { defineSecret, defineString } from "firebase-functions/params";
import { formatSmtpFrom } from "./smtp-utils.mjs";

/** Shared Zoho SMTP params. Import these from any function that sends mail. */
export const smtpHost = defineString("SMTP_HOST", { default: "smtp.zoho.eu" });
export const smtpPort = defineString("SMTP_PORT", { default: "465" });
export const smtpUser = defineString("SMTP_USER", { default: "" });
export const smtpFrom = defineString("SMTP_FROM", { default: "" });
export const smtpPassword = defineSecret("SMTP_PASSWORD");

/** Attach to any Cloud Function that calls `sendMail`. */
export const mailFunctionSecrets = [smtpPassword];

/**
 * @returns {{ host: string, port: string, user: string, password: string, from: string }}
 */
export const readSmtpRuntimeConfig = () => {
    const user = smtpUser.value();
    return {
        host: smtpHost.value(),
        port: smtpPort.value(),
        user,
        password: smtpPassword.value(),
        from: formatSmtpFrom(smtpFrom.value(), user),
    };
};
