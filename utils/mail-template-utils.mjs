import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./email-utils.mjs";

const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const UNESCAPED_PLACEHOLDER_RE = /\{\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}\}/g;
const ESCAPED_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export const MAIL_LAYOUT_NAME = "base";
export const MAIL_LOGO_CID = "ramblex-logo";

export const MAIL_TEMPLATES_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "mail",
);

export const MAIL_LOGO_PATH = join(MAIL_TEMPLATES_DIR, "assets", "ramblex-logo.png");

/** @type {Map<string, string>} */
const templateCache = new Map();

/**
 * @param {string} name
 * @returns {string}
 */
const assertTemplateName = (name) => {
    if (!TEMPLATE_NAME_RE.test(name)) {
        throw new Error(`Invalid mail template name: ${name}`);
    }
    return name;
};

/**
 * @param {string} name File stem under {@link MAIL_TEMPLATES_DIR}, e.g. `report-received`.
 * @returns {string}
 */
export const loadMailTemplate = (name) => {
    const safeName = assertTemplateName(name);
    const cached = templateCache.get(safeName);
    if (cached) return cached;

    const path = join(MAIL_TEMPLATES_DIR, `${safeName}.html`);
    let source;
    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT") {
            throw new Error(`Mail template not found: ${safeName}`);
        }
        throw error;
    }

    templateCache.set(safeName, source);
    return source;
};

export const loadMailLayout = () => loadMailTemplate(MAIL_LAYOUT_NAME);

/**
 * Inline logo for HTML mail clients. Nodemailer `cid` matches `src="cid:ramblex-logo"`.
 *
 * @returns {{ filename: string, path: string, cid: string, contentType: string }}
 */
export const ramblexLogoAttachment = () => ({
    filename: "ramblex-logo.png",
    path: MAIL_LOGO_PATH,
    cid: MAIL_LOGO_CID,
    contentType: "image/png",
});

/**
 * @param {string} source
 * @param {Record<string, string | number | null | undefined>} vars
 * @returns {string}
 */
export const interpolateMailTemplate = (source, vars) => {
    const withRaw = source.replace(UNESCAPED_PLACEHOLDER_RE, (_, key) => {
        const value = vars[key];
        return value == null ? "" : String(value);
    });
    return withRaw.replace(ESCAPED_PLACEHOLDER_RE, (_, key) => {
        const value = vars[key];
        if (value == null) return "";
        return escapeHtml(String(value));
    });
};

/**
 * @param {string} html
 * @returns {string}
 */
export const htmlToPlainText = (html) =>
    html
        .replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/gi, "")
        .replace(/<!--\[if !mso\]><!-->/gi, "")
        .replace(/<!--<!\[endif\]-->/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
        .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
            const text = label.replace(/<[^>]+>/g, "").trim();
            return text && text !== href ? `${text} (${href})` : href;
        })
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

/**
 * Renders one use-case body inside {@link MAIL_LAYOUT_NAME}.
 *
 * @param {string} name
 * @param {Record<string, string | number | null | undefined>} vars
 * @returns {{ html: string, text: string }}
 */
export const renderMailTemplate = (name, vars) => {
    if (name === MAIL_LAYOUT_NAME) {
        throw new Error("base is a layout, not a mail use case");
    }

    const body = interpolateMailTemplate(loadMailTemplate(name), vars);
    const html = interpolateMailTemplate(loadMailLayout(), {
        title: "Ramblex",
        footerNotice: "",
        signoff:
            'Have a great trip!<br>Your Kudosai team',
        ...vars,
        body,
    });
    return { html, text: htmlToPlainText(html) };
};
