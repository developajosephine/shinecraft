# WashLog — offline-first car wash tracker

Zetech Forge · Software Development track · Challenge B (Offline-First Resource Tracker). Repository: `shinecraft`.

## 1. What it is

**WashLog** lets roadside car wash attendants in Kenya log wash jobs and supply stock on their phones with no signal. Every change is saved on the phone first, queued, and sent to a shared server when connectivity returns.

- **User:** car wash attendants and the cashier at an informal roadside car wash, each with their own phone.
- **Problem:** signal at the wash bay is unreliable. Paper tallies and chat messages get lost, and a retry after a dropped connection can count the same car twice.
- **SDG 6 (clean water):** each job records the litres of water used, so the site can see and reduce its water use per vehicle.
- **SDG 8 (decent work):** each job records which attendant did it and whether it was paid, giving attendants a provable record of their work.
- **Why lost or duplicated records matter:** a lost job is unpaid work for an attendant and missing revenue for the owner. A duplicated job overstates takings and water use, and makes the cashier's totals disagree with the cash in hand. WashLog is built so a job is applied **exactly once**, and every conflict between phones is **visible**, never silently dropped.

All data in this repository and in the demo is **synthetic**.

## 2. Live deployment

| | |
|---|---|
| Live URL | `TODO: https://<app>.primecloud.example` |
| Health check | `TODO: https://<app>.primecloud.example/healthz` |
| Deployed commit | `TODO: <git sha>` (also returned as `revision` by `/healthz`) |

Deployment steps: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## 3. Architecture

```mermaid
flowchart LR
  subgraph Phone["Phone (PWA: React + Vite)"]
    UI[UI] -->|one Dexie transaction| REC[(records<br/>record map)]
    UI -->|same transaction| Q[(opQueue<br/>FIFO)]
    Q --> LOOP[Sync loop]
    LOOP --> ACK[(ackedOps<br/>op-ID set)]
    LOOP --> CONF[(conflicts)]
    SW[Service worker<br/>precached app shell]
  end
  subgraph Server["One service (Node 20 + Express)"]
    API["/api/sync/ops · /api/sync/changes<br/>/api/conflicts · /healthz"]
    STATIC[Static client/dist + SPA fallback]
  end
  subgraph PG[(PostgreSQL)]
    R[records]
    P[processed_ops]
    C[conflict_log]
  end
  LOOP -- "POST one op (Bearer token)" --> API
  API -- "applied / duplicate /<br/>conflict_resolved / rejected" --> LOOP
  LOOP -- "GET changes since seq" --> API
  API -->|single transaction| PG
```

**Stack.** npm workspaces monorepo: `client/` (React, Vite, TypeScript, Dexie.js, vite-plugin-pwa/Workbox), `server/` (Node.js 20, Express, TypeScript, `pg`, zod), `shared/` (types, zod schemas and the conflict-resolution function, imported by both). PostgreSQL for storage. Vitest, fake-indexeddb and Supertest for tests.

No sync or replication library is used. The queue, record map, op-ID set and conflict algorithm are this project's own code: `client/src/store.ts`, `client/src/sync.ts`, `shared/src/conflict.ts`, `server/src/syncService.ts`.

## 4. Setup

**Prerequisites:** Node.js ≥ 20.12, npm ≥ 10, Docker (for PostgreSQL).

**Environment variables** (names only; see [`.env.example`](.env.example)):

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server | PostgreSQL connection string |
| `SYNC_TOKEN` | server | bearer token required on `/api/*` |
| `PORT` | server | listen port (default 8080) |
| `GIT_SHA` | server | reported as `revision` by `/healthz` |
| `DEMO_MODE` | server | `true` enables the demo failure toggles |
| `TEST_DATABASE_URL` | server tests | PostgreSQL used by `npm test` |
| `VITE_SYNC_TOKEN` | client build | token baked into the client; must equal `SYNC_TOKEN` |

For local development no `.env` is needed: outside `NODE_ENV=production` the server falls back to the docker-compose databases and a development-only token. In production `DATABASE_URL` and `SYNC_TOKEN` are required and the server refuses to start without them.

**Run locally**

```bash
npm install
docker compose up -d      # PostgreSQL on :5433 (dev) and :5434 (tests)
npm run migrate           # also runs automatically on server start
npm run seed              # 25 synthetic jobs, 5 supplies, 3 attendants (safe to re-run)
npm run dev               # API on :8080, Vite dev server on :5173
```

