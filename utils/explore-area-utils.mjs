/**
 * Viewport-driven Explore: request parsing and the spread-by-cell pick that
 * keeps one popular place per map cell at every zoom level.
 *
 * Cells are aligned to the Web Mercator world grid of the integer zoom band,
 * not to the requested bounds, so a place keeps (or loses) its cell no matter
 * how the user pans at the same zoom.
 */

/** World-pixel size of one spread cell at the integer zoom band. */
export const EXPLORE_AREA_CELL_PX = 56;

/** Places kept per cell. */
export const EXPLORE_AREA_PLACES_PER_CELL = 1;

/** Places returned per request (the client asks for a padded viewport). */
export const EXPLORE_AREA_MAX_RESULTS = 150;

/** Most-popular rows considered before the per-cell pick. */
export const EXPLORE_AREA_CANDIDATE_LIMIT = 4000;

/**
 * Areas whose circumscribed circle is at most this wide also filter with
 * `ST_DWithin`, so PostGIS uses the spatial index. Larger areas walk the
 * popularity index instead, which stays fast even for the whole world.
 */
export const EXPLORE_AREA_SPATIAL_RADIUS_KM = 300;

export const EXPLORE_AREA_MAX_ZOOM_BAND = 20;

/** Web Mercator stops here; the grid clamps latitudes to it. */
const MERCATOR_MAX_LAT = 85.05112878;

const EARTH_RADIUS_M = 6_371_000;

/**
 * @typedef {{
 *   south: number,
 *   west: number,
 *   north: number,
 *   east: number,
 *   zoom: number,
 *   zoomBand: number,
 *   crossesAntimeridian: boolean,
 *   countryCode: string | null,
 * }} ExploreArea
 */

const badRequest = (message) => {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
};

const finiteNumber = (value, name) => {
    const number = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) {
        throw badRequest(`${name} must be a finite number`);
    }
    return number;
};

/**
 * Validates `{ south, west, north, east, zoom }` plus optional `countryCode`.
 * `west > east` means the area crosses the antimeridian; `west = -180, east = 180`
 * is the whole world. When `countryCode` is set, place rows are limited to that
 * ISO country so a country-sized viewport does not leak neighbors.
 *
 * @param {Record<string, unknown>} payload
 * @returns {ExploreArea}
 */
export const parseExploreAreaRequest = (payload) => {
    const south = finiteNumber(payload?.south, "south");
    const north = finiteNumber(payload?.north, "north");
    const west = finiteNumber(payload?.west, "west");
    const east = finiteNumber(payload?.east, "east");
    const zoom = finiteNumber(payload?.zoom, "zoom");

    if (south < -90 || north > 90 || south > north) {
        throw badRequest("south/north must satisfy -90 <= south <= north <= 90");
    }
    if (west < -180 || west > 180 || east < -180 || east > 180) {
        throw badRequest("west/east must be within [-180, 180]");
    }
    if (zoom < 0 || zoom > 30) {
        throw badRequest("zoom must be within [0, 30]");
    }

    let countryCode = null;
    if (payload?.countryCode != null && String(payload.countryCode).trim()) {
        countryCode = String(payload.countryCode).trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(countryCode)) {
            throw badRequest("countryCode must be a 2-letter ISO code");
        }
    }

    return {
        south,
        west,
        north,
        east,
        zoom,
        zoomBand: exploreZoomBand(zoom),
        crossesAntimeridian: west > east,
        countryCode,
    };
};

/**
 * @param {number} zoom
 * @returns {number}
 */
export const exploreZoomBand = (zoom) =>
    Math.max(0, Math.min(EXPLORE_AREA_MAX_ZOOM_BAND, Math.floor(zoom)));

/**
 * Longitude span in degrees, antimeridian-aware.
 *
 * @param {Pick<ExploreArea, "west" | "east">} area
 * @returns {number}
 */
export const exploreAreaLngSpan = ({ west, east }) =>
    west <= east ? east - west : 360 - west + east;

/**
 * Web Mercator cell of a point at [zoomBand].
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} zoomBand
 * @param {number} [cellPx]
 * @returns {string}
 */
