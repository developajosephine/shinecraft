-- Make the job and supply data visible as ordinary columns, and keep the reference data
-- (vehicle types, services, supply units) in the database. Idempotent; nothing is dropped.
--
-- `records.data` (jsonb) stays the source of truth: sync, conflict resolution and field stamps
-- all work on it. The views below only read it, so they can never disagree with it.

-- ---- Reference data -------------------------------------------------------------------------
-- The codes are the fixed values the app accepts (shared/src/types.ts). Names and default
-- price / water can be changed here; phones pick the change up on their next sync
-- (GET /api/catalog) and use the built-in values while offline. Seeded from
-- shared/src/catalog.ts DEFAULT_CATALOG; ON CONFLICT DO NOTHING keeps any edits made here.

CREATE TABLE IF NOT EXISTS vehicle_types (
  code                 text PRIMARY KEY CHECK (code IN ('saloon', 'suv', 'matatu', 'motorbike', 'pickup')),
  label                text    NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  default_water_litres numeric NOT NULL CHECK (default_water_litres >= 0),
  sort_order           int     NOT NULL
);
INSERT INTO vehicle_types (code, label, default_water_litres, sort_order) VALUES
  ('saloon',    'Saloon',    40, 1),
  ('suv',       'SUV',       60, 2),
  ('matatu',    'Matatu',    90, 3),
  ('motorbike', 'Motorbike', 15, 4),
  ('pickup',    'Pickup',    55, 5)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS services (
  code              text PRIMARY KEY CHECK (code IN ('body', 'full', 'interior', 'engine')),
  label             text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  default_price_kes int  NOT NULL CHECK (default_price_kes BETWEEN 0 AND 1000000),
  sort_order        int  NOT NULL
);
INSERT INTO services (code, label, default_price_kes, sort_order) VALUES
  ('body',     'Body wash',     300, 1),
  ('full',     'Full wash',     600, 2),
  ('interior', 'Interior wash', 400, 3),
  ('engine',   'Engine wash',   500, 4)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS supply_units (
  code       text PRIMARY KEY CHECK (code IN ('litres', 'bottles', 'kg', 'pct')),
  label      text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  sort_order int  NOT NULL
);
INSERT INTO supply_units (code, label, sort_order) VALUES
  ('litres',  'litres',  1),
  ('bottles', 'bottles', 2),
  ('kg',      'kg',      3),
  ('pct',     '%',       4)
ON CONFLICT (code) DO NOTHING;

-- ---- Readable views over records ------------------------------------------------------------
-- One column per field. Deleted jobs/supplies (tombstones) are left out; they remain in `records`.
-- Every value was validated by the strict schema before it was stored, so the casts are safe.

CREATE OR REPLACE VIEW jobs AS
SELECT
  r.id,
  r.data ->> 'plate'                         AS plate,
  r.data ->> 'vehicleType'                   AS vehicle_type,
  vt.label                                   AS vehicle_label,
  r.data ->> 'service'                       AS service,
  s.label                                    AS service_label,
  (r.data ->> 'priceKes')::int               AS price_kes,
  r.data ->> 'status'                        AS status,
  r.data ->> 'paymentMethod'                 AS payment_method,
  r.data ->> 'mpesaCode'                     AS mpesa_code,
  r.data ->> 'attendant'                     AS attendant,
  (r.data ->> 'waterLitres')::numeric        AS water_litres,
  (r.data ->> 'createdAt')::timestamptz      AS created_at,
  r.version,
  r.updated_at,
  r.updated_by
FROM records r
LEFT JOIN vehicle_types vt ON vt.code = r.data ->> 'vehicleType'
LEFT JOIN services s       ON s.code  = r.data ->> 'service'
WHERE r.record_type = 'job' AND NOT r.deleted;

CREATE OR REPLACE VIEW supplies AS
SELECT
  r.id,
  r.data ->> 'item'                  AS item,
  (r.data ->> 'quantity')::numeric   AS quantity,
  r.data ->> 'unit'                  AS unit,
  u.label                            AS unit_label,
  r.version,
  r.updated_at,
  r.updated_by
FROM records r
LEFT JOIN supply_units u ON u.code = r.data ->> 'unit'
WHERE r.record_type = 'supply' AND NOT r.deleted;

-- Finding a car by plate, and listing jobs by status, without scanning every record.
CREATE INDEX IF NOT EXISTS records_job_plate_idx  ON records ((data ->> 'plate'))  WHERE record_type = 'job';
CREATE INDEX IF NOT EXISTS records_job_status_idx ON records ((data ->> 'status')) WHERE record_type = 'job';
