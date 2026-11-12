import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { parseOp } from '@washlog/shared';
import { CLIENT_DIST } from './config';
import type { Pool } from './db';
import { allRecords, changesSince, handleOp, recentConflicts } from './syncService';

export interface AppOptions {
  pool: Pool;
  syncToken: string;
  demoMode: boolean;
  revision: string;
  clientDist?: string;
  log?: (line: string) => void;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = crypto.createHash('sha256').update(header.slice(7)).digest();
  const expected = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(given, expected);
}

export function createApp(opts: AppOptions) {
  const { pool, syncToken, demoMode, revision } = opts;
  const clientDist = opts.clientDist ?? CLIENT_DIST;
  const log = opts.log ?? ((line: string) => console.log(line));

  // Demo toggles live in memory on purpose: they are one-shot switches, not data.
  const demo = { failNext: false, dropAckNext: false };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!tokenMatches(req.headers.authorization, syncToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok', revision });
    } catch {
      res.status(503).json({ status: 'error', db: 'unreachable', revision });
    }
  });

  app.post('/api/sync/ops', requireAuth, async (req, res) => {
    const started = performance.now();
    const done = (opId: unknown, status: string) =>
      log(JSON.stringify({ event: 'op', opId, status, durationMs: Math.round((performance.now() - started) * 10) / 10 }));

    const parsed = parseOp(req.body);
    if (!parsed.success) {
      done(req.body?.opId ?? null, 'invalid');
      res.status(400).json({ error: 'invalid_op', reasons: parsed.errors });
      return;
    }
    const op = parsed.data;

    if (demoMode && demo.failNext) {
      demo.failNext = false;
      done(op.opId, 'demo_failed_not_applied');
      res.status(503).json({ error: 'demo: sync failed, nothing applied' });
      return;
    }

    const result = await handleOp(pool, op);

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

  if (demoMode) {
    app.get('/api/demo/status', requireAuth, (_req, res) => {
      res.json({ demoMode: true, ...demo });
    });
    app.post('/api/demo/fail-next', requireAuth, (_req, res) => {
      demo.failNext = true;
      res.json({ demoMode: true, ...demo });
    });
    app.post('/api/demo/drop-ack-next', requireAuth, (_req, res) => {
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
