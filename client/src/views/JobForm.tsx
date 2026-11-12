import { useEffect, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { JOB_STATUSES, SERVICES, VEHICLE_TYPES, type JobRecord, type JobStatus } from '@washlog/shared';
import { db } from '../db';
import { go } from '../hooks';
import { createRecord, deleteRecord, updateRecord } from '../store';

interface Props {
  id?: string; // undefined = new job
  deviceName: string;
  onChanged: () => void;
}

export function JobForm({ id, deviceName, onChanged }: Props) {
  const existing = useLiveQuery(
    async () => (id ? (((await db.records.get(id)) as JobRecord | undefined) ?? null) : null),
    [id],
  );
  const [form, setForm] = useState({
    plate: '',
    vehicleType: 'saloon',
    service: 'body',
    priceKes: '300',
    paymentMethod: '',
    mpesaCode: '',
    attendant: deviceName,
    waterLitres: '40',
  });
  const [newStatus, setNewStatus] = useState<JobStatus>('waiting');
  const [error, setError] = useState('');
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

  if (id && existing === undefined) return null; // loading
  if (id && (existing === null || existing?.deleted)) {
    return (
      <section>
        <p className="muted">This job no longer exists (it was deleted).</p>
        <button onClick={() => go('jobs')}>Back to jobs</button>
      </section>
    );
  }

  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [field]: e.target.value });

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
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
      if (existing) await updateRecord(db, existing.id, fields);
      else await createRecord(db, 'job', { ...fields, status: newStatus, createdAt: new Date().toISOString() });
      onChanged();
      go('jobs');
    } catch (err) {
      fail(err);
    }
  };

  /** Status buttons on an existing job apply immediately, as their own queued op. */
  const pickStatus = async (status: JobStatus) => {
    if (!existing) return setNewStatus(status);
    try {
      if (await updateRecord(db, existing.id, { status })) onChanged();
    } catch (err) {
      fail(err);
    }
  };

  const remove = async () => {
    if (!existing) return;
    await deleteRecord(db, existing.id);
    onChanged();
    go('jobs');
  };

  const status = existing ? existing.status : newStatus;

  return (
    <section>
      <div className="row between">
        <h2>{existing ? `Edit ${existing.plate}` : 'Add car'}</h2>
        <button className="link" onClick={() => go('jobs')}>
          Cancel
        </button>
      </div>

      <div className="field-label">Status</div>
      <div className="status-buttons">
        {JOB_STATUSES.map((s) => (
          <button key={s} type="button" className={`chip ${s} ${s === status ? 'current' : 'dim'}`} onClick={() => pickStatus(s)}>
            {s}
          </button>
        ))}
      </div>

      <form onSubmit={save} className="form">
        <label>
          Number plate
          <input value={form.plate} onChange={set('plate')} placeholder="KDA 123A" autoCapitalize="characters" maxLength={16} />
        </label>
        <div className="grid2">
          <label>
            Vehicle
            <select value={form.vehicleType} onChange={set('vehicleType')}>
              {VEHICLE_TYPES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Service
            <select value={form.service} onChange={set('service')}>
              {SERVICES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Price (KES)
            <input value={form.priceKes} onChange={set('priceKes')} inputMode="numeric" />
          </label>
          <label>
            Water (litres)
            <input value={form.waterLitres} onChange={set('waterLitres')} inputMode="decimal" />
          </label>
          <label>
            Payment
            <select value={form.paymentMethod} onChange={set('paymentMethod')}>
              <option value="">not paid yet</option>
              <option value="cash">cash</option>
              <option value="mpesa">mpesa</option>
            </select>
          </label>
          {form.paymentMethod === 'mpesa' && (
            <label>
              M-Pesa code
              <input value={form.mpesaCode} onChange={set('mpesaCode')} autoCapitalize="characters" maxLength={32} />
            </label>
          )}
        </div>
        <label>
          Attendant
          <input value={form.attendant} onChange={set('attendant')} maxLength={60} />
        </label>

        {error && <p className="error">{error}</p>}
        <button className="primary big" type="submit">
          {existing ? 'Save changes' : 'Save job'}
        </button>
      </form>

      {existing &&
        (confirmDelete ? (
          <div className="confirm">
            <span>Delete {existing.plate}? This cannot be undone.</span>
            <button className="danger" onClick={remove}>
              Yes, delete
            </button>
            <button onClick={() => setConfirmDelete(false)}>Keep</button>
          </div>
        ) : (
          <button className="danger outline" onClick={() => setConfirmDelete(true)}>
            Delete job
          </button>
        ))}
    </section>
  );
}
