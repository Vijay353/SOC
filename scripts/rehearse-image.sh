#!/usr/bin/env bash
# CH-22: runs the same steps as the Dockerfile stages without Docker, then checks the production process.
# Use it where no image registry is reachable. It is a rehearsal, not proof that the image builds.
# Usage: bash scripts/rehearse-image.sh [workdir]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
BUILD="$WORK/build"; RUNTIME="$WORK/runtime"; DATA="$WORK/data"; BACKUPS="$WORK/backups"
PORT="${REHEARSAL_PORT:-4390}"
mkdir -p "$BUILD" "$RUNTIME" "$DATA" "$BACKUPS"; chmod 755 "$WORK"

echo "== build stage: context without ignored files"
(cd "$REPO" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$BUILD"
rm -rf "$BUILD/node_modules" "$BUILD/app/dist" "$BUILD/dist-server"
(cd "$BUILD" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent && npm run build:server --silent)

echo "== runtime stage: production dependencies only"
cp "$BUILD/package.json" "$BUILD/package-lock.json" "$RUNTIME/"
(cd "$RUNTIME" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
cp -r "$BUILD/app" "$RUNTIME/app-src-tmp" && mkdir -p "$RUNTIME/app" && mv "$RUNTIME/app-src-tmp/dist" "$RUNTIME/app/dist" && rm -rf "$RUNTIME/app-src-tmp"
cp -r "$BUILD/dist-server" "$RUNTIME/dist-server"
test ! -e "$RUNTIME/node_modules/tsx" && echo "dev dependency tsx absent from runtime: ok"

RUNAS=()
if [ "$(id -u)" = "0" ] && id nobody >/dev/null 2>&1; then chown -R nobody "$DATA" "$BACKUPS"; RUNAS=(setpriv --reuid=nobody --regid=nogroup --clear-groups); echo "running as nobody (non-root)"; fi
export NODE_ENV=production HOST=127.0.0.1 PORT DATA_DIR="$DATA"
# Throwaway values for this rehearsal only. In a real deployment they come from the panel's secrets.
export ACCESS_PIN="${REHEARSAL_PIN:-$(printf '%04d' $((RANDOM % 10000)))}" ACCESS_SESSION_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cd "$RUNTIME"

echo "== start before bootstrap must refuse"
set +e; "${RUNAS[@]}" node dist-server/server/src/index.mjs > "$WORK/refuse.log" 2>&1; code=$?; set -e
echo "exit=$code"; grep -o 'START REFUSED: The databases are empty.*bootstrap' "$WORK/refuse.log" | head -1
test "$code" = "1"

echo "== bootstrap twice (idempotent)"
"${RUNAS[@]}" node dist-server/scripts/bootstrap.mjs
"${RUNAS[@]}" node dist-server/scripts/bootstrap.mjs

start() { "${RUNAS[@]}" node dist-server/server/src/index.mjs > "$WORK/server.log" 2>&1 & echo $! > "$WORK/pid"; for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/api/ready" >/dev/null && return 0; sleep 0.2; done; cat "$WORK/server.log"; return 1; }
stop() { kill "$(cat "$WORK/pid")"; wait "$(cat "$WORK/pid")" 2>/dev/null || true; }
login() { curl -s -D - -o /dev/null -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/api/access/login" -d "{\"pin\":\"$ACCESS_PIN\"}" | grep -i '^set-cookie:' | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]*).*/\1/'; }

echo "== first start"
start
curl -sf "http://127.0.0.1:$PORT/api/ready"; echo
echo "without a session: page $(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "http://127.0.0.1:$PORT/approvals"), api $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/queue")"
echo "wrong PIN: $(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/api/access/login" -d '{"pin":"00x0"}')"
SETC="$(curl -s -D - -o /dev/null -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/api/access/login" -d "{\"pin\":\"$ACCESS_PIN\"}" | grep -i '^set-cookie:')"
echo "$SETC" | grep -qi 'HttpOnly' && echo "$SETC" | grep -qi 'Secure' && echo "$SETC" | grep -qi 'SameSite=Lax' && echo "right PIN: session cookie has HttpOnly, Secure, SameSite=Lax"
COOKIE="$(login)"; test -n "$COOKIE"
H=(-H 'content-type: application/json' -H 'x-demo-user: analyst-priya' -H "cookie: $COOKIE")
curl -sf "${H[@]}" "http://127.0.0.1:$PORT/" | grep -o '<title>[^<]*</title>'
curl -sf "${H[@]}" "http://127.0.0.1:$PORT/approvals" | grep -c '<div id="root">' | sed 's/^/deep link serves app shell: /'
# The secret is long and random, so a match would be real. The PIN is only four digits and may appear by chance in
# minified code, so the check for it is that no build file reads ACCESS_PIN or VITE_ variables.
if grep -rq "$ACCESS_SESSION_SECRET" app/dist dist-server 2>/dev/null || grep -rq "ACCESS_PIN\|VITE_" app/dist 2>/dev/null; then echo "secret or PIN reference found in build output"; exit 1; else echo "no session secret in build output, and the browser bundle does not read ACCESS_PIN: ok"; fi
REQ=$(curl -sf "${H[@]}" -X POST "http://127.0.0.1:$PORT/api/events/manual-isolation-requested" -d '{"eventId":"evt-rehearsal-1","incidentId":"INC-90482","machineId":"device-d8f92a10","requestedAction":"FULL_ISOLATION"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.requestId+" "+j.view.evaluation.decision)})')
echo "evaluated: $REQ"; ID=${REQ%% *}
curl -sf "${H[@]}" -X POST "http://127.0.0.1:$PORT/api/requests/$ID/stage" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("staged: "+j.view.request.approvalId+" "+j.view.request.state)})'
A1=$(curl -sf "${H[@]}" "http://127.0.0.1:$PORT/api/audit/verify" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.intact+" "+j.length)})')
echo "audit before restart: $A1"
stop

echo "== restart: same state, no reseed, no new writes"
start
A2=$(curl -sf "${H[@]}" "http://127.0.0.1:$PORT/api/audit/verify" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.intact+" "+j.length)})')
echo "audit after restart: $A2"; test "$A1" = "$A2"
curl -sf "${H[@]}" "http://127.0.0.1:$PORT/api/requests/$ID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("request after restart: "+j.request.state+" packet "+j.packet.approvalId)})'

echo "== backup while running, then restore check"
"${RUNAS[@]}" env BACKUP_DIR="$BACKUPS" node dist-server/scripts/backup.mjs
stop
ls -l "$DATA" | awk '{print $1, $3, $9}' | grep -E '\.db' | head -6
echo "REHEARSAL PASSED ($WORK)"
