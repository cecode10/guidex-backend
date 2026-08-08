/** Allowed place-type filters from the Plan a trip UI. */
export const TRIP_PLACE_TYPES = Object.freeze([
    "LANDMARK",
    "HISTORICAL",
    "MUSEUM",
    "PARK",
]);

export const TRIP_STOP_COUNTS = Object.freeze([3, 5, 7, 8, 10]);

/** Minimum stops needed for a walking tour that can be navigated. */
export const TRIP_MIN_NAVIGABLE_STOPS = 2;

/** Min/max trip length in metres (matches the app slider: 2–15 km). */
export const TRIP_RADIUS_METERS_MIN = 2000;
export const TRIP_RADIUS_METERS_MAX = 15000;

/** Extra search radius beyond the user's selected trip length (10%). */
export const TRIP_RADIUS_TOLERANCE = 0.1;

/**
 * Search radius used to fetch candidates (selected length + 10% tolerance).
 * @param {number} radiusKm
 * @returns {number}
 */
export const tripSearchRadiusKm = (radiusKm) => {
    const km = Number(radiusKm);
    if (!Number.isFinite(km) || km <= 0) return km;
    return km * (1 + TRIP_RADIUS_TOLERANCE);
};

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export const normalizeTripTypes = (raw) => {
    if (!Array.isArray(raw)) return [];
    const allowed = new Set(TRIP_PLACE_TYPES);
    const out = [];
    for (const item of raw) {
        const upper = String(item || "")
            .trim()
            .toUpperCase();
        if (allowed.has(upper) && !out.includes(upper)) out.push(upper);
    }
    return out;
};

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
export const normalizeStopCount = (raw) => {
    const n = Number.parseInt(String(raw), 10);
    if (!TRIP_STOP_COUNTS.includes(n)) return null;
    return n;
};

/**
 * @param {unknown} rawMeters
 * @param {unknown} rawKm
 * @returns {number | null} radius in km
 */
export const normalizeTripRadiusKm = (rawMeters, rawKm) => {
    if (rawMeters != null && rawMeters !== "") {
        const meters = Number(rawMeters);
        if (!Number.isFinite(meters)) return null;
        if (meters < TRIP_RADIUS_METERS_MIN || meters > TRIP_RADIUS_METERS_MAX) {
            return null;
        }
        return meters / 1000;
    }
    if (rawKm != null && rawKm !== "") {
        const km = Number(rawKm);
        if (!Number.isFinite(km)) return null;
        const meters = km * 1000;
        if (meters < TRIP_RADIUS_METERS_MIN || meters > TRIP_RADIUS_METERS_MAX) {
            return null;
        }
        return km;
    }
    return null;
};

/**
 * @param {Record<string, unknown>} place
 * @param {string} wantedUpper
 * @returns {boolean}
 */
export const placeMatchesTripType = (place, wantedUpper) => {
    const type = String(place.type ?? "").toUpperCase();
    const category = String(place.categoryLabel ?? "").toUpperCase();
    const hay = `${type} ${category}`;

    switch (wantedUpper) {
        case "MUSEUM":
            return hay.includes("MUSEUM");
        case "PARK":
            return hay.includes("PARK") || hay.includes("GARDEN");
        case "HISTORICAL":
            return (
                type === "HISTORICAL" ||
                hay.includes("HISTORIC") ||
                hay.includes("CASTLE") ||
                hay.includes("RUIN") ||
                hay.includes("ARCHAEOLOGICAL") ||
                hay.includes("FORTRESS") ||
                hay.includes("PALACE") ||
                hay.includes("ABBEY") ||
                hay.includes("MONASTERY")
            );
        case "LANDMARK":
            return (
                type === "LANDMARK" ||
                hay.includes("LANDMARK") ||
                hay.includes("MONUMENT") ||
                hay.includes("ATTRACTION") ||
                hay.includes("TOWER") ||
                hay.includes("BRIDGE")
            );
        default:
            return type === wantedUpper;
    }
};

/**
 * @param {Array<Record<string, unknown>>} places
 * @param {string[]} types
 * @returns {Array<Record<string, unknown>>}
 */
