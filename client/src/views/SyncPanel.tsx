import { useLiveQuery } from 'dexie-react-hooks';
import type { Op } from '@washlog/shared';
import type { LinkState } from '../App';
import { db } from '../db';
import { formatTime } from '../hooks';
import { Icon, type IconName } from '../ui';

interface Props {
  link: LinkState;
  syncing: boolean;
  onSync: () => void;
}

const VERB = { create: 'Add', update: 'Change', delete: 'Delete' } as const;

export function SyncPanel({ link, syncing, onSync }: Props) {
  const queue = useLiveQuery(() => db.opQueue.orderBy('seq').toArray(), [], [] as Op[]);
  const names = useLiveQuery(
    async () => {
      const map = new Map<string, string>();
      for (const r of await db.records.toArray()) map.set(r.id, r.type === 'job' ? r.plate : r.item);
      return map;
    },
    [],
    new Map<string, string>(),
  );
  const meta = useLiveQuery(
    async () => {
      const [lastSyncAt, lastError] = await db.meta.bulkGet(['lastSyncAt', 'lastError']);
      return { lastSyncAt: lastSyncAt?.value as string | undefined, lastError: lastError?.value as string | null };
    },
    [],
    { lastSyncAt: undefined, lastError: null },
  );

  const pending = queue.length;
  const changes = `${pending} ${pending === 1 ? 'change' : 'changes'}`;
  let tone: 'ok' | 'warn' | 'off' = 'ok';
  let icon: IconName = 'cloud';
  let title = 'Everything is synced';
  let detail = 'All changes from this phone are on the server.';
  if (link === 'off') {
    tone = 'off';
    icon = 'offline';
    title = 'You are offline';
    detail = pending ? `${changes} saved on this phone. They will be sent when the signal returns.` : 'Keep working. Changes are saved on this phone.';
  } else if (link === 'warn') {
    tone = 'warn';
    icon = 'alert';
    title = 'The last sync did not go through';
    detail = pending ? `${changes} still saved on this phone. Nothing is lost.` : 'Nothing is waiting to be sent.';
  } else if (pending) {
    tone = 'warn';
    icon = 'clock';
    title = `${changes} waiting to sync`;
    detail = 'They are saved on this phone and will be sent in order.';
  }

  return (
    <section>
      <div className={`status-card ${tone}`}>
        <span className="status-icon">
          <Icon name={icon} size={30} />
        </span>
        <div>
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
      </div>

      <button className="btn primary big" onClick={onSync} disabled={syncing}>
        <Icon name="sync" /> {syncing ? 'Syncing…' : 'Sync now'}
      </button>

      <dl className="facts">
        <dt>Last successful sync</dt>
        <dd>{meta.lastSyncAt ? formatTime(meta.lastSyncAt) : 'Never'}</dd>
        <dt>Waiting to send</dt>
        <dd>{changes}</dd>
        {meta.lastError && (
          <>
            <dt>Last error</dt>
            <dd className="bad-text">{meta.lastError}</dd>
          </>
        )}
      </dl>

      {pending > 0 && (
        <>
          <h3>Waiting to send, in order</h3>
          <ol className="queue-list">
            {queue.slice(0, 25).map((op, i) => (
              <li key={op.seq} className={i === 0 ? 'head' : ''}>
                <span className="queue-num">{i + 1}</span>
                <span>
                  {VERB[op.type]} {op.recordType} <b>{names.get(op.recordId) ?? ''}</b>
                </span>
                {i === 0 && <span className="chip st-washing">next</span>}
              </li>
            ))}
          </ol>
          {pending > 25 && <p className="muted">…and {pending - 25} more.</p>}
        </>
      )}

      <p className="muted">
        Sync also runs by itself when the signal returns and every 30 seconds while online.
      </p>
      <a className="link-row" href="#/debug">
        <Icon name="bug" size={18} /> Developer view (queue IDs and demo toggles)
        <Icon name="chevron" size={18} />
      </a>
    </section>
  );
}
