-- Per-user login, sessions and an audit trail.

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL,
  role       text        NOT NULL CHECK (role IN ('attendant', 'cashier', 'manager')),
  pin_hash   text        NOT NULL,              -- scrypt, never the PIN itself
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,                  -- sha256 of the token; the token itself is never stored
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  user_name   text        NOT NULL,
  role        text        NOT NULL,
  device_id   text,
  action      text        NOT NULL,             -- e.g. job.create, job.update, user.create, auth.login
  record_id   uuid,
  outcome     text        NOT NULL,             -- applied, conflict_resolved, rejected, ok, failed
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
