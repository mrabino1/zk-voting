// NOT FOR PROFIT — civic public good, not a commercial product.
// Handwritten layout override. Copy to apps/node/site/layout.override.mjs (or
// point LAYOUT_OVERRIDE_MODULE at it). It runs on the server with full trust,
// after the saved (database) layout and layout.json. Whatever it returns is
// validated again, so unsafe links or theme values are dropped with a warning.

/** @param {object} layout effective layout so far (a copy, safe to mutate) */
export default function overrideLayout(layout) {
  layout.nav.items.push({ id: 'status', label: 'Status', href: '/public', audience: 'all', visible: true });
  return layout;
}
