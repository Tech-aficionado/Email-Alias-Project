-- Migration: Cloudflare Email Routing destination-address cache
--
-- Forwarding through `message.forward()` is free and unmetered, but Cloudflare
-- only permits it to verified destination addresses on the account. This table
-- caches that verification state locally so the email hot path never has to
-- call the Cloudflare API.
--
-- Apply with:
--   npx wrangler d1 execute ghostrelay-db --remote --file=database/migration-cf-destinations.sql

CREATE TABLE IF NOT EXISTS cf_destinations (
    -- Lowercased destination inbox. Account-scoped in Cloudflare, so it is
    -- shared across every alias and user that forwards there.
    email TEXT PRIMARY KEY,
    -- Cloudflare's identifier for the destination address (nullable until synced).
    cf_tag TEXT,
    -- 1 once the owner has clicked Cloudflare's verification link.
    verified INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cf_destinations_verified ON cf_destinations(verified);