export const exploreCellKey = (lat, lng, zoomBand, cellPx = EXPLORE_AREA_CELL_PX) => {
    const worldPx = 256 * 2 ** zoomBand;
    const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
    const sinLat = Math.sin((clampedLat * Math.PI) / 180);
    const x = ((lng + 180) / 360) * worldPx;
    const y =
        (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldPx;
    return `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
};

const haversineMeters = (latA, lngA, latB, lngB) => {
    const toRad = Math.PI / 180;
    const dLat = (latB - latA) * toRad;
    const dLng = (lngB - lngA) * toRad;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(latA * toRad) * Math.cos(latB * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

const normalizeLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

/**
 * Center and radius of a circle that contains the whole area, or null when
 * the area is too large for a useful spatial filter.
 *
 * @param {ExploreArea} area
 * @param {number} [maxRadiusKm]
 * @returns {{ lat: number, lng: number, radiusM: number } | null}
 */
export const exploreAreaSpatialFilter = (
    area,
    maxRadiusKm = EXPLORE_AREA_SPATIAL_RADIUS_KM,
) => {
    const lngSpan = exploreAreaLngSpan(area);
    if (lngSpan >= 180 || area.north - area.south >= 90) return null;

    const lat = (area.south + area.north) / 2;
    const lng = normalizeLng(area.west + lngSpan / 2);
    const boundary = [];
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const edgeLng = normalizeLng(area.west + lngSpan * fraction);
        boundary.push([area.south, edgeLng], [area.north, edgeLng]);
    }
    boundary.push([area.south + (area.north - area.south) / 2, area.west]);
    boundary.push([area.south + (area.north - area.south) / 2, area.east]);

    const radiusM =
        Math.max(...boundary.map(([pLat, pLng]) => haversineMeters(lat, lng, pLat, pLng))) *
            1.01 +
        1;
    if (radiusM > maxRadiusKm * 1000) return null;
    return { lat, lng, radiusM };
};

/**
 * SQL for the popularity-ordered candidate rows inside [area].
 *
 * @param {ExploreArea} area
 * @param {number} [candidateLimit]
 * @returns {{ text: string, values: unknown[] }}
 */
export const buildExploreAreaCandidateQuery = (
    area,
    candidateLimit = EXPLORE_AREA_CANDIDATE_LIMIT,
) => {
    const values = [area.south, area.north, area.west, area.east, candidateLimit];
    const lngClause = area.crossesAntimeridian
        ? "(lng >= $3 OR lng <= $4)"
        : "lng BETWEEN $3 AND $4";
    let countryClause = "";
    if (area.countryCode) {
        values.push(area.countryCode);
        countryClause = `\n  AND country_code = $${values.length}`;
    }
    const spatial = exploreAreaSpatialFilter(area);
    let spatialClause = "";
    if (spatial) {
        values.push(spatial.lng, spatial.lat, spatial.radiusM);
        const radiusIdx = values.length;
        spatialClause = `
  AND ST_DWithin(
    location,
    ST_SetSRID(ST_MakePoint($${radiusIdx - 2}, $${radiusIdx - 1}), 4326)::geography,
    $${radiusIdx}
  )`;
    }
    const text = `
SELECT id, lat, lng, sitelinks
FROM sightseeing
WHERE lat BETWEEN $1 AND $2
  AND ${lngClause}${countryClause}${spatialClause}
ORDER BY sitelinks DESC, id ASC
LIMIT $5
`.trim();
    return { text, values };
};

/**
 * Keeps the most popular [perCell] candidates of each Mercator cell. When
 * more than [limit] remain, every cell's best place wins over any cell's
 * second best. The result stays in popularity order.
 *
 * @template {{ lat: number, lng: number, sitelinks: number }} T
 * @param {T[]} candidates
 * @param {number} zoomBand
 * @param {{ cellPx?: number, perCell?: number, limit?: number }} [options]
 * @returns {T[]}
 */
export const pickSpreadPlaces = (
    candidates,
    zoomBand,
    {
        cellPx = EXPLORE_AREA_CELL_PX,
        perCell = EXPLORE_AREA_PLACES_PER_CELL,
        limit = EXPLORE_AREA_MAX_RESULTS,
    } = {},
) => {
    const ordered = candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort(
            (a, b) =>
                (Number(b.candidate.sitelinks) || 0) - (Number(a.candidate.sitelinks) || 0) ||
                a.index - b.index,
        );

    const perCellCount = new Map();
    /** @type {Array<{ candidate: T, index: number, cellRank: number }>} */
    const kept = [];
    for (const entry of ordered) {
        const lat = Number(entry.candidate.lat);
        const lng = Number(entry.candidate.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const key = exploreCellKey(lat, lng, zoomBand, cellPx);
        const count = perCellCount.get(key) ?? 0;
        if (count >= perCell) continue;
        perCellCount.set(key, count + 1);
        kept.push({ ...entry, cellRank: count });
    }

    if (kept.length <= limit) return kept.map((entry) => entry.candidate);

    return kept
        .map((entry, order) => ({ ...entry, order }))
        .sort((a, b) => a.cellRank - b.cellRank || a.order - b.order)
        .slice(0, limit)
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.candidate);
};
