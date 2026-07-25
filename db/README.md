# Europe sightseeing (PostGIS)

Explore (`resolveNearMePopular`, `resolveGlobalSearchPopular`) and check-in nearby
(`resolveNearbyPlaces`) read tourist destinations from Cloud SQL Postgres + PostGIS.

## Schema

Apply once per database:

```bash
export DATABASE_URL=postgresql://USER:PASS@HOST:5432/sightseeing
psql "$DATABASE_URL" -f db/001_sightseeing.sql
# or: npm run script:sightseeing:migrate
```

## Seed specific QIDs (admin)

Calls the deployed `ensureSightseeingByQid` Cloud Function (no local DB access needed):

```bash
# credentials: scripts/guidex-afc30-*.json
# API key + BACKEND_URL: auto-read from mobile-app/.env
npm run script:sightseeing:seed-qids:dry-run -- --file scripts/qids.txt
npm run script:sightseeing:seed-qids -- --file scripts/qids.txt
npm run script:sightseeing:seed-qids -- --qid Q243 --qid Q1054070
```

## Firebase secrets / VPC

```bash
# Connection string must use the Cloud SQL *private* IP (not the VPC connector range):
# postgresql://postgres:PASSWORD@10.x.x.x:5432/sightseeing
firebase functions:secrets:set SIGHTSEEING_DATABASE_URL --project guidex-afc30

# VPC connector is configured via `.env.guidex-afc30` (SIGHTSEEING_VPC_CONNECTOR).
# Shell `export` alone is ignored by `firebase deploy` — edit that file if the
# connector name differs, then:
npm run deploy:batch:sightseeing
```

After deploy, Cloud Run → function → Networking should show the connector
(not `Network: None`).

Radii stay **3 km** (near-me / check-in) and **10 km** (city search via geocode types).
