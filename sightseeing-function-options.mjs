import { defineSecret, defineString } from "firebase-functions/params";

/** Cloud SQL connection string (Postgres + PostGIS). */
export const sightseeingDatabaseUrl = defineSecret("SIGHTSEEING_DATABASE_URL");

/**
 * Serverless VPC Access connector for private-IP Cloud SQL.
 * Firebase reads this from `.env` / `.env.<projectId>` or the default below.
 * Shell `export` alone is NOT applied during `firebase deploy` analysis.
 */
export const sightseeingVpcConnector = defineString("SIGHTSEEING_VPC_CONNECTOR", {
    default:
        "projects/guidex-afc30/locations/europe-west3/connectors/sightseeing-sql",
});

/**
 * Shared onRequest options for handlers that query the sightseeing DB.
 *
 * @param {{
 *   timeoutSeconds?: number,
 *   memory?: string,
 *   secrets?: Array<import("firebase-functions/params").SecretParam>,
 * }} [extra]
 * @returns {Record<string, unknown>}
 */
export const sightseeingHttpsOptions = (extra = {}) => ({
    cors: true,
    region: "europe-west3",
    timeoutSeconds: extra.timeoutSeconds ?? 60,
    memory: extra.memory ?? "512MiB",
    secrets: [sightseeingDatabaseUrl, ...(extra.secrets ?? [])],
    vpcConnector: sightseeingVpcConnector,
    vpcConnectorEgressSettings: "PRIVATE_RANGES_ONLY",
});