export const filterPlacesByTripTypes = (places, types) => {
    if (!Array.isArray(types) || types.length === 0) return places;
    return places.filter((place) =>
        types.some((wanted) => placeMatchesTripType(place, wanted)),
    );
};

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export const parseTripJsonFromModel = (text) => {
    const raw = String(text || "").trim();
    if (!raw) {
        const err = new Error("empty model response");
        err.statusCode = 502;
        throw err;
    }

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] ?? raw).trim();

    let parsed;
    try {
        parsed = JSON.parse(candidate);
    } catch {
        const start = candidate.indexOf("{");
        const end = candidate.lastIndexOf("}");
        if (start < 0 || end <= start) {
            const err = new Error("model response was not valid JSON");
            err.statusCode = 502;
            throw err;
        }
        try {
            parsed = JSON.parse(candidate.slice(start, end + 1));
        } catch {
            const err = new Error("model response was not valid JSON");
            err.statusCode = 502;
            throw err;
        }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        const err = new Error("model response was not a JSON object");
        err.statusCode = 502;
        throw err;
    }
    return /** @type {Record<string, unknown>} */ (parsed);
};

const EARTH_RADIUS_M = 6371000;

/**
 * Great-circle distance in metres.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
export const haversineMeters = (lat1, lng1, lat2, lng2) => {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * @param {Record<string, unknown>} place
 * @returns {{ lat: number, lng: number } | null}
 */
const placeCoords = (place) => {
    const lat = Number(place.lat);
    const lng = Number(place.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
};

/**
 * Sum of walking legs: user → stop1 → stop2 → …
 * @param {number} userLat
 * @param {number} userLng
 * @param {Array<Record<string, unknown>>} stops
 * @returns {number}
 */
export const routeLengthMeters = (userLat, userLng, stops) => {
    let total = 0;
    let prevLat = userLat;
    let prevLng = userLng;
    for (const stop of stops) {
        const coords = placeCoords(stop);
        if (!coords) continue;
        total += haversineMeters(prevLat, prevLng, coords.lat, coords.lng);
        prevLat = coords.lat;
        prevLng = coords.lng;
    }
    return total;
};

/**
 * Nearest-neighbor order from the user position.
 * @param {number} userLat
 * @param {number} userLng
 * @param {Array<Record<string, unknown>>} stops
 * @returns {Array<Record<string, unknown>>}
 */
export const orderStopsNearestNeighbor = (userLat, userLng, stops) => {
    const remaining = [...stops];
    /** @type {Array<Record<string, unknown>>} */
    const ordered = [];
    let curLat = userLat;
    let curLng = userLng;

    while (remaining.length > 0) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const coords = placeCoords(remaining[i]);
            if (!coords) continue;
            const d = haversineMeters(curLat, curLng, coords.lat, coords.lng);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        const next = remaining.splice(bestIdx, 1)[0];
        const coords = placeCoords(next);
        if (coords) {
            curLat = coords.lat;
            curLng = coords.lng;
        }
        ordered.push({ ...next, order: ordered.length });
    }
    return ordered;
};

/**
 * Keep a prefix of [ordered] whose route length stays ≤ maxMeters.
 * @param {number} userLat
 * @param {number} userLng
 * @param {Array<Record<string, unknown>>} ordered
 * @param {number} maxMeters
 * @returns {Array<Record<string, unknown>>}
 */
export const trimStopsToBudget = (userLat, userLng, ordered, maxMeters) => {
    /** @type {Array<Record<string, unknown>>} */
    const kept = [];
    let prevLat = userLat;
    let prevLng = userLng;
    let total = 0;

    for (const stop of ordered) {
        const coords = placeCoords(stop);
        if (!coords) continue;
        const leg = haversineMeters(prevLat, prevLng, coords.lat, coords.lng);
        if (total + leg > maxMeters) break;
        total += leg;
        prevLat = coords.lat;
        prevLng = coords.lng;
        kept.push({ ...stop, order: kept.length });
    }
    return kept;
};

/**
 * Append unused candidates (highest sitelinks, then nearest to user field) until [target].
 * Used only when no walking budget is provided (tests / legacy).
 *
 * @param {Array<Record<string, unknown>>} stops
 * @param {Set<string>} seen
 * @param {Array<Record<string, unknown>>} candidates
 * @param {number} target
 */
