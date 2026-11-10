# CH-22: one container that serves the built UI and the API from the same origin, with SQLite on a mounted volume.
# Pin the base image by digest at build time (docker buildx imagetools inspect node:22.22.0-bookworm-slim).
# The project needs Node 22.13 or later for the built-in node:sqlite module.

FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM node:22.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4300 \
    DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/app/dist ./app/dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# First start on an empty volume seeds the simulators once (idempotent bootstrap); afterwards it just starts.
# NOTE: intentionally not `[ -f /data/soc.db ] || npm run bootstrap; npm start` — the runtime image has no
# dev dependencies or TS sources, so `npm run bootstrap`/`npm start` (tsx) fail there, and the real
# database files are security.db / itsm.db / gate.db, not soc.db.
CMD ["sh", "-c", "[ -f \"${DATA_DIR:-/data}/gate.db\" ] || node dist-server/scripts/bootstrap.mjs; node dist-server/server/src/index.mjs"]
