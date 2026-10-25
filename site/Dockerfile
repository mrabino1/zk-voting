# NOT FOR PROFIT: civic public good, not a commercial product.
# zk-voting.org informational site. Static HTML/CSS served by nginx.
# Coolify: base directory /site, build pack Dockerfile, port 80, health check GET /health.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/health >/dev/null || exit 1
