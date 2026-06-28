import { describe, expect, it } from "vitest";
import { SPARQL_POI_CATEGORIES } from "./places-lookup-utils.mjs";

const categoryQids = () =>
    new Set([...SPARQL_POI_CATEGORIES.matchAll(/Q\d+/g)].map((match) => match[0]));

describe("SPARQL POI category whitelist", () => {
    it("includes key heritage and venue types", () => {
        const categories = categoryQids();
        expect(categories.has("Q570116")).toBe(true); // tourist attraction
        expect(categories.has("Q483453")).toBe(true); // fountain
        expect(categories.has("Q16560")).toBe(true); // palace
        expect(categories.has("Q907116")).toBe(true); // Monument (Spain)
        expect(categories.has("Q916475")).toBe(true); // Historical Monument (France)
        expect(categories.has("Q2977")).toBe(true); // cathedral
        expect(categories.has("Q56242215")).toBe(true); // Catholic cathedral
        expect(categories.has("Q163687")).toBe(true); // basilica
        expect(categories.has("Q120560")).toBe(true); // minor basilica
        expect(categories.has("Q133747929")).toBe(true); // expiatory temple
        expect(categories.has("Q43501")).toBe(true); // zoo
        expect(categories.has("Q41253")).toBe(true); // movie theater
        expect(categories.has("Q483110")).toBe(true); // stadium
        expect(categories.has("Q849706")).toBe(true); // airport terminal
        expect(categories.has("Q194195")).toBe(true); // amusement park
    });

    it("drops known corrupted POC QIDs", () => {
        const categories = categoryQids();
        expect(categories.has("Q10502151")).toBe(false); // fungus
        expect(categories.has("Q10864048")).toBe(false); // admin division
        expect(categories.has("Q213422")).toBe(false); // Seneca
    });
});
