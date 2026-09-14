/**
 * Nodemailer transport options for Zoho Mail (or any SMTP host).
 *
 * Zoho:
 * - Personal / free org: smtp.zoho.com | smtp.zoho.eu | smtp.zoho.in
 * - Paid org (custom domain): smtppro.zoho.com | smtppro.zoho.eu | …
 * - Port 465 + SSL, or 587 + STARTTLS
 * - Username is the full mailbox address; 2FA needs an app password
 *
 * @param {{
 *   host: string,
 *   port: number,
 *   user: string,
 *   password: string,
 * }} config
 * @returns {import("nodemailer").TransportOptions}
 */
export const smtpTransportOptions = ({ host, port, user, password }) => {
    const secure = Number(port) === 465;
    return {
        host,
        port: Number(port),
        secure,
        requireTLS: !secure,
        auth: {
            user,
            pass: password,
        },
    };
};

/**
 * Zoho requires MAIL FROM / From to be the authenticated mailbox or one of its
 * aliases. `SMTP_FROM=Ramblex` alone is rejected as relay; turn a display name
 * into `Ramblex <user@domain>`. A full address in SMTP_FROM (bare or angled)
 * is kept so aliases like support@ can send while SMTP_USER stays the mailbox.
 *
 * @param {string} from
 * @param {string} user
 * @returns {string}
 */
export const formatSmtpFrom = (from, user) => {
    const mailbox = (user || "").trim();
    const raw = (from || "").trim();
    if (!raw) return mailbox;
    if (!mailbox) return raw;

    const angled = raw.match(/^(.*)<([^>]+)>\s*$/);
    if (angled) {
        const label = angled[1].trim();
        const address = angled[2].trim();
        const email = address.includes("@") ? address : mailbox;
        return label ? `${label} <${email}>` : email;
    }
    if (raw.includes("@")) return raw;
    return `${raw} <${mailbox}>`;
};

/**
 * @param {{ host?: string, port?: string | number, user?: string, password?: string, from?: string }} config
 * @returns {string | null}
 */
export const smtpConfigError = (config) => {
    if (!config.host?.trim()) return "SMTP_HOST is not set";
    const port = Number(config.port);
    if (!Number.isInteger(port) || port <= 0) return "SMTP_PORT is invalid";
    if (!config.user?.trim()) return "SMTP_USER is not set";
    if (!config.password) return "SMTP_PASSWORD is not set";
    return null;
};
