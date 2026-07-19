# Europe sightseeing (PostGIS)

Explore (`resolveNearMePopular`, `resolveGlobalSearchPopular`) and check-in nearby
(`resolveNearbyPlaces`) read tourist destinations from Cloud SQL Postgres + PostGIS.

## Schema

Apply once per database:

```bash
export DATABASE_URL=postgresql://USER:PASS@HOST:5432/sightseeing
psql "$DATABASE_URL" -f db/001_sightseeing.sql
# or: npm run sightseeing:migrate
```

## Seed from Wikidata

```bash
export DATABASE_URL=postgresql://USER:PASS@HOST:5432/sightseeing
npm run sightseeing:seed:dry-run
npm run sightseeing:seed -- --country=Malta
npm run sightseeing:seed

# Heavy countries (FR/DE/IT/AT/RU) auto-start on tight bbox tiles.
# Example France retry (lighter first pass):
caffeinate -dims -- node scripts/seed-europe-sightseeing.mjs \
  --country=France --min-sitelinks=15 --page-size=500 --delay-ms=2500
```

## Firebase secrets / VPC

```bash
firebase functions:secrets:set SIGHTSEEING_DATABASE_URL
# Optional, private-IP Cloud SQL only:
# export SIGHTSEEING_VPC_CONNECTOR=projects/PROJECT/locations/europe-west3/connectors/NAME
firebase deploy --only functions:resolveNearMePopular,functions:resolveGlobalSearchPopular,functions:resolveNearbyPlaces
# or: npm run deploy:sightseeing
```

Radii stay **3 km** (near-me / check-in) and **10 km** (city search via geocode types).
