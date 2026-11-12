import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalConflict } from '../db';
import { formatTime, shortId } from '../hooks';

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export function Conflicts({ deviceId, onRefresh }: { deviceId: string; onRefresh: () => void }) {
  const conflicts = useLiveQuery(() => db.conflicts.orderBy('id').reverse().toArray(), [], [] as LocalConflict[]);
  const labels = useLiveQuery(
    async () => {
      const map = new Map<string, string>();
      for (const r of await db.records.toArray()) map.set(r.id, r.type === 'job' ? r.plate : r.item);
      return map;
    },
    [],
    new Map<string, string>(),
  );
  const device = (id: string) => (id === deviceId ? 'this phone' : shortId(id));
  const sorted = [...conflicts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section>
      <div className="row between">
        <h2>Conflicts</h2>
        <button className="link" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <p className="muted">
        When two phones change the same record, the later change wins. Nothing is hidden: every rejected value is listed
        here. Money fields are highlighted.
      </p>
      {sorted.length === 0 && <p className="muted">No conflicts recorded.</p>}
      <ul className="list">
        {sorted.map((c) => (
          <li key={c.id} className={`card conflict-card ${c.policy === 'lww-flag-money' ? 'money' : ''}`}>
            <div className="row between">
              <span className="plate">
                {labels.get(c.recordId) ?? shortId(c.recordId)} · {c.policy === 'tombstone' ? 'edit after delete' : c.field}
              </span>
              {c.policy === 'lww-flag-money' && <span className="badge conflict">money</span>}
              {c.policy === 'tombstone' && <span className="badge conflict">deleted wins</span>}
            </div>
            <div className="versus">
              <div>
                <span className="muted">Kept ({device(c.winningDevice)})</span>
                <b>{show(c.winningValue)}</b>
              </div>
              <div>
                <span className="muted">Rejected ({device(c.rejectedDevice)})</span>
                <s>{show(c.rejectedValue)}</s>
              </div>
            </div>
            <div className="muted small">
              {c.recordType} · {formatTime(c.createdAt)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
