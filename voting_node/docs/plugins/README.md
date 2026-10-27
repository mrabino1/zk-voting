# zk-voting plugins

> NOT FOR PROFIT — civic public good, not a commercial product.

Plugins add UI pieces (banners, widgets, admin pages) or back-office features
(routes, settings, event listeners) to zk-voting **without** touching the voting
core. Product names in plugin docs and screens default to **zk-voting**; a super
admin or admin can rename the product under **Site admin → Layout → Branding**,
and plugins should read the name from `ctx.productName` rather than hard-coding one.

## Trust model (read this first)

**A server plugin runs inside the zk-voting Node process with full trust.**
The scoped API below is a *convenience and review boundary*, not a sandbox: a
malicious server entrypoint can `import` Node built-ins and do anything the
process can. Only install plugins whose source you have reviewed, from people
you trust. The safeguards below cut down mistakes and drive-by attacks. They do
not make untrusted code safe.

Client plugins run in visitors' browsers as same-origin ES modules. They may
only render into the slots they declare, and their code is scanned at import
(see *CSP-safe client code*).

Plugins never get the store, the database, crypto keys, ballots, votes, tallies,
proofs or the chain clients. Plugin code is never loaded into the ZK, circuit,
tally or contract paths.

## Security defaults

| Control | Default |
| --- | --- |
| Zip upload (`PLUGINS_ALLOW_UPLOAD`) | **off**. Repo-bundled plugins in `plugins/` still load (disabled) |
| Who can install/enable/disable/uninstall | `manage_plugins` (super_admin, admin) |
| Re-authentication | install, enable and uninstall need a sign-in within `PLUGIN_REAUTH_MS` (10 min; max 60). Otherwise `401 REAUTH_REQUIRED` |
| CSRF | `x-csrf-token` required on every write |
| State after import | **disabled**. Nothing runs until enabled |
| Permissions | shown in the enable dialog; the request must echo the exact list (`acceptPermissions`) or it fails with `400 PERMISSIONS_NOT_ACCEPTED` |
| Upload integrity | the browser sends `x-plugin-sha256`; the server recomputes it and rejects a mismatch. Optional per-file `checksums` in `plugin.json` are verified too |
| Zip size (`PLUGIN_MAX_ZIP_BYTES`) | 1 MiB (max 16 MiB); ≤ 200 entries, ≤ 2 MiB per file, ≤ 8 MiB unpacked, compression ratio ≤ 100 |
| Zip-slip | absolute paths, `..`, drive letters, backslashes, NUL, empty segments, symlinks, duplicates, encryption and ZIP64 are all rejected |
| Allowed files | `.json .mjs .js .css .md .txt .png .webp`, plus `LICENSE/NOTICE/README/CHANGELOG`. No dotfiles, no native addons, no `node_modules` |
| Storage | 64 KiB JSON per plugin |
| Audit | install, rejected install, enable, disable, uninstall → hash-chained site-admin audit log |
| Assets | `/plugins-assets/<name>/…` serves only the declared client/styles files and images, with `nosniff`, and only while enabled. `plugin.json` and server files are never served |

## Layout of a plugin

```
plugins/<name>/
  plugin.json          # manifest (required)
  server/index.mjs     # optional: export function register(api)
  client.mjs           # optional: export function register(host)
  styles.css           # optional
  README.md
```

Repo-bundled plugins live in `plugins/` at the repo root (`PLUGINS_DIR`).
Uploaded plugins are unpacked into `<DATA_DIR>/plugins` (`PLUGINS_UPLOAD_DIR`).
The folder name must equal `name`.

## Manifest (`plugin.json`)

| Field | Rules |
| --- | --- |
| `name` | `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`; unique |
| `displayName`, `description` | plain text (description ≤ 400 chars, no `<>`) |
| `version` | semver `x.y.z[-pre]` |
| `author`, `license` | required |
| `type` | `ui`, `backoffice` or `both` |
| `minAppVersion` | optional semver. Refused when the app is older |
| `permissions` | subset of the table below |
| `entrypoints` | `{ server?, client?, styles? }`, relative paths inside the package |
| `hooks` | `routes`, `adminPages`, `menu`, `layout`, `event:<event>`. Each needs its permission |
| `slots` | client slots it renders into (needs `client` and `entrypoints.client`) |
| `adminPages` | `[{ id, title, capability }]`, up to 8. The page shows at `/site-admin/plugin/<name>/<id>` to users holding `capability` |
| `menu` | `[{ label, page }]`. `page` must name one of its `adminPages` |
| `checksums` | optional `{ "<file>": "<sha256 hex>" }` |

### Permissions