const padStopsBySitelinks = (stops, seen, candidates, target) => {
    if (stops.length >= target) return;
    const remaining = candidates
        .filter((place) => {
            const id = String(place.wikidataId ?? "").trim();
            return id && !seen.has(id);
        })
        .sort((a, b) => {
            const byLinks =
                (Number(b.sitelinks) || 0) - (Number(a.sitelinks) || 0);
            if (byLinks !== 0) return byLinks;
            return (Number(a.distance) || 0) - (Number(b.distance) || 0);
        });
    for (const place of remaining) {
        if (stops.length >= target) break;
        const id = String(place.wikidataId ?? "").trim();
        seen.add(id);
        stops.push({
            ...place,
            order: stops.length,
            why: String(place.why ?? "").trim(),
        });
    }
};

/**
 * Append unused candidates that still fit under the walking budget.
 * Prefers places that leave room for remaining stops (fair-share leg),
 * then higher sitelinks, then shorter legs — so short trips can still fill.
 *
 * @param {Array<Record<string, unknown>>} stops
 * @param {Set<string>} seen
 * @param {Array<Record<string, unknown>>} candidates
 * @param {number} target
 * @param {number} userLat
 * @param {number} userLng
 * @param {number} maxMeters
 */
const padStopsWithinBudget = (
    stops,
    seen,
    candidates,
    target,
    userLat,
    userLng,
    maxMeters,
) => {
    while (stops.length < target) {
        let prevLat = userLat;
        let prevLng = userLng;
        if (stops.length > 0) {
            const lastCoords = placeCoords(stops[stops.length - 1]);
            if (!lastCoords) break;
            prevLat = lastCoords.lat;
            prevLng = lastCoords.lng;
        }
        const usedLength = routeLengthMeters(userLat, userLng, stops);
        const remainingBudget = maxMeters - usedLength;
        if (remainingBudget <= 0) break;

        const remainingSlots = target - stops.length;
        const fairLeg = remainingBudget / remainingSlots;

        /** @type {Record<string, unknown> | null} */
        let best = null;
        let bestScore = -Infinity;

        for (const place of candidates) {
            const id = String(place.wikidataId ?? "").trim();
            if (!id || seen.has(id)) continue;
            const coords = placeCoords(place);
            if (!coords) continue;
            const leg = haversineMeters(prevLat, prevLng, coords.lat, coords.lng);
            if (leg > remainingBudget) continue;
            const links = Number(place.sitelinks) || 0;
            // Prefer legs that leave room for the remaining stops; then rating; then shorter.
            const packBonus = leg <= fairLeg * 1.25 ? 1_000_000 : 0;
            const score = packBonus + links * 1000 - leg;
            if (score > bestScore) {
                best = place;
                bestScore = score;
            }
        }

        if (!best) break;
        const id = String(best.wikidataId ?? "").trim();
        seen.add(id);
        stops.push({
            ...best,
            order: stops.length,
            why: String(best.why ?? "").trim(),
        });
    }
};

/**
 * Ground AI stop picks to the candidate list (no invented places).
 * Fills up to the requested stop count from real candidates only, while keeping
 * total walking distance (user → … → last) ≤ maxMeters. If the budget cannot
 * fit all requested stops, returns as many real places as fit — never invents.
 *
 * @param {Record<string, unknown>} modelJson
 * @param {Array<Record<string, unknown>>} candidates
 * @param {number} stopCount
 * @param {{ userLat?: number, userLng?: number, maxMeters?: number }} [routeOpts]
 * @returns {{ title: string, summary: string, stops: Array<Record<string, unknown>> }}
 */
