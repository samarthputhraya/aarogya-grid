# Aarogya Grid — Cloud Run image.
#
# WHY CLOUD RUN AND NOT A KEY IN AN ENV VAR
# -----------------------------------------
# This project's Google Cloud organisation disallows both API keys and service
# account key files. That is a sensible policy and it rules out the usual
# "paste a credential into the hosting provider" deployment entirely.
#
# On Cloud Run the service account attaches to the service itself, so the
# container receives Application Default Credentials from the metadata server.
# There is no long-lived secret to create, rotate, leak, or forget to revoke,
# and inference stays inside asia-south1 with the rest of the workload.

# ---------- deps ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The 128 prerendered district routes read src/data/districts/*.json from disk
# at build time, so the data must be present here, not just at runtime.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root, because a container that does not need to be root should not be.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# Cloud Run injects PORT; 8080 is its default and the right thing to bind when
# it does not. HOSTNAME must be 0.0.0.0 or the server listens on loopback only
# and every request times out with no error in the logs.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
EXPOSE 8080

CMD ["node", "server.js"]
