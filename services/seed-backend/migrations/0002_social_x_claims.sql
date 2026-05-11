CREATE TABLE IF NOT EXISTS social_x_claims (
  id bigserial PRIMARY KEY,
  wallet text NOT NULL,
  participant_handle text NOT NULL,
  tweet_url text NOT NULL,
  tweet_id text NOT NULL,
  tweet_author text NOT NULL,
  tweet_created_at timestamptz NOT NULL,
  amount_raw numeric(78,0) NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  ip_hash text,
  ip_subnet text,
  tx_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (wallet),
  UNIQUE (tweet_id),
  UNIQUE (tweet_author)
);

CREATE INDEX IF NOT EXISTS social_x_claims_status_idx ON social_x_claims(status, created_at);
CREATE INDEX IF NOT EXISTS social_x_claims_sent_at_idx ON social_x_claims(sent_at);
CREATE INDEX IF NOT EXISTS social_x_claims_subnet_idx ON social_x_claims(ip_subnet, created_at);

CREATE TABLE IF NOT EXISTS social_x_claim_attempts (
  id bigserial PRIMARY KEY,
  wallet text,
  tweet_id text,
  tweet_author text,
  ip_hash text,
  ip_subnet text,
  outcome text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_x_claim_attempts_ip_idx ON social_x_claim_attempts(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS social_x_claim_attempts_wallet_idx ON social_x_claim_attempts(wallet, created_at);
CREATE INDEX IF NOT EXISTS social_x_claim_attempts_subnet_idx ON social_x_claim_attempts(ip_subnet, created_at);
