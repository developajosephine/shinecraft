import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DEFAULT_CATALOG, mergeCatalog, type Catalog, type Role, type Session } from '@washlog/shared';
import { db } from './db';

/** The logged-in user's role. Least privilege until it has loaded. */
export function useRole(): Role {
  return useLiveQuery(async () => ((await db.meta.get('session'))?.value as Session | undefined)?.user.role ?? 'attendant', [], 'attendant' as Role);
}

/** Vehicle types, services and units as last fetched from the server; built-in values until then (or offline). */
export function useCatalog(): Catalog {
  return useLiveQuery(async () => mergeCatalog((await db.meta.get('catalog'))?.value), [], DEFAULT_CATALOG);
}

/** navigator.onLine is only a hint: it says "has a network", not "can reach the server". */
export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const update = () => setParts(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return parts;
}

export function go(path: string): void {
  window.location.hash = `#/${path}`;
}

export const shortId = (id: string) => id.slice(0, 8);

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString();
}
