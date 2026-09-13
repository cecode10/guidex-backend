import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./email-utils.mjs";

const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export const MAIL_TEMPLATES_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "mail",
);

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

/**
 * @param {string} source
 * @param {Record<string, string | number | null | undefined>} vars
 * @returns {string}
 */
export const interpolateMailTemplate = (source, vars) =>
    source.replace(PLACEHOLDER_RE, (_, key) => {
        const value = vars[key];
        if (value == null) return "";
        return escapeHtml(String(value));
    });

/**
 * @param {string} html
 * @returns {string}
 */
export const htmlToPlainText = (html) =>
    html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
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
 * Renders one HTML mail template and a plain-text fallback.
 *
 * @param {string} name
 * @param {Record<string, string | number | null | undefined>} vars
 * @returns {{ html: string, text: string }}
 */
export const renderMailTemplate = (name, vars) => {
    const html = interpolateMailTemplate(loadMailTemplate(name), vars);
    return { html, text: htmlToPlainText(html) };
};
