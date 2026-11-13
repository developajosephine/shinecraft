import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { can, type Session } from '@washlog/shared';
import { httpTransport, logout } from './api';
import { db } from './db';
import { useHashRoute, useOnline } from './hooks';
import { syncOnce } from './sync';
import { toast } from './toast';
import { ROLE_LABEL } from './labels';
import { clearSession, ensureDeviceId } from './store';
import { Icon, Sheet, Toasts, type IconName } from './ui';
import { Activity, Users } from './views/Admin';
import { Conflicts } from './views/Conflicts';
import { Debug } from './views/Debug';
import { JobForm } from './views/JobForm';
import { Jobs } from './views/Jobs';
import { Login } from './views/Setup';
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
  // undefined = still loading. The login is read from the phone, so the app opens with no signal.
  // (Live queries may only read, so the device ID is created in an effect.)
  useEffect(() => {
    void ensureDeviceId(db);
  }, []);
  const auth = useLiveQuery(async () => {
    const [deviceId, session, expired] = await db.meta.bulkGet(['deviceId', 'session', 'sessionExpired']);
    if (!deviceId) return undefined;
    return { deviceId: deviceId.value as string, session: (session?.value as Session | undefined) ?? null, expired: expired?.value === true };
  });
  const [account, setAccount] = useState(false);
  const pendingCount = useLiveQuery(() => db.opQueue.count(), [], 0);
  const lastError = useLiveQuery(async () => ((await db.meta.get('lastError'))?.value as string | null) ?? null, [], null);
  const online = useOnline();
  const route = useHashRoute();
  const [syncing, setSyncing] = useState(false);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await syncOnce(db, httpTransport);
      if (result.refused) {
        toast(`${result.refused} ${result.refused === 1 ? 'change was' : 'changes were'} not allowed. See Conflicts.`, 'bad');
      }
      return result;
    } finally {
      setSyncing(false);
    }
  }, []);

  const ready = Boolean(auth?.session) && !auth?.expired;
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
    if (result.refused) return; // already explained
    if (!result.ok) toast('Sync failed. Your changes are still saved on this phone.', 'bad');
    else toast(result.sent > 0 ? `Synced ${result.sent} ${result.sent === 1 ? 'change' : 'changes'}` : 'Everything is up to date');
  }, [runSync]);

  if (auth === undefined) return null;
  if (!auth.session || auth.expired) {
    return (
      <>
        <Login expired={auth.expired} pending={pendingCount} />
        <Toasts />
      </>
    );
  }
  const user = auth.session.user;
  const device = { deviceId: auth.deviceId, deviceName: user.name };
  const isManager = can(user.role, 'manageUsers');

  const logOut = async () => {
    setAccount(false);
    await logout().catch(() => {}); // offline: the server session simply expires later
    await clearSession(db);
    window.location.hash = '#/jobs';
  };

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
  else if (tab === 'users' && isManager) view = <Users myId={user.id} />;
  else if (tab === 'activity' && isManager) view = <Activity />;
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
        <button className="device account-btn" onClick={() => setAccount(true)} aria-label={`Account: ${user.name}, ${ROLE_LABEL[user.role]}`}>
          {user.name} · {ROLE_LABEL[user.role]}
        </button>
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
          const active = tab === t.key || (t.key === 'sync' && ['debug', 'users', 'activity'].includes(tab));
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
      {account && (
        <Sheet title={user.name} onClose={() => setAccount(false)}>
          <p className="muted">
            Logged in as {ROLE_LABEL[user.role].toLowerCase()} on this phone.
            {pendingCount > 0 && ` ${pendingCount} unsynced ${pendingCount === 1 ? 'change stays' : 'changes stay'} on this phone and will be sent after the next login.`}
          </p>
          <div className="pay-options">
            {isManager && (
              <>
                <a className="link-row" href="#/users" onClick={() => setAccount(false)}>
                  Users <Icon name="chevron" size={18} />
                </a>
                <a className="link-row" href="#/activity" onClick={() => setAccount(false)}>
                  Activity log <Icon name="chevron" size={18} />
                </a>
              </>
            )}
            <button className="btn big" onClick={logOut}>
              Log out
            </button>
          </div>
        </Sheet>
      )}
      <Toasts />
    </div>
  );
}
