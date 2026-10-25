# backoffice-notes (example back-office plugin)

Adds **Site admin → Operator notes** for holders of `manage_elections`:
shared notes, a public election count, user counts by role, and a log of
role changes received through the `user.role_changed` event.

- Routes: `GET|POST /api/plugins/backoffice-notes/notes` (`manage_elections`, CSRF on POST).
- Uses `storage`, `users:read` (counts only), `elections:read` (public fields only), `events`.
- Disabled by default.