Open http://localhost:5173. The service worker is only active in the production build, so for anything involving offline loading use the built app:

```bash
npm run build && npm start   # app + API together on http://localhost:8080
```

**Test**

```bash
npm test                  # shared + client + server (needs `docker compose up -d`)
npm run test:report       # same, and writes docs/test-results.txt
```

Try the API by hand with the files in [`samples/`](samples):

```bash
curl -X POST localhost:8080/api/sync/ops -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' -d @samples/01-create-job.json
```

Sent in order, the five samples return `applied`, `applied`, `conflict_resolved`, `applied` (delete) and `rejected` (update after delete). Sending any of them twice returns `duplicate`.

## 5. Data structures and complexity

| Structure | Where | Role | Cost |
|---|---|---|---|
| **FIFO queue** | Dexie `opQueue`, key `++seq` (auto-increment) | durable, ordered list of pending operations | enqueue O(1), dequeue-head O(1) as a queue |
| **Record map** | Dexie `records`, key `id` | current local state of every job and supply | get/put average O(1) as a hash map |
| **Op-ID set** | Dexie `ackedOps`, key `opId` | operations the server has acknowledged | membership/insert average O(1) as a hash set |
| **Processed-ops index** | PostgreSQL `processed_ops` primary key | server-side exactly-once guard | O(log n) B-tree lookup/insert |

Those are the abstract costs. The honest physical costs:

- IndexedDB stores are B-trees, so each queue, map or set operation on the phone is **O(log n)** in the size of that store, plus transaction overhead.
- Checking whether a record still has queued ops uses the `recordId` index on `opQueue`: O(log p + k) for k matching ops.
- Sync is **not** O(1). Pushing p pending ops costs p HTTP round trips, each O(log n) on the server (primary-key lookup in `processed_ops`, row lock in `records`, plus one `conflict_log` insert per contested field). A pull returning c changed records is O(log r + c) on the server (index on `change_seq`) and O(c log r) on the phone.
- List screens load all records of one type and filter in memory: O(r). IndexedDB cannot index booleans, so `pending` and `deleted` are filtered, not looked up.
- **Space:** O(r + p + d) on the phone for r records, p pending ops and d acknowledged op IDs, plus O(D) on the server for every op ID ever processed. Neither set is pruned yet (see limitations).

## 6. Sync protocol and acknowledgment flow

**Local write.** Every create, edit or delete runs in one Dexie transaction that (a) updates the record in `records` with `pending = true` and (b) appends one operation to `opQueue`. If either write fails, both roll back. The operation gets its `opId` (UUID) here, once; retries reuse it. Edits queue only the fields that changed. Several edits to one record stay as separate queue entries in order.

```ts
{ opId, seq, deviceId, recordType: 'job'|'supply', recordId,
  type: 'create'|'update'|'delete', payload, baseVersion, clientTimestamp }
```

**Push — `POST /api/sync/ops`, one operation per request.** The loop always sends the head of the queue:

1. If the head's `opId` is already in `ackedOps`, remove it and continue (never resend).
2. Send it, with an 8 s timeout.
3. On any failure (network error, timeout, non-2xx) **stop**. The head stays in place with the same `opId`. Nothing behind it is sent.
4. On a 2xx response, in one transaction: delete the op from the queue, add its `opId` to `ackedOps`, store any reported conflict, and update the record from the server's copy. `pending` is cleared only when no queued ops remain for that record; until then the local edits are kept and only the version is tracked.

**Server, one transaction per operation:**

1. `INSERT INTO processed_ops … ON CONFLICT DO NOTHING RETURNING op_id`. No row returned means this op was already handled: roll back and answer `duplicate` with the stored outcome and the current record. A concurrent retry blocks on this insert until the first attempt commits, so two simultaneous retries still apply once.
2. `SELECT … FROM records WHERE id = $1 FOR UPDATE`.
3. Apply the policy in section 7.
4. Store the response in `processed_ops`, commit, respond.

The response is `{ opId, status, record, conflict }` with status `applied`, `duplicate`, `conflict_resolved` or `rejected`. Because the op ID is committed in the same transaction as the record change, a lost acknowledgment is harmless: the phone retries the same `opId` and gets `duplicate`.

