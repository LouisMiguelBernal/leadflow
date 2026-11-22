-- Runs before 001. citext gives case-insensitive email comparison;
-- pgcrypto provides gen_random_uuid() on older Postgres.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
