-- Shares belong to signed-in people (decision 0014), not paired machines.
-- Owner and subscriber ids are the front door's share-user ids (one per
-- identity provider subject), stored as opaque strings. Shares made under
-- the machine model had Twitch-user owners and cannot be carried over.

DROP TABLE IF EXISTS share_subscriptions;
DROP TABLE IF EXISTS shares;

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
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

CREATE INDEX shares_owner ON shares(owner_user_id);

CREATE TABLE share_subscriptions (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL,
  installed_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, subscriber_id)
);

CREATE INDEX share_subscriptions_subscriber ON share_subscriptions(subscriber_id);
