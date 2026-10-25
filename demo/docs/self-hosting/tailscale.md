# Tailscale sidecar

**NOT FOR PROFIT** — civic public good. Not a commercial product.

`docker-compose.tailscale.yml` is the full zk-voting stack plus a [`tailscale/tailscale:stable`](https://hub.docker.com/r/tailscale/tailscale) sidecar. It joins the Node to your tailnet, issues an HTTPS certificate for a `*.ts.net` name, and proxies to the Node. Use it to:

- give officers and operators **private access** without opening any public port;
- get **HTTPS for passkeys** with no domain or reverse proxy of your own;
- optionally publish the voting site to the internet with **Tailscale Funnel**.

The Tailscale client is open source (BSD-3-Clause). A coordination server is required: Tailscale's hosted service, or the open-source [Headscale](https://github.com/juanfont/headscale).

## 1. Create an auth key

In the Tailscale admin console, open **Settings → Keys → Generate auth key**. A reusable, tagged key (for example `tag:zk-voting`) is best for servers. Turn on **MagicDNS** and **HTTPS certificates** for the tailnet.

## 2. Configure

Add to `.env`:

```env
TS_AUTHKEY=tskey-auth-...        # required
TS_HOSTNAME=zk-voting            # machine name on the tailnet
VOTE_FQDN=zk-voting.your-tailnet.ts.net
TRUST_PROXY=1
```

`VOTE_FQDN` must be the exact HTTPS name Tailscale serves (`<TS_HOSTNAME>.<tailnet>.ts.net`), otherwise passkeys are refused.

## 3. Start

```bash
docker compose -f docker-compose.tailscale.yml up -d --build
docker compose -f docker-compose.tailscale.yml ps
```

Open `https://zk-voting.your-tailnet.ts.net` from any device on the tailnet. The first HTTPS request can take a few seconds while the certificate is issued.

## How it is wired

| Setting | Value | Why |
| --- | --- | --- |
| `TS_AUTHKEY` | `${TS_AUTHKEY:?}` | Required. Compose (and Coolify) refuse to start without it. |
| `TS_HOSTNAME` | `${TS_HOSTNAME:-zk-voting}` | Tailnet machine name. |
| `TS_STATE_DIR` | `/var/lib/tailscale` on volume `tailscale-state` | Keeps the node identity across restarts, so the key is used once and the name stays stable. |
| `TS_USERSPACE` | `true` | No `NET_ADMIN` capability or `/dev/net/tun` needed. |
| `TS_SERVE_CONFIG` | `/config/serve.json` | Written at start-up: HTTPS on 443 proxies to `http://node:3000`. `${TS_CERT_DOMAIN}` is filled in by Tailscale. |
| `TS_FUNNEL` | `${TS_FUNNEL:-false}` | `true` publishes the site to the internet through Funnel (the tailnet policy must allow Funnel for this node). |
| `TS_ENABLE_HEALTH_CHECK` | `true` | Serves `/healthz` on `TS_LOCAL_ADDR_PORT` (`127.0.0.1:9002`): HTTP 200 once the node has a tailnet IP. |
| Network | `republic` | Same Compose network as `node`, so the proxy reaches `node:3000`. |

The `node` and `l2` ports are bound to `127.0.0.1` in this file, so nothing is reachable from the public network except through Tailscale (or a proxy you add).

## Behind Coolify or Dokploy

Pick `docker-compose.tailscale.yml` as the Compose file and set `TS_AUTHKEY` in the UI. You can keep a public Coolify domain on `node` and use the tailnet name for officer access, or skip the public domain and use Funnel. Only one name can be `VOTE_FQDN` (the passkey authority), so choose the one voters will use.

## Alternative: share the network namespace

Instead of the serve proxy, the Node can run inside the sidecar's network namespace with `network_mode: service:tailscale` on `node`. Then `node` cannot join other Compose networks, and `CHAIN_RPC` must point at an address reachable from the sidecar. The bundled file uses the proxy because it keeps the default topology unchanged.

## Troubleshooting

- `docker compose logs tailscale` shows the login URL or auth errors. An expired or single-use key that was already consumed needs a new key, or remove the `tailscale-state` volume to re-register.
- Health stays `starting`: the node has no tailnet IP yet. Check the key and that the host can reach the coordination server over HTTPS.
- Passkey errors: `VOTE_FQDN` must equal the `*.ts.net` name exactly, without `https://`.
