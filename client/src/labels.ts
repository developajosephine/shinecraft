import { DEFAULT_CATALOG, type JobStatus, type Service, type SupplyUnit, type VehicleType } from '@washlog/shared';
import { ValidationError } from './store';

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Built-in names and defaults (shared DEFAULT_CATALOG). Screens use useCatalog(), which prefers the server's copy. */
export const VEHICLE_LABEL = Object.fromEntries(DEFAULT_CATALOG.vehicleTypes.map((v) => [v.code, v.label])) as Record<VehicleType, string>;

export const STATUS_LABEL: Record<JobStatus, string> = {
  waiting: 'Waiting',
  washing: 'Washing',
  done: 'Done',
  paid: 'Paid',
};

/** The one-tap action that moves a job to its next status. */
export const NEXT_STEP: Record<JobStatus, { next: JobStatus; label: string } | null> = {
  waiting: { next: 'washing', label: 'Start wash' },
  washing: { next: 'done', label: 'Mark done' },
  done: { next: 'paid', label: 'Take payment' },
  paid: null,
};

/** Suggested values for a new job; the attendant can always change them. */
export const SERVICE_PRICE = Object.fromEntries(DEFAULT_CATALOG.services.map((s) => [s.code, s.defaultPriceKes])) as Record<Service, number>;
export const VEHICLE_WATER = Object.fromEntries(DEFAULT_CATALOG.vehicleTypes.map((v) => [v.code, v.defaultWaterLitres])) as Record<VehicleType, number>;
export const PRICE_PRESETS = [200, 300, 400, 500, 600, 800];

export const UNIT_LABEL = Object.fromEntries(DEFAULT_CATALOG.supplyUnits.map((u) => [u.code, u.label])) as Record<SupplyUnit, string>;
export const UNIT_STEP: Record<SupplyUnit, number> = { litres: 10, bottles: 1, kg: 1, pct: 5 };

export const FIELD_LABEL: Record<string, string> = {
  plate: 'Number plate',
  vehicleType: 'Vehicle',
  service: 'Service',
  priceKes: 'Price',
  paymentMethod: 'Payment',
  mpesaCode: 'M-Pesa code',
  attendant: 'Attendant',
  status: 'Status',
  waterLitres: 'Water used',
  createdAt: 'Created',
  item: 'Item',
  quantity: 'Quantity',
  unit: 'Unit',
};

/** Show a stored value the way a person would say it. */
export function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (field === 'priceKes') return `KES ${Number(value).toLocaleString()}`;
  if (field === 'waterLitres') return `${String(value)} litres`;
  if (field === 'paymentMethod') return value === 'mpesa' ? 'M-Pesa' : cap(String(value));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${formatValue(k, v)}`)
      .join(', ');
  }
  return field === 'mpesaCode' || field === 'plate' || field === 'attendant' || field === 'item' ? String(value) : cap(String(value));
}

const FRIENDLY: Record<string, string> = {
  plate: 'Enter the number plate, for example KDA 123A.',
  priceKes: 'Enter the price in whole shillings, 0 or more.',
  waterLitres: 'Enter the litres of water used, 0 or more.',
  attendant: 'Enter the attendant’s name.',
  mpesaCode: 'The M-Pesa code is too long (32 characters at most).',
  item: 'Enter the item name.',
  quantity: 'Enter a quantity of 0 or more.',
};

/** Turn a validation failure into one message per field ("_" = not tied to a field). */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ValidationError)) return { _: err instanceof Error ? err.message : String(err) };
  const out: Record<string, string> = {};
  for (const reason of err.reasons) {
    const field = reason.split(':')[0].trim();
    if (field in FIELD_LABEL) out[field] = FRIENDLY[field] ?? `${FIELD_LABEL[field]} is not valid.`;
    else out._ = reason;
  }
  return out;
}

export const ROLE_LABEL: Record<'attendant' | 'cashier' | 'manager', string> = { attendant: 'Attendant', cashier: 'Cashier', manager: 'Manager' };
