import { describe, expect, it } from "vitest";
import { parseImageStoryStream } from "./image-story-stream.mjs";
import { buildImageStoryUserPrompt } from "../prompts/prompts.mjs";

async function* deltas(parts) {
    for (const part of parts) {
        yield part;
    }
}

const collect = async (parts) => {
    const events = [];
    for await (const event of parseImageStoryStream(deltas(parts))) {
        events.push(event);
    }
    return events;
};

describe("parseImageStoryStream", () => {
    it("emits the name and then the story when the header is split across deltas", async () => {
        const events = await collect([
            "NA",
            "ME: Eiffel Tower\n",
            "\n",
            "A tower in Paris.",
        ]);
        expect(events).toEqual([
            { type: "name", name: "Eiffel Tower" },
            { type: "token", token: "A tower in Paris." },
        ]);
    });

    it("stops on an unrecognized subject and drops any later text", async () => {
        const events = await collect(["NAME: UNRECOGNIZED.\n", "ignore this"]);
        expect(events).toEqual([{ type: "unrecognized" }]);
    });

    it("treats a missing name line as story text that still needs a title", async () => {
        const events = await collect(["The cathedral was begun in 1882."]);
        expect(events).toEqual([
            { type: "needs_summary" },
            { type: "token", token: "The cathedral was begun in 1882." },
        ]);
    });

    it("accepts a name with no story yet", async () => {
        const events = await collect(["name: Church in Valencia"]);
        expect(events).toEqual([{ type: "name", name: "Church in Valencia" }]);
    });

    it("asks for a summary when the first line never arrives", async () => {
        const events = await collect(["x".repeat(241)]);
        expect(events[0]).toEqual({ type: "needs_summary" });
        expect(events[1].type).toBe("token");
        expect(events[1].token).toHaveLength(241);
    });
});

describe("buildImageStoryUserPrompt", () => {
    it("includes the name contract and the camera location", () => {
        const prompt = buildImageStoryUserPrompt({ lat: 48.8584, lon: 2.2945 });
        expect(prompt).toContain("NAME: UNRECOGNIZED");
        expect(prompt).toContain("NAME: ");
        expect(prompt).toContain("48.8584");
        expect(prompt).toContain("Do not guess from location alone");
    });

    it("omits the location hint when the photo has no coordinates", () => {
        const prompt = buildImageStoryUserPrompt(null);
        expect(prompt).not.toContain("Location hint");
    });
});
