import { z } from 'zod';
import {
  JOB_STATUSES,
  OP_TYPES,
  PAYMENT_METHODS,
  RECORD_TYPES,
  SERVICES,
  SUPPLY_UNITS,
  VEHICLE_TYPES,
  type JobFields,
  type Op,
  type RecordType,
  type SupplyFields,
} from './types';

/** "kda 123a " -> "KDA 123A" */
export function normalisePlate(plate: string): string {
  return plate.trim().toUpperCase().replace(/\s+/g, ' ');
}

const isoDateTime = z.iso.datetime({ offset: true });

export const jobFieldsSchema = z.strictObject({
  plate: z.string().trim().min(1).max(16).transform(normalisePlate),
  vehicleType: z.enum(VEHICLE_TYPES),
  service: z.enum(SERVICES),
  priceKes: z.number().int().min(0).max(1_000_000),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  mpesaCode: z.string().trim().max(32).nullable().optional(),
  attendant: z.string().trim().min(1).max(60),
  status: z.enum(JOB_STATUSES),
  waterLitres: z.number().min(0).max(100_000),
  createdAt: isoDateTime,
});

export const supplyFieldsSchema = z.strictObject({
  item: z.string().trim().min(1).max(60),
  quantity: z.number().min(0).max(1_000_000),
  unit: z.enum(SUPPLY_UNITS),
});

const opEnvelopeSchema = z.strictObject({
  opId: z.uuid(),
  seq: z.number().int().min(0),
  deviceId: z.string().min(1).max(100),
  recordType: z.enum(RECORD_TYPES),
  recordId: z.uuid(),
  type: z.enum(OP_TYPES),
  payload: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().min(0).nullable(),
  clientTimestamp: isoDateTime,
});

export type ParseResult<T> = { success: true; data: T } | { success: false; errors: string[] };

function reasons(error: z.ZodError, prefix = ''): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
    return `${path || '(root)'}: ${issue.message}`;
  });
}

/** Validate (and normalise) the fields of a record. `partial` = update payload. */
export function parseFields(
  recordType: RecordType,
  input: unknown,
  partial: boolean,
  prefix = '',
): ParseResult<Partial<JobFields> & Partial<SupplyFields>> {
  const result =
    recordType === 'job'
      ? (partial ? jobFieldsSchema.partial() : jobFieldsSchema).safeParse(input)
      : (partial ? supplyFieldsSchema.partial() : supplyFieldsSchema).safeParse(input);
  if (!result.success) return { success: false, errors: reasons(result.error, prefix) };
  return { success: true, data: result.data };
}

/** Validate one sync operation. Used by the server on every push and by the client before enqueueing. */
export function parseOp(input: unknown): ParseResult<Op> {
  const envelope = opEnvelopeSchema.safeParse(input);
  if (!envelope.success) return { success: false, errors: reasons(envelope.error) };
  const op = envelope.data;

  if (op.type === 'delete') {
    if (op.baseVersion === null) return { success: false, errors: ['baseVersion: required for delete'] };
    return { success: true, data: { ...op, payload: {} } };
  }
  if (op.type === 'update' && op.baseVersion === null) {
    return { success: false, errors: ['baseVersion: required for update'] };
  }

  const fields = parseFields(op.recordType, op.payload, op.type === 'update', 'payload');
  if (!fields.success) return fields;
  if (op.type === 'update' && Object.keys(fields.data).length === 0) {
    return { success: false, errors: ['payload: update must change at least one field'] };
  }
  return { success: true, data: { ...op, payload: fields.data } };
}
