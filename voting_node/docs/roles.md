# Roles and capabilities

> NOT FOR PROFIT — civic public good, not a commercial product.

Site administration works like WordPress roles: each role is a set of
**capabilities**, and every Site admin route checks a capability **on the server**.
The UI only hides what you can't use. Screens live at `/site-admin`
(Roles & users, Layout, Plugins, Audit).

## Roles

| Role (id) | Aliases | Capabilities |
| --- | --- | --- |
| Super admin (`platform_super_admin`) | `super_admin`, `superadmin` | all |
| Admin (`platform_admin`) | `admin` | all except `manage_admins` |
| Designer (`designer`) | `editor` | `access_site_admin`, `edit_layout` |
| Election manager (`election_manager`) | | `access_site_admin`, `manage_elections` |
| Auditor (`auditor`) | | `access_site_admin`, `view_audit`, `view_users` |
| Moderator (`moderator`) | | `access_site_admin`, `moderate_content` |
| Voter and existing officer roles | | none in Site admin (their existing permissions are unchanged) |

## Capabilities

| Capability | Allows |
| --- | --- |
| `access_site_admin` | open `/site-admin` |
| `view_users` | list users (id, handle, role. No emails) |
| `manage_roles` | change roles that aren't admin roles |
| `manage_admins` | grant or remove `platform_super_admin` / `platform_admin` |
| `edit_layout` | nav, regions/widgets, visibility, order, theme tokens |
| `manage_branding` | rename the product (default **ZK-Voting**) |
| `manage_plugins` | install, update, enable, disable, uninstall plugins |
| `manage_elections` | election back-office plugin pages (e.g. backoffice-notes) |
| `view_audit` | read and verify the site-admin audit chain |
| `moderate_content` | reserved for moderation plugins |

## Rules

- `SUPER_ADMIN_EMAIL` is still the bootstrap super admin and is promoted on sign-in as before.
- Only holders of `manage_admins` (super admins) can grant or remove admin roles.
  An admin can assign designer, election manager, auditor, moderator or voter.
- **The last super admin can't be demoted** (`409 LAST_SUPER_ADMIN`).
- Suspended users have no capabilities.
- Every role change is audit-logged with actor, before, after and result. That covers
  `PUT /api/site-admin/users/:id/role`, the legacy `PATCH /api/admin/users/:id` and
  `/api/admin/admins`. Denied attempts are logged too. Plugins get a `user.role_changed` event.
- Writes need a session and the CSRF token. Bot API keys can't reach Site admin routes.

## API

| Method and path | Capability |
| --- | --- |
| `GET /api/site-admin/me` | session |
| `GET /api/site-admin/roles` | `access_site_admin` |
| `GET /api/site-admin/users?q=` | `view_users` |
| `PUT /api/site-admin/users/:id/role` `{ role }` | `manage_roles` (+ `manage_admins` for admin roles) |
| `GET/PUT /api/site-admin/layout`, `POST /layout/reset` | `edit_layout` (renames need `manage_branding`) |
| `GET /api/site-admin/plugins`, upload/enable/disable/delete, `POST /plugins/check-updates`, `POST /plugins/:name/update`, `POST /plugins/:name/auto-update` | `manage_plugins` (+ recent sign-in to install/enable/update/uninstall and to change automatic updates) |
| `GET /api/site-admin/audit` | `view_audit` |
| `GET /api/layout`, `GET /api/layout/theme.css` | public (audience-filtered) |

## Storage and migration

Roles stay in the user record's `role` field. Store schema **v9** adds
`layout`, `plugins` (enabled state, granted permissions, checksum), `pluginData`
and `siteAudit`. The migration runs on load and is idempotent. Existing roles
and data are untouched.
