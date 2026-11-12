-- Per-field last-writer stamps: { "<field>": { "timestamp": "<ISO>", "deviceId": "<id>" } }.
-- Lets conflicts be resolved field by field instead of record by record.
ALTER TABLE records ADD COLUMN IF NOT EXISTS field_stamps jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Rows written before this column existed: stamp every field with the record's last writer.
UPDATE records r
SET field_stamps = (
  SELECT COALESCE(
    jsonb_object_agg(
      k,
      jsonb_build_object(
        'timestamp', to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'deviceId', r.updated_by
      )
    ),
    '{}'::jsonb
  )
  FROM jsonb_object_keys(r.data) AS k
)
WHERE r.field_stamps = '{}'::jsonb;
