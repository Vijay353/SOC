# Deployment: one small VPS (CH-22)

Status: **CH-22A TESTED_LOCALLY** (production process, without Docker). **Image: CONFIGURED** (Dockerfile written; not built here, because no image registry was reachable from the build environment). **CH-22B: NOT DEPLOYED** (needs your server, DNS and authorization). Nothing in this file has been run against a live server.

## 1. Runtime audit (what the repository actually does)

| Item | Finding |
|---|---|
| Node | Node 22.13 or later (built-in `node:sqlite`, no native addon). Checked on Node 22.22.0. |
| Processes | One Node process serves the built UI (`app/dist`), the Gate API (`/api`) and both simulators (`/sim/*`) on one port, so UI and API share one origin. |
| Databases | Three SQLite files in `DATA_DIR`: `security.db`, `itsm.db`, `gate.db`, each in WAL mode. The `-wal` and `-shm` files stay next to them. |
| Migrations | Additive and idempotent, run on open (`ALTER TABLE ... ADD COLUMN` when missing, audit anchor on first open). Tested on fresh files and on a file written by the pre-V3 code. |
| Seeding | Development: seeds empty stores on start. Production: never on start. Seeding is the explicit `bootstrap` step, which only fills empty stores and never resets. |
| Clock | The demo has a scenario clock. In production its position is stored in `gate.db` so a restart continues it instead of going back to 06:14. |
| SPA fallback | Any path not under `/api` or `/sim` returns `index.html`, so deep links work. |
| Health | `GET /api/health` (liveness) and `GET /api/ready` (each database answers `SELECT 1`; read-only). |
| Server bundle | `npm run build:server` bundles the server and the two scripts with esbuild into `dist-server/`; runtime needs production dependencies only. |

## 2. Build and run

```bash
docker build -t business-impact-gate:$(git rev-parse --short HEAD) .
docker run -d --name gate -p 127.0.0.1:4300:4300 \
  -v /srv/gate/data:/data -v /srv/gate/backups:/backups \
  --memory 512m business-impact-gate:<sha>
```

The container's command seeds the simulators once on first start (when `$DATA_DIR/gate.db` is missing)
and just starts otherwise, so no separate `docker exec ... bootstrap` step is needed. The bootstrap only
fills empty stores and never resets.

### Coolify: custom start command (recommended) and healthcheck

If you prefer an explicit start command instead of the image default, set Coolify
Applications / SOC / Configuration / General / Custom Start Command to:

```bash
sh -c "node dist-server/scripts/bootstrap.mjs && node dist-server/server/src/index.mjs"
```

Use the node dist-server paths, not npm start: the runtime image installs
production dependencies only, so npm start (tsx on TypeScript sources not in the
image) fails there, while the compiled bundles under dist-server are what the
image contains. The bootstrap is idempotent, so running it on every start is safe.

Healthcheck: keep the /api/ready check but give the first start room to seed. In
Coolify's Healthcheck menu, either temporarily disable the healthcheck or set the
start period to 45s (the image also uses a 45s start period). Save and confirm
the Saved indicator.

The container runs as the `node` user. Create the host directories first and give them to uid 1000: `sudo install -d -o 1000 -g 1000 -m 700 /srv/gate/data /srv/gate/backups`. If `DATA_DIR` is missing, not a directory or not writable, the process stops with `START REFUSED` and a reason. If the databases are empty, it stops and tells you to run the bootstrap.

Run exactly **one** container against a data directory. SQLite here is a single-writer store: no replicas, no shared mount between containers.

Pin the base image by digest before the first production build (`docker buildx imagetools inspect node:22.22.0-bookworm-slim`), then replace the tag in both `FROM` lines with `node:22.22.0-bookworm-slim@sha256:...`. TO_VERIFY: the tag and digest at build time.

## 3. Panel (for example Coolify) and host

These steps are for you to run. Nothing here was run, and no installer, firewall change, push or deploy was done from this project.

