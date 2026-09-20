import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { interpolateMailTemplate, MAIL_LOGO_PATH } from "./mail-template-utils.mjs";

const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export const WEB_LAYOUT_NAME = "base";
export const WEB_TEMPLATES_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "web",
);
export const WEB_HOSTING_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "hosting",
);
export const WEB_HOSTING_ASSETS_DIR = join(WEB_HOSTING_DIR, "assets");
export const WEB_HOSTING_LOGO_PATH = join(WEB_HOSTING_ASSETS_DIR, "ramblex-logo.png");

/** @type {Map<string, string>} */
const templateCache = new Map();

/**
 * @param {string} name
 * @returns {string}
 */
const assertTemplateName = (name) => {
    if (!TEMPLATE_NAME_RE.test(name)) {
        throw new Error(`Invalid web template name: ${name}`);
    }
    return name;
};

/**
 * @param {string} name File stem under {@link WEB_TEMPLATES_DIR}, e.g. `email-confirmed`.
 * @returns {string}
 */
export const loadWebTemplate = (name) => {
    const safeName = assertTemplateName(name);
    const cached = templateCache.get(safeName);
    if (cached) return cached;

    const path = join(WEB_TEMPLATES_DIR, `${safeName}.html`);
    let source;
    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT") {
            throw new Error(`Web template not found: ${safeName}`);
        }
        throw error;
    }

    templateCache.set(safeName, source);
    return source;
};

export const loadWebLayout = () => loadWebTemplate(WEB_LAYOUT_NAME);

/**
 * @param {string} name
 * @returns {string | null}
 */
const loadWebScriptTemplate = (name) => {
    assertTemplateName(name);
    const path = join(WEB_TEMPLATES_DIR, `${name}.script.html`);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
};

/**
 * Renders one hosted page inside {@link WEB_LAYOUT_NAME}.
 *
 * @param {string} name
 * @param {Record<string, string | number | null | undefined>} vars
 * @returns {string}
 */
export const renderWebPage = (name, vars) => {
    if (name === WEB_LAYOUT_NAME) {
        throw new Error("base is a layout, not a hosted page");
    }

    const body = interpolateMailTemplate(loadWebTemplate(name), vars);
    const scriptTemplate = loadWebScriptTemplate(name);
    const scripts = scriptTemplate
        ? interpolateMailTemplate(scriptTemplate, vars)
        : "";

    return interpolateMailTemplate(loadWebLayout(), {
        title: "Ramblex",
        signoffBlock: "",
        scripts,
        ...vars,
        body,
    });
};

/**
 * Writes static Firebase Hosting assets from web templates.
 */
export const buildHosting = () => {
    mkdirSync(WEB_HOSTING_ASSETS_DIR, { recursive: true });
    cpSync(MAIL_LOGO_PATH, WEB_HOSTING_LOGO_PATH);

    const emailConfirmedHtml = renderWebPage("email-confirmed", {
        title: "Confirming email · Ramblex",
    });
    const emailConfirmedDir = join(WEB_HOSTING_DIR, "email-confirmed");
    mkdirSync(emailConfirmedDir, { recursive: true });
    writeFileSync(join(emailConfirmedDir, "index.html"), emailConfirmedHtml, "utf8");
};
