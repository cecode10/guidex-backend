#!/usr/bin/env node
/**
 * Thin wrapper: seed the Europe country list (same countries as the original Europe seed).
 * See scripts/seed/README.md for usage.
 */
import { pathToFileURL } from "node:url";
import { EUROPEAN_COUNTRIES } from "./europe-countries-config.mjs";
import { runContinentMain, runContinentSeed } from "./seed-continent.mjs";

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    runContinentMain(() =>
        runContinentSeed({
            slug: "europe",
            label: "Europe",
            countries: EUROPEAN_COUNTRIES,
        }),
    );
}
