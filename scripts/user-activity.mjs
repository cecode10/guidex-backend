#!/usr/bin/env node
/**
 * Prints what a user did in the app, from the Firebase Analytics BigQuery
 * export (daily + streaming intraday tables). Events are matched on the
 * analytics user ID, which the app sets to the Firebase Auth uid.
 *
 *   node scripts/user-activity.mjs <uid|email>                 # last session
 *   node scripts/user-activity.mjs <uid|email> --last 1h       # 30m, 6h, 1d, 7d...
 *   node scripts/user-activity.mjs <uid|email> --last 1d --json
 *
 * Options:
 *   --last WINDOW        "session" (default) or a duration like 30m, 1h, 1d.
 *   --verbose            Show every event parameter, including GA internals.
 *   --json               Print events as JSON instead of a timeline.
 *   --limit N            Max events to fetch (default 2000).
 *   --dataset NAME       Analytics dataset (default: the only analytics_* one).
 *   --credentials PATH   Service account JSON (default: scripts/guidex-afc30-*.json).
 *                        Needs BigQuery Data Viewer + BigQuery Job User.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { resolveCredentialsPath } from "./seed/script-common.mjs";

const SCRIPT_LABEL = "user-activity";
const PROJECT_ID = "guidex-afc30";
const SESSION_LOOKBACK_DAYS = 7;
const DEFAULT_LIMIT = 2000;

const USAGE =
    "usage: node scripts/user-activity.mjs <uid|email> [--last session|30m|1h|1d] [--verbose] [--json] [--limit N] [--dataset NAME] [--credentials PATH]";

/** Parameters GA adds to every event; hidden unless --verbose. */
const NOISE_PARAMS = new Set([
    "engaged_session_event",
    "engagement_time_msec",
    "entrances",
    "firebase_conversion",
    "firebase_event_origin",
    "firebase_previous_class",
    "firebase_previous_id",
    "firebase_previous_screen",
    "firebase_screen_class",
    "firebase_screen_id",
    "ga_session_id",
    "ga_session_number",
    "previous_first_open_count",
    "session_engaged",
    "system_app",
    "system_app_update",
    "update_with_analytics",
]);

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * @param {string} value "session" or a duration like "30m", "1h", "7d"
 * @returns {{ mode: "session", ms: number } | { mode: "range", ms: number }}
 */
export const parseWindow = (value) => {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "" || raw === "session") {
        return { mode: "session", ms: SESSION_LOOKBACK_DAYS * UNIT_MS.d };
    }
    const match = /^(\d+)\s*([mhd])$/.exec(raw);
    if (!match || Number(match[1]) <= 0) {
        throw new Error(`invalid --last "${value}" (use session, 30m, 1h, 1d...)`);
    }
    return { mode: "range", ms: Number(match[1]) * UNIT_MS[/** @type {"m"|"h"|"d"} */ (match[2])] };
};

/** @param {Date} date */
const yyyymmdd = (date) => date.toISOString().slice(0, 10).replaceAll("-", "");

/**
 * Table suffix range covering [fromMs, nowMs]. Padded by a day on each side
 * because export tables are split by the property's time zone, not UTC.
 *
 * @param {number} fromMs
 * @param {number} nowMs
 */
export const tableDayRange = (fromMs, nowMs) => ({
    fromDay: yyyymmdd(new Date(fromMs - UNIT_MS.d)),
    toDay: yyyymmdd(new Date(nowMs + UNIT_MS.d)),
});

/**
 * @param {{ dataset: string, sessionOnly: boolean }} opts
 */
export const buildActivityQuery = ({ dataset, sessionOnly }) => `
WITH ev AS (
    SELECT
        DIV(event_timestamp, 1000) AS ts_ms,
        event_name,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id,
        ARRAY(
            SELECT AS STRUCT
                key,
                COALESCE(
                    value.string_value,
                    CAST(value.int_value AS STRING),
                    CAST(value.double_value AS STRING),
                    CAST(value.float_value AS STRING)
                ) AS value
            FROM UNNEST(event_params)
            ORDER BY key
        ) AS params,
        platform,
        app_info.version AS app_version,
        device.mobile_brand_name AS device_brand,
        device.mobile_model_name AS device_model,
        device.operating_system_version AS os_version,
        geo.city AS city,
        geo.country AS country
    FROM \`${PROJECT_ID}.${dataset}.events_*\`
    WHERE (
            _TABLE_SUFFIX BETWEEN @fromDay AND @toDay
            OR _TABLE_SUFFIX BETWEEN CONCAT('intraday_', @fromDay) AND CONCAT('intraday_', @toDay)
        )
        AND user_id = @uid
        AND event_timestamp >= @fromMicros
    -- A day can briefly exist in both the intraday and the daily table.
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY user_pseudo_id, event_timestamp, event_name, event_bundle_sequence_id
    ) = 1
)
SELECT * FROM ev
${sessionOnly
        ? "WHERE session_id = (SELECT session_id FROM ev WHERE session_id IS NOT NULL ORDER BY ts_ms DESC LIMIT 1)"
        : ""}
ORDER BY ts_ms
LIMIT @limit
`;

