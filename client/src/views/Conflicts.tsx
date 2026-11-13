import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalConflict } from '../db';
import { formatTime, shortId } from '../hooks';
import { FIELD_LABEL, formatValue } from '../labels';
import { Empty, Icon } from '../ui';

export function Conflicts({ deviceId, onRefresh }: { deviceId: string; onRefresh: () => void }) {
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), [], [] as LocalConflict[]);
  const names = useLiveQuery(
    async () => {
      const map = new Map<string, string>();
      for (const r of await db.records.toArray()) map.set(r.id, r.type === 'job' ? r.plate : r.item);
      return map;
    },
    [],
    new Map<string, string>(),
  );
  const device = (id: string) => (id === deviceId ? 'this phone' : id === 'seed-script' ? 'demo data' : `phone ${shortId(id)}`);
  const sorted = [...conflicts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section>
      <div className="row between section-head">
        <h2>Conflicts</h2>
        <button className="btn small" onClick={onRefresh}>
          <Icon name="sync" size={16} /> Refresh
        </button>
      </div>
      <p className="muted">
        When two phones change the same thing, the later change is kept. Nothing is hidden: every value that was not kept is
        listed here. Money is highlighted so someone checks it.
      </p>

      {sorted.length === 0 ? (
        <Empty icon="check" title="No conflicts">
          Phones have not disagreed about any record.
        </Empty>
      ) : (
        <ul className="list">
          {sorted.map((c) => {
            const money = c.policy === 'lww-flag-money';
            const tombstone = c.policy === 'tombstone';
            return (
              <li key={c.id} className={`conflict-card ${money ? 'money' : ''}`}>
                <div className="conflict-head">
                  <div>
                    <span className="plate">{names.get(c.recordId) ?? `Record ${shortId(c.recordId)}`}</span>
                    <span className="conflict-field">{tombstone ? 'Edited after it was deleted' : (FIELD_LABEL[c.field] ?? c.field)}</span>
                  </div>
                  {money && <span className="chip st-money">Check money</span>}
                  {tombstone && <span className="chip st-waiting">Stays deleted</span>}
                </div>
                <div className="versus">
                  <div className="kept">
                    <span className="versus-label">
                      <Icon name="check" size={14} /> Kept · {device(c.winningDevice)}
                    </span>
                    <b>{tombstone ? 'Deleted' : formatValue(c.field, c.winningValue)}</b>
                  </div>
                  <div className="rejected">
                    <span className="versus-label">Not kept · {device(c.rejectedDevice)}</span>
                    <s>{formatValue(c.field, c.rejectedValue)}</s>
                  </div>
                </div>
                <div className="muted small">{formatTime(c.createdAt)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
