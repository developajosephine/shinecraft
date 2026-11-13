import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { can, loginSchema, parseOp, userCreateSchema, userUpdateSchema, type Capability } from '@washlog/shared';
import {
  DEMO_PIN,
  DEMO_USERS,
  SERVICE_ACTOR,
  constantTimeEqual,
  createUser,
  listUsers,
  login,
  recentAudit,
  resolveSession,
  revokeSession,
  updateUser,
  writeAudit,
  type Actor,
} from './auth';
import { CLIENT_DIST } from './config';
import type { Pool } from './db';
import { Counter, rateLimit, tooMany } from './rateLimit';
import { allRecords, changesSince, handleOp, recentConflicts } from './syncService';

export interface Limits {
  /** Requests per minute, per IP, across the whole API. */
  apiPerMinute: number;
  /** Login attempts per minute, per IP. */
  loginPerMinute: number;
  /** Wrong PINs allowed per name in 15 minutes before that name is locked. */
  loginFailures: number;
}

export const DEFAULT_LIMITS: Limits = { apiPerMinute: 600, loginPerMinute: 10, loginFailures: 5 };

export interface AppOptions {
  pool: Pool;
  /** Operator/service token: full access, for scripts and tests. Never sent to browsers. */
  syncToken: string;
  demoMode: boolean;
  revision: string;
  clientDist?: string;
  log?: (line: string) => void;
  limits?: Partial<Limits>;
  /** Number of reverse proxies in front of the app (so rate limits see the real client IP). */
  trustProxy?: number;
  /** Send Strict-Transport-Security (only when served over HTTPS). */
  hsts?: boolean;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
};

const actorOf = (res: Response): Actor => res.locals.actor as Actor;