/**
 * @typedef {{
 *   ts_ms: number, event_name: string, session_id: number | null,
 *   params: { key: string, value: string | null }[],
 *   platform: string | null, app_version: string | null,
 *   device_brand: string | null, device_model: string | null, os_version: string | null,
 *   city: string | null, country: string | null,
 * }} EventRow
 */

/**
 * Consecutive events with the same session id, in order.
 *
 * @param {EventRow[]} rows sorted by ts_ms
 * @returns {{ sessionId: number | null, events: EventRow[] }[]}
 */
export const groupBySession = (rows) => {
    const groups = [];
    for (const row of rows) {
        const sessionId = row.session_id ?? null;
        const last = groups.at(-1);
        if (last && last.sessionId === sessionId) last.events.push(row);
        else groups.push({ sessionId, events: [row] });
    }
    return groups;
};

/** @param {number} ms */
export const formatDuration = (ms) => {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
};

/**
 * @param {EventRow["params"]} params
 * @param {boolean} verbose
 */
export const formatParams = (params, verbose) =>
    (params ?? [])
        .filter(({ key, value }) => value != null && (verbose || !NOISE_PARAMS.has(key)))
        .map(({ key, value }) => {
            const isDuration = /_(ms|msec)$/.test(key) && /^\d+$/.test(String(value));
            return `${key}=${isDuration ? formatDuration(Number(value)) : value}`;
        })
        .join(" ");

/**
 * Total screen_time per screen, longest first.
 *
 * @param {EventRow[]} rows
 */
export const screenTimeTotals = (rows) => {
    /** @type {Map<string, number>} */
    const totals = new Map();
    for (const row of rows) {
        if (row.event_name !== "screen_time") continue;
        const get = (key) => row.params?.find((p) => p.key === key)?.value;
        const screen = get("screen_name");
        const ms = Number(get("duration_ms"));
        if (!screen || !Number.isFinite(ms)) continue;
        totals.set(screen, (totals.get(screen) ?? 0) + ms);
    }
    return [...totals].sort((a, b) => b[1] - a[1]);
};

/** @param {EventRow} row */
const describeDevice = (row) =>
    [
        [row.platform, row.os_version].filter(Boolean).join(" "),
        [row.device_brand, row.device_model].filter(Boolean).join(" "),
        row.app_version ? `app ${row.app_version}` : "",
        [row.city, row.country].filter(Boolean).join(", "),
    ]
        .filter(Boolean)
        .join(" · ");

const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/**
 * @param {EventRow[]} rows
 * @param {{ who: string, windowLabel: string, verbose: boolean }} opts
 */
export const renderTimeline = (rows, { who, windowLabel, verbose }) => {
    const lines = [];
    const groups = groupBySession(rows);
    const sessionCount = new Set(rows.map((r) => r.session_id).filter((id) => id != null)).size;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    lines.push(`User ${who}`);
    lines.push(`Window: ${windowLabel} · times in ${tz}`);
    lines.push(`${rows.length} events · ${sessionCount} session${sessionCount === 1 ? "" : "s"}`);

    const screens = screenTimeTotals(rows);
    if (screens.length > 0) {
        lines.push(`Time on screens: ${screens.map(([s, ms]) => `${s} ${formatDuration(ms)}`).join(" · ")}`);
    }

    const nameWidth = Math.min(28, Math.max(...rows.map((r) => r.event_name.length)));
    for (const { sessionId, events } of groups) {
        const first = events[0];
        const last = events.at(-1) ?? first;
        lines.push("");
        lines.push(
            `── Session ${sessionId ?? "(none)"} · ${dateTimeFmt.format(first.ts_ms)} → ${timeFmt.format(last.ts_ms)}` +
            ` (${formatDuration(last.ts_ms - first.ts_ms)}) ──`,
        );
        const device = describeDevice(first);
        if (device) lines.push(`   ${device}`);
        for (const row of events) {
            const params = formatParams(row.params, verbose);
            lines.push(`${timeFmt.format(row.ts_ms)}  ${row.event_name.padEnd(nameWidth)}  ${params}`.trimEnd());
        }
    }
    return lines.join("\n");
};

