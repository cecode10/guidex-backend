#!/usr/bin/env node
/**
 * Thin wrapper: seed the North America country list.
 * See scripts/seed/README.md for usage.
 */
import { pathToFileURL } from "node:url";
import { NORTH_AMERICA_COUNTRIES } from "./north-america-countries-config.mjs";
import {
    runContinentMain,
    runContinentSeed,
    selectCountries as selectCountriesFromList,
} from "./seed-continent.mjs";
import {
    COUNTRY_SIGHTSEEING_BOUNDS,
    bindingToSightseeingRow,
    buildCountrySightseeingSparql,
    countrySightseeingBoundList,
    countrySightseeingBounds,
    shouldForceTileSeed,
} from "./seed-sightseeing-engine.mjs";

export {
    COUNTRY_SIGHTSEEING_BOUNDS,
    bindingToSightseeingRow,
    buildCountrySightseeingSparql,
    countrySightseeingBoundList,
    countrySightseeingBounds,
    shouldForceTileSeed,
};

/** @param {string} needle */
export function selectCountries(needle) {
    return selectCountriesFromList(NORTH_AMERICA_COUNTRIES, needle, "North America");
}

const isMain =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    runContinentMain(() =>
        runContinentSeed({
            slug: "north-america",
            label: "North America",
            countries: NORTH_AMERICA_COUNTRIES,
        }),
    );
}