**Pull — `GET /api/sync/changes?since=<seq>`.** Every server write takes a new `change_seq` from a sequence. The phone asks for rows newer than its `lastPulledSeq` and applies them to its record map, **except** records that still have pending ops (those are resolved by the server when the ops are pushed). The phone pulls after each successful push run and on app start.

**Triggers:** app start, the browser `online` event, the "Sync now" button, every 30 s while online, and right after a local change if the phone appears online. `navigator.onLine` is treated as a hint only; a failed sync is what marks the server as unreachable.

**Validation and auth.** Every op is validated with the shared zod schema; an invalid op gets `400` with reasons, nothing is written and the op ID is not recorded. All `/api/*` routes require `Authorization: Bearer <SYNC_TOKEN>` and return `401` otherwise. JSON bodies are limited to 100 kb.

**Other endpoints:** `GET /healthz` (`{status, db, revision}`, 503 if the database is unreachable), `GET /api/conflicts`, `GET /api/records`, and when `DEMO_MODE=true`: `POST /api/demo/fail-next` (next op gets 503, nothing applied) and `POST /api/demo/drop-ack-next` (next op is applied and committed, then answered with 503).

## 7. Conflict and deletion policy

- **No conflict:** an update whose `baseVersion` equals the server version is applied and the version increases by one.
- **Stale update (`baseVersion` below the server version): last writer wins, per field.** The server keeps a stamp (client timestamp + device ID) for whoever last wrote each field. For every payload field whose value differs from the server's, the shared function `resolveLww` compares the incoming op's stamp with that field's stamp. The later `clientTimestamp` wins; on an exact tie the lexicographically greater `deviceId` wins, so the result never depends on arrival order.
- **Field-level log:** every contested field is written to `conflict_log` with the winning value, the rejected value and both device IDs. The response status is `conflict_resolved` and the phone shows the entries on its Conflicts screen. The other phone sees them after its next sync.
- **Money flag:** conflicts on `priceKes`, `paymentMethod` or `mpesaCode` get policy `lww-flag-money` and are highlighted in the UI so a person reviews them.
- **Deletion wins:** a delete sets a tombstone, even from a stale version. Any later update (or re-sent create) for a tombstoned record is `rejected`, logged with policy `tombstone`, and the tombstone is returned so the record cannot be resurrected.
- **Own edits chain:** a phone's own queued edits (create, edit, edit made offline on the same base) are applied in order and are not reported as conflicts with each other.

One deliberate choice: the comparison is made per field rather than once per record. With a single per-record comparison, "A marks the job paid, B corrects the price" would keep both edits or drop one depending on which phone synced first. Per-field stamps give the same end state in either order, and a value is only rejected when two phones changed the same field.

## 8. Demo script

Use the live URL, or locally `npm run build && npm start` at http://localhost:8080 after `npm run seed`. Open the app in **two browser profiles** (A and B) and give each a device name. "Offline" means DevTools → Network → Offline. The Debug tab shows the queue and the demo buttons.

1. **Online create.** In A, tap **Add car**, enter a plate, save. The job shows the `synced` badge.
2. **Offline create, edit, delete, reload.** In A, go offline. The banner "Offline — changes saved on this phone" appears. Create a job, change its status, delete another job. Reload the page: the app still loads, the changes are still there with the `pending` badge, and Debug lists the queued ops in order.
3. **Failed sync keeps the head op.** In B (online), Debug → **Fail next sync**. In A, go back online: the sync fails with a 503, the Sync tab shows the error, and Debug shows the same op at the head with the same op ID and everything behind it still queued. Tap **Sync now**: all ops are applied.
4. **Lost acknowledgment.** In A, Debug → **Drop next ack**, then add a car. The server commits it but answers 503, so A still shows it as `pending`. Tap **Sync now**: the retry comes back as `duplicate` (visible in the server log) and there is exactly one car, on A, on B after it syncs, and in `GET /api/records`.
5. **Two phones edit the same job.** Pick a seeded job that is `waiting`. Put both A and B offline. In A set its status to **paid**. In B change its price. Bring A online, then B. Both edits survive on both phones, and the Conflicts tab lists the contested field with kept and rejected values and both devices, highlighted because price is a money field. To see a rejection, repeat with both phones changing the price: the later edit is kept and the earlier one is listed as rejected.
6. **Delete beats edit.** Both offline. In A delete a job. In B edit the same job. Bring A online, then B. The job stays deleted on both phones, and the Conflicts tab shows the rejected edit as "edit after delete".
7. **Restart the backend.** Restart or redeploy the server (locally: stop and `npm start` again). Reload either profile: all data is still there, because records and processed op IDs live in PostgreSQL, not on the container's disk.

