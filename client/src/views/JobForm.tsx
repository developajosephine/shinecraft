import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { JOB_STATUSES, can, type JobRecord, type JobStatus, type Service, type VehicleType } from '@washlog/shared';
import { db } from '../db';
import { go, useCatalog, useRole } from '../hooks';
import { PRICE_PRESETS, SERVICE_PRICE, STATUS_LABEL, VEHICLE_WATER, fieldErrors } from '../labels';
import { createRecord, deleteRecord, updateRecord } from '../store';
import { toast } from '../toast';
import { Icon, Sheet, Tiles } from '../ui';

interface Props {
  id?: string; // undefined = new job
  deviceName: string;
  onChanged: () => void;
}

type Payment = '' | 'cash' | 'mpesa';

export function JobForm({ id, deviceName, onChanged }: Props) {
  const role = useRole(); // before any early return: hooks must run in the same order every render
  // Names and suggested price / water: the server's lookup tables when synced, built-in values otherwise.
  const catalog = useCatalog();
  const priceOf = (s: Service) => catalog.services.find((e) => e.code === s)?.defaultPriceKes ?? SERVICE_PRICE[s];
  const waterOf = (v: VehicleType) => catalog.vehicleTypes.find((e) => e.code === v)?.defaultWaterLitres ?? VEHICLE_WATER[v];
  const existing = useLiveQuery(
    async () => (id ? (((await db.records.get(id)) as JobRecord | undefined) ?? null) : null),
    [id],
  );
  const [form, setForm] = useState({
    plate: '',
    vehicleType: 'saloon' as VehicleType,
    service: 'body' as Service,
    priceKes: String(SERVICE_PRICE.body),
    paymentMethod: '' as Payment,
    mpesaCode: '',
    attendant: deviceName,
    waterLitres: String(VEHICLE_WATER.saloon),
  });
  // On a new job the price follows the service and the water follows the vehicle, until edited by hand.
  const touched = useRef({ price: false, water: false });
  const [newStatus, setNewStatus] = useState<JobStatus>('waiting');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Fill the form once when an existing job loads.
  const loadedId = existing?.id;
  useEffect(() => {
    if (!existing) return;
    setForm({
      plate: existing.plate,
      vehicleType: existing.vehicleType,
      service: existing.service,
      priceKes: String(existing.priceKes),
      paymentMethod: existing.paymentMethod ?? '',
      mpesaCode: existing.mpesaCode ?? '',
      attendant: existing.attendant,
      waterLitres: String(existing.waterLitres),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);

  // A new job: when the catalog arrives (or changes), refresh the suggestions not yet edited by hand.
  useEffect(() => {
    if (id) return;
    setForm((f) => ({
      ...f,
      priceKes: touched.current.price ? f.priceKes : String(priceOf(f.service)),
      waterLitres: touched.current.water ? f.waterLitres : String(waterOf(f.vehicleType)),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, catalog]);

  if (id && existing === undefined) return null; // loading
  if (id && (existing === null || existing?.deleted)) {
    return (
      <main>
        <div className="empty">
          <strong>This job no longer exists</strong>
          <p>It was deleted, on this phone or another one.</p>
          <a className="btn" href="#/jobs">
            Back to jobs
          </a>
        </div>
      </main>
    );
  }

  const set = <K extends keyof typeof form>(field: K, value: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: '', _: '' }));
  };

  const pickService = (service: Service) =>
    setForm((f) => ({ ...f, service, priceKes: !existing && !touched.current.price ? String(priceOf(service)) : f.priceKes }));
  const pickVehicle = (vehicleType: VehicleType) =>
    setForm((f) => ({
      ...f,
      vehicleType,
      waterLitres: !existing && !touched.current.water ? String(waterOf(vehicleType)) : f.waterLitres,
    }));
  const bumpWater = (by: number) => {
    touched.current.water = true;
    set('waterLitres', String(Math.max(0, (Number(form.waterLitres) || 0) + by)));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (!existing && newStatus === 'paid' && !form.paymentMethod) {
      setErrors({ paymentMethod: 'Choose how the customer paid (cash or M-Pesa) before saving the job as paid.' });
      return;
    }
    const fields = {
      plate: form.plate,
      vehicleType: form.vehicleType,
      service: form.service,
      priceKes: form.priceKes.trim() === '' ? NaN : Number(form.priceKes),
      paymentMethod: form.paymentMethod || null,
      mpesaCode: form.paymentMethod === 'mpesa' ? form.mpesaCode.trim() || null : null,
      attendant: form.attendant,
      waterLitres: form.waterLitres.trim() === '' ? NaN : Number(form.waterLitres),
    };
    try {
      if (existing) {
        const changed = await updateRecord(db, existing.id, fields);
        toast(changed ? `${existing.plate} saved` : 'No changes to save', changed ? 'ok' : 'info');
      } else {
        await createRecord(db, 'job', { ...fields, status: newStatus, createdAt: new Date().toISOString() });
        toast('Job saved');
      }
      onChanged();
      go('jobs');
    } catch (err) {
      const found = fieldErrors(err);
      setErrors(found);
      const first = Object.keys(found).find((k) => k !== '_');
      const input = first ? document.getElementById(`f-${first}`) : null;
      input?.focus();
      input?.scrollIntoView({ block: 'center' }); // focus alone does not scroll if the field already had focus
    }
  };

  /** Status steps on an existing job apply immediately, as their own queued change. */
  const pickStatus = async (status: JobStatus) => {
    if (!existing) return setNewStatus(status);
    // A paid job always records how it was paid, so the payment method is never left empty.
    const method = form.paymentMethod || existing.paymentMethod;
    if (status === 'paid' && !method) {
      setErrors({ paymentMethod: 'Choose how the customer paid (cash or M-Pesa) under Payment, then mark the job paid.' });
      document.getElementById('f-paymentMethod')?.scrollIntoView({ block: 'center' });
      return;
    }
    const changes =
      status === 'paid'
        ? { status, paymentMethod: method, mpesaCode: method === 'mpesa' ? (form.paymentMethod ? form.mpesaCode.trim().toUpperCase() || null : existing.mpesaCode ?? null) : null }
        : { status };
    try {
      if (await updateRecord(db, existing.id, changes)) {
        toast(`${existing.plate}: ${STATUS_LABEL[status].toLowerCase()}`);
        onChanged();
      }
    } catch (err) {
      setErrors(fieldErrors(err));
    }
  };

  const remove = async () => {
    if (!existing) return;
    await deleteRecord(db, existing.id);
    toast(`${existing.plate} deleted`);
    onChanged();
    go('jobs');
  };

  const canPay = can(role, 'takePayment');
  const canPrice = !existing || can(role, 'changePrice');
  const canReassign = can(role, 'reassignJob');
  const status = existing ? existing.status : newStatus;
  const statusIndex = JOB_STATUSES.indexOf(status);
  const err = (field: string) => errors[field] || '';

  return (
    <>
      <header className="topbar formbar">
        <a className="icon-btn" href="#/jobs" aria-label="Back to jobs">
          <Icon name="back" size={22} />
        </a>
        <h1>{existing ? `Edit ${existing.plate}` : 'Add car'}</h1>
        {existing && can(role, 'deleteRecords') && (
          <button className="icon-btn danger" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${existing.plate}`}>
            <Icon name="trash" size={20} />
          </button>
        )}
      </header>

      <main className="has-savebar">
        <form onSubmit={save} className="form" id="job-form" noValidate>
          <fieldset className="tiles">
            <legend>Status{existing && <span className="hint-inline"> — tap to change now</span>}</legend>
            <ol className="steps">
              {JOB_STATUSES.map((s, i) => (
                <li key={s} className={i < statusIndex ? 'past' : i === statusIndex ? 'current' : ''}>
                  <button type="button" onClick={() => pickStatus(s)} disabled={s === 'paid' && !canPay} aria-current={i === statusIndex ? 'step' : undefined}>
                    <span className="step-dot">{i < statusIndex ? <Icon name="check" size={14} /> : i + 1}</span>
                    {STATUS_LABEL[s]}
                  </button>
                </li>
              ))}
            </ol>
          </fieldset>

          <div className={`field ${err('plate') ? 'invalid' : ''}`}>
            <label htmlFor="f-plate">Number plate</label>
            <input
              id="f-plate"
              className="plate-input"
              value={form.plate}
              onChange={(e) => set('plate', e.target.value)}
              placeholder="KDA 123A"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={16}
              autoFocus={!existing}
            />
            {err('plate') && <p className="field-error">{err('plate')}</p>}
          </div>

          <Tiles
            label="Vehicle"
            columns={3}
            value={form.vehicleType}
            onChange={pickVehicle}
            options={catalog.vehicleTypes.map((v) => ({ value: v.code, label: v.label }))}
          />

          <Tiles
            label="Service"
            columns={2}
            value={form.service}
            onChange={pickService}
            options={catalog.services.map((s) => ({ value: s.code, label: s.label, hint: `usually KES ${s.defaultPriceKes.toLocaleString()}` }))}
          />

          <div className={`field ${err('priceKes') ? 'invalid' : ''}`}>
            <label htmlFor="f-priceKes">Price</label>
            <div className="affix">
              <span>KES</span>
              <input
                id="f-priceKes"
                value={form.priceKes}
                onChange={(e) => {
                  touched.current.price = true;
                  set('priceKes', e.target.value);
                }}
                inputMode="numeric"
                disabled={!canPrice}
              />
            </div>
            <div className="presets" role="group" aria-label="Quick prices">
              {PRICE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p}
                  className={`preset ${Number(form.priceKes) === p ? 'on' : ''}`}
                  disabled={!canPrice}
                  onClick={() => {
                    touched.current.price = true;
                    set('priceKes', String(p));
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
            {err('priceKes') && <p className="field-error">{err('priceKes')}</p>}
          </div>

          <div className={`field ${err('waterLitres') ? 'invalid' : ''}`}>
            <label htmlFor="f-waterLitres">Water used</label>
            <div className="stepper-field">
              <button type="button" className="btn square" onClick={() => bumpWater(-5)} aria-label="5 litres less">
                <Icon name="minus" />
              </button>
              <div className="affix">
                <input
                  id="f-waterLitres"
                  value={form.waterLitres}
                  onChange={(e) => {
                    touched.current.water = true;
                    set('waterLitres', e.target.value);
                  }}
                  inputMode="decimal"
                />
                <span>litres</span>
              </div>
              <button type="button" className="btn square" onClick={() => bumpWater(5)} aria-label="5 litres more">
                <Icon name="plus" />
              </button>
            </div>
            {err('waterLitres') && <p className="field-error">{err('waterLitres')}</p>}
          </div>

          {!canPay && <p className="hint">Payment is recorded by the cashier or manager.</p>}
          {canPay && (
            <div id="f-paymentMethod" className={err('paymentMethod') ? 'invalid' : ''}>
              <Tiles
                label="Payment"
                columns={3}
                value={form.paymentMethod}
                onChange={(v) => set('paymentMethod', v)}
                options={[
                  { value: '', label: 'Not paid yet' },
                  { value: 'cash', label: 'Cash' },
                  { value: 'mpesa', label: 'M-Pesa' },
                ]}
              />
              {err('paymentMethod') && <p className="field-error">{err('paymentMethod')}</p>}
            </div>
          )}

          {canPay && form.paymentMethod === 'mpesa' && (
            <div className={`field ${err('mpesaCode') ? 'invalid' : ''}`}>
              <label htmlFor="f-mpesaCode">M-Pesa code (optional)</label>
              <input
                id="f-mpesaCode"
                value={form.mpesaCode}
                onChange={(e) => set('mpesaCode', e.target.value)}
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={32}
              />
              {err('mpesaCode') && <p className="field-error">{err('mpesaCode')}</p>}
            </div>
          )}

          <div className={`field ${err('attendant') ? 'invalid' : ''}`}>
            <label htmlFor="f-attendant">Attendant</label>
            <input id="f-attendant" value={form.attendant} onChange={(e) => set('attendant', e.target.value)} maxLength={60} disabled={!canReassign} />
            {err('attendant') && <p className="field-error">{err('attendant')}</p>}
          </div>

          {err('_') && <p className="field-error">{err('_')}</p>}
        </form>
      </main>

      <div className="savebar">
        <button className="btn primary big" type="submit" form="job-form">
          {existing ? 'Save changes' : 'Save job'}
        </button>
      </div>

      {confirmDelete && existing && (
        <Sheet title={`Delete ${existing.plate}?`} onClose={() => setConfirmDelete(false)}>
          <p className="muted">
            The job is removed from every phone after the next sync. This cannot be undone, and edits made to it on other
            phones will be rejected.
          </p>
          <div className="pay-options">
            <button className="btn danger big" onClick={remove}>
              Delete job
            </button>
            <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
              Keep job
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
