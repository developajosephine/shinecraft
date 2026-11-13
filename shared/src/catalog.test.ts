import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, mergeCatalog } from './catalog';
import { SERVICES, SUPPLY_UNITS, VEHICLE_TYPES } from './types';

describe('catalog', () => {
  it('defaults cover exactly the codes the schema accepts', () => {
    expect(DEFAULT_CATALOG.vehicleTypes.map((e) => e.code)).toEqual([...VEHICLE_TYPES]);
    expect(DEFAULT_CATALOG.services.map((e) => e.code)).toEqual([...SERVICES]);
    expect(DEFAULT_CATALOG.supplyUnits.map((e) => e.code)).toEqual([...SUPPLY_UNITS]);
  });

  it('nothing or garbage gives the defaults', () => {
    expect(mergeCatalog(undefined)).toEqual(DEFAULT_CATALOG);
    expect(mergeCatalog('nope')).toEqual(DEFAULT_CATALOG);
    expect(mergeCatalog({ services: 'x', vehicleTypes: [null, 3] })).toEqual(DEFAULT_CATALOG);
  });

  it('valid overrides win, bad values fall back, unknown codes are dropped', () => {
    const merged = mergeCatalog({
      services: [
        { code: 'full', label: 'Full valet', defaultPriceKes: 750 },
        { code: 'engine', label: '', defaultPriceKes: -5 },
        { code: 'polish', label: 'Polish', defaultPriceKes: 900 },
      ],
      vehicleTypes: [{ code: 'suv', defaultWaterLitres: 70 }],
    });
    expect(merged.services.map((s) => s.code)).toEqual([...SERVICES]);
    expect(merged.services[1]).toEqual({ code: 'full', label: 'Full valet', defaultPriceKes: 750 });
    expect(merged.services[3]).toEqual(DEFAULT_CATALOG.services[3]);
    expect(merged.vehicleTypes[1]).toEqual({ code: 'suv', label: 'SUV', defaultWaterLitres: 70 });
  });
});