| Permission | Grants |
| --- | --- |
| `routes` | HTTP routes under `/api/plugins/<name>/` |
| `admin_pages` | pages in Site admin |
| `menu` | Site admin menu items |
| `events` | app events (below) |
| `storage` | own key/value settings (64 KiB) |
| `users:read` | public user fields only (`id`, `handle`, `role`) and counts by role. Never emails or credentials |
| `elections:read` | public election summaries (no ballots, votes or keys) |
| `layout` | a layout filter (output re-validated like any layout edit) |
| `client` | a browser module in its declared slots |

## Server hooks: the scoped API

`register(api)` receives a frozen object:

| Member | Needs | Notes |
| --- | --- | --- |
| `api.name`, `api.version`, `api.appVersion`, `api.manifest`, `api.permissions` | | read-only |
| `api.log.info/warn/error` | | prefixed `[plugin:<name>]` |
| `api.routes()` | `routes` | Express router mounted at `/api/plugins/<name>/`, live only while enabled |
| `api.json({ limitBytes })` | | JSON body parser (default 16 KiB, max 64 KiB). Put it **after** the auth middleware |
| `api.requireCapability(cap)` | | `[session, csrf, capability]` middleware array. Spread it: `...api.requireCapability('edit_layout')` |
| `api.requireSession()` | | signed-in plus CSRF on writes |
| `api.can(user, cap)` | | capability check |
| `api.on(event, fn)` | `events` and `event:<event>` hook | handler errors are logged, never thrown into the app |
| `api.storage.get/all/set/delete` | `storage` | JSON values |
| `api.users.getPublic(id)`, `api.users.countByRole()` | `users:read` | |
| `api.elections.listPublic()` | `elections:read` | id, title, jurisdictionId, status, phase, dates |
| `api.layout.filter(fn)` | `layout` and `layout` hook | `fn(layout) → layout`, re-validated |

Plugin routes are **not** in the bot API-key catalogue, so API keys cannot call
them. They need a browser session.

### Events

| Event | Payload |
| --- | --- |
| `user.role_changed` | `{ userId, handle, from, to, by }` |
| `layout.updated` | `{ by, reset? }` |
| `plugin.enabled` / `plugin.disabled` | `{ name, version }` |

## Client slots

| Slot | Where |
| --- | --- |
| `banner` | full-width strip at the top of every public/office page (under the ribbon) |
| `header` | full-width strip after the banner region |
| `home` | top of `<main>` on `/` only (kept there across route renders) |
| `sidebar` | aside at the end of the side navigation |
| `footer` | top of the site footer |
| `site-admin.page` | the plugin's own admin pages (`ctx.page` = page id) |
| `site-admin.dashboard` | Site admin overview |

`register(host)` calls `host.slot(name, (root, ctx) => …)` for declared slots
only. `ctx` holds `{ plugin, version, productName, page?, fetchJson(rel, opts) }`.
`fetchJson` is confined to `/api/plugins/<name>/` and adds the CSRF token on writes.

### CSP-safe client code

`/site-admin` ships a strict Content-Security-Policy
(`script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'`…).
Client modules are rejected at import if they contain `eval`, `new Function`,
string timers, `document.write`, remote `import()` / `import … from 'https://…'` or
`javascript:` URLs. The scan is a lint, not a sandbox. Build DOM with `createElement` and `textContent`.
Put styles in the declared `styles` file, not in inline `<style>` tags.

## Install, enable, disable, uninstall

1. Bundled plugins in `plugins/` show up in **Site admin → Plugins** as *disabled*.
2. To upload, set `PLUGINS_ALLOW_UPLOAD=1`, then pack a plugin:
   `node apps/node/scripts/pack-plugin.mjs plugins/<name>`. This validates it exactly
   like the server does and prints the SHA-256.
3. Upload the zip (needs a recent sign-in). It lands **disabled**.
4. **Enable** opens a dialog with the requested permissions, the full-trust
   warning and the checksum. Confirming grants exactly those permissions.
5. **Disable** stops routes, listeners, filters, slots and assets right away.
   **Uninstall** removes uploaded plugins (repo-bundled ones can only be disabled).

A plugin that fails validation is listed with its error and cannot be enabled.

## Examples

- [`plugins/announcement-banner`](../../plugins/announcement-banner): UI. A dismissible banner plus a settings admin page (`edit_layout`).
- [`plugins/backoffice-notes`](../../plugins/backoffice-notes): back office. An admin page and gated routes for operator notes (`manage_elections`), a log of `user.role_changed` events and counts from `users:read` / `elections:read`.

## Layout overrides without plugins

The effective layout stacks these layers in order:
defaults → saved layout (Site admin, DB) → `apps/node/site/layout.json` (`LAYOUT_FILE`)
→ `apps/node/site/layout.override.mjs` (`LAYOUT_OVERRIDE_MODULE`, handwritten,
full trust) → enabled plugin layout filters. Every layer is re-validated. The
`*.example.*` files in `apps/node/site/` are inert templates. A file layer replaces
the whole `nav` and `theme` it defines, plus any non-empty region.