export const groundTripStops = (modelJson, candidates, stopCount, routeOpts) => {
    const userLat = Number(routeOpts?.userLat);
    const userLng = Number(routeOpts?.userLng);
    const maxMeters = Number(routeOpts?.maxMeters);
    const hasBudget =
        Number.isFinite(userLat) &&
        Number.isFinite(userLng) &&
        Number.isFinite(maxMeters) &&
        maxMeters > 0;

    const byId = new Map();
    for (const place of candidates) {
        const id = String(place.wikidataId ?? "").trim();
        if (id) byId.set(id, place);
    }

    const title = String(modelJson.title ?? "").trim() || "Walking trip";
    const summary = String(modelJson.summary ?? "").trim();
    const rawStops = Array.isArray(modelJson.stops) ? modelJson.stops : [];

    /** Model "why" text keyed by wikidata id. */
    const whyById = new Map();
    /** @type {string[]} */
    const preferredIds = [];
    for (const raw of rawStops) {
        if (!raw || typeof raw !== "object") continue;
        const row = /** @type {Record<string, unknown>} */ (raw);
        const id = String(row.wikidataId ?? "").trim();
        if (!id || !byId.has(id) || whyById.has(id)) continue;
        whyById.set(id, String(row.why ?? "").trim());
        preferredIds.push(id);
    }

    const target = Math.min(stopCount, candidates.length);
    const minStops = Math.min(TRIP_MIN_NAVIGABLE_STOPS, target);

    /** @type {Array<Record<string, unknown>>} */
    let stops = [];

    if (hasBudget) {
        const preferred = preferredIds
            .map((id) => byId.get(id))
            .filter(Boolean);
        const seen = new Set();
        padStopsWithinBudget(
            stops,
            seen,
            preferred,
            Math.min(target, preferred.length),
            userLat,
            userLng,
            maxMeters,
        );
        if (stops.length < target) {
            padStopsWithinBudget(
                stops,
                seen,
                candidates,
                target,
                userLat,
                userLng,
                maxMeters,
            );
        }
        if (stops.length > 1) {
            stops = orderStopsNearestNeighbor(userLat, userLng, stops);
            stops = trimStopsToBudget(userLat, userLng, stops, maxMeters);
        }
        if (stops.length < target) {
            const seenAfter = new Set(
                stops.map((s) => String(s.wikidataId ?? "").trim()).filter(Boolean),
            );
            padStopsWithinBudget(
                stops,
                seenAfter,
                candidates,
                target,
                userLat,
                userLng,
                maxMeters,
            );
            if (stops.length > 1) {
                stops = orderStopsNearestNeighbor(userLat, userLng, stops);
                stops = trimStopsToBudget(userLat, userLng, stops, maxMeters);
            }
        }
        stops = trimStopsToBudget(userLat, userLng, stops, maxMeters);
    } else {
        const seen = new Set();
        for (const id of preferredIds) {
            if (stops.length >= target) break;
            const place = byId.get(id);
            if (!place || seen.has(id)) continue;
            seen.add(id);
            stops.push({
                ...place,
                order: stops.length,
                why: whyById.get(id) || "",
            });
        }
        if (stops.length < target) {
            padStopsBySitelinks(stops, seen, candidates, target);
        }
    }

    stops = stops.map((stop, index) => {
        const id = String(stop.wikidataId ?? "").trim();
        return {
            ...stop,
            order: index,
            why: whyById.get(id) || String(stop.why ?? "").trim(),
        };
    });

    if (stops.length === 0) {
        const err = new Error("could not build a trip from nearby places");
        err.statusCode = 422;
        throw err;
    }

    if (hasBudget && stops.length < minStops) {
        const seen = new Set();
        stops = [];
        padStopsWithinBudget(
            stops,
            seen,
            candidates,
            target,
            userLat,
            userLng,
            maxMeters,
        );
        if (stops.length > 1) {
            stops = orderStopsNearestNeighbor(userLat, userLng, stops);
            stops = trimStopsToBudget(userLat, userLng, stops, maxMeters);
        }
        stops = stops.map((stop, index) => {
            const id = String(stop.wikidataId ?? "").trim();
            return {
                ...stop,
                order: index,
                why: whyById.get(id) || String(stop.why ?? "").trim(),
            };
        });
    }

    if (hasBudget) {
        const length = routeLengthMeters(userLat, userLng, stops);
        if (length > maxMeters + 1) {
            stops = trimStopsToBudget(userLat, userLng, stops, maxMeters);
            stops = stops.map((stop, index) => ({ ...stop, order: index }));
        }
    }

    if (stops.length < minStops && candidates.length >= minStops && !hasBudget) {
        const err = new Error("could not build a navigable trip from nearby places");
        err.statusCode = 422;
        throw err;
    }

    if (stops.length === 0) {
        const err = new Error("could not build a trip from nearby places");
        err.statusCode = 422;
        throw err;
    }

    return { title, summary, stops };
};

