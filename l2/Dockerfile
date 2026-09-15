# NOT FOR PROFIT — civic public good, not a commercial sequencer.
# Republic L2 sequencer + prover. Same image, different compose command.
# Build from the repository root so the root .dockerignore applies.

FROM node:22-bookworm-slim
WORKDIR /l2
ENV NODE_ENV=production \
    L2_RPC_HOST=0.0.0.0 \
    L2_RPC_PORT=8546 \
    L2_DATA_DIR=/data \
    DEV_MOCK_PROOF=true \
    NODE_PATH=/opt/deps/node_modules

COPY l2/ ./
COPY docker/healthcheck.mjs /healthcheck.mjs

# viem is only needed when L1_RPC + SETTLEMENT_ADDRESS + PRIVATE_KEY are set.
RUN mkdir -p /opt/deps /data \
    && cd /opt/deps \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund viem@2.56.5 \
    && chown -R node:node /l2 /data /opt/deps

USER node
EXPOSE 8546
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=8 \
    CMD ["node", "/healthcheck.mjs", "http://127.0.0.1:8546/health"]
CMD ["node", "sequencer/index.mjs"]
