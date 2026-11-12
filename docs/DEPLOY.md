# Deploying WashLog

WashLog deploys as **one container** (app + API on one URL) plus **one PostgreSQL database**. Nothing is stored on the container's disk: records, processed op IDs and the conflict log all live in PostgreSQL, so the container can be restarted or redeployed freely.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. If the provider requires TLS, add the provider's recommended `sslmode` parameter to the URL. |
| `SYNC_TOKEN` | yes | Long random string. The server will not start without it. |
| `PORT` | no | Defaults to 8080. The server listens on whatever the platform sets. |
| `GIT_SHA` | no | Shown as `revision` in `/healthz`. Can also be passed as a build arg. |
| `DEMO_MODE` | no | Set to `true` only if the demo failure toggles are wanted. |

| `SEED_ON_START` | no | `true` loads the synthetic demo data on every start (idempotent). Use it when the database cannot be reached from outside the platform. |

No build arguments are required. The client reads the sync token from the server at runtime, so changing `SYNC_TOKEN` only needs a restart. (`VITE_SYNC_TOKEN` still works as an optional build-time fallback.)

## Generic Docker steps

```bash
# 1. Build (from the repository root)
docker build \
  --build-arg GIT_SHA="$(git rev-parse --short HEAD)" \
  -t washlog .

# 2. Run
docker run -p 8080:8080 \
  -e DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME" \
  -e SYNC_TOKEN="$SYNC_TOKEN" \
  -e DEMO_MODE=true \
  washlog

# 3. Verify
curl http://localhost:8080/healthz
# {"status":"ok","db":"ok","revision":"<sha>"}
```

- Migrations in `server/migrations/` run automatically on every start and are idempotent. No manual step is needed.
- Optional: load the synthetic demo data once with `DATABASE_URL=... npm run seed` from a checkout (safe to re-run).
- Health check path for the platform: `GET /healthz` (returns 503 if the database is unreachable).

To try the exact production image locally with its own database:

```bash
docker compose --profile app up --build   # http://localhost:8080
```

## PrimeCloud

> **Placeholder.** Follow the official PrimeCloud guide for the hackathon and record the exact steps here. No PrimeCloud-specific commands have been assumed.

- [ ] Create a PostgreSQL database; copy its connection string into `DATABASE_URL`.
- [ ] Create a service from this repository's `Dockerfile`.
- [ ] Set the environment variables above and the `VITE_SYNC_TOKEN` build argument.
- [ ] Set the health check to `/healthz`.
- [ ] Deploy, then fill in the live URL, `/healthz` URL and commit in `README.md` section 2.
- [ ] Redeploy once and confirm the data is still there (demo step 7).
