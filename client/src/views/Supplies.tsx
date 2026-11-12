import { useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SUPPLY_UNITS, type SupplyRecord } from '@washlog/shared';
import { db } from '../db';
import { createRecord, deleteRecord, updateRecord } from '../store';
import { SyncBadge } from './Jobs';

type LocalSupply = SupplyRecord & { pending: boolean };

export function Supplies({ onChanged }: { onChanged: () => void }) {
  const supplies = useLiveQuery(
    async () =>
      ((await db.records.where('type').equals('supply').toArray()).filter((r) => !r.deleted) as LocalSupply[]).sort(
        (a, b) => a.item.localeCompare(b.item),
      ),
    [],
    [] as LocalSupply[],
  );
  const conflicted = useLiveQuery(
    async () => new Set((await db.conflicts.toArray()).map((c) => c.recordId)),
    [],
    new Set<string>(),
  );
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState<string>('litres');
  const [error, setError] = useState('');

  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await createRecord(db, 'supply', { item, quantity: quantity.trim() === '' ? NaN : Number(quantity), unit });
      setItem('');
      setQuantity('1');
    });
  };

  return (
    <section>
      <h2>Supplies</h2>
      {supplies.length === 0 && <p className="muted">No supplies yet. Add one below.</p>}
      <ul className="list">
        {supplies.map((s) => (
          <li key={s.id} className="card">
            <div>
              <div className="plate">{s.item}</div>
              <SyncBadge record={s} conflicted={conflicted.has(s.id)} />
            </div>
            <div className="stepper">
              <button
                aria-label={`Decrease ${s.item}`}
                disabled={s.quantity <= 0}
                onClick={() => run(() => updateRecord(db, s.id, { quantity: Math.max(0, s.quantity - 1) }))}
              >
                −
              </button>
              <span>
                <b>{s.quantity}</b> {s.unit}
              </span>
              <button aria-label={`Increase ${s.item}`} onClick={() => run(() => updateRecord(db, s.id, { quantity: s.quantity + 1 }))}>
                +
              </button>
              <button className="link danger-text" aria-label={`Remove ${s.item}`} onClick={() => run(() => deleteRecord(db, s.id))}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h3>Add item</h3>
      <form onSubmit={add} className="form">
        <label>
          Item
          <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Car shampoo" maxLength={60} />
        </label>
        <div className="grid2">
          <label>
            Quantity
            <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" />
          </label>
          <label>
            Unit
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {SUPPLY_UNITS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">
          Add item
        </button>
      </form>
    </section>
  );
}
