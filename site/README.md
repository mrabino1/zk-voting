# site: zk-voting.org

The informational landing page for **zk-voting.org**: what ZK Voting is, who it's for, why it matters, when a poll shows per-choice counts and turnout and when a vote shows turnout during the election and choices only at the deadline, and a prominent link to the community forum at https://community.zk-voting.org. Plain static HTML and CSS, with no JavaScript, no build step, no tracking and no third-party assets.

The voting demo is a separate app (`voting_node/`). This site only links to it; never embed or iframe it here.

- `public/`: the site itself (`index.html`, `styles.css`, `favicon.svg`).
- `Dockerfile` + `nginx.conf`: serves `public/` with nginx on port 80, with a `GET /health` endpoint.
- `check-assets.sh`: checks the `?v=<hash>` cache-busting versions on local assets (CSS, SVG and so on) referenced from the HTML pages. After changing an asset, run `site/check-assets.sh --fix` and commit the updated HTML.

## Caching

HTML is served with `Cache-Control: no-cache`, so browsers always revalidate it. Local assets are linked as `file?v=<first 10 hex of its sha256>`, so a changed file gets a new URL and a stale cached copy (from the server, a CDN or the browser) is never reused. The infographic SVGs also carry their own colors and font sizes as presentation attributes, so they stay legible even if `styles.css` is stale or fails to load.

## Coolify

Base directory `/site`, branch `master`, build pack **Dockerfile** (`/Dockerfile`), port **80**, health check path `/health`. No environment variables or database are needed.

Alternatively use Coolify's **Static** build pack with base directory `/site` and publish directory `/public`.

## Local preview

```bash
docker build -t zk-voting-site site && docker run --rm -p 8080:80 zk-voting-site
# or, without Docker:
python3 -m http.server -d site/public 8080
```
