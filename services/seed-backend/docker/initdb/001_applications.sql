CREATE TABLE IF NOT EXISTS applications (
  id text PRIMARY KEY,
  handle text NOT NULL,
  owner text NOT NULL,
  github_url text NOT NULL,
  status text NOT NULL DEFAULT 'Building',
  season_id integer NOT NULL DEFAULT 1,
  registered_at bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS applications_owner_idx ON applications(owner);
