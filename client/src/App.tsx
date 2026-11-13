import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { httpTransport } from './api';
import { db } from './db';
import { useHashRoute, useOnline } from './hooks';
import { syncOnce } from './sync';
import { toast } from './toast';
import { Icon, Toasts, type IconName } from './ui';
import { Conflicts } from './views/Conflicts';
import { Debug } from './views/Debug';
import { JobForm } from './views/JobForm';
import { Jobs } from './views/Jobs';
import { Setup } from './views/Setup';
import { Supplies } from './views/Supplies';
import { SyncPanel } from './views/SyncPanel';

const TABS: { key: string; label: string; icon: IconName }[] = [
  { key: 'jobs', label: 'Jobs', icon: 'car' },
  { key: 'supplies', label: 'Supplies', icon: 'box' },
  { key: 'sync', label: 'Sync', icon: 'sync' },
  { key: 'conflicts', label: 'Conflicts', icon: 'alert' },
];

export type LinkState = 'on' | 'warn' | 'off';

export default function App() {
  // undefined = still loading, null = first run
  const device = useLiveQuery(async () => {
    const [id, name] = await db.meta.bulkGet(['deviceId', 'deviceName']);
    return id && name ? { deviceId: id.value as string, deviceName: name.value as string } : null;
  });
  const pendingCount = useLiveQuery(() => db.opQueue.count(), [], 0);
  const lastError = useLiveQuery(async () => ((await db.meta.get('lastError'))?.value as string | null) ?? null, [], null);
  const online = useOnline();
  const route = useHashRoute();
  const [syncing, setSyncing] = useState(false);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      return await syncOnce(db, httpTransport);
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

  /** "Sync now" pressed by a person: tell them what happened. */
  const manualSync = useCallback(async () => {
    const result = await runSync();
    if (!result.ok) toast('Sync failed. Your changes are still saved on this phone.', 'bad');
    else toast(result.sent > 0 ? `Synced ${result.sent} ${result.sent === 1 ? 'change' : 'changes'}` : 'Everything is up to date');
  }, [runSync]);

  if (device === undefined) return null;
  if (device === null) return <Setup />;

  // navigator.onLine only says "has a network"; a failed sync says the server was not reachable.
  const link: LinkState = !online ? 'off' : lastError ? 'warn' : 'on';
  const linkLabel = { off: 'Offline', warn: 'Sync failed', on: 'Online' }[link];
  const tab = route[0] ?? 'jobs';

  // The job form is a focused task: its own header, no tab bar.
  if (tab === 'job') {
    return (
      <div className="app">
        <JobForm key={route[1]} id={route[1] === 'new' ? undefined : route[1]} deviceName={device.deviceName} onChanged={changed} />
        <Toasts />
      </div>
    );
  }

  let view;
  if (tab === 'supplies') view = <Supplies onChanged={changed} />;
  else if (tab === 'sync') view = <SyncPanel link={link} syncing={syncing} onSync={manualSync} />;
  else if (tab === 'conflicts') view = <Conflicts deviceId={device.deviceId} onRefresh={manualSync} />;
  else if (tab === 'debug') view = <Debug online={online} />;
  else view = <Jobs onChanged={changed} />;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">
            <Icon name="drop" size={18} />
          </span>
          WashLog
        </span>
        <span className="device">{device.deviceName}</span>
        <a className={`pill ${link}`} href="#/sync" aria-label={`Connection: ${linkLabel}. Open sync.`}>
          <span className="dot" />
          {linkLabel}
          {pendingCount > 0 && <span className="pill-count">{pendingCount}</span>}
        </a>
      </header>
      {link === 'off' && (
        <div className="banner">
          <Icon name="offline" size={18} /> Offline — changes saved on this phone
        </div>
      )}
      {link === 'warn' && (
        <div className="banner">
          <Icon name="alert" size={18} /> Last sync failed — changes saved on this phone
        </div>
      )}
      <main>{view}</main>
      <nav className="tabs" aria-label="Main">
        {TABS.map((t) => {
          const active = tab === t.key || (t.key === 'sync' && tab === 'debug');
          return (
            <a key={t.key} href={`#/${t.key}`} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
              <span className="tab-icon">
                <Icon name={t.icon} size={22} />
                {t.key === 'sync' && pendingCount > 0 && <span className="tab-badge">{pendingCount}</span>}
              </span>
              {t.label}
            </a>
          );
        })}
      </nav>
      <Toasts />
    </div>
  );
}
