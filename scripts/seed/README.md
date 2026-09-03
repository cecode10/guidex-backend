# Sightseeing seed scripts

All seed entrypoints, country lists, and helpers live in this folder
(`backend/scripts/seed/`).

Populate the PostGIS `sightseeing` table from Wikidata. All geographic seeds
use the same quality filters as the original Europe seed
(`SPARQL_POI_CATEGORIES` + `SPARQL_INSTANCE_OF_CLAUSE`).

Run from `backend/` with a reachable Postgres URL (Cloud SQL Auth Proxy for
private IP):

```bash
export DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/sightseeing
npm run script:sightseeing:migrate   # once per database (creates the table)
```

On macOS, geographic seeds re-launch under `caffeinate -dims` unless you pass
`--no-caffeinate`.
---

## 1. One city or country

Use this for “seed San Francisco” or “seed USA”. Resolves the place on
Wikidata (name, ISO code, or Q-id).

```bash
npm run script:sightseeing:seed:dry-run -- --city "San Francisco"
npm run script:sightseeing:seed -- --city "San Francisco"
npm run script:sightseeing:seed -- --country USA
npm run script:sightseeing:seed -- --city Paris --country France
npm run script:sightseeing:seed -- --country Q30 --min-sitelinks=15
```

| Flag | Meaning |
|------|---------|
| `--city NAME\|QID` | City / town |
| `--country NAME\|QID\|ISO` | Country; with `--city`, disambiguates (Paris, France) |
| `--dry-run` | Fetch Wikidata only; no DB writes |
| `--migrate-db` | Applies `db/001_sightseeing.sql` (create table/indexes if missing) before seeding. Default: off |
| `--resume` | Skip QIDs already ok in the checkpoint |
| `--radius-km N` | City bbox when Wikidata has no extremes (default 20) |
| `--min-sitelinks N` | Keep POIs with sitelinks ≥ N (default 1) |
| `--max-sitelinks N` | Exclusive upper bound (for range passes) |
| `--page-size N` | SPARQL page size (default 2000) |
| `--delay-ms N` | Pause between SPARQL calls (default 1500) |
| `--force-tiles` | Always split the bbox into tiles first |

Checkpoint: `scripts/seed/reports/seed-sightseeing-checkpoint.json`

---

## 2. Whole continent

Thin wrappers over the same engine, each with a fixed country list. `--country`
filters **that list** (name, ISO-2, alias, or Q-id) — it does not search
Wikidata. Omit `--country` to seed every country on the list.

```bash
npm run script:sightseeing:seed-europe -- --country=Malta
npm run script:sightseeing:seed-north-america -- --country=USA
npm run script:sightseeing:seed-asia -- --country=JP
npm run script:sightseeing:seed-africa -- --country=Egypt
npm run script:sightseeing:seed-south-america -- --country=Brazil
npm run script:sightseeing:seed-oceania -- --country=Australia

# full continent (long). Resume after interrupt:
npm run script:sightseeing:seed-europe -- --resume
```

Dry-run pilots (tiny country, no caffeinate):

```bash
npm run script:sightseeing:seed-europe:dry-run
npm run script:sightseeing:seed-north-america:dry-run
npm run script:sightseeing:seed-asia:dry-run
npm run script:sightseeing:seed-africa:dry-run
npm run script:sightseeing:seed-south-america:dry-run
npm run script:sightseeing:seed-oceania:dry-run
```

| Continent | Script | Checkpoint |
|-----------|--------|------------|
| Europe | `seed-europe-sightseeing.mjs` | `seed-europe-checkpoint.json` |
| North America | `seed-north-america-sightseeing.mjs` | `seed-north-america-checkpoint.json` |
| Asia | `seed-asia-sightseeing.mjs` | `seed-asia-checkpoint.json` |
| Africa | `seed-africa-sightseeing.mjs` | `seed-africa-checkpoint.json` |
| South America | `seed-south-america-sightseeing.mjs` | `seed-south-america-checkpoint.json` |
| Oceania | `seed-oceania-sightseeing.mjs` | `seed-oceania-checkpoint.json` |

Upserts merge by `wikidata_id`, so continents can be seeded in any order.

Russia / Turkey / Georgia / Armenia / Azerbaijan live on the **Europe** list
(with European-portion bounds). They are not repeated on Asia.

---

## 3. Explicit QIDs

Calls the deployed `ensureSightseeingByQid` Cloud Function (no local Postgres).

```bash
# credentials: scripts/guidex-afc30-*.json
# API key + BACKEND_URL: auto-read from mobile-app/.env
npm run script:sightseeing:seed-qids:dry-run -- --file scripts/seed/qids.txt
npm run script:sightseeing:seed-qids -- --file scripts/seed/qids.txt
npm run script:sightseeing:seed-qids -- --qid Q243 --qid Q1054070
```

Optional `--direct` talks to Postgres in-process instead of the HTTP API.

---

## Logs

Geographic runs append `scripts/seed/reports/seed-*-progress.log` and write a
timestamped JSON report in the same folder. Re-run with `--resume` to continue
after a failure or interrupt.
