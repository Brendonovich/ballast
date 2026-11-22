-- Generic provider webhooks. A hook is a public bearer capability
-- (machine_id, hook_id) registered by one machine.

CREATE TABLE IF NOT EXISTS webhook_hooks (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  hook_id TEXT NOT NULL,
  label TEXT,
  verification_json TEXT,
  secret_ciphertext TEXT,
  secret_iv TEXT,
  response_json TEXT,
  max_age_ms INTEGER NOT NULL,
  on_stale TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (machine_id, hook_id)
);

CREATE INDEX IF NOT EXISTS webhook_hooks_machine_id ON webhook_hooks(machine_id);
CREATE INDEX IF NOT EXISTS webhook_hooks_updated_at ON webhook_hooks(updated_at);
