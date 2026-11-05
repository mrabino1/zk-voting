# NOT FOR PROFIT — civic public good, not a commercial product.
# ZK-Voting Node: JSON API + voter / admin / back-office / explorer SPA host.
# Build from the repository root so the root .dockerignore applies.
#
# Install npm **workspaces** (`@zk-voting/chain-client` and its in-tree
# siblings). Those packages are private — they are not on the npm registry.

FROM node:24-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/node/package.json apps/node/package.json
COPY packages ./packages
RUN npm ci --omit=dev --no-audit --no-fund \
    && mkdir -p apps/node/node_modules

FROM node:24-bookworm-slim AS runner
WORKDIR /src
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

# Coolify's dashboard HTTP probe runs inside this container as
# `curl ... || wget ...` and replaces the image HEALTHCHECK unless
# Coolify has already recorded that instruction. bookworm-slim ships
# neither binary. The HEALTHCHECK below is Node and does not need them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl wget \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data \
    && chown node:node /data /src

COPY --from=deps --chown=node:node /src/node_modules ./node_modules
# npm ci leaves some production deps in apps/node/node_modules. Hoisting
# them onto the root copy is the wrong fix: @noble/curves@1.9.7 cannot
# replace the root @noble/curves@1.9.1 that viem and ox pin exactly, and
# the app's ^1.9.7 range does not accept 1.9.1. @simplewebauthn/server
# is installed in that same nested tree. Node resolves apps/node/src by
# walking apps/node/node_modules before /src/node_modules, so the runner
# has to contain the tree npm ci produced. An empty directory is copied
# when a future lockfile hoists everything.
COPY --from=deps --chown=node:node /src/apps/node/node_modules ./apps/node/node_modules
COPY --from=deps --chown=node:node /src/packages ./packages
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/node/package.json apps/node/package.json
COPY --chown=node:node apps/node/src ./apps/node/src
COPY --chown=node:node apps/node/public ./apps/node/public
COPY --chown=node:node apps/node/scripts ./apps/node/scripts
COPY --chown=node:node apps/node/legal ./apps/node/legal
COPY --chown=node:node apps/node/site ./apps/node/site
# Repo-bundled plugins (disabled until a super admin enables them).
COPY --chown=node:node plugins ./plugins
# Self-hosting guides served at /docs (read-only Markdown).
COPY --chown=node:node docs/self-hosting ./docs/self-hosting
# outcomes.mjs imports the offline auditor from the repo-root tools/ path.
COPY --chown=node:node tools/auditor/verify.mjs ./tools/auditor/verify.mjs
# Fails the image build when a runtime import is missing from this stage.
COPY --chown=node:node scripts/image-import-smoke.mjs ./scripts/image-import-smoke.mjs
COPY --chown=node:node l2/lease ./l2/lease
# Super-admin write:l2 runs the archive job (credentials blanked). That module
# imports the sequencer state helper and the disclosure clock; nothing else.
COPY --chown=node:node l2/archive ./l2/archive
COPY --chown=node:node l2/disclosure.mjs ./l2/disclosure.mjs
COPY --chown=node:node l2/sequencer/state.mjs ./l2/sequencer/state.mjs
# L2 identity, operator auth and L1 funding helpers (state.mjs imports adminAuth).
COPY --chown=node:node l2/adminAuth.mjs l2/identity.mjs ./l2/
COPY --chown=node:node l2/prover/funding.mjs ./l2/prover/funding.mjs

USER node
WORKDIR /src/apps/node
# Same module lookup as `node src/server.mjs`. Non-zero exits fail the build.
RUN node /src/scripts/image-import-smoke.mjs
EXPOSE 3000
# GET /health on PORT (default 3000). HTTP 200 is success for active and standby.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
