import { describe, expect, it } from "vitest";
import {
    formatExternalApiCacheHit,
    mediaWikiApiParamsFromUrl,
    sparqlQueryFromUrl,
    wikipediaRestPathFromUrl,
} from "./external-api-debug.mjs";

describe("external-api-debug query formatting", () => {
    it("extracts SPARQL from wikidata query URLs", () => {
        const url =
            "https://query.wikidata.org/sparql?query=" +
            encodeURIComponent("SELECT ?item WHERE { ?item wdt:P31 wd:Q570116 }") +
            "&format=json";
        expect(sparqlQueryFromUrl(url)).toBe("SELECT ?item WHERE { ?item wdt:P31 wd:Q570116 }");
    });

    it("extracts MediaWiki API params from wikidata URLs", () => {
        const url =
            "https://www.wikidata.org/w/api.php?action=wbsearchentities" +
            "&search=Colosseum&language=en&format=json&origin=*";
        expect(mediaWikiApiParamsFromUrl(url)).toEqual({
            action: "wbsearchentities",
            search: "Colosseum",
            language: "en",
            format: "json",
        });
    });

    it("extracts Wikipedia REST paths", () => {
        const url = "https://en.wikipedia.org/api/rest_v1/page/summary/Colosseum";
        expect(wikipediaRestPathFromUrl(url)).toBe("page/summary/Colosseum");
    });
});

describe("external-api-debug cache hit formatting", () => {
    it("formats cache hits with skipped providers", () => {
        expect(
            formatExternalApiCacheHit("geo-location-popular", {
                key: "41.9031_12.4663",
                detail: "places=30",
                skippedProviders: ["wikidata", "wikipedia", "wikimedia"],
            }),
        ).toBe(
            "[external-api] cache hit cache=geo-location-popular key=41.9031_12.4663 " +
                "skipped=[wikidata, wikipedia, wikimedia] places=30",
        );
    });
});