## 9. Test evidence

Full output: [`docs/test-results.txt`](docs/test-results.txt), regenerated with `npm run test:report`. 46 tests: 9 shared, 11 client (Dexie on fake-indexeddb), 26 server (Supertest against a real PostgreSQL, schema reset per test file).

| Requirement | Test |
|---|---|
| FIFO order, dequeue only after ack | `client/tests/queue.test.ts` |
| Record update + enqueue atomic | `client/tests/queue.test.ts` |
| Multiple ops per record stay separate | `client/tests/queue.test.ts` |
| Failed send keeps head, same op ID, no skipping | `client/tests/sync.test.ts` |
| Acked op skipped and removed | `client/tests/sync.test.ts` |
| Pull does not overwrite pending records | `client/tests/sync.test.ts` |
| Data survives closing and reopening the DB | `client/tests/queue.test.ts` |
| LWW, deterministic tie-break, per-field result | `shared/src/conflict.test.ts` |
| Create, duplicate, lost ack, fail-next, invalid op | `server/tests/sync.test.ts` |
| Two-device conflict, tombstone wins, conflict log | `server/tests/conflict.test.ts` |
| 401, `/healthz`, changes since | `server/tests/api.test.ts` |

**Measured timings.** HTTP round trip per operation, measured on a developer laptop (Apple M1, Node 24, PostgreSQL 16 in Docker, loopback network, sequential requests, n = 280 each). These are local numbers, not the deployed service.

| Operation | Median | p95 |
|---|---|---|
| create | 4.2 ms | 5.7 ms |
| duplicate retry | 3.0 ms | 4.1 ms |
| update | 5.0 ms | 11.3 ms |
| pull of 300 records | 19 ms (single request) | |

The demo script in section 8 was also run in a browser against the production build: offline load from the service worker, pending ops surviving a reload, failed sync, lost acknowledgment, a two-device edit and delete-versus-edit. That run used one browser profile; the second device was driven with `curl`, and "offline" was simulated by stopping the server.

## 10. Security and privacy

- **Synthetic data only.** Seed plates, attendant names and M-Pesa codes are generated; no real people or vehicles.
- **Token-protected API.** All `/api/*` routes need the bearer token; comparison is constant-time. `/healthz` is the only open route and exposes no data.
- **Input validation.** Every op is checked with strict zod schemas (unknown fields rejected, enums, ranges, lengths) before anything is written. Body limit 100 kb. All SQL is parameterised.
- **No secrets in the repository.** `.env` is git-ignored; `.env.example` holds placeholders. The credentials in `docker-compose.yml` are for throwaway local databases.
- **Demo toggles off by default in production.** They exist only when `DEMO_MODE=true` and still require the token.
- **Container** runs as the non-root `node` user and stores nothing on local disk.

## 11. Known limitations

- **Client clocks decide conflicts.** Last-writer-wins uses each phone's clock. A phone with a wrong clock can win or lose unfairly. The conflict log makes this visible but does not prevent it.
- **One shared token, no per-user auth.** The token is baked into the client bundle, so anyone with the app can read it. `deviceId` and attendant name are self-declared.
- **A rejected op blocks the queue.** By design the loop never skips the head. The client validates with the same schema as the server so a `400` should not occur, but if it did, later ops would wait behind it.
- **No pruning.** `ackedOps` on the phone and `processed_ops` and `conflict_log` on the server grow without bound. The phone keeps a copy of the latest 200 conflict entries.
- **Pull is not paginated** and list screens filter in memory; fine for one car wash, not for thousands of records.
- **Writes are serialised** on the server with one advisory lock so pulls never miss a change; this limits write throughput.
- **Demo toggles are in memory**, so they apply to one server instance.
- **Offline loading needs one online visit first** (to install the service worker), and the app icon is SVG only.

## 12. AI-tool disclosure and team

- **AI tools used:** `TODO: list tools and what they were used for`
- **Team:** `TODO: names and roles`
