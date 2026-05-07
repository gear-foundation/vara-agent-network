CREATE TABLE IF NOT EXISTS seed_allocations (
  id bigserial PRIMARY KEY,
  wallet text NOT NULL,
  application_id text NOT NULL,
  github_url text NOT NULL,
  github_owner text,
  github_repo text,
  state text NOT NULL DEFAULT 'active',
  total_funded_raw numeric(78,0) NOT NULL DEFAULT 0,
  daily_funded_raw numeric(78,0) NOT NULL DEFAULT 0,
  daily_window date NOT NULL DEFAULT CURRENT_DATE,
  last_funded_at timestamptz,
  suspicious_count int NOT NULL DEFAULT 0,
  risk_score int NOT NULL DEFAULT 0,
  last_reason text,
  github_checked_at timestamptz,
  github_ok boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet, application_id)
);

CREATE INDEX IF NOT EXISTS seed_allocations_wallet_idx ON seed_allocations(wallet);
CREATE INDEX IF NOT EXISTS seed_allocations_state_idx ON seed_allocations(state);

CREATE TABLE IF NOT EXISTS seed_payouts (
  idempotency_key text PRIMARY KEY,
  status text NOT NULL,
  wallet text NOT NULL,
  application_id text NOT NULL,
  github_owner text NOT NULL,
  github_repo text NOT NULL,
  amount_raw numeric(78,0) NOT NULL,
  reason text NOT NULL,
  tx_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS seed_payouts_status_idx ON seed_payouts(status);
CREATE INDEX IF NOT EXISTS seed_payouts_wallet_idx ON seed_payouts(wallet);
CREATE INDEX IF NOT EXISTS seed_payouts_app_idx ON seed_payouts(application_id);
CREATE INDEX IF NOT EXISTS seed_payouts_github_idx ON seed_payouts(github_owner);
CREATE INDEX IF NOT EXISTS seed_payouts_repo_idx ON seed_payouts(github_owner, github_repo);

CREATE TABLE IF NOT EXISTS seed_funding_events (
  id bigserial PRIMARY KEY,
  wallet text NOT NULL,
  application_id text NOT NULL,
  amount_raw numeric(78,0) NOT NULL,
  tx_hash text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seed_spend_events (
  id text PRIMARY KEY,
  wallet text NOT NULL,
  recipient text NOT NULL,
  amount_raw numeric(78,0) NOT NULL,
  kind text NOT NULL,
  allowed boolean NOT NULL,
  substrate_block_number int NOT NULL,
  substrate_block_ts timestamptz NOT NULL,
  extrinsic_idx int,
  event_idx int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seed_spend_events_wallet_idx ON seed_spend_events(wallet);
CREATE INDEX IF NOT EXISTS seed_spend_events_allowed_idx ON seed_spend_events(allowed);

CREATE TABLE IF NOT EXISTS seed_taint_targets (
  id bigserial PRIMARY KEY,
  source_wallet text NOT NULL,
  source_application_id text NOT NULL,
  program_id text NOT NULL,
  amount_raw numeric(78,0) NOT NULL DEFAULT 0,
  first_seen_block int NOT NULL,
  last_seen_block int NOT NULL,
  last_event_id text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_wallet, source_application_id, program_id)
);

CREATE INDEX IF NOT EXISTS seed_taint_targets_program_idx ON seed_taint_targets(program_id);
CREATE INDEX IF NOT EXISTS seed_taint_targets_source_wallet_idx ON seed_taint_targets(source_wallet);

CREATE TABLE IF NOT EXISTS seed_monitor_cursor (
  id text PRIMARY KEY,
  last_processed_block int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seed_audit_events (
  id bigserial PRIMARY KEY,
  wallet text,
  application_id text,
  level text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
