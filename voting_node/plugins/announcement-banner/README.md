# announcement-banner (example UI plugin)

Shows a dismissible announcement in the `banner` slot on every page that loads
`/plugin-runtime.js`. Holders of `edit_layout` edit the text from
**Site admin → Announcement**.

- Routes: `GET /api/plugins/announcement-banner/message` (public),
  `GET|PUT /api/plugins/announcement-banner/settings` (`edit_layout`, CSRF).
- Storage: one key, `message`.
- Disabled by default; enable from Site admin → Plugins after reviewing permissions.
