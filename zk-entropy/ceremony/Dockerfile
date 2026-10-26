# NOT FOR PROFIT — zk-voting public entropy ceremony.
# Build context is the zk-entropy/ directory (Coolify base directory /zk-entropy,
# Dockerfile location ceremony/Dockerfile):
#   docker build -f ceremony/Dockerfile -t zk-entropy-ceremony zk-entropy
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./package.json
COPY src ./src
COPY ceremony/package.json ceremony/package-lock.json ./ceremony/
RUN cd ceremony && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY ceremony/src ./ceremony/src
COPY ceremony/public ./ceremony/public

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
WORKDIR /app/ceremony
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
