PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS twitch_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  twitch_user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  secrets_json TEXT NOT NULL,
  machine_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, twitch_user_id)
);

CREATE INDEX IF NOT EXISTS twitch_accounts_user_id ON twitch_accounts(user_id);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS machines_user_id ON machines(user_id);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  scopes_json TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES twitch_accounts(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  condition_json TEXT NOT NULL,
  cost INTEGER NOT NULL,
  provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL,
  on_stale TEXT NOT NULL,
  max_age_ms INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, type, version, condition_json)
);

CREATE INDEX IF NOT EXISTS event_subscriptions_account_id ON event_subscriptions(account_id);
CREATE INDEX IF NOT EXISTS event_subscriptions_machine_id ON event_subscriptions(machine_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  message_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES twitch_accounts(id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_received_at ON webhook_deliveries(received_at);
