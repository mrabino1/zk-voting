# NOT FOR PROFIT — civic public good, not a commercial sequencer.
# ZK-Voting L2 sequencer + prover. Same image, different compose command.
# Build from the repository root so the root .dockerignore applies.

FROM node:24-bookworm-slim
WORKDIR /l2
ENV NODE_ENV=production \
    L2_RPC_HOST=0.0.0.0 \
    L2_RPC_PORT=8546 \
    L2_DATA_DIR=/data \
    DEV_MOCK_PROOF=true \
    NODE_PATH=/opt/deps/node_modules

# Same Coolify probe as the Node image: `curl ... || wget ...` inside the
# container. The HEALTHCHECK below is Node. bookworm-slim has neither client.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl wget \
    && rm -rf /var/lib/apt/lists/*

COPY l2/ ./
# These two modules live in the Node app. The sequencer imports them by a
# relative path that resolves to /apps/node/src when this image's workdir is /l2.
# Without them the process exits before /health exists and Compose marks l2 unhealthy.
COPY apps/node/src/disclosure.mjs apps/node/src/electionType.mjs /apps/node/src/
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# viem is only needed when L1_RPC + SETTLEMENT_ADDRESS + PRIVATE_KEY are set.
RUN mkdir -p /opt/deps /data \
    && cd /opt/deps \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund viem@2.56.5 \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && chown -R node:node /l2 /apps /data /opt/deps \
    && node --input-type=module -e "await import('/l2/sequencer/state.mjs')"

# Stay root so the entrypoint can hand a fresh volume to the node user.
# The entrypoint drops privileges before sequencer/index.mjs.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
EXPOSE 8546
# GET /health on L2_RPC_PORT (default 8546). HTTP 200 is success for active and standby.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=8 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.L2_RPC_PORT||8546)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "sequencer/index.mjs"]
