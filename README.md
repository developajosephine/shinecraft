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
    API["/api/sync/ops · /api/sync/changes<br/>/api/conflicts · /api/catalog · /healthz"]
    STATIC[Static client/dist + SPA fallback]
  end
  subgraph PG[(PostgreSQL)]
    R[records]
    P[processed_ops]
    C[conflict_log]
    V[jobs / supplies views<br/>vehicle_types · services · supply_units]
  end
  LOOP -- "POST one op (Bearer token)" --> API
  API -- "applied / duplicate /<br/>conflict_resolved / rejected" --> LOOP
  LOOP -- "GET changes since seq" --> API
  API -->|single transaction| PG
```

**Stack.** npm workspaces monorepo: `client/` (React, Vite, TypeScript, Dexie.js, vite-plugin-pwa/Workbox), `server/` (Node.js 20, Express, TypeScript, `pg`, zod), `shared/` (types, zod schemas and the conflict-resolution function, imported by both). PostgreSQL for storage. Vitest, fake-indexeddb and Supertest for tests.

No sync or replication library is used. The queue, record map, op-ID set and conflict algorithm are this project's own code: `client/src/store.ts`, `client/src/sync.ts`, `shared/src/conflict.ts`, `server/src/syncService.ts`.

## 4. Setup

**Prerequisites:** Node.js ≥ 20.12, npm ≥ 10, and a PostgreSQL database: either Docker Desktop (easiest, nothing to configure) or your own PostgreSQL.

**Quick start (one command)**

```bash
npm install
npm run setup    # starts the databases, creates the tables, loads the demo data
npm run dev      # then open http://localhost:5173
```

`npm run setup` checks Node and Docker, tells you in plain words what is missing, and is safe to run again.

**Without Docker.** Create two databases (`washlog` and `washlog_test`) in your own PostgreSQL, copy `.env.example` to `.env` **in the repository root**, and set:

```
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/washlog
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/washlog_test
```

Then run `npm run setup`; it sees `DATABASE_URL` and skips Docker.

**Troubleshooting**

| Message | Cause | Fix |
|---|---|---|
| `Cannot reach PostgreSQL at localhost:5433` or `ECONNREFUSED` | no database is running | start Docker Desktop and run `npm run setup`, or use the no-Docker steps above |
| `Docker is installed but not running` | Docker Desktop is closed | open it, wait until it is running, run `npm run setup` again |
| `rejected the username or password` | wrong credentials in `.env` | fix `DATABASE_URL` |
| `.env` seems ignored | wrong folder, or saved as `.env.txt` | it must be named exactly `.env`, next to the root `package.json` |
| "Your login ended" | session expired, PIN or role changed, or account switched off | log in again; unsynced changes stay on the phone and are sent afterwards |

**Environment variables** (names only; see [`.env.example`](.env.example)):

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server | PostgreSQL connection string |
| `SYNC_TOKEN` | server | operator token for scripts and `curl` (acts as a manager); never sent to browsers |
| `PORT` | server | listen port (default 8080) |
| `GIT_SHA` | server | reported as `revision` by `/healthz` |
| `DEMO_MODE` | server | `true` creates the synthetic demo logins and enables the failure toggles (managers only) |
| `TEST_DATABASE_URL` | server tests | PostgreSQL used by `npm test` |
| `SEED_ON_START` | server | `true` loads the synthetic demo data on startup (idempotent) |
| `ADMIN_NAME`, `ADMIN_PIN` | server | create a first manager account on start (only if that name is free) |
| `TRUST_PROXY` | server | number of reverse proxies in front of the app, so rate limits see the real client IP (default 1 in production) |

For local development no `.env` is needed: outside `NODE_ENV=production` the server falls back to the docker-compose databases and a development-only token. In production `DATABASE_URL` and `SYNC_TOKEN` are required and the server refuses to start without them.

**Run locally, step by step** (what `npm run setup` does for you)

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

**What is in PostgreSQL.** Every job and supply is one row in `records`. Its fields (plate, vehicle type, service, price, status, payment method, M-Pesa code, attendant, water, created time; item, quantity, unit) are stored in the `data` jsonb column, which is the source of truth for sync and conflict resolution. To read them as ordinary columns, query the views added in migration `004_readable_data.sql`:

```sql
SELECT plate, vehicle_type, service, price_kes, status, payment_method, attendant, water_litres, created_at FROM jobs;
SELECT item, quantity, unit FROM supplies;
```

The views leave out deleted records (they stay in `records` as tombstones). The reference data is in tables too: `vehicle_types` (name, default water), `services` (name, default price) and `supply_units`, seeded from `shared/src/catalog.ts`. A manager can change a name or a default price there; phones fetch it on their next sync (`GET /api/catalog`) and keep using the built-in values while offline. The codes themselves are fixed by the app's schema, so new vehicle types or services still need a code change. Changes still queued on a phone that has not synced are not in PostgreSQL yet, by design.

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

**Validation and auth.** Every op is validated with the shared zod schema; an invalid op gets `400` with reasons, nothing is written and the op ID is not recorded. All `/api/*` routes except login need `Authorization: Bearer <session token>` (or the operator `SYNC_TOKEN`) and return `401` otherwise. Each op is then checked against the sender's role (see section 10); a refused op is answered `200` with `status: "rejected"` and `reasons`, so it leaves the phone's queue instead of blocking it, and it is recorded in the conflict log and the audit log. JSON bodies are limited to 100 kb.

**Other endpoints:** `POST /api/auth/login` (`{name, pin, deviceId}` → session), `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/options` (demo accounts, only in demo mode), manager only: `GET/POST /api/users`, `PATCH /api/users/:id`, `GET /api/audit`; `GET /healthz` (`{status, db, revision}`, 503 if the database is unreachable), `GET /api/conflicts`, `GET /api/records`, and when `DEMO_MODE=true` (manager only): `POST /api/demo/fail-next` (next op gets 503, nothing applied) and `POST /api/demo/drop-ack-next` (next op is applied and committed, then answered with 503).

## 7. Conflict and deletion policy

- **No conflict:** an update whose `baseVersion` equals the server version is applied and the version increases by one.
- **Stale update (`baseVersion` below the server version): last writer wins, per field.** The server keeps a stamp (client timestamp + device ID) for whoever last wrote each field. For every payload field whose value differs from the server's, the shared function `resolveLww` compares the incoming op's stamp with that field's stamp. The later `clientTimestamp` wins; on an exact tie the lexicographically greater `deviceId` wins, so the result never depends on arrival order.
- **Field-level log:** every contested field is written to `conflict_log` with the winning value, the rejected value and both device IDs. The response status is `conflict_resolved` and the phone shows the entries on its Conflicts screen. The other phone sees them after its next sync.
- **Money flag:** conflicts on `priceKes`, `paymentMethod` or `mpesaCode` get policy `lww-flag-money` and are highlighted in the UI so a person reviews them.
- **Deletion wins:** a delete sets a tombstone, even from a stale version. Any later update (or re-sent create) for a tombstoned record is `rejected`, logged with policy `tombstone`, and the tombstone is returned so the record cannot be resurrected.
- **Own edits chain:** a phone's own queued edits (create, edit, edit made offline on the same base) are applied in order and are not reported as conflicts with each other.

One deliberate choice: the comparison is made per field rather than once per record. With a single per-record comparison, "A marks the job paid, B corrects the price" would keep both edits or drop one depending on which phone synced first. Per-field stamps give the same end state in either order, and a value is only rejected when two phones changed the same field.

## 8. Demo script

Use the live URL, or locally `npm run build && npm start` at http://localhost:8080 after `npm run seed`. Open the app in **two browser profiles**: log in on A as **Manager** and on B as **Chiku** (cashier); with `DEMO_MODE=true` the login screen lists these synthetic accounts, PIN `2468`. "Offline" means DevTools → Network → Offline. The **Developer view** (Sync tab → Developer view) shows the queue with op IDs and the demo buttons.

1. **Online create.** In A, tap **Add car**, enter a plate, save. The job shows **Synced**.
2. **Offline create, edit, delete, reload.** In A, open Developer view → **Fail next sync** (used in step 3), then go offline. The banner "Offline — changes saved on this phone" appears. Create a job, change its status, delete another job. Reload the page: the app still loads, the changes are still there marked **Not synced yet**, and the Sync tab lists the waiting changes in order (the Developer view shows their op IDs).
3. **Failed sync keeps the head op.** In A, go back online: the sync fails with a 503, the Sync tab shows the error, and the Developer view shows the same op at the head with the same op ID and everything behind it still queued. Tap **Sync now**: all ops are applied.
4. **Lost acknowledgment.** In A, Developer view → **Drop next ack**, then add a car. The server commits it but answers 503, so A still shows it as **Not synced yet**. Tap **Sync now**: the retry comes back as `duplicate` (visible in the server log) and there is exactly one car, on A, on B after it syncs, and in `GET /api/records`.
5. **Two phones edit the same job.** Pick a seeded job that is `waiting`. Put both A and B offline. In A set its status to **paid**. In B change its price. Bring A online, then B. Both edits survive on both phones, and the Conflicts tab lists the contested field with kept and rejected values and both devices, highlighted because price is a money field. To see a rejection, repeat with both phones changing the price: the later edit is kept and the earlier one is listed as rejected.
6. **Delete beats edit.** Both offline. In A delete a job. In B edit the same job. Bring A online, then B. The job stays deleted on both phones, and the Conflicts tab shows the rejected edit as "Edited after it was deleted".
7. **Restart the backend.** Restart or redeploy the server (locally: stop and `npm start` again). Reload either profile: all data is still there, because records and processed op IDs live in PostgreSQL, not on the container's disk.
8. **Roles.** Log out of B (tap the name at the top) and log in as **Amani** (attendant). Amani can add cars and mark them washing or done, but there is no **Take payment** button, the price and attendant are locked, and there is no delete. Amani's new jobs are always in Amani's name. If a change is refused by the server anyway (for example, it was queued before a role change), it leaves the queue and is listed in Conflicts as **Change refused** with the reason. In A (Manager), tap the name at the top → **Activity log** shows each change, login and refusal with who did it.

## 9. Test evidence

Full output: [`docs/test-results.txt`](docs/test-results.txt), regenerated with `npm run test:report`. 76 tests: 15 shared, 15 client (Dexie on fake-indexeddb), 46 server (Supertest against a real PostgreSQL, schema reset per test file).

| Requirement | Test |
|---|---|
| FIFO order, dequeue only after ack | `client/tests/queue.test.ts` |
| Record update + enqueue atomic | `client/tests/queue.test.ts` |
| Multiple ops per record stay separate | `client/tests/queue.test.ts` |
| Failed send keeps head, same op ID, no skipping | `client/tests/sync.test.ts` |
| Acked op skipped and removed | `client/tests/sync.test.ts` |
| Pull does not overwrite pending records | `client/tests/sync.test.ts` |
| Data survives closing and reopening the DB | `client/tests/queue.test.ts` |
| Role rules (shared), checked on the phone before queueing | `shared/src/auth.test.ts`, `client/tests/roles.test.ts` |
| Refused op leaves the queue; refused create removed locally | `client/tests/roles.test.ts` |
| Login, hashed PINs and sessions, logout, expiry, device binding | `server/tests/security.test.ts` |
| Server enforces roles on every op; refusals logged; manager-only endpoints | `server/tests/security.test.ts` |
| Rate limits, login lockout, security headers, audit log | `server/tests/security.test.ts` |
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
- **Login: name + PIN, per person.** PINs are 4 to 8 digits, stored only as scrypt hashes with a random salt. A login returns a random 256-bit session token; the server stores only its SHA-256, bound to the phone's device ID, valid 30 days (long on purpose: phones work offline for days). Unknown names and wrong PINs get the same answer and take the same time. Logout, a PIN change, a role change or switching an account off ends its sessions at once. The session is kept in IndexedDB so the app opens offline; when it ends, the unsynced queue stays on the phone and is sent after the next login.
- **Roles (RBAC), enforced on the server for every op.** One shared rule set (`shared/src/auth.ts`) is used by the server to decide and by the phone to hide controls and avoid queueing changes that would be refused.

  | | Attendant | Cashier | Manager |
  |---|---|---|---|
  | Add jobs and supplies, move a job to washing / done, edit plate, vehicle, service, water, stock | ✓ | ✓ | ✓ |
  | Take payment (status `paid`, method, M-Pesa code), reopen a paid job | | ✓ | ✓ |
  | Change a price or the attendant on an existing job | | ✓ | ✓ |
  | Delete jobs and supplies | | | ✓ |
  | Manage users, view the activity log, demo toggles | | | ✓ |

  An attendant's new job is always recorded in their own name. A session can only send ops for the device it logged in on.
- **Audit log.** Every op (applied, resolved or refused), login, failed login, logout and user change is written with who, role, device and outcome; sync ops are logged in the same transaction as the change. PINs are never logged. Managers see it under Activity.
- **Rate limits.** 600 API requests per minute per IP; 10 login attempts per minute per IP; 5 wrong PINs for one name lock that name for 15 minutes. Over the limit: `429` with `Retry-After`. Limits are in memory (one instance).
- **Security headers** on every response: Content-Security-Policy (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`, and HSTS in production. API responses are `Cache-Control: no-store`.
- **Operator token.** `SYNC_TOKEN` still works as a bearer token with manager rights for scripts and `curl`; it is compared in constant time and is no longer served to browsers. `/healthz` and the login endpoints are the only open routes.
- **Input validation.** Every op is checked with strict zod schemas (unknown fields rejected, enums, ranges, lengths) before anything is written. Body limit 100 kb. All SQL is parameterised.
- **No secrets in the repository.** `.env` is git-ignored; `.env.example` holds placeholders. The credentials in `docker-compose.yml` are for throwaway local databases.
- **Demo mode is explicit.** With `DEMO_MODE=true` the server creates four synthetic logins (Amani and Baraka, attendants; Chiku, cashier; Manager) with PIN `2468`, lists them on the login screen, and enables the failure toggles for managers. Never turn it on for real use; set `ADMIN_NAME` / `ADMIN_PIN` instead.
- **Container** runs as the non-root `node` user and stores nothing on local disk.

## 11. Known limitations

- **Client clocks decide conflicts.** Last-writer-wins uses each phone's clock. A phone with a wrong clock can win or lose unfairly. The conflict log makes this visible but does not prevent it.
- **PINs are short.** A 4-digit PIN is weak against an attacker who can try many; the per-name lockout and per-IP limit slow this down but are in memory and per instance. Use longer PINs for managers.
- **A stolen phone stays logged in** until its session expires or a manager changes that person's PIN or switches them off.
- **An invalid op blocks the queue.** By design the loop never skips the head. The client validates with the same schema as the server so a `400` should not occur, but if it did, later ops would wait behind it. (Ops refused for role reasons do not block: they are answered and leave the queue.)
- **No pruning.** `ackedOps` on the phone and `processed_ops` and `conflict_log` on the server grow without bound. The phone keeps a copy of the latest 200 conflict entries.
- **Pull is not paginated** and list screens filter in memory; fine for one car wash, not for thousands of records.
- **Writes are serialised** on the server with one advisory lock so pulls never miss a change; this limits write throughput.
- **Demo toggles are in memory**, so they apply to one server instance.
- **Offline loading needs one online visit first** (to install the service worker), and the app icon is SVG only.

## 12. AI-tool disclosure and team

- **AI tools used:** `TODO: list tools and what they were used for`
- **Team:** `TODO: names and roles`
