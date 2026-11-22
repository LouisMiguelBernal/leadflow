-- 001_init.sql — core pipeline: a lead arrives, gets qualified, a human
-- approves, money is collected. Every state change is recorded.

BEGIN;

CREATE TABLE schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Lead lifecycle. Enforced in the database rather than in application code,
-- because n8n, the agent service and the dashboard all write here.
CREATE TYPE lead_status AS ENUM (
  'new',            -- received, not yet looked at
  'qualifying',     -- agent is working on it
  'awaiting_review',-- agent produced a verdict, waiting on a human
  'approved',
  'rejected',
  'paid'
);

CREATE TABLE leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext NOT NULL,
  full_name    text,
  company      text,
  message      text,
  source       text NOT NULL DEFAULT 'webhook',
  status       lead_status NOT NULL DEFAULT 'new',

  -- Agent output. score is 0-100; reasoning is kept so a human reviewing the
  -- decision can see why, which is the whole point of the approval step.
  score        smallint CHECK (score BETWEEN 0 AND 100),
  reasoning    text,
  agent_model  text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leads_status_created_idx ON leads (status, created_at DESC);
CREATE INDEX leads_email_idx ON leads (email);

-- Append-only audit trail. Never updated, never deleted: this is what you
-- show when someone asks "why did the system do that?"
CREATE TABLE lead_events (
  id         bigserial PRIMARY KEY,
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind       text NOT NULL,        -- received | qualified | approved | paid | error
  actor      text NOT NULL,        -- 'agent' | 'n8n' | a user email | 'stripe'
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, created_at);

-- Human-in-the-loop gate. One open approval per lead at a time.
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  decision     text CHECK (decision IN ('approved', 'rejected')),
  note         text
);

CREATE UNIQUE INDEX approvals_one_open_per_lead
  ON approvals (lead_id) WHERE decided_at IS NULL;

-- Stripe side. stripe_event_id carries the unique constraint that makes
-- webhook handling idempotent — Stripe retries for up to 3 days and the same
-- event WILL arrive twice.
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  stripe_session_id text UNIQUE,
  stripe_event_id text UNIQUE,
  amount_cents    integer NOT NULL,
  currency        text NOT NULL DEFAULT 'usd',
  status          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Keep updated_at honest without relying on every caller to set it.
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER leads_touch BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

INSERT INTO schema_migrations (version) VALUES ('001_init');

COMMIT;
