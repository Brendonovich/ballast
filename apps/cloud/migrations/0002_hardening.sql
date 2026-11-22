-- Deployment hardening: auth state, token-refresh leases and rate limits.

ALTER TABLE twitch_accounts ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE twitch_accounts ADD COLUMN refresh_lock TEXT;
ALTER TABLE twitch_accounts ADD COLUMN refresh_lock_until INTEGER NOT NULL DEFAULT 0;

-- Fixed-window counters for pairing-code creation (per user) and claims
-- (per client IP). Expired rows are pruned opportunistically.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_expires_at ON rate_limits(expires_at);
