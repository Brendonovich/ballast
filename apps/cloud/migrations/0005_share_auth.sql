-- Share-server sign-in (decision 0014). Sharing authenticates people through
-- an OpenID Connect issuer (Sign in with Anomaly) instead of paired machines.

-- One row per identity-provider subject. The subject, never the email or
-- username, is the identity; name and username are display copies.
CREATE TABLE IF NOT EXISTS share_users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  name TEXT,
  username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (issuer, subject)
);

-- Bearer tokens handed to agents after sign-in; only a peppered hash is kept.
CREATE TABLE IF NOT EXISTS share_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES share_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS share_sessions_user ON share_sessions(user_id);

-- In-flight sign-ins between /login and the issuer's callback. The payload
-- (PKCE verifier, nonce, DPoP key, the agent's redirect) is sealed.
CREATE TABLE IF NOT EXISTS share_sign_ins (
  state TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Single-use codes the browser carries back to the agent's loopback
-- redirect, redeemed with the agent's PKCE verifier.
CREATE TABLE IF NOT EXISTS share_auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES share_users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
