export const RECORD_TYPES = ['job', 'supply'] as const;
export const VEHICLE_TYPES = ['saloon', 'suv', 'matatu', 'motorbike', 'pickup'] as const;
export const SERVICES = ['body', 'full', 'interior', 'engine'] as const;
export const PAYMENT_METHODS = ['cash', 'mpesa'] as const;
export const JOB_STATUSES = ['waiting', 'washing', 'done', 'paid'] as const;
export const SUPPLY_UNITS = ['litres', 'bottles', 'kg', 'pct'] as const;
export const OP_TYPES = ['create', 'update', 'delete'] as const;

export type RecordType = (typeof RECORD_TYPES)[number];
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export type Service = (typeof SERVICES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type SupplyUnit = (typeof SUPPLY_UNITS)[number];
export type OpType = (typeof OP_TYPES)[number];

/** Fields in a conflict that get the "lww-flag-money" policy so the UI highlights them. */
export const MONEY_FIELDS: readonly string[] = ['priceKes', 'paymentMethod', 'mpesaCode'];

export interface BaseRecord {
  id: string; // UUID v4, generated on the client
  version: number; // server-assigned; 0 = never synced
  updatedAt: string; // ISO string, client clock
  updatedBy: string; // deviceId
  deleted: boolean; // tombstone
  deletedAt: string | null;
}

export interface JobFields {
  plate: string;
  vehicleType: VehicleType;
  service: Service;
  priceKes: number;
  paymentMethod: PaymentMethod | null;
  mpesaCode?: string | null;
  attendant: string;
  status: JobStatus;
  waterLitres: number;
  createdAt: string;
}

export interface SupplyFields {
  item: string;
  quantity: number;
  unit: SupplyUnit;
}

export type JobRecord = BaseRecord & { type: 'job' } & JobFields;
export type SupplyRecord = BaseRecord & { type: 'supply' } & SupplyFields;
export type WashRecord = JobRecord | SupplyRecord;

export type OpPayload = Partial<JobFields> & Partial<SupplyFields>;

export interface Op {
  opId: string; // generated once at enqueue time, never regenerated
  seq: number; // client queue position (Dexie auto-increment)
  deviceId: string;
  recordType: RecordType;
  recordId: string;
  type: OpType;
  payload: OpPayload;
  baseVersion: number | null; // record version the client edited on top of; null for create
  clientTimestamp: string;
}

export type ConflictPolicy = 'lww' | 'lww-flag-money' | 'tombstone';

export interface FieldConflict {
  field: string;
  winningValue: unknown;
  rejectedValue: unknown;
  policy: ConflictPolicy;
}

export interface ConflictInfo {
  winner: 'server' | 'incoming';
  winningDevice: string;
  rejectedDevice: string;
  fields: FieldConflict[];
}

export type SyncStatus = 'applied' | 'duplicate' | 'conflict_resolved' | 'rejected';

export interface SyncResponse {
  opId: string;
  status: SyncStatus;
  record: WashRecord | null; // current server record (null only if it never existed)
  conflict: ConflictInfo | null;
}

export interface ChangesResponse {
  records: WashRecord[];
  latestSeq: number;
}

export interface ConflictLogEntry {
  id: number;
  recordId: string;
  recordType: RecordType;
  field: string;
  winningValue: unknown;
  rejectedValue: unknown;
  winningDevice: string;
  rejectedDevice: string;
  policy: ConflictPolicy;
  createdAt: string;
}
