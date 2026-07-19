import { defineSecret } from "firebase-functions/params";

/** Cloud SQL connection string (Postgres + PostGIS). */
export const sightseeingDatabaseUrl = defineSecret("SIGHTSEEING_DATABASE_URL");

/**
 * Shared onRequest options for handlers that query the sightseeing DB.
 *
 * Set `SIGHTSEEING_VPC_CONNECTOR` in the Functions runtime env when Cloud SQL
 * uses a private IP (Serverless VPC Access), e.g.
 * `projects/guidex-afc30/locations/europe-west3/connectors/sightseeing-sql`.
 *
 * @param {{
 *   timeoutSeconds?: number,
 *   memory?: string,
 *   secrets?: Array<import("firebase-functions/params").SecretParam>,
 * }} [extra]
 * @returns {Record<string, unknown>}
 */
export const sightseeingHttpsOptions = (extra = {}) => {
    /** @type {Record<string, unknown>} */
    const options = {
        cors: true,
        region: "europe-west3",
        timeoutSeconds: extra.timeoutSeconds ?? 60,
        memory: extra.memory ?? "512MiB",
        secrets: [sightseeingDatabaseUrl, ...(extra.secrets ?? [])],
    };

    const vpc = String(process.env.SIGHTSEEING_VPC_CONNECTOR ?? "").trim();
    if (vpc) {
        options.vpcConnector = vpc;
        options.vpcConnectorEgressSettings = "PRIVATE_RANGES_ONLY";
    }

    return options;
};
