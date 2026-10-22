# NOT FOR PROFIT — civic public good, not a commercial product.
# Republic Node: JSON API + voter / admin / back-office / explorer SPA host.
# Build from the repository root so the root .dockerignore applies.
#
# Install npm **workspaces** (`@zk-voting/chain-client` and its in-tree
# siblings). Those packages are private — they are not on the npm registry.

FROM node:22-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/node/package.json apps/node/package.json
COPY packages ./packages
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runner
WORKDIR /src
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

# Coolify's container health check shells out to curl, then wget.
# bookworm-slim ships neither. The image HEALTHCHECK below uses node.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data \
    && chown node:node /data /src

COPY --from=deps --chown=node:node /src/node_modules ./node_modules
COPY --from=deps --chown=node:node /src/packages ./packages
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/node/package.json apps/node/package.json
COPY --chown=node:node apps/node/src ./apps/node/src
COPY --chown=node:node apps/node/public ./apps/node/public
COPY --chown=node:node apps/node/scripts ./apps/node/scripts
COPY --chown=node:node apps/node/legal ./apps/node/legal
# outcomes.mjs imports the offline auditor from the repo-root tools/ path.
COPY --chown=node:node tools/auditor/verify.mjs ./tools/auditor/verify.mjs
COPY --chown=node:node l2/lease ./l2/lease
# Super-admin write:l2 runs the archive job (credentials blanked). That module
# imports the sequencer state helper and the disclosure clock; nothing else.
COPY --chown=node:node l2/archive ./l2/archive
COPY --chown=node:node l2/disclosure.mjs ./l2/disclosure.mjs
COPY --chown=node:node l2/sequencer/state.mjs ./l2/sequencer/state.mjs
COPY --chown=node:node docker/healthcheck.mjs /healthcheck.mjs

USER node
WORKDIR /src/apps/node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
    CMD ["node", "/healthcheck.mjs", "http://127.0.0.1:3000/health"]
CMD ["node", "src/server.mjs"]
