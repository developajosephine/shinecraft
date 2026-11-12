-- WashLog schema. Idempotent: safe to run on every startup.

CREATE TABLE IF NOT EXISTS records (
  id          uuid PRIMARY KEY,
  record_type text        NOT NULL,
  data        jsonb       NOT NULL,
  version     int         NOT NULL,
  updated_at  timestamptz NOT NULL,
  updated_by  text        NOT NULL,
  deleted     boolean     NOT NULL DEFAULT false,
  deleted_at  timestamptz,
  change_seq  bigserial   NOT NULL  -- bumped with nextval() on every write; drives pull
);
CREATE INDEX IF NOT EXISTS records_change_seq_idx ON records (change_seq);

-- Operation-ID set: one row per op the server has ever handled.
CREATE TABLE IF NOT EXISTS processed_ops (
  op_id        uuid PRIMARY KEY,
  device_id    text        NOT NULL,
  record_id    uuid        NOT NULL,
  result       jsonb,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conflict_log (
  id              serial PRIMARY KEY,
  record_id       uuid        NOT NULL,
  record_type     text        NOT NULL,
  field           text        NOT NULL,
  winning_value   jsonb,
  rejected_value  jsonb,
  winning_device  text        NOT NULL,
  rejected_device text        NOT NULL,
  policy          text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conflict_log_record_idx ON conflict_log (record_id);
