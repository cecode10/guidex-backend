import { describe, expect, it } from "vitest";
import {
    extractQidsFromJson,
    extractQidsFromText,
    normalizeQidList,
    parseArgs,
} from "./seed-sightseeing-from-qids.mjs";

describe("parseArgs", () => {
    it("collects file, flags, and positional QIDs", () => {
        const opts = parseArgs([
            "--file",
            "qids.json",
            "--qid",
            "Q243",
            "Q1054070",
            "--dry-run",
            "--delay-ms",
            "100",
            "--direct",
        ]);
        expect(opts.file).toBe("qids.json");
        expect(opts.qids).toEqual(["Q243", "Q1054070"]);
        expect(opts.dryRun).toBe(true);
        expect(opts.delayMs).toBe(100);
        expect(opts.direct).toBe(true);
    });
});

describe("extractQidsFromJson", () => {
    it("accepts a string array", () => {
        expect(extractQidsFromJson(["Q243", "Q1"])).toEqual(["Q243", "Q1"]);
    });

    it("accepts { qids } and object rows", () => {
        expect(extractQidsFromJson({ qids: ["Q243"] })).toEqual(["Q243"]);
        expect(
            extractQidsFromJson([{ wikidataId: "Q243" }, { wikidata_id: "Q99" }]),
        ).toEqual(["Q243", "Q99"]);
    });
});

describe("extractQidsFromText", () => {
    it("reads one QID per line and ignores comments", () => {
        expect(
            extractQidsFromText(`
# paris
Q243 Eiffel Tower
Q1054070
`),
        ).toEqual(["Q243", "Q1054070"]);
    });
});

describe("normalizeQidList", () => {
    it("dedupes, normalizes case, and reports invalid tokens", () => {
        const { qids, invalid } = normalizeQidList([
            "q243",
            "wd:Q243",
            "Q1054070",
            "not-a-qid",
            "Q1",
        ]);
        expect(qids).toEqual(["Q243", "Q1054070", "Q1"]);
        expect(invalid).toEqual(["not-a-qid"]);
    });
});