/**
 * @param {{
 *   stopCount: number,
 *   radiusKm: number,
 *   searchRadiusKm?: number,
 *   preference: string,
 *   language: string,
 *   userLat: number,
 *   userLng: number,
 *   candidates: Array<Record<string, unknown>>,
 * }} options
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export const buildTripPrompts = ({
    stopCount,
    radiusKm,
    searchRadiusKm,
    preference,
    language,
    userLat,
    userLng,
    candidates,
}) => {
    const formatKm = (km) =>
        km < 1
            ? `${Math.round(km * 1000)} m`
            : Number.isInteger(km)
              ? `${km} km`
              : `${Number(km.toFixed(2))} km`;
    const radiusLabel = formatKm(radiusKm);
    const searchLabel = formatKm(
        Number.isFinite(Number(searchRadiusKm))
            ? Number(searchRadiusKm)
            : tripSearchRadiusKm(radiusKm),
    );
    const candidateLines = candidates.map((place, index) => {
        const id = String(place.wikidataId ?? "");
        const name = String(place.name ?? "");
        const type = String(place.type ?? "");
        const sitelinks = Number(place.sitelinks) || 0;
        const distance = Number(place.distance) || 0;
        const city = String(place.city ?? "");
        const lat = Number(place.lat);
        const lng = Number(place.lng);
        const coords =
            Number.isFinite(lat) && Number.isFinite(lng)
                ? `${lat.toFixed(5)},${lng.toFixed(5)}`
                : "?,?";
        return `${index + 1}. ${id} | ${name} | ${type} | rating=${sitelinks} | ${distance}m from user | ${coords} | ${city}`;
    });

    const preferenceBlock = preference
        ? `Optional soft preference (use only to break ties / slight re-ranking among high-rated places):\n"${preference}"`
        : "Optional soft preference: (none)";

    const available = candidates.length;
    const targetStops = Math.min(stopCount, available);
    const fillNote = `Aim for ${targetStops} stops, but ONLY if the walking path user→…→last stays ≤ ${searchLabel}. Prefer fewer real stops over exceeding the distance. Never invent places.`;

    const systemPrompt = `
You are an expert local walking-tour planner for the rambleX travel app.
Build a walking route of the most notable (highest-rated) places near the user.

Hard constraints:
- Use ONLY places from the provided candidate list (fetched within ~${searchLabel}).
- Never invent places, names, coordinates, or Wikidata IDs.
- Respond with JSON only — no markdown, no commentary.
- Write title, summary, and each stop "why" in ${language || "English"}.
- HARD PATH BUDGET: sum of walking legs (user → stop1 → stop2 → … → last) MUST be ≤ ${searchLabel} (user's ${radiusLabel} + 10% tolerance).
- ${fillNote}

Selection priority (must follow):
1) Path budget — never exceed ${searchLabel} total walking distance.
2) Real places only — every stop must come from the candidate list.
3) Fill from available — pick as many as fit under the budget, up to ${targetStops}.
4) Rating — prefer higher sitelinks among places that still fit a compact route.
5) Soft preference — if the user gave a vibe, use it only to break ties.
6) Route optimization — order stops for the shortest practical walk from the user; cluster nearby stops; avoid zigzagging across the city.
`.trim();

    const userPrompt = `
Design a walking trip of the highest-rated nearby places.

User position (start of the walk): ${userLat}, ${userLng}
User trip length: ${radiusLabel}
Maximum total walking distance (sum of all legs): ${searchLabel} — do NOT exceed this
Requested stop count: up to ${stopCount} — return fewer if needed to stay under ${searchLabel} (pool size: ${available})
${preferenceBlock}

Candidates (already sorted by rating/sitelinks, highest first)
(wikidataId | name | type | rating | distance from user | lat,lng | city):
${candidateLines.join("\n")}

Selection & ordering instructions:
- Prefer a compact cluster of high-rated places so the ordered walk stays ≤ ${searchLabel}.
- Pick up to ${targetStops} places; if adding another would break the budget, stop earlier.
- Order picks into an efficient walking route from the user using lat,lng.
- Never invent a place that is not in the candidate list.
- In each stop's "why", one short line on why it is worth visiting (rating/notability), not generic praise.

Return JSON with this shape:
{
  "title": "short trip title",
  "summary": "1-2 sentences: highlights of this high-rated walk from the user's location",
  "stops": [
    { "wikidataId": "Q…", "why": "one short reason this stop is worth visiting" }
  ]
}

Rules:
- "stops" is an ordered array: index 0 is visited first after leaving the user position
- every wikidataId must appear in the candidate list
- do not repeat wikidataIds
- total path length user→…→last ≤ ${searchLabel}
- never invent stops to reach ${stopCount}
`.trim();

    return { systemPrompt, userPrompt };
};
