import type { ChangesResponse, ConflictLogEntry, SyncResponse } from '@washlog/shared';
import type { Transport } from './sync';

const TOKEN: string = import.meta.env.VITE_SYNC_TOKEN || 'dev-token';
const TIMEOUT_MS = 8000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = [body.error, ...(body.reasons ?? [])].filter(Boolean).join(' — ');
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`Server responded ${res.status}${detail ? `: ${detail}` : ''}`);
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

export const httpTransport: Transport = {
  sendOp: (op) => request<SyncResponse>('/api/sync/ops', { method: 'POST', body: JSON.stringify(op) }),
  fetchChanges: (since) => request<ChangesResponse>(`/api/sync/changes?since=${since}`),
  fetchConflicts: async () => (await request<{ conflicts: ConflictLogEntry[] }>('/api/conflicts')).conflicts,
};

export interface DemoStatus {
  demoMode: boolean;
  failNext: boolean;
  dropAckNext: boolean;
}

/** null when the server is unreachable or DEMO_MODE is off (404). */
export async function demoStatus(): Promise<DemoStatus | null> {
  try {
    return await request<DemoStatus>('/api/demo/status');
  } catch {
    return null;
  }
}

export const demoFailNext = () => request<DemoStatus>('/api/demo/fail-next', { method: 'POST' });
export const demoDropAckNext = () => request<DemoStatus>('/api/demo/drop-ack-next', { method: 'POST' });
