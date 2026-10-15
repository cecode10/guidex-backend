const NAME_LINE = /^NAME:\s*(.*)$/i;
const UNRECOGNIZED_NAME = /^UNRECOGNIZED$/i;
const MAX_HEADER_CHARS = 240;

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
 * Turns model text deltas into name, story, and unrecognized events.
 * The model is asked to start with a single "NAME: ..." line.
 *
 * @param {AsyncIterable<string>} deltas
 */
export async function* parseImageStoryStream(deltas) {
    let header = "";
    let headerDone = false;
    let skipLeadingBreaks = false;

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
                yield* emitStory(rest);
                continue;
            }
            yield { type: "needs_summary" };
            yield* emitStory(`${firstLine}\n${rest}`);
            continue;
        }

        yield* emitStory(delta);
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
