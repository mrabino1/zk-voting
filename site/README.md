# site: zk-voting.org

The informational landing page for **zk-voting.org**. Plain static HTML and CSS, with no JavaScript, no build step, no tracking and no third-party assets.

- `public/`: the site itself (`index.html`, `styles.css`, `favicon.svg`).
- `Dockerfile` + `nginx.conf`: serves `public/` with nginx on port 80, with a `GET /health` endpoint.

## Coolify

Base directory `/site`, branch `master`, build pack **Dockerfile** (`/Dockerfile`), port **80**, health check path `/health`. No environment variables or database are needed.

Alternatively use Coolify's **Static** build pack with base directory `/site` and publish directory `/public`.

## Local preview

```bash
docker build -t zk-voting-site site && docker run --rm -p 8080:80 zk-voting-site
# or, without Docker:
python3 -m http.server -d site/public 8080
```
