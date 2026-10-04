/**
 * Normalizes a place name into a slug used for the name-fallback cache key.
 * Mirrors the Dart `PlaceImageService` implementation so both ends agree.
 */
export const slugifyName = (name) =>
    String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

/**
 * Stable Firestore doc id for a place. Wikidata QIDs are authoritative;
 * everything else falls back to a normalized-name key.
 */
export const placeKeyFor = (wikidataId, name) => {
    const qid = String(wikidataId || "").trim();
    if (/^Q\d+$/.test(qid)) return qid;
    return `name:${slugifyName(name)}`;
};
