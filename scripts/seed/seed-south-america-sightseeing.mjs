#!/usr/bin/env node
/**
 * Thin wrapper: seed the South America country list.
 * See scripts/seed/README.md for usage.
 */
import { pathToFileURL } from "node:url";
import { SOUTH_AMERICA_COUNTRIES } from "./south-america-countries-config.mjs";
import { runContinentMain, runContinentSeed } from "./seed-continent.mjs";

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    runContinentMain(() =>
        runContinentSeed({
            slug: "south-america",
            label: "South America",
            countries: SOUTH_AMERICA_COUNTRIES,
        }),
    );
}
