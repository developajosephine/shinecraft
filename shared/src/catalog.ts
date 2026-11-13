import { SERVICES, SUPPLY_UNITS, VEHICLE_TYPES, type Service, type SupplyUnit, type VehicleType } from './types';

/**
 * Reference data: the vehicle types, services and supply units a job or supply can use, with
 * their display names and suggested defaults. The codes are fixed (they are the strict enums the
 * sync schema accepts); the names, default price and default water can be changed in the
 * database tables `vehicle_types`, `services` and `supply_units` (seeded from these values by
 * migration 004). Phones fetch them with GET /api/catalog and fall back to these when offline.
 */
export interface VehicleTypeEntry {
  code: VehicleType;
  label: string;
  defaultWaterLitres: number;
}

export interface ServiceEntry {
  code: Service;
  label: string;
  defaultPriceKes: number;
}

export interface SupplyUnitEntry {
  code: SupplyUnit;
  label: string;
}

export interface Catalog {
  vehicleTypes: VehicleTypeEntry[];
  services: ServiceEntry[];
  supplyUnits: SupplyUnitEntry[];
}

export const DEFAULT_CATALOG: Catalog = {
  vehicleTypes: [
    { code: 'saloon', label: 'Saloon', defaultWaterLitres: 40 },
    { code: 'suv', label: 'SUV', defaultWaterLitres: 60 },
    { code: 'matatu', label: 'Matatu', defaultWaterLitres: 90 },
    { code: 'motorbike', label: 'Motorbike', defaultWaterLitres: 15 },
    { code: 'pickup', label: 'Pickup', defaultWaterLitres: 55 },
  ],
  services: [
    { code: 'body', label: 'Body wash', defaultPriceKes: 300 },
    { code: 'full', label: 'Full wash', defaultPriceKes: 600 },
    { code: 'interior', label: 'Interior wash', defaultPriceKes: 400 },
    { code: 'engine', label: 'Engine wash', defaultPriceKes: 500 },
  ],
  supplyUnits: [
    { code: 'litres', label: 'litres' },
    { code: 'bottles', label: 'bottles' },
    { code: 'kg', label: 'kg' },
    { code: 'pct', label: '%' },
  ],
};

const isNonNegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const isLabel = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 60;

/**
 * Merge catalog entries from the server (or local storage) over the built-in defaults.
 * Only known codes are kept, every known code is always present, in the built-in order,
 * and any missing or malformed value falls back to the default. Never throws.
 */
export function mergeCatalog(input: unknown): Catalog {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const byCode = (list: unknown): Map<string, Record<string, unknown>> => {
    const map = new Map<string, Record<string, unknown>>();
    if (Array.isArray(list)) {
      for (const e of list) if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') map.set((e as { code: string }).code, e as Record<string, unknown>);
    }
    return map;
  };
  const vehicles = byCode(src.vehicleTypes);
  const services = byCode(src.services);
  const units = byCode(src.supplyUnits);
  return {
    vehicleTypes: DEFAULT_CATALOG.vehicleTypes.map((d) => {
      const e = vehicles.get(d.code);
      return {
        code: d.code,
        label: isLabel(e?.label) ? e.label : d.label,
        defaultWaterLitres: isNonNegative(e?.defaultWaterLitres) ? e.defaultWaterLitres : d.defaultWaterLitres,
      };
    }),
    services: DEFAULT_CATALOG.services.map((d) => {
      const e = services.get(d.code);
      return {
        code: d.code,
        label: isLabel(e?.label) ? e.label : d.label,
        defaultPriceKes: isNonNegative(e?.defaultPriceKes) && Number.isInteger(e.defaultPriceKes) ? e.defaultPriceKes : d.defaultPriceKes,
      };
    }),
    supplyUnits: DEFAULT_CATALOG.supplyUnits.map((d) => {
      const e = units.get(d.code);
      return { code: d.code, label: isLabel(e?.label) ? e.label : d.label };
    }),
  };
}

// The defaults must cover exactly the codes the schema accepts.
const sameCodes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c === b[i]);
if (
  !sameCodes(DEFAULT_CATALOG.vehicleTypes.map((e) => e.code), VEHICLE_TYPES) ||
  !sameCodes(DEFAULT_CATALOG.services.map((e) => e.code), SERVICES) ||
  !sameCodes(DEFAULT_CATALOG.supplyUnits.map((e) => e.code), SUPPLY_UNITS)
) {
  throw new Error('DEFAULT_CATALOG is out of step with the enums in types.ts');
}
