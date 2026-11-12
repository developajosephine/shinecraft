/**
 * SYNTHETIC demo data: 3 attendants, 25 jobs, 5 supplies.
 * Plates, names and M-Pesa codes are invented - no real people or vehicles.
 * Goes through the same handleOp() path as real sync, with fixed op IDs, so it is safe to re-run.
 */
import { parseOp, type Op } from '@washlog/shared';
import type { Pool } from './db';
import { handleOp } from './syncService';

const DEVICE = 'seed-script';
const ATTENDANTS = ['Attendant Amani (demo)', 'Attendant Baraka (demo)', 'Attendant Chiku (demo)'];
const VEHICLES = ['saloon', 'suv', 'matatu', 'motorbike', 'pickup'] as const;
const SERVICES = ['body', 'full', 'interior', 'engine'] as const;
const STATUSES = ['paid', 'paid', 'done', 'washing', 'waiting'] as const;
const PRICES = { body: 300, full: 600, interior: 400, engine: 500 };
const LITRES = { saloon: 40, suv: 60, matatu: 90, motorbike: 15, pickup: 55 };
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Deterministic, valid UUID v4 strings: kind 1 = op, 2 = job, 3 = supply. */
const uuid = (kind: number, n: number) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function buildOps(): Op[] {
  const ops: Op[] = [];
  const now = Date.now();

  for (let i = 0; i < 25; i++) {
    const vehicleType = VEHICLES[i % VEHICLES.length];
    const service = SERVICES[(i * 3) % SERVICES.length];
    const status = STATUSES[i % STATUSES.length];
    const paid = status === 'paid';
    const mpesa = paid && i % 2 === 0;
    // Kenyan-format plate, e.g. "KDZ 107H" — generated, not real.
    const plate = `KD${LETTERS[(i * 7) % LETTERS.length]} ${String(100 + i * 7).slice(-3)}${LETTERS[(i * 5 + 3) % LETTERS.length]}`;
    const at = new Date(now - i * 9 * 60_000).toISOString();
    ops.push({
      opId: uuid(1, i + 1),
      seq: i + 1,
      deviceId: DEVICE,
      recordType: 'job',
      recordId: uuid(2, i + 1),
      type: 'create',
      payload: {
        plate,
        vehicleType,
        service,
        priceKes: PRICES[service] + (vehicleType === 'matatu' ? 200 : 0),
        paymentMethod: paid ? (mpesa ? 'mpesa' : 'cash') : null,
        mpesaCode: mpesa ? `SYNTH${String(i).padStart(5, '0')}` : null,
        attendant: ATTENDANTS[i % ATTENDANTS.length],
        status,
        waterLitres: LITRES[vehicleType] + (service === 'full' ? 20 : 0),
        createdAt: at,
      },
      baseVersion: null,
      clientTimestamp: at,
    });
  }

  const SUPPLIES = [
    ['Water tank', 850, 'litres'],
    ['Car shampoo', 12, 'bottles'],
    ['Wax polish', 6, 'bottles'],
    ['Microfibre cloths', 4, 'kg'],
    ['Tyre shine', 65, 'pct'],
  ] as const;

  SUPPLIES.forEach(([item, quantity, unit], i) => {
    ops.push({
      opId: uuid(1, 100 + i),
      seq: 100 + i,
      deviceId: DEVICE,
      recordType: 'supply',
      recordId: uuid(3, i + 1),
      type: 'create',
      payload: { item, quantity, unit },
      baseVersion: null,
      clientTimestamp: new Date(now).toISOString(),
    });
  });
  return ops;
}

/** Insert the demo data (idempotent). Returns how many ops ended in each status. */
export async function seedDemoData(pool: Pool): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (const op of buildOps()) {
    const parsed = parseOp(op);
    if (!parsed.success) throw new Error(`Seed op invalid: ${parsed.errors.join('; ')}`);
    const { status } = await handleOp(pool, parsed.data);
    tally[status] = (tally[status] ?? 0) + 1;
  }
  return tally;
}
