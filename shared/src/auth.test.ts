import { describe, expect, it } from 'vitest';
import { authorizeOp, can, loginSchema, userCreateSchema } from './index';

const job = (type: 'create' | 'update' | 'delete', payload: Record<string, unknown>) => ({ type, recordType: 'job' as const, payload });

describe('authorizeOp', () => {
  it('attendants can add jobs and move them up to done', () => {
    expect(authorizeOp('attendant', job('create', { plate: 'KDA 123A', priceKes: 300, status: 'waiting', paymentMethod: null }))).toEqual([]);
    expect(authorizeOp('attendant', job('update', { status: 'washing' }))).toEqual([]);
    expect(authorizeOp('attendant', job('update', { status: 'done', waterLitres: 55 }))).toEqual([]);
  });

  it('attendants cannot touch money, reassign, reopen paid jobs or delete', () => {
    expect(authorizeOp('attendant', job('update', { status: 'paid' }))).toHaveLength(1);
    expect(authorizeOp('attendant', job('update', { paymentMethod: 'cash' }))).toHaveLength(1);
    expect(authorizeOp('attendant', job('update', { priceKes: 1 }))).toHaveLength(1);
    expect(authorizeOp('attendant', job('update', { attendant: 'Someone else' }))).toHaveLength(1);
    expect(authorizeOp('attendant', job('update', { status: 'done' }), { status: 'paid' })).toHaveLength(1);
    expect(authorizeOp('attendant', job('delete', {}))).toHaveLength(1);
    expect(authorizeOp('attendant', job('create', { status: 'paid', paymentMethod: 'cash' })).length).toBeGreaterThanOrEqual(2);
  });

  it('cashiers can take payment and change prices but not delete', () => {
    expect(authorizeOp('cashier', job('update', { status: 'paid', paymentMethod: 'mpesa', mpesaCode: 'SYNTH1', priceKes: 450 }))).toEqual([]);
    expect(authorizeOp('cashier', job('delete', {}))).toHaveLength(1);
  });

  it('managers can do everything; anyone can edit supplies but only managers remove them', () => {
    expect(authorizeOp('manager', job('delete', {}))).toEqual([]);
    expect(authorizeOp('attendant', { type: 'update', recordType: 'supply', payload: { quantity: 3 } })).toEqual([]);
    expect(authorizeOp('cashier', { type: 'delete', recordType: 'supply', payload: {} })).toHaveLength(1);
  });

  it('capabilities follow the role table', () => {
    expect(can('attendant', 'takePayment')).toBe(false);
    expect(can('cashier', 'takePayment')).toBe(true);
    expect(can('cashier', 'manageUsers')).toBe(false);
    expect(can('manager', 'manageUsers')).toBe(true);
  });
});

describe('auth schemas', () => {
  it('accepts a 4–8 digit PIN and rejects anything else', () => {
    expect(userCreateSchema.safeParse({ name: 'Amani', role: 'attendant', pin: '2468' }).success).toBe(true);
    expect(userCreateSchema.safeParse({ name: 'Amani', role: 'attendant', pin: '12' }).success).toBe(false);
    expect(userCreateSchema.safeParse({ name: 'Amani', role: 'owner', pin: '2468' }).success).toBe(false);
    expect(loginSchema.safeParse({ name: 'Amani', pin: '2468', deviceId: 'd', extra: 1 }).success).toBe(false);
  });
});
