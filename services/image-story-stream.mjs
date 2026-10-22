const NAME_LINE = /^NAME:\s*(.*)$/i;
const UNRECOGNIZED_NAME = /^UNRECOGNIZED$/i;
const MAX_HEADER_CHARS = 240;
const ID_LINE = /^ID:\s*(.*)$/i;
const PLACE_REF = /^P\d{1,2}$/;
const MAX_ID_LINE_CHARS = 40;

const parseNameLine = (line) => {
    const cleaned = line.replace(/^\uFEFF/, "").trim();
    const match = cleaned.match(NAME_LINE);
    if (!match) {
        return { kind: "story" };
    }
    const name = match[1].trim().replace(/[.。]$/, "").trim();
    if (!name || UNRECOGNIZED_NAME.test(name)) {
        return { kind: "unrecognized" };
    }
    return { kind: "name", name };
};

const stripLeadingBreaks = (text) => text.replace(/^[\r\n]+/, "");

/**
 * @param {string} line
 * @returns {string | null} the place ref ("P3"), "" for an ID line without a valid ref, null when not an ID line
 */
const parseIdLine = (line) => {
    const match = line.trim().match(ID_LINE);
    if (!match) {
        return null;
    }
    const value = match[1].trim().replace(/[.。]$/, "").toUpperCase();
    return PLACE_REF.test(value) ? value : "";
};

/** True while `pending` (no newline yet) could still become an "ID: ..." line. */
const couldBeIdLine = (pending) => {
    if (pending.length < 3) {
        return "ID:".startsWith(pending.toUpperCase());
    }
    return ID_LINE.test(pending) && pending.length <= MAX_ID_LINE_CHARS;
};

/**
 * Turns model text deltas into name, place, story, and unrecognized events.
 * The model is asked to start with a single "NAME: ..." line, optionally
 * followed by an "ID: P3" line when the subject is a listed nearby place.
 *
 * @param {AsyncIterable<string>} deltas
 */
export async function* parseImageStoryStream(deltas) {
    let header = "";
    let headerDone = false;
    let skipLeadingBreaks = false;
    let awaitingId = false;
    let idBuffer = "";

    const emitStory = function* (text) {
        if (!text) {
            return;
        }
        if (skipLeadingBreaks) {
            const stripped = stripLeadingBreaks(text);
            if (!stripped) {
                return;
            }
            skipLeadingBreaks = false;
            if (stripped !== text && stripped.length === 0) {
                return;
            }
            yield { type: "token", token: stripped };
            return;
        }
        yield { type: "token", token: text };
    };

    // Holds back the text after the name until we know whether it starts with an ID line.
    const resolveId = function* (final) {
        const pending = stripLeadingBreaks(idBuffer);
        if (!pending) {
            if (final) {
                awaitingId = false;
                idBuffer = "";
            }
            return;
        }
        const newlineAt = pending.indexOf("\n");
        if (newlineAt === -1 && !final && couldBeIdLine(pending)) {
            return;
        }
        awaitingId = false;
        idBuffer = "";
        const line = (newlineAt === -1 ? pending : pending.slice(0, newlineAt)).replace(/\r$/, "");
        const id = parseIdLine(line);
        if (id === null) {
            yield* emitStory(pending);
            return;
        }
        if (id) {
            yield { type: "place", ref: id };
        }
        skipLeadingBreaks = true;
        yield* emitStory(newlineAt === -1 ? "" : pending.slice(newlineAt + 1));
    };

    for await (const delta of deltas) {
        if (typeof delta !== "string" || delta.length === 0) {
            continue;
        }
        if (!headerDone) {
            header += delta;
            const newlineAt = header.indexOf("\n");
            const headerTooLong = newlineAt === -1 && header.length > MAX_HEADER_CHARS;
            if (newlineAt === -1 && !headerTooLong) {
                continue;
            }

            headerDone = true;
            if (headerTooLong) {
                yield { type: "needs_summary" };
                yield* emitStory(header);
                header = "";
                continue;
            }

            const firstLine = header.slice(0, newlineAt).replace(/\r$/, "");
            const rest = header.slice(newlineAt + 1);
            header = "";
            const parsed = parseNameLine(firstLine);
            if (parsed.kind === "unrecognized") {
                yield { type: "unrecognized" };
                return;
            }
            if (parsed.kind === "name") {
                yield { type: "name", name: parsed.name };
                skipLeadingBreaks = true;
                awaitingId = true;
                idBuffer = rest;
                yield* resolveId(false);
                continue;
            }
            yield { type: "needs_summary" };
            yield* emitStory(`${firstLine}\n${rest}`);
            continue;
        }

        if (awaitingId) {
            idBuffer += delta;
            yield* resolveId(false);
            continue;
        }
        yield* emitStory(delta);
    }

    if (awaitingId) {
        yield* resolveId(true);
    }

    if (!headerDone && header.trim()) {
        const parsed = parseNameLine(header);
        if (parsed.kind === "unrecognized") {
            yield { type: "unrecognized" };
            return;
        }
        if (parsed.kind === "name") {
            yield { type: "name", name: parsed.name };
            return;
        }
        yield { type: "needs_summary" };
        yield { type: "token", token: header };
    }
}
