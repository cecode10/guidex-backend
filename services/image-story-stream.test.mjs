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

    it("emits the place for an ID line and keeps it out of the story", async () => {
        const events = await collect(["NAME: Monument\n", "I", "D: P", "2\n", "\nIt was built in 1907."]);
        expect(events).toEqual([
            { type: "name", name: "Monument" },
            { type: "place", ref: "P2" },
            { type: "token", token: "It was built in 1907." },
        ]);
    });

    it("handles the name, ID and story in a single delta", async () => {
        const events = await collect(["NAME: Monument\nid: p2.\n\nStory."]);
        expect(events).toEqual([
            { type: "name", name: "Monument" },
            { type: "place", ref: "P2" },
            { type: "token", token: "Story." },
        ]);
    });

    it("drops an ID line without a valid place ref", async () => {
        const events = await collect(["NAME: Fountain\n", "ID: none\n\nStory."]);
        expect(events).toEqual([
            { type: "name", name: "Fountain" },
            { type: "token", token: "Story." },
        ]);
    });

    it("does not hold back a story that only starts like an ID line", async () => {
        const events = await collect(["NAME: Bridge\n\n", "I", "n 1882 the bridge opened."]);
        expect(events).toEqual([
            { type: "name", name: "Bridge" },
            { type: "token", token: "In 1882 the bridge opened." },
        ]);
    });

    it("emits a trailing ID line when the stream ends", async () => {
        const events = await collect(["NAME: Monument\n", "ID: P7"]);
        expect(events).toEqual([
            { type: "name", name: "Monument" },
            { type: "place", ref: "P7" },
        ]);
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

    it("lists nearby candidates with refs and asks for the ID line", () => {
        const prompt = buildImageStoryUserPrompt({ lat: 42.69, lon: 23.33 }, [
            {
                ref: "P1",
                name: "Saint Sofia Church",
                type: "Church",
                extraTypes: ["place of worship", "tourist attraction"],
                distance: 42,
                address: "ul. Paris 2, Sofia",
            },
            { ref: "P2", name: "Monument to the Unknown Soldier", type: "Monument", extraTypes: [], distance: 90, address: null },
        ]);
        expect(prompt).toContain(
            "- [P1] Saint Sofia Church — Church (also: place of worship, tourist attraction); 42 m away; address: ul. Paris 2, Sofia.",
        );
        expect(prompt).toContain("- [P2] Monument to the Unknown Soldier — Monument; 90 m away.");
        expect(prompt).toContain('"ID: P2"');
        expect(prompt).toContain("Never choose a place only because it is close");
        expect(prompt).not.toContain("Location hint");
    });

    it("omits the location hint when the photo has no coordinates", () => {
        const prompt = buildImageStoryUserPrompt(null);
        expect(prompt).not.toContain("Location hint");
    });
});