/** @param {EventRow} row */
const toJsonEvent = (row) => ({
    ts: new Date(row.ts_ms).toISOString(),
    event: row.event_name,
    session_id: row.session_id,
    params: Object.fromEntries((row.params ?? []).map(({ key, value }) => [key, value])),
    platform: row.platform,
    app_version: row.app_version,
    device: [row.device_brand, row.device_model].filter(Boolean).join(" ") || null,
    os_version: row.os_version,
    city: row.city,
    country: row.country,
});

/**
 * @param {BigQuery} bigquery
 */
const findAnalyticsDataset = async (bigquery) => {
    const [datasets] = await bigquery.getDatasets();
    const ids = datasets.map((d) => d.id ?? "").filter((id) => /^analytics_\d+$/.test(id));
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) {
        throw new Error(
            `no analytics_* dataset in ${PROJECT_ID}. Link Analytics to BigQuery in ` +
            "Firebase Console → Project settings → Integrations → BigQuery.",
        );
    }
    throw new Error(`several analytics datasets (${ids.join(", ")}); pass --dataset`);
};

/**
 * @param {string} identifier
 * @param {object} serviceAccount
 */
const resolveUid = async (identifier, serviceAccount) => {
    const value = identifier.trim();
    if (!value.includes("@")) return { uid: value, email: null };
    initializeApp({ credential: cert(serviceAccount), projectId: PROJECT_ID });
    const user = await getAuth().getUserByEmail(value);
    return { uid: user.uid, email: user.email ?? value };
};

/**
 * @param {unknown} error
 * @param {string} clientEmail
 */
const explainError = (error, clientEmail) => {
    const message = String(/** @type {any} */ (error)?.message ?? error);
    const code = /** @type {any} */ (error)?.code;
    if (code === 403 || /permission|access denied/i.test(message)) {
        return `${message}\n\nGrant ${clientEmail} the roles "BigQuery Data Viewer" and ` +
            `"BigQuery Job User" on ${PROJECT_ID}, or pass --credentials with a key that has them.`;
    }
    if (/auth\/user-not-found/.test(code ?? "") || /no user record/i.test(message)) {
        return `no account found: ${message}`;
    }
    return message;
};

const main = async () => {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            last: { type: "string", default: "session" },
            verbose: { type: "boolean", default: false },
            json: { type: "boolean", default: false },
            limit: { type: "string", default: String(DEFAULT_LIMIT) },
            dataset: { type: "string", default: "" },
            credentials: { type: "string", default: "" },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help || positionals.length !== 1) {
        console.log(USAGE);
        process.exit(values.help ? 0 : 1);
    }

    const window = parseWindow(values.last);
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`invalid --limit "${values.limit}"`);

    const credentialsPath = resolveCredentialsPath(values.credentials, SCRIPT_LABEL);
    const serviceAccount = JSON.parse(readFileSync(credentialsPath, "utf8"));
    console.error(`using credentials ${credentialsPath}`);

    try {
        const { uid, email } = await resolveUid(positionals[0], serviceAccount);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
        const bigquery = new BigQuery({ projectId: PROJECT_ID });
        const dataset = values.dataset || (await findAnalyticsDataset(bigquery));

        const nowMs = Date.now();
        const fromMs = nowMs - window.ms;
        const sessionOnly = window.mode === "session";
        const [rows] = await bigquery.query({
            query: buildActivityQuery({ dataset, sessionOnly }),
            params: {
                uid,
                fromMicros: fromMs * 1000,
                limit,
                ...tableDayRange(fromMs, nowMs),
            },
        });

        const who = email ? `${uid} (${email})` : uid;
        if (values.json) {
            console.log(JSON.stringify({ uid, email, window: values.last, events: rows.map(toJsonEvent) }, null, 2));
        } else if (rows.length === 0) {
            console.log(sessionOnly
                ? `No sessions for ${who} in the last ${SESSION_LOOKBACK_DAYS} days. Try --last 30d.`
                : `No events for ${who} in the last ${values.last}.`);
        } else {
            const windowLabel = sessionOnly ? "last session" : `last ${values.last}`;
            console.log(renderTimeline(rows, { who, windowLabel, verbose: values.verbose }));
        }
        if (rows.length === limit) {
            console.error(`\nstopped at --limit ${limit}; older events were cut off`);
        }
    } catch (error) {
        console.error(explainError(error, serviceAccount.client_email));
        process.exitCode = 1;
    }
};

const isDirectRun =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
    main().catch((error) => {
        console.error(error?.stack || error);
        process.exit(1);
    });
}
