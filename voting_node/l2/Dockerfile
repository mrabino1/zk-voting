# NOT FOR PROFIT — civic public good, not a commercial product.
# ZK-Voting L2 operator: follows ZkVotingRollup on L1, accepts ballots, settles batches.
# Build from the voting_node directory so the shared modules can be copied.

FROM node:24.22.3-bookworm-slim
ENV NODE_ENV=production \
    L2_RPC_HOST=0.0.0.0 \
    L2_RPC_PORT=8546 \
    L2_DATA_DIR=/data \
    NODE_PATH=/opt/deps/node_modules

# Same probe tools as the Node image (Coolify runs `curl ... || wget ...`).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl wget \
    && rm -rf /var/lib/apt/lists/*

# The operator imports the ballot cryptography and the contract ABIs by relative
# path (../../apps/node/public, ../../packages/chain-client); keep that layout.
# ESM `import 'viem'` ignores NODE_PATH, so /node_modules links to /opt/deps/node_modules
# (resolution walks up from /l2/rollup to /node_modules). NODE_PATH stays for require().
COPY l2/ /l2/
COPY apps/node/public/ballot-crypto.js apps/node/public/keccak.js apps/node/public/poseidon.js /apps/node/public/
COPY packages/chain-client/ /packages/chain-client/
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /opt/deps /data \
    && cd /opt/deps \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund viem@2.56.5 \
    && ln -s /opt/deps/node_modules /node_modules \
    && printf '{"type":"module"}\n' > /apps/node/package.json \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && chown -R node:node /l2 /apps /packages /data /opt/deps \
    && node --input-type=module -e "await import('/l2/rollup/operator.mjs'); await import('/l2/rollup/l1.mjs'); await import('/l2/rollup/server.mjs'); await import('/l2/rollup/boot.mjs')"

WORKDIR /l2
# Stay root so the entrypoint can hand a fresh volume to the node user, then drop it.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
EXPOSE 8546
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.L2_RPC_PORT||8546)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "rollup/main.mjs"]
