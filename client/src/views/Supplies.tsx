import { useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SUPPLY_UNITS, can, type SupplyRecord, type SupplyUnit } from '@washlog/shared';
import { db } from '../db';
import { useRole } from '../hooks';
import { UNIT_LABEL, UNIT_STEP, cap, fieldErrors } from '../labels';
import { createRecord, deleteRecord, updateRecord } from '../store';
import { toast } from '../toast';
import { Empty, Icon, Sheet, SyncBadge, Tiles } from '../ui';

type LocalSupply = SupplyRecord & { pending: boolean };

/** Rough "running low" rule so the items that need restocking stand out. */
const isLow = (s: SupplyRecord) => (s.unit === 'pct' ? s.quantity < 20 : s.unit === 'litres' ? s.quantity <= 100 : s.quantity <= 2);

function AddSheet({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState<SupplyUnit>('bottles');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createRecord(db, 'supply', { item, quantity: quantity.trim() === '' ? NaN : Number(quantity), unit });
      toast(`${item.trim()} added`);
      onChanged();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
    }
  };

  return (
    <Sheet title="Add supply item" onClose={onClose}>
      <form onSubmit={add} className="form" noValidate>
        <div className={`field ${errors.item ? 'invalid' : ''}`}>
          <label htmlFor="s-item">Item</label>
          <input id="s-item" autoFocus value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Car shampoo" maxLength={60} />
          {errors.item && <p className="field-error">{errors.item}</p>}
        </div>
        <Tiles
          label="Measured in"
          columns={4}
          value={unit}
          onChange={setUnit}
          options={SUPPLY_UNITS.map((u) => ({ value: u, label: u === 'pct' ? '% full' : cap(u) }))}
        />
        <div className={`field ${errors.quantity ? 'invalid' : ''}`}>
          <label htmlFor="s-qty">Quantity now</label>
          <div className="affix">
            <input id="s-qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" />
            <span>{UNIT_LABEL[unit]}</span>
          </div>
          {errors.quantity && <p className="field-error">{errors.quantity}</p>}
        </div>
        {errors._ && <p className="field-error">{errors._}</p>}
        <button className="btn primary big" type="submit">
          Add item
        </button>
        <button className="btn ghost" type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </Sheet>
  );
}

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
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<LocalSupply | null>(null);
  const canDelete = can(useRole(), 'deleteRecords');

  const change = async (s: LocalSupply, by: number) => {
    const max = s.unit === 'pct' ? 100 : Infinity;
    const quantity = Math.min(max, Math.max(0, s.quantity + by));
    if (await updateRecord(db, s.id, { quantity })) onChanged();
  };

  const remove = async () => {
    if (!removing) return;
    await deleteRecord(db, removing.id);
    toast(`${removing.item} removed`);
    setRemoving(null);
    onChanged();
  };

  const low = supplies.filter(isLow).length;

  return (
    <section>
      <div className="row between section-head">
        <h2>Supplies</h2>
        {low > 0 && <span className="badge conflict">{low} running low</span>}
      </div>

      {supplies.length === 0 ? (
        <Empty icon="box" title="No supplies yet">
          Add the water tank, shampoo and anything else you want to keep an eye on.
        </Empty>
      ) : (
        <ul className="list">
          {supplies.map((s) => {
            const step = UNIT_STEP[s.unit];
            return (
              <li key={s.id} className={`supply ${isLow(s) ? 'low' : ''}`}>
                <div className="supply-head">
                  <div>
                    <div className="supply-name">{s.item}</div>
                    <div className="job-tags">
                      {isLow(s) && <span className="chip st-low">Running low</span>}
                      <SyncBadge record={s} conflicted={conflicted.has(s.id)} />
                    </div>
                  </div>
                  {canDelete && (
                    <button className="icon-btn" onClick={() => setRemoving(s)} aria-label={`Remove ${s.item}`}>
                      <Icon name="trash" size={18} />
                    </button>
                  )}
                </div>
                {s.unit === 'pct' && (
                  <div className="level" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, s.quantity)}%` }} />
                  </div>
                )}
                <div className="supply-controls">
                  <button className="btn square" disabled={s.quantity <= 0} onClick={() => change(s, -step)} aria-label={`${step} less ${s.item}`}>
                    <Icon name="minus" />
                  </button>
                  <div className="supply-qty">
                    <b>{s.quantity.toLocaleString()}</b> {UNIT_LABEL[s.unit]}
                  </div>
                  <button
                    className="btn square"
                    disabled={s.unit === 'pct' && s.quantity >= 100}
                    onClick={() => change(s, step)}
                    aria-label={`${step} more ${s.item}`}
                  >
                    <Icon name="plus" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button className="fab" onClick={() => setAdding(true)}>
        <Icon name="plus" size={22} /> Add item
      </button>

      {adding && <AddSheet onClose={() => setAdding(false)} onChanged={onChanged} />}
      {removing && (
        <Sheet title={`Remove ${removing.item}?`} onClose={() => setRemoving(null)}>
          <p className="muted">It is removed from every phone after the next sync.</p>
          <div className="pay-options">
            <button className="btn danger big" onClick={remove}>
              Remove item
            </button>
            <button className="btn ghost" onClick={() => setRemoving(null)}>
              Keep item
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
