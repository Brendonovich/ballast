-- Provider subscriptions are shared; each client/project is an owner link.
-- Reconcile may only delete a provider subscription once no owner wants it.

CREATE TABLE IF NOT EXISTS event_subscription_owners (
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  on_stale TEXT NOT NULL,
  max_age_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, owner)
);

CREATE INDEX IF NOT EXISTS event_subscription_owners_owner
  ON event_subscription_owners(owner);

-- Existing single-owner rows become owned by the legacy default client.
INSERT OR IGNORE INTO event_subscription_owners
  (subscription_id, owner, on_stale, max_age_ms, created_at, updated_at)
SELECT id, 'default', on_stale, max_age_ms, created_at, updated_at
FROM event_subscriptions;
