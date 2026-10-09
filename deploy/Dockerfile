# syntax=docker/dockerfile:1
# Satu Dockerfile untuk API dan dashboard. Build dari akar repositori: docker compose -f deploy/docker-compose.yml build

# ---- dependensi: hanya workspace yang dipakai server (tanpa Capacitor/Android dari apps/pos) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/bank-parsers/package.json packages/bank-parsers/
COPY packages/domain/package.json packages/domain/
COPY packages/events/package.json packages/events/
COPY packages/order/package.json packages/order/
COPY packages/pos-core/package.json packages/pos-core/
COPY packages/reconciliation/package.json packages/reconciliation/
COPY packages/rules/package.json packages/rules/
COPY packages/sim/package.json packages/sim/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/admin/package.json apps/admin/
COPY apps/pos/package.json apps/pos/
RUN npm ci --workspace=@pos/api --workspace=@pos/dashboard --workspace=@pos/admin --include-workspace-root

# ---- API ----
FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/api ./apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrasi database berjalan otomatis saat API start.
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]

# ---- dashboard: build ----
FROM deps AS dashboard-build
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @pos/dashboard

# ---- dashboard: jalan ----
FROM node:22-bookworm-slim AS dashboard
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=dashboard-build --chown=node:node /app ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "-w", "@pos/dashboard"]

# ---- konsol admin platform: build ----
FROM deps AS admin-build
COPY tsconfig.json ./
COPY apps/admin ./apps/admin
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @pos/admin

# ---- konsol admin platform: jalan ----
FROM node:22-bookworm-slim AS admin
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=admin-build --chown=node:node /app ./
USER node
EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3003/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "-w", "@pos/admin"]
