-- Shared projects (decision 0013). This database belongs to the shares
-- shares API; owner and subscriber ids are the Ballast cloud's user and machine
-- ids, stored as opaque strings (the cloud owns identity and authorization).

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_machine_id TEXT,
  name TEXT NOT NULL,
  repo TEXT NOT NULL UNIQUE,
  share_code TEXT NOT NULL UNIQUE,
  current_sha TEXT,
  manifest_hash TEXT,
  message TEXT,
  deployed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_user_id);

CREATE TABLE IF NOT EXISTS share_subscriptions (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL,
  installed_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, machine_id)
);

CREATE INDEX IF NOT EXISTS share_subscriptions_machine ON share_subscriptions(machine_id);
