# NOT FOR PROFIT — civic public good, not a commercial product.
# Republic Node: JSON API + voter / admin / back-office / explorer SPA host.
# Build from the repository root so the root .dockerignore applies.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY apps/node/package.json apps/node/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data \
    && chown node:node /data /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node apps/node/package.json apps/node/package-lock.json ./
COPY --chown=node:node apps/node/src ./src
COPY --chown=node:node apps/node/public ./public
COPY --chown=node:node docker/healthcheck.mjs /healthcheck.mjs

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
    CMD ["node", "/healthcheck.mjs", "http://127.0.0.1:3000/health"]
CMD ["node", "src/server.mjs"]
