import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { httpTransport } from './api';
import { db } from './db';
import { go, useHashRoute, useOnline } from './hooks';
import { syncOnce } from './sync';
import { Conflicts } from './views/Conflicts';
import { Debug } from './views/Debug';
import { JobForm } from './views/JobForm';
import { Jobs } from './views/Jobs';
import { Setup } from './views/Setup';
import { Supplies } from './views/Supplies';
import { SyncPanel } from './views/SyncPanel';

const TABS = [
  ['jobs', 'Jobs'],
  ['supplies', 'Supplies'],
  ['sync', 'Sync'],
  ['conflicts', 'Conflicts'],
  ['debug', 'Debug'],
] as const;

export default function App() {
  // undefined = still loading, null = first run
  const device = useLiveQuery(async () => {
    const [id, name] = await db.meta.bulkGet(['deviceId', 'deviceName']);
    return id && name ? { deviceId: id.value as string, deviceName: name.value as string } : null;
  });
  const pendingCount = useLiveQuery(() => db.opQueue.count(), [], 0);
  const online = useOnline();
  const route = useHashRoute();
  const [syncing, setSyncing] = useState(false);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncOnce(db, httpTransport);
    } finally {
      setSyncing(false);
    }
  }, []);

  const ready = Boolean(device);
  useEffect(() => {
    if (!ready) return;
    void runSync(); // app start
    const onOnline = () => void runSync(); // connectivity returned
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => {
      if (navigator.onLine) void runSync(); // every 30s while online
    }, 30_000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [ready, runSync]);

  /** After a local change: try to sync straight away if we appear to be online. */
  const changed = useCallback(() => {
    if (navigator.onLine) void runSync();
  }, [runSync]);

  if (device === undefined) return null;
  if (device === null) return <Setup />;

  const tab = route[0] ?? 'jobs';
  let view;
  if (tab === 'job') {
    view = (
      <JobForm
        key={route[1]}
        id={route[1] === 'new' ? undefined : route[1]}
        deviceName={device.deviceName}
        onChanged={changed}
      />
    );
  } else if (tab === 'supplies') view = <Supplies onChanged={changed} />;
  else if (tab === 'sync') view = <SyncPanel online={online} syncing={syncing} onSync={runSync} />;
  else if (tab === 'conflicts') view = <Conflicts deviceId={device.deviceId} onRefresh={runSync} />;
  else if (tab === 'debug') view = <Debug online={online} />;
  else view = <Jobs />;

  return (
    <div className="app">
      <header className="topbar">
        <strong>WashLog</strong>
        <span className="device">{device.deviceName}</span>
        <button className="pill" onClick={() => go('sync')} aria-label="Open sync panel">
          <span className={`dot ${online ? 'on' : 'off'}`} />
          {online ? 'Online' : 'Offline'}
          {pendingCount > 0 && <span className="count">{pendingCount} pending</span>}
        </button>
      </header>
      {!online && <div className="offline-banner">Offline — changes saved on this phone</div>}
      <main>{view}</main>
      <nav className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} href={`#/${key}`} className={tab === key || (key === 'jobs' && tab === 'job') ? 'active' : ''}>
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
