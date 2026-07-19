-- Europe sightseeing corpus for Explore + check-in nearby radius queries.
-- Requires PostGIS (Cloud SQL: enable postgis extension / install PostGIS flag).

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS sightseeing (
  id              BIGSERIAL PRIMARY KEY,
  wikidata_id     TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  category_label  TEXT,
  country_code    CHAR(2),
  country         TEXT,
  city            TEXT,
  sitelinks       INTEGER NOT NULL DEFAULT 0,
  image_url       TEXT,
  wikipedia_url   TEXT,
  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sightseeing_location_gix
  ON sightseeing USING GIST (location);

CREATE INDEX IF NOT EXISTS sightseeing_sitelinks_idx
  ON sightseeing (sitelinks DESC);

CREATE INDEX IF NOT EXISTS sightseeing_country_idx
  ON sightseeing (country_code);
