/**
 * North American countries/territories for sightseeing seed.
 * `bounds` optionally limits a country to its primary tourist landmass
 * (e.g. contiguous US, excluding Alaska/Hawaii overseas).
 *
 * @typedef {import("./seed-continent.mjs").ContinentCountry} ContinentCountry
 */

/** @type {ContinentCountry[]} */
export const NORTH_AMERICA_COUNTRIES = [
    // Northern America
    {
        name: "United States",
        wikidataId: "Q30",
        iso2: "US",
        aliases: ["USA", "America"],
        bounds: { minLon: -125, maxLon: -66.5, minLat: 24.5, maxLat: 49.5 },
    },
    {
        name: "Canada",
        wikidataId: "Q16",
        iso2: "CA",
        bounds: { minLon: -141, maxLon: -52, minLat: 41.5, maxLat: 70 },
    },
    { name: "Greenland", wikidataId: "Q223", iso2: "GL" },
    { name: "Bermuda", wikidataId: "Q23635", iso2: "BM" },
    { name: "Saint Pierre and Miquelon", wikidataId: "Q34617", iso2: "PM" },

    // Mexico + Central America
    {
        name: "Mexico",
        wikidataId: "Q96",
        iso2: "MX",
        bounds: { minLon: -118.5, maxLon: -86.5, minLat: 14.5, maxLat: 32.8 },
    },
    { name: "Guatemala", wikidataId: "Q774", iso2: "GT" },
    { name: "Belize", wikidataId: "Q242", iso2: "BZ" },
    { name: "El Salvador", wikidataId: "Q792", iso2: "SV" },
    { name: "Honduras", wikidataId: "Q783", iso2: "HN" },
    { name: "Nicaragua", wikidataId: "Q811", iso2: "NI" },
    { name: "Costa Rica", wikidataId: "Q800", iso2: "CR" },
    { name: "Panama", wikidataId: "Q804", iso2: "PA" },

    // Caribbean
    { name: "Cuba", wikidataId: "Q241", iso2: "CU" },
    { name: "Dominican Republic", wikidataId: "Q786", iso2: "DO" },
    { name: "Haiti", wikidataId: "Q790", iso2: "HT" },
    { name: "Jamaica", wikidataId: "Q766", iso2: "JM" },
    { name: "Bahamas", wikidataId: "Q778", iso2: "BS" },
    { name: "Trinidad and Tobago", wikidataId: "Q754", iso2: "TT" },
    { name: "Barbados", wikidataId: "Q244", iso2: "BB" },
    { name: "Puerto Rico", wikidataId: "Q1183", iso2: "PR" },
    { name: "United States Virgin Islands", wikidataId: "Q11703", iso2: "VI" },
    { name: "Cayman Islands", wikidataId: "Q5785", iso2: "KY" },
    { name: "Aruba", wikidataId: "Q21203", iso2: "AW" },
    { name: "Curaçao", wikidataId: "Q25279", iso2: "CW" },
    { name: "Saint Lucia", wikidataId: "Q760", iso2: "LC" },
    { name: "Antigua and Barbuda", wikidataId: "Q781", iso2: "AG" },
    { name: "Saint Kitts and Nevis", wikidataId: "Q763", iso2: "KN" },
    { name: "Grenada", wikidataId: "Q769", iso2: "GD" },
    { name: "Dominica", wikidataId: "Q784", iso2: "DM" },
    { name: "Saint Vincent and the Grenadines", wikidataId: "Q757", iso2: "VC" },
];