export function createApp(opts: AppOptions) {
  const { pool, syncToken, demoMode, revision } = opts;
  const clientDist = opts.clientDist ?? CLIENT_DIST;
  const log = opts.log ?? ((line: string) => console.log(line));
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };

  // Demo toggles live in memory on purpose: they are one-shot switches, not data.
  const demo = { failNext: false, dropAckNext: false };

  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', opts.trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (opts.hsts) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });

  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok', revision });
    } catch {
      res.status(503).json({ status: 'error', db: 'unreachable', revision });
    }
  });

  app.use('/api', rateLimit(60_000, limits.apiPerMinute), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    const actor = !token ? null : constantTimeEqual(token, syncToken) ? SERVICE_ACTOR : await resolveSession(pool, token);
    if (!actor) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.locals.actor = actor;
    next();
  };

  const requireCan = (capability: Capability) => (_req: Request, res: Response, next: NextFunction) => {
    if (!can(actorOf(res).role, capability)) {
      res.status(403).json({ error: 'forbidden', reasons: ['Your role is not allowed to do this.'] });
      return;
    }
    next();
  };

  // ---- Login ----

  const loginFailures = new Counter(15 * 60_000, limits.loginFailures);

  // What the login screen needs before anyone is logged in. The demo accounts are synthetic
  // and only exist (and are only listed) when DEMO_MODE is on.
  app.get('/api/auth/options', (_req, res) => {
    res.json({ demoMode, demoAccounts: demoMode ? DEMO_USERS : [], demoPin: demoMode ? DEMO_PIN : null });
  });

  app.post('/api/auth/login', rateLimit(60_000, limits.loginPerMinute), async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_login', reasons: ['Enter your name and PIN.'] });
      return;
    }
    const { name, pin, deviceId } = parsed.data;
    const key = name.toLowerCase();
    const locked = loginFailures.blockedFor(key);
    if (locked) return tooMany(res, locked);

    const session = await login(pool, name, pin, deviceId);
    const who = { userId: session?.user.id ?? null, name: session?.user.name ?? name, role: session?.user.role ?? '-', deviceId };
    if (!session) {
      loginFailures.hit(key);
      await writeAudit(pool, who, { action: 'auth.login', outcome: 'failed' });
      res.status(401).json({ error: 'invalid_credentials', reasons: ['Wrong name or PIN.'] });
      return;
    }
    loginFailures.reset(key);
    await writeAudit(pool, who, { action: 'auth.login', outcome: 'ok' });
    res.json({ ...session, demoMode });
  });

  app.post('/api/auth/logout', requireAuth, async (req, res) => {
    const actor = actorOf(res);
    if (actor.kind === 'user') {
      await revokeSession(pool, bearer(req)!);
      await writeAudit(pool, actor, { action: 'auth.logout', outcome: 'ok' });
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (_req, res) => {
    const actor = actorOf(res);
    res.json({ user: { id: actor.userId, name: actor.name, role: actor.role }, demoMode });
  });

  // ---- Sync ----

  app.post('/api/sync/ops', requireAuth, async (req, res) => {
    const started = performance.now();
    const actor = actorOf(res);
    const done = (opId: unknown, status: string) =>
      log(
        JSON.stringify({ event: 'op', opId, status, user: actor.name, role: actor.role, durationMs: Math.round((performance.now() - started) * 10) / 10 }),
      );

    const parsed = parseOp(req.body);
    if (!parsed.success) {
      done(req.body?.opId ?? null, 'invalid');
      res.status(400).json({ error: 'invalid_op', reasons: parsed.errors });
      return;
    }
    const op = parsed.data;

    // An attendant's new job is always in their own name, whatever the phone sent.
    if (actor.kind === 'user' && op.type === 'create' && op.recordType === 'job' && !can(actor.role, 'reassignJob')) {
      op.payload = { ...op.payload, attendant: actor.name };
    }

    if (demoMode && demo.failNext) {
      demo.failNext = false;
      done(op.opId, 'demo_failed_not_applied');
      res.status(503).json({ error: 'demo: sync failed, nothing applied' });
      return;
    }

    const result = await handleOp(pool, op, actor);

    if (demoMode && demo.dropAckNext) {
      demo.dropAckNext = false;
      done(op.opId, `${result.status}_ack_dropped`);
      res.status(503).json({ error: 'demo: op committed, acknowledgment dropped' });
      return;
    }

    done(op.opId, result.status);
    res.json(result);
  });

  app.get('/api/sync/changes', requireAuth, async (req, res) => {
    const raw = req.query.since ?? '0';
    const since = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isNaN(since)) {
      res.status(400).json({ error: 'invalid_since', reasons: ['since: must be a non-negative integer'] });
      return;
    }
    res.json(await changesSince(pool, since));
  });

  app.get('/api/conflicts', requireAuth, async (_req, res) => {
    res.json({ conflicts: await recentConflicts(pool) });
  });

  app.get('/api/records', requireAuth, async (_req, res) => {
    res.json({ records: await allRecords(pool) });
  });

  // ---- Manager: users and activity ----

  const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
    error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);

  app.get('/api/users', requireAuth, requireCan('manageUsers'), async (_req, res) => {
    res.json({ users: await listUsers(pool) });
  });

  app.post('/api/users', requireAuth, requireCan('manageUsers'), async (req, res) => {
    const parsed = userCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_user', reasons: issues(parsed.error) });
      return;
    }
    const user = await createUser(pool, parsed.data.name, parsed.data.role, parsed.data.pin);
    if (!user) {
      res.status(409).json({ error: 'name_taken', reasons: ['Someone already has that name.'] });
      return;
    }
    await writeAudit(pool, actorOf(res), { action: 'user.create', outcome: 'ok', detail: { name: user.name, role: user.role } });
    res.status(201).json({ user });
  });

  app.patch('/api/users/:id', requireAuth, requireCan('manageUsers'), async (req, res) => {
    const parsed = userUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_user', reasons: issues(parsed.error) });
      return;
    }
    const id = String(req.params.id);
    const result = /^[0-9a-f-]{36}$/i.test(id) ? await updateUser(pool, id, parsed.data) : { error: 'not_found' as const };
    if ('error' in result) {
      if (result.error === 'not_found') res.status(404).json({ error: 'not_found' });
      else res.status(409).json({ error: 'last_manager', reasons: ['There must be at least one active manager.'] });
      return;
    }
    await writeAudit(pool, actorOf(res), {
      action: 'user.update',
      outcome: 'ok',
      // Never the PIN itself: only the fact that it changed.
      detail: { name: result.user.name, role: parsed.data.role, active: parsed.data.active, pinChanged: parsed.data.pin !== undefined },
    });
    res.json({ user: result.user });
  });

  app.get('/api/audit', requireAuth, requireCan('viewAudit'), async (_req, res) => {
    res.json({ entries: await recentAudit(pool) });
  });

  // ---- Demo toggles (manager only, and only when DEMO_MODE is on) ----

  if (demoMode) {
    const guard = [requireAuth, requireCan('demoToggles')];
    app.get('/api/demo/status', guard, (_req: Request, res: Response) => {
      res.json({ demoMode: true, ...demo });
    });
    app.post('/api/demo/fail-next', guard, (_req: Request, res: Response) => {
      demo.failNext = true;
      res.json({ demoMode: true, ...demo });
    });
    app.post('/api/demo/drop-ack-next', guard, (_req: Request, res: Response) => {
      demo.dropAckNext = true;
      res.json({ demoMode: true, ...demo });
    });
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // One service = app + API: serve the built client, with SPA fallback.
  const indexHtml = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(indexHtml);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', reasons: ['body: limit is 100kb'] });
      return;
    }
    if (err.status === 400) {
      res.status(400).json({ error: 'invalid_json', reasons: ['body: not valid JSON'] });
      return;
    }
    log(JSON.stringify({ event: 'error', message: err.message }));
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
