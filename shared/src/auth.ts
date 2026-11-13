import { z } from 'zod';
import type { Op } from './types';

export const ROLES = ['attendant', 'cashier', 'manager'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

/** What a logged-in phone keeps: enough to work offline and to call the API when online. */
export interface Session {
  token: string;
  expiresAt: string;
  user: { id: string; name: string; role: Role };
}

const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');
const userName = z.string().trim().min(1).max(60);

export const loginSchema = z.strictObject({
  name: userName,
  pin: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(100),
});

export const userCreateSchema = z.strictObject({ name: userName, role: z.enum(ROLES), pin });

export const userUpdateSchema = z
  .strictObject({ role: z.enum(ROLES), active: z.boolean(), pin })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export type Capability = 'takePayment' | 'changePrice' | 'reassignJob' | 'deleteRecords' | 'manageUsers' | 'viewAudit' | 'demoToggles';

const CAPABILITIES: Record<Role, Capability[]> = {
  attendant: [],
  cashier: ['takePayment', 'changePrice', 'reassignJob'],
  manager: ['takePayment', 'changePrice', 'reassignJob', 'deleteRecords', 'manageUsers', 'viewAudit', 'demoToggles'],
};

/** Used by the client to hide controls and by the server to guard endpoints. */
export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES[role].includes(capability);
}

/**
 * The role rules for one sync operation. Returns the reasons it is not allowed (empty = allowed).
 * The server enforces this on every op; the client uses the same function to avoid queueing
 * changes that would be refused. `current` is the record as the server has it, when it exists.
 */
export function authorizeOp(role: Role, op: Pick<Op, 'type' | 'recordType' | 'payload'>, current?: Record<string, unknown> | null): string[] {
  const reasons: string[] = [];
  if (op.type === 'delete' && !can(role, 'deleteRecords')) reasons.push('Only a manager can delete records.');
  if (op.recordType !== 'job' || op.type === 'delete') return reasons;

  const p = op.payload;
  if (!can(role, 'takePayment')) {
    if (p.status === 'paid') reasons.push('Only a cashier or manager can mark a job as paid.');
    if (p.paymentMethod != null || (p.mpesaCode != null && p.mpesaCode !== '')) {
      reasons.push('Only a cashier or manager can record a payment.');
    }
    if (current?.status === 'paid' && 'status' in p && p.status !== 'paid') {
      reasons.push('Only a cashier or manager can reopen a paid job.');
    }
  }
  if (op.type === 'update') {
    if ('priceKes' in p && !can(role, 'changePrice')) reasons.push('Only a cashier or manager can change a price.');
    if ('attendant' in p && !can(role, 'reassignJob')) reasons.push('Only a cashier or manager can change the attendant.');
  }
  return reasons;
}
