/**
 * European countries used when building the 100k+ city list.
 * `bounds` optionally limits transcontinental countries to their European portion.
 *
 * @typedef {{ name: string, wikidataId: string, bounds?: { minLon?: number, maxLon?: number, minLat?: number, maxLat?: number } }} EuropeanCountry
 */

/** @type {EuropeanCountry[]} */
export const EUROPEAN_COUNTRIES = [
    { name: "Albania", wikidataId: "Q222" },
    { name: "Andorra", wikidataId: "Q228" },
    { name: "Austria", wikidataId: "Q40" },
    { name: "Belarus", wikidataId: "Q184" },
    { name: "Belgium", wikidataId: "Q31" },
    { name: "Bosnia and Herzegovina", wikidataId: "Q225" },
    { name: "Bulgaria", wikidataId: "Q219" },
    { name: "Croatia", wikidataId: "Q224" },
    { name: "Cyprus", wikidataId: "Q229" },
    { name: "Czech Republic", wikidataId: "Q213" },
    { name: "Denmark", wikidataId: "Q35" },
    { name: "Estonia", wikidataId: "Q191" },
    { name: "Finland", wikidataId: "Q33" },
    { name: "France", wikidataId: "Q142" },
    { name: "Germany", wikidataId: "Q183" },
    { name: "Greece", wikidataId: "Q41" },
    { name: "Hungary", wikidataId: "Q28" },
    { name: "Iceland", wikidataId: "Q189" },
    { name: "Ireland", wikidataId: "Q27" },
    { name: "Italy", wikidataId: "Q38" },
    { name: "Kosovo", wikidataId: "Q1246" },
    { name: "Latvia", wikidataId: "Q211" },
    { name: "Liechtenstein", wikidataId: "Q347" },
    { name: "Lithuania", wikidataId: "Q37" },
    { name: "Luxembourg", wikidataId: "Q32" },
    { name: "Malta", wikidataId: "Q233" },
    { name: "Moldova", wikidataId: "Q217" },
    { name: "Monaco", wikidataId: "Q235" },
    { name: "Montenegro", wikidataId: "Q236" },
    { name: "Netherlands", wikidataId: "Q55" },
    { name: "North Macedonia", wikidataId: "Q221" },
    { name: "Norway", wikidataId: "Q20" },
    { name: "Poland", wikidataId: "Q36" },
    { name: "Portugal", wikidataId: "Q45" },
    { name: "Romania", wikidataId: "Q218" },
    {
        name: "Russia",
        wikidataId: "Q159",
        bounds: { maxLon: 60 },
    },
    { name: "San Marino", wikidataId: "Q238" },
    { name: "Serbia", wikidataId: "Q403" },
    { name: "Slovakia", wikidataId: "Q214" },
    { name: "Slovenia", wikidataId: "Q215" },
    { name: "Spain", wikidataId: "Q29" },
    { name: "Sweden", wikidataId: "Q34" },
    { name: "Switzerland", wikidataId: "Q39" },
    {
        name: "Turkey",
        wikidataId: "Q43",
        bounds: { maxLon: 29.5 },
    },
    { name: "Ukraine", wikidataId: "Q212" },
    { name: "United Kingdom", wikidataId: "Q145" },
    { name: "Vatican City", wikidataId: "Q237" },
    {
        name: "Georgia",
        wikidataId: "Q230",
        bounds: { maxLon: 46.8 },
    },
    { name: "Armenia", wikidataId: "Q399" },
    {
        name: "Azerbaijan",
        wikidataId: "Q227",
        bounds: { maxLon: 50.5 },
    },
];

export const DEFAULT_MIN_POPULATION = 100_000;

export const DEFAULT_CITIES_FILE = "scripts/data/european-cities-100k.json";
