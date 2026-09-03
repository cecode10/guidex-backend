#!/usr/bin/env node
/**
 * Thin wrapper: seed the Africa country list.
 * See scripts/seed/README.md for usage.
 */
import { pathToFileURL } from "node:url";
import { AFRICA_COUNTRIES } from "./africa-countries-config.mjs";
import { runContinentMain, runContinentSeed } from "./seed-continent.mjs";

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    runContinentMain(() =>
        runContinentSeed({
            slug: "africa",
            label: "Africa",
            countries: AFRICA_COUNTRIES,
        }),
    );
}
