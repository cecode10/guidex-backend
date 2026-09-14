import nodemailer from "nodemailer";
import { MAIL_SUPPORT_BCC, asAddressList } from "../utils/email-utils.mjs";
import { readSmtpRuntimeConfig } from "../utils/mail-params.mjs";
import { smtpConfigError, smtpTransportOptions } from "../utils/smtp-utils.mjs";
import { MAIL_LOGO_CID, ramblexLogoAttachment } from "../utils/mail-template-utils.mjs";

/** @type {import("nodemailer").Transporter | null} */
let cachedTransporter = null;
let cachedTransportKey = "";

/**
 * @param {{
 *   host: string,
 *   port: string | number,
 *   user: string,
 *   password: string,
 * }} smtp
 */
const transporterFor = (smtp) => {
    const key = `${smtp.host}|${smtp.port}|${smtp.user}`;
    if (cachedTransporter && cachedTransportKey === key) return cachedTransporter;
    cachedTransporter = nodemailer.createTransport(smtpTransportOptions(smtp));
    cachedTransportKey = key;
    return cachedTransporter;
};

/**
 * Fills From / Reply-To / optional support BCC. Workflows only supply content.
 *
 * @param {{
 *   to?: string | string[],
 *   cc?: string | string[],
 *   bcc?: string | string[],
 *   subject: string,
 *   text: string,
 *   html?: string,
 *   from?: string,
 *   replyTo?: string,
 *   bccSupport?: boolean,
 * }} input
 * @param {string} defaultFrom
 */
export const resolveMailMessage = (input, defaultFrom) => {
    const to = asAddressList(input.to);
    const cc = asAddressList(input.cc);
    const bcc = asAddressList(input.bcc);
    if (input.bccSupport) {
        const support = MAIL_SUPPORT_BCC.toLowerCase();
        if (!bcc.includes(support) && !to.includes(support)) bcc.push(support);
    }

    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    const text = typeof input.text === "string" ? input.text : "";
    const html = typeof input.html === "string" && input.html.trim()
        ? input.html
        : undefined;
    const from = (input.from || defaultFrom || "").trim();
    const replyTo = (input.replyTo || MAIL_SUPPORT_BCC).trim();

    return { from, to, cc, bcc, replyTo, subject, text, html };
};

/**
 * @param {{ from: string, to: string[], cc: string[], bcc: string[], subject: string, text: string }} message
 * @returns {string | null}
 */
export const mailMessageError = (message) => {
    if (!message.from) return "From address is missing";
    if (message.to.length === 0 && message.bcc.length === 0) return "No recipients";
    if (!message.subject) return "Subject is required";
    if (!message.text.trim()) return "Text body is required";
    return null;
};

/**
 * Send a transactional email over the shared Zoho SMTP account.
 *
 * @param {{
 *   to?: string | string[],
 *   cc?: string | string[],
 *   bcc?: string | string[],
 *   subject: string,
 *   text: string,
 *   html?: string,
 *   from?: string,
 *   replyTo?: string,
 *   bccSupport?: boolean,
 *   attachments?: import("nodemailer").SendMailOptions["attachments"],
 * }} input
 * @returns {Promise<{ ok: true, messageId: string } | { ok: false, error: string }>}
 */
export const sendMail = async (input) => {
    const smtp = readSmtpRuntimeConfig();
    const configError = smtpConfigError(smtp);
    if (configError) {
        console.error("sendMail: %s", configError);
        return { ok: false, error: configError };
    }

    const message = resolveMailMessage(input, smtp.from);
    const messageError = mailMessageError(message);
    if (messageError) {
        console.error("sendMail: %s", messageError);
        return { ok: false, error: messageError };
    }

    const attachments = Array.isArray(input.attachments) ? [...input.attachments] : [];
    if (message.html?.includes(`cid:${MAIL_LOGO_CID}`)) {
        attachments.push(ramblexLogoAttachment());
    }

    const info = await transporterFor(smtp).sendMail({
        from: message.from,
        to: message.to,
        cc: message.cc.length > 0 ? message.cc : undefined,
        bcc: message.bcc.length > 0 ? message.bcc : undefined,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: attachments.length > 0 ? attachments : undefined,
    });
    return { ok: true, messageId: info.messageId || "" };
};
