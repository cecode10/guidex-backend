import { onRequest } from "firebase-functions/v2/https";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import { ensureSightseeingByQid } from "../ensure-sightseeing-by-qid.mjs";
import { sightseeingHttpsOptions } from "../sightseeing-function-options.mjs";

const FUNCTION_NAME = "ensureSightseeingByQid";

/**
 * Hidden Explore admin endpoint: check/insert a Wikidata QID into sightseeing.
 */
export const ensureSightseeingByQidFn = onRequest(
    sightseeingHttpsOptions({
        timeoutSeconds: 60,
        memory: "512MiB",
    }),
    async (req, res) => {
        const start = Date.now();
        try {
            await requireAuth(req);
            const payload = req.body || {};
            validateMandatoryFields(payload, ["wikidataId"]);

            const result = await ensureSightseeingByQid(String(payload.wikidataId));
            const elapsed = Date.now() - start;
            console.log(
                `[${FUNCTION_NAME}] ${result.status} ${result.wikidataId}` +
                    (result.name ? ` name="${result.name}"` : "") +
                    ` in ${elapsed}ms`,
            );
            return res.status(200).json(result);
        } catch (error) {
            const elapsed = Date.now() - start;
            const statusCode = error?.statusCode || 500;
            console.error(
                `[${FUNCTION_NAME}] failed in ${elapsed}ms status=${statusCode}:`,
                error?.message || error,
            );
            return res
                .status(statusCode)
                .json({
                    error: statusCode === 401 ? "unauthorized" : error?.message || "failed",
                });
        }
    },
);
