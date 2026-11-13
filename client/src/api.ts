import type { Catalog, ChangesResponse, ConflictLogEntry, Role, Session, SyncResponse, User } from '@washlog/shared';
import { db, getMeta, setMeta } from './db';
import type { Transport } from './sync';

const TIMEOUT_MS = 8000;

/** Thrown for any non-2xx answer, with the server's own explanation when it gave one. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public reasons: string[],
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, authed = true): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authed) {
      // The login lives in IndexedDB next to the data, so it is still there offline.
      const session = await getMeta<Session>(db, 'session');
      if (session) headers.Authorization = `Bearer ${session.token}`;
    }
    const res = await fetch(path, { ...init, headers, signal: controller.signal });
    if (res.status === 401 && authed) {
      // Login ended (expired, PIN changed, account switched off). Nothing local is thrown away:
      // the queue waits and is sent after the next login.
      await setMeta(db, 'sessionExpired', true);
      throw new ApiError(401, [], 'Please log in again');
    }
    if (!res.ok) {
      let reasons: string[] = [];
      let code = '';
      try {
        const body = await res.json();
        code = body.error ?? '';
        reasons = body.reasons ?? [];
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, reasons, reasons[0] ?? `Server responded ${res.status}${code ? `: ${code}` : ''}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('Timed out after 8s');
    if (err instanceof TypeError) throw new Error('Network error — server unreachable');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const httpTransport: Transport = {
  sendOp: (op) => request<SyncResponse>('/api/sync/ops', post(op)),
  fetchChanges: (since) => request<ChangesResponse>(`/api/sync/changes?since=${since}`),
  fetchConflicts: async () => (await request<{ conflicts: ConflictLogEntry[] }>('/api/conflicts')).conflicts,
  fetchCatalog: () => request<Catalog>('/api/catalog'),
};

// ---- Login ----

export interface LoginOptions {
  demoMode: boolean;
  demoAccounts: { name: string; role: Role }[];
  demoPin: string | null;
}

export const loginOptions = () => request<LoginOptions>('/api/auth/options', {}, false);
export const login = (name: string, pin: string, deviceId: string) => request<Session>('/api/auth/login', post({ name, pin, deviceId }), false);
export const logout = () => request<{ ok: boolean }>('/api/auth/logout', post());

// ---- Manager ----

export interface AuditEntry {
  id: number;
  at: string;
  userName: string;
  role: string;
  deviceId: string | null;
  action: string;
  recordId: string | null;
  outcome: string;
  detail: { reasons?: string[]; fields?: string[]; name?: string } | null;
}

export const listUsers = async () => (await request<{ users: User[] }>('/api/users')).users;
export const createUser = (name: string, role: Role, pin: string) => request<{ user: User }>('/api/users', post({ name, role, pin }));
export const updateUser = (id: string, changes: { role?: Role; active?: boolean; pin?: string }) =>
  request<{ user: User }>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(changes) });
export const auditLog = async () => (await request<{ entries: AuditEntry[] }>('/api/audit')).entries;

// ---- Demo toggles (manager, DEMO_MODE only) ----

export interface DemoStatus {
  demoMode: boolean;
  failNext: boolean;
  dropAckNext: boolean;
}

/** null when the server is unreachable, DEMO_MODE is off (404) or this user is not a manager (403). */
export async function demoStatus(): Promise<DemoStatus | null> {
  try {
    return await request<DemoStatus>('/api/demo/status');
  } catch {
    return null;
  }
}

export const demoFailNext = () => request<DemoStatus>('/api/demo/fail-next', post());
export const demoDropAckNext = () => request<DemoStatus>('/api/demo/drop-ack-next', post());
