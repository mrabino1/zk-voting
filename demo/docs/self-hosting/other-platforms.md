# Dokploy, CapRover, and plain Compose

**NOT FOR PROFIT** — civic public good. Not a commercial product.

zk-voting is plain Docker Compose with no proprietary dependencies, so it runs on any host that can run Compose. These notes cover the open-source platforms operators ask about most.

## Dokploy

[Dokploy](https://dokploy.com) deploys a Compose file from a Git repository.

1. **Create Service → Compose**. Compose type: **Docker Compose** (not Stack: Stack mode runs `docker stack deploy`, which ignores `build:`).
2. Provider: your Git fork. Branch: `master` (production) or `test/unstable` (staging). Compose path: `./docker-compose.yml` or `./docker-compose.tailscale.yml`.
3. **Environment**: paste the variables you need from `.env.example`. Dokploy writes them to a `.env` file next to the Compose file, and the `${VAR}` references pick them up.
4. **Domains**: add `vote.example.org` on service `node`, container port `3000`, HTTPS on. Set `VOTE_FQDN=vote.example.org` and `TRUST_PROXY=1`.
5. **Deploy**. Then open `https://vote.example.org/health`.

Notes:

- The named volumes `node-data` and `l2-data` survive redeploys and can be scheduled under **Volume Backups**.
- Do not bind-mount files from the repository with a relative path; Dokploy re-clones on each deploy. Use **Advanced → Mounts → File Mount** instead. The bundled Tailscale file writes its serve config itself.
- As with Coolify, published `ports:` bypass the proxy. Firewall 3000 and 8546 or remove those lines in your fork.

## CapRover

[CapRover](https://caprover.com) supports only a subset of Compose (`image`, `environment`, `ports`, `volumes`, `depends_on`, `hostname`, `cap_add`, `command`) and ignores `build`, `healthcheck`, `networks`, and `restart`. zk-voting needs `build` and health checks, so run it with plain Compose next to CapRover and let CapRover's Nginx route to it:

1. On the CapRover host, clone the repository and run it with Compose, attached to CapRover's overlay network:

   ```bash
   cp .env.example .env    # set VOTE_FQDN=vote.example.org, TRUST_PROXY=1
   cat > docker-compose.override.yml <<'YAML'
   services:
     node:
       networks: [republic, captain-overlay-network]
   networks:
     captain-overlay-network:
       external: true
   YAML
   docker compose up -d --build
   ```

2. In CapRover, create an app (for example `vote`) using the **Nginx reverse proxy** one-click app, with upstream `http://zk-voting-node:3000`.
3. Attach `vote.example.org` to that app and enable HTTPS.

Upgrades follow the plain Compose steps below.

## Plain Docker Compose (any Linux host)

Follow the [quickstart](./docker-compose.md), then put a TLS reverse proxy in front of port 3000. A minimal [Caddy](https://caddyserver.com) example:

```text
vote.example.org {
  reverse_proxy 127.0.0.1:3000
}
```

Set `VOTE_FQDN=vote.example.org` and `TRUST_PROXY=1`, then `docker compose up -d`. Prefer not to run a public proxy at all? Use the [Tailscale sidecar](./tailscale.md).
