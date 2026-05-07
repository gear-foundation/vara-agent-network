CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gasless_program_status_enum') THEN
    CREATE TYPE gasless_program_status_enum AS ENUM ('enabled', 'disabled');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS gasless_program (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name character varying,
  address character varying,
  vara_to_issue integer NOT NULL,
  weight integer NOT NULL DEFAULT 1,
  duration integer NOT NULL,
  status gasless_program_status_enum NOT NULL DEFAULT 'enabled',
  one_time boolean DEFAULT false,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS gasless_program_address_uq
  ON gasless_program (address)
  WHERE address IS NOT NULL;

CREATE TABLE IF NOT EXISTS voucher (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id character varying NOT NULL,
  account character varying NOT NULL,
  programs jsonb NOT NULL,
  vara_to_issue double precision NOT NULL DEFAULT 0,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_up_to_block bigint NOT NULL,
  valid_up_to timestamp without time zone NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  last_renewed_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS voucher_voucher_id_uq
  ON voucher (voucher_id);

CREATE INDEX IF NOT EXISTS voucher_account_revoked_idx
  ON voucher (account, revoked);

CREATE INDEX IF NOT EXISTS voucher_valid_up_to_revoked_idx
  ON voucher (valid_up_to, revoked);

CREATE TABLE IF NOT EXISTS ip_tranche_usage (
  ip varchar(64) NOT NULL,
  utc_day date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, utc_day)
);
