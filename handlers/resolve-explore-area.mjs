import { onRequest } from "firebase-functions/v2/https";
import { requireAuth } from "../utils/auth.mjs";
import { parseExploreAreaRequest } from "../utils/explore-area-utils.mjs";
import { explorePopularHttpStatus } from "../services/explore-popular-core.mjs";
import { sightseeingHttpsOptions } from "../utils/sightseeing-function-options.mjs";
import { findSightseeingInArea } from "../services/sightseeing-query.mjs";

const FUNCTION_NAME = "resolveExploreArea";

/**
 * Cloud Function: Explore places inside the map area the user is looking at.
 * Body: `{ south, west, north, east, zoom, countryCode? }` (`west > east`
 * crosses the antimeridian). When `countryCode` is set, only that country's
 * rows are considered. Returns the most popular place per map cell (PostGIS).
 */
export const resolveExploreArea = onRequest(
    sightseeingHttpsOptions({
        timeoutSeconds: 30,
        memory: "512MiB",
    }),
    async (req, res) => {
        const start = Date.now();
        try {
            await requireAuth(req);
            const area = parseExploreAreaRequest(req.body || {});
            const { places, candidateCount } = await findSightseeingInArea(area);

            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] s=${area.south} w=${area.west} n=${area.north} ` +
                    `e=${area.east} zoom=${area.zoom} band=${area.zoomBand} ` +
                    `country=${area.countryCode ?? "-"} ` +
                    `candidates=${candidateCount} places=${places.length} in ${elapsed}ms`,
            );
            return res.status(200).json({
                bounds: {
                    south: area.south,
                    west: area.west,
                    north: area.north,
                    east: area.east,
                },
                zoomBand: area.zoomBand,
                places,
            });
        } catch (error) {
            const elapsed = Date.now() - start;
            const statusCode = explorePopularHttpStatus(error);
            console.error(`[${FUNCTION_NAME}] error after ${elapsed}ms:`, error?.message || error);
            return res
                .status(statusCode)
                .json({ error: statusCode === 401 ? "unauthorized" : error?.message || "failed" });
        }
    },
);
