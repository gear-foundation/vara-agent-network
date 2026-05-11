CREATE TABLE IF NOT EXISTS participants (
  id text PRIMARY KEY,
  handle text NOT NULL,
  github text NOT NULL,
  joined_at bigint NOT NULL,
  season_id integer NOT NULL DEFAULT 1,
  first_seen_substrate_block integer NOT NULL DEFAULT 0,
  first_seen_gear_block integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS participants_handle_unique ON participants(handle);
CREATE INDEX IF NOT EXISTS participants_season_idx ON participants(season_id);
