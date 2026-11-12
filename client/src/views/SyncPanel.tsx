import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { formatTime } from '../hooks';

interface Props {
  online: boolean;
  syncing: boolean;
  onSync: () => void;
}

export function SyncPanel({ online, syncing, onSync }: Props) {
  const pending = useLiveQuery(() => db.opQueue.count(), [], 0);
  const meta = useLiveQuery(
    async () => {
      const [lastSyncAt, lastError] = await db.meta.bulkGet(['lastSyncAt', 'lastError']);
      return { lastSyncAt: lastSyncAt?.value as string | undefined, lastError: lastError?.value as string | null };
    },
    [],
    { lastSyncAt: undefined, lastError: null },
  );

  return (
    <section>
      <h2>Sync</h2>
      <dl className="facts">
        <dt>Connection</dt>
        <dd>
          <span className={`dot ${online ? 'on' : 'off'}`} /> {online ? 'Online' : 'Offline'}
        </dd>
        <dt>Pending changes</dt>
        <dd>{pending}</dd>
        <dt>Last sync</dt>
        <dd>{meta.lastSyncAt ? formatTime(meta.lastSyncAt) : 'Never'}</dd>
        <dt>Last error</dt>
        <dd className={meta.lastError ? 'error' : ''}>{meta.lastError || 'None'}</dd>
      </dl>
      <button className="primary big" onClick={onSync} disabled={syncing}>
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
      <p className="muted">
        Changes are saved on this phone first and sent in order when the server can be reached. Sync also runs when the
        connection returns and every 30 seconds while online.
      </p>
    </section>
  );
}