1. Install the panel with its current official installer and docs. Check current server sizes and prices with your provider at that time.
2. Firewall: SSH only from your address where practical; 80 and 443 public; the panel port closed or restricted after setup. Confirm before enforcing: Docker-published ports can bypass host firewall rules, so publish the app port only on 127.0.0.1 or not at all and let the panel proxy reach the container on its internal network.
3. App: build from this repository's Dockerfile. One instance. Persistent volume at `/data` (and `/backups`). Container port is whatever `PORT` is set to (Dockerfile default 4300; Coolify example uses 8080). Health check path `/api/ready`.
4. Environment (panel secrets, never committed): `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=4300` (or 8080 on Coolify), `DATA_DIR=/data`, `ACCESS_PIN`, `ACCESS_SESSION_SECRET`, `TRUST_PROXY=1`. Coolify aliases work too: `SOC_ACCESS_PIN`, `SOC_ACCESS_SESSION_SECRET` (also `SOC_SESSION_SECRET`), `SOC_TRUST_PROXY` (`true` means one proxy), `SOC_ACCESS_GATE=true`, `SOC_ALLOW_DEMO_RESET=false` (or `ALLOW_DEMO_RESET=false`) keeps `POST /api/lab/reset` disabled in production, and `SOC_CLARITY_PROJECT_ID` or `VITE_CLARITY_PROJECT_ID` for the Clarity ID (`VITE_CLARITY_ALLOW_LOCAL` only matters locally). See `docs/ACCESS-AND-ANALYTICS.md` and `.env.example`.
5. DNS: point the domain at the server; let the panel issue TLS and redirect HTTP to HTTPS once DNS resolves.
6. Resources: start with a 512 MB memory limit, then set it from what `docker stats` shows during the demo. Check memory before adding swap; swap is not a substitute for RAM.

## 4. Backups and restore

A mounted volume is not a backup. `scripts/backup.ts` uses SQLite `VACUUM INTO` for each database, which gives a consistent copy while the server keeps writing. It writes a manifest (size, SHA-256, row counts, audit chain result), then restores the copy into a throwaway directory and compares it with the manifest.

```bash
docker exec -e BACKUP_DIR=/backups gate node dist-server/scripts/backup.mjs
# old backups beyond BACKUP_KEEP (default 7) are only listed; add -e BACKUP_PRUNE=yes to remove them
```

Schedule it (host cron or the panel's scheduled task), then copy `/srv/gate/backups` off the host (for example to object storage) with its own credentials. Keep panel configuration backups separate from these database backups.

Restore (throwaway check first): stop the container, copy a backup's three `.db` files into an empty directory, start a second container on that directory with another port, check `/api/audit/verify` and the request list, then swap the directories and start the original container.

Image cleanup: use the panel's cleanup setting. Without one, run `docker image prune --filter "until=168h"` as a dry run first by listing `docker image ls`, keep the image of the previous release for rollback, and never prune volumes.

## 5. Acceptance and rollback

Before switching public traffic, on the real server:

1. Record the Git SHA and image ID.
2. `curl -fsS https://<domain>/api/ready`, then open the app, a deep link (for example `/approvals`), and run the seeded scenario on the demo database: prepare the SAP gateway review, stage the packet, check `Check the audit log` in the Inspector.
3. `docker restart gate`, then confirm the same request, the same packet and the same audit length, with no new rows and no reseed.
4. Redeploy the same image with the same volume and check again.
5. Take a backup and confirm the restore check passes.

Rollback: start the previous image on the same volume. Migrations are additive, so the previous V3 image can read the files. Going back to code from before V3 also works (it ignores the new columns and settings). A schema downgrade beyond that needs a reviewed restore from backup, not an automatic reverse migration.

Reset (throwaway demo instances only, never as normal start-up): stop the container, empty the data directory, start it, run the bootstrap.

## 6. Local evidence (CH-22A)

`bash scripts/rehearse-image.sh /tmp/rehearsal` runs the Dockerfile's steps without Docker: clean `npm ci`, `npm run build`, `npm run build:server`, a runtime folder with production dependencies only, then the server as the unprivileged `nobody` user with `NODE_ENV=production`. It checks: start refused before bootstrap, bootstrap twice, readiness, the app and a deep link, the seeded scenario staged, restart with the same audit length and the same packet, and a backup with a passing restore check. The output from the run recorded in `docs/V3-CHANGE-REPORT.md` is real. This is a rehearsal: it does not prove that the image builds or that the panel is configured.
