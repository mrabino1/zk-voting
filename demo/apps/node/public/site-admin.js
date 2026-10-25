// NOT FOR PROFIT — civic public good, not a commercial product.
// Site admin screen: roles & users, layout/branding, plugins, audit, and
// plugin-provided admin pages. CSP-safe (no inline script, no eval, no
// innerHTML with data). Every action is re-checked server-side.

import { applyLayout, fetchLayout, renderSlot } from '/plugin-runtime.js';
import { brandName } from '/brand.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#sa-view');
const statusEl = $('#sa-status');
const titleEl = $('#sa-title');
let me = null;

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

function say(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('is-error', Boolean(isError));
}

async function call(method, url, body, extraHeaders = {}) {
  const headers = { accept: 'application/json', ...extraHeaders };
  let payload;
  if (body instanceof ArrayBuffer || body instanceof Blob) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET' && me?.csrfToken) headers['x-csrf-token'] = me.csrfToken;
  const res = await fetch(url, { method, credentials: 'same-origin', headers, body: payload });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json;
}

const can = (cap) => Boolean(me?.capabilities?.includes(cap));

function confirmDialog(title, bodyNodes, okLabel = 'Confirm') {
  const dlg = $('#sa-dialog');
  $('#sa-dialog-title').textContent = title;
  $('#sa-dialog-body').replaceChildren(...bodyNodes);
  $('#sa-dialog-ok').textContent = okLabel;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- roles
async function renderRoles() {
  titleEl.textContent = 'Roles & users';
  const { roles, capabilities, superAdmins } = await call('GET', '/api/site-admin/roles');
  const siteRoles = roles.filter((r) => r.site);
  const matrix = h(
    'table',
    { class: 'sa-table' },
    h('caption', { class: 'sa-hint', text: 'Capabilities granted by each site role. Checked on the server for every request.' }),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Capability' }), siteRoles.map((r) => h('th', { scope: 'col', text: r.label })))),
    h(
      'tbody',
      {},
      capabilities.map((c) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, h('span', { class: 'sa-code', text: c.id }), h('br'), h('span', { class: 'sa-hint', text: c.label })),
          siteRoles.map((r) =>
            r.capabilities.includes(c.id)
              ? h('td', { class: 'sa-yes' }, h('span', { 'aria-hidden': 'true', text: '✓' }), h('span', { class: 'visually-hidden', text: 'Yes' }))
              : h('td', { class: 'sa-no' }, h('span', { 'aria-hidden': 'true', text: '—' }), h('span', { class: 'visually-hidden', text: 'No' })),
          ),
        ),
      ),
    ),
  );

  const tbody = h('tbody');
  const q = h('input', { type: 'search', id: 'sa-user-q', placeholder: 'handle', autocomplete: 'off' });
  const roleFilter = h('select', { id: 'sa-user-role' }, h('option', { value: '', text: 'Any role' }), roles.map((r) => h('option', { value: r.id, text: r.label })));
  async function load() {
    if (!can('view_users')) {
      tbody.replaceChildren(h('tr', {}, h('td', { colspan: '3', text: 'You do not have view_users.' })));
      return;
    }
    const params = new URLSearchParams({ q: q.value, role: roleFilter.value, limit: '50' });
    const { users, total } = await call('GET', `/api/site-admin/users?${params}`);
    tbody.replaceChildren(
      ...users.map((u) => {
        const sel = h(
          'select',
          { 'aria-label': `Role for ${u.handle}`, disabled: !can('manage_roles') },
          roles.map((r) => h('option', { value: r.id, text: r.label, selected: r.id === u.role })),
        );
        const save = h('button', {
          type: 'button',
          class: 'btn btn-secondary',
          text: 'Save',
          disabled: !can('manage_roles'),
          'aria-label': `Save role for ${u.handle}`,
          onclick: async () => {
            try {
              const r = await call('PUT', `/api/site-admin/users/${encodeURIComponent(u.id)}/role`, { role: sel.value });
              say(`${u.handle} is now ${r.user.roleLabel || r.user.role}.`);
            } catch (err) {
              say(`Could not change ${u.handle}: ${err.message}`, true);
              sel.value = u.role;
            }
          },
        });
        return h('tr', {}, h('td', { text: u.handle }), h('td', {}, sel), h('td', {}, save));
      }),
    );
    if (!users.length) tbody.append(h('tr', {}, h('td', { colspan: '3', text: 'No users match.' })));
    countEl.textContent = `${users.length} of ${total} shown.`;
  }
  const countEl = h('p', { class: 'sa-hint' });
  const search = h(
    'form',
    { class: 'sa-row', role: 'search', onsubmit: (e) => { e.preventDefault(); load().catch((err) => say(err.message, true)); } },
    h('div', { class: 'sa-field' }, h('label', { for: 'sa-user-q', text: 'Find user' }), q),
    h('div', { class: 'sa-field' }, h('label', { for: 'sa-user-role', text: 'Role' }), roleFilter),
    h('div', { class: 'sa-field' }, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Search' })),
  );
  view.replaceChildren(
    h(
      'section',
      { class: 'sa-card', 'aria-labelledby': 'sa-users-h' },
      h('h2', { id: 'sa-users-h', text: 'Users' }),
      h('p', {
        class: 'sa-hint',
        text: `Super admins: ${superAdmins}. The last super admin cannot be demoted. Only super admins can grant or remove admin and super admin. Every change is written to the audit log.`,
      }),
      search,
      h('div', { class: 'sa-table-wrap' }, h('table', { class: 'sa-table' }, h('caption', { class: 'visually-hidden', text: 'Users and roles' }), h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Handle' }), h('th', { scope: 'col', text: 'Role' }), h('th', { scope: 'col', text: 'Action' }))), tbody)),
      countEl,
    ),
    h('section', { class: 'sa-card', 'aria-labelledby': 'sa-matrix-h' }, h('h2', { id: 'sa-matrix-h', text: 'Roles and capabilities' }), h('div', { class: 'sa-table-wrap' }, matrix)),
  );
  await load();
}

// --------------------------------------------------------------- layout
async function renderLayout() {
  titleEl.textContent = 'Layout & appearance';
  const data = await call('GET', '/api/site-admin/layout');
  const draft = structuredClone(data.saved);
  const { schema } = data;

  const defaults = data.brandingDefaults || { name: 'ZK-Voting', shortName: 'ZK-Voting', tagline: '' };
  const canBrand = can('manage_branding');
  const brandInput = (id, field, max, fallback) =>
    h('input', {
      type: 'text',
      id,
      maxlength: String(max),
      value: draft.branding?.[field] || '',
      placeholder: fallback,
      disabled: !canBrand,
      'aria-describedby': 'sa-product-hint',
    });
  const productName = brandInput('sa-product-name', 'productName', 60, defaults.name);
  const shortName = brandInput('sa-short-name', 'shortName', 24, defaults.shortName);
  const tagline = brandInput('sa-tagline', 'tagline', 160, defaults.tagline);
  // An empty short name follows the product name, so show what it will resolve to.
  const syncShortPlaceholder = () => {
    shortName.placeholder = productName.value.trim() || defaults.shortName;
  };
  productName.addEventListener('input', syncShortPlaceholder);
  syncShortPlaceholder();
  const branding = h(
    'section',
    { class: 'sa-card', 'aria-labelledby': 'sa-brand-h' },
    h('h2', { id: 'sa-brand-h', text: 'Branding' }),
    h('div', { class: 'sa-field' }, h('label', { for: 'sa-product-name', text: 'Product name' }), productName),
    h('div', { class: 'sa-field' }, h('label', { for: 'sa-short-name', text: 'Short name' }), shortName),
    h('div', { class: 'sa-field' }, h('label', { for: 'sa-tagline', text: 'Tagline' }), tagline),
    h('p', {
      id: 'sa-product-hint',
      class: 'sa-hint',
      text: canBrand
        ? `Leave a field empty to use the default (“${defaults.name}”). The name appears in page titles, headers, footers, emails and PDFs. Plain text only.`
        : `Only a super admin or admin can rename the product (now “${data.effective?.branding?.productName || defaults.name}”).`,
    }),
  );

  // Nav items
  const navBody = h('tbody');
  function navRows() {
    navBody.replaceChildren(
      ...draft.nav.items.map((item, i) =>
        h(
          'tr',
          {},
          h('td', {}, h('input', { type: 'text', value: item.label, 'aria-label': `Label for item ${i + 1}`, oninput: (e) => { item.label = e.target.value; } })),
          h('td', {}, h('input', { type: 'text', value: item.href, 'aria-label': `Link for item ${i + 1}`, oninput: (e) => { item.href = e.target.value; } })),
          h('td', {}, h('select', { 'aria-label': `Audience for item ${i + 1}`, onchange: (e) => { item.audience = e.target.value; } }, schema.audiences.map((a) => h('option', { value: a, text: a, selected: a === item.audience })))),
          h('td', {}, h('input', { type: 'checkbox', checked: item.visible !== false, 'aria-label': `Visible: item ${i + 1}`, onchange: (e) => { item.visible = e.target.checked; } })),
          h('td', {},
            h('button', { type: 'button', class: 'btn btn-secondary', text: '↑', 'aria-label': `Move item ${i + 1} up`, disabled: i === 0, onclick: () => { [draft.nav.items[i - 1], draft.nav.items[i]] = [draft.nav.items[i], draft.nav.items[i - 1]]; navRows(); } }),
            ' ',
            h('button', { type: 'button', class: 'btn btn-secondary', text: 'Remove', 'aria-label': `Remove item ${i + 1}`, onclick: () => { draft.nav.items.splice(i, 1); navRows(); } }),
          ),
        ),
      ),
    );
    if (!draft.nav.items.length) navBody.append(h('tr', {}, h('td', { colspan: '5', text: 'No extra items. Built-in navigation is shown.' })));
  }
  navRows();
  const hidden = h('textarea', { id: 'sa-nav-hidden', rows: '3' });
  hidden.value = (draft.nav.hidden || []).join('\n');
  const managed = h('input', { type: 'checkbox', id: 'sa-nav-managed', checked: Boolean(draft.nav.managed) });
  const nav = h(
    'section',
    { class: 'sa-card', 'aria-labelledby': 'sa-nav-h' },
    h('h2', { id: 'sa-nav-h', text: 'Navigation' }),
    h('div', { class: 'sa-field sa-check' }, managed, h('label', { for: 'sa-nav-managed', text: 'Replace the built-in menu with these items' })),
    h('div', { class: 'sa-table-wrap' }, h('table', { class: 'sa-table' }, h('caption', { class: 'visually-hidden', text: 'Extra navigation items' }), h('thead', {}, h('tr', {}, ['Label', 'Link', 'Audience', 'Visible', 'Order'].map((t) => h('th', { scope: 'col', text: t })))), navBody)),
    h('div', { class: 'sa-actions' }, h('button', { type: 'button', class: 'btn btn-secondary', text: 'Add item', onclick: () => { draft.nav.items.push({ id: `item-${Date.now().toString(36)}`, label: 'New link', href: '/', audience: 'all', visible: true }); navRows(); } })),
    h('div', { class: 'sa-field' }, h('label', { for: 'sa-nav-hidden', text: 'Hide built-in links (one path per line)' }), hidden),
  );

  // Regions: notice widgets
  const regionList = h('div');
  function regionRows() {
    regionList.replaceChildren(
      ...schema.regions.map((region) =>
        h(
          'div',
          { class: 'sa-region' },
          h('h3', { text: region }),
          h('ul', {}, (draft.regions[region] || []).map((w, i) =>
            h('li', {},
              h('span', { class: 'sa-pill', text: w.type }),
              ` ${w.title || w.id}${w.type === 'plugin' ? ` (${w.plugin}:${w.slot})` : ''} `,
              h('button', { type: 'button', class: 'btn btn-secondary', text: 'Remove', 'aria-label': `Remove ${w.title || w.id} from ${region}`, onclick: () => { draft.regions[region].splice(i, 1); regionRows(); } }),
            ),
          )),
          (draft.regions[region] || []).length ? null : h('p', { class: 'sa-hint', text: 'Empty.' }),
        ),
      ),
    );
  }
  regionRows();
  const nRegion = h('select', { id: 'sa-w-region' }, schema.regions.map((r) => h('option', { value: r, text: r })));
  const nTitle = h('input', { type: 'text', id: 'sa-w-title', maxlength: '80' });
  const nBody = h('textarea', { id: 'sa-w-body', rows: '2', maxlength: '500' });
  const regions = h(
    'section',
    { class: 'sa-card', 'aria-labelledby': 'sa-regions-h' },
    h('h2', { id: 'sa-regions-h', text: 'Regions & widgets' }),
    h('p', { class: 'sa-hint', text: 'Plain-text notices and link lists. Enabled UI plugins also render into their declared slots.' }),
    regionList,
    h('div', { class: 'sa-grid' },
      h('div', { class: 'sa-field' }, h('label', { for: 'sa-w-region', text: 'Region' }), nRegion),
      h('div', { class: 'sa-field' }, h('label', { for: 'sa-w-title', text: 'Notice title' }), nTitle),
      h('div', { class: 'sa-field' }, h('label', { for: 'sa-w-body', text: 'Notice text' }), nBody),
    ),
    h('button', { type: 'button', class: 'btn btn-secondary', text: 'Add notice', onclick: () => {
      const r = nRegion.value;
      draft.regions[r] = draft.regions[r] || [];
      draft.regions[r].push({ id: `notice-${Date.now().toString(36)}`, type: 'notice', title: nTitle.value, body: nBody.value, tone: 'info', audience: 'all', visible: true });
      nTitle.value = '';
      nBody.value = '';
      regionRows();
    } }),
  );

  // Theme tokens
  const themeInputs = [];
  const themeGrid = (mode) =>
    h('fieldset', { class: 'sa-card' },
      h('legend', { text: mode === 'light' ? 'Light theme tokens' : 'Dark theme tokens' }),
      h('div', { class: 'sa-grid' }, schema.themeTokens.map((t) => {
        const idAttr = `sa-theme-${mode}-${t.id}`;
        const input = h('input', { type: 'text', id: idAttr, value: draft.theme?.[mode]?.[t.id] || '', placeholder: t.kind === 'color' ? '#1d4ed8' : t.kind === 'length' ? '0.5rem' : 'system-ui, sans-serif' });
        themeInputs.push([mode, t.id, input]);
        return h('div', { class: 'sa-field' }, h('label', { for: idAttr }, h('span', { class: 'sa-code', text: `--${t.id}` }), ` (${t.kind})`), input);
      })),
    );
  const warnings = (data.warnings || []).length
    ? h('div', { class: 'sa-warn', role: 'note' }, h('p', { text: 'Contrast warnings:' }), h('ul', {}, data.warnings.map((w) => h('li', { text: w.message || String(w) }))))
    : null;
  const theme = h('section', { class: 'sa-card', 'aria-labelledby': 'sa-theme-h' }, h('h2', { id: 'sa-theme-h', text: 'Theme' }), warnings, themeGrid('light'), themeGrid('dark'));

  const sources = h('p', {
    class: 'sa-hint',
    text: `Effective layout = defaults → saved settings${data.fileOverride ? ' → layout.json file (active)' : ''}${data.codeOverride ? ' → layout.override.mjs code (active)' : ''} → plugin filters. File and code overrides win over these settings.`,
  });

  function collect() {
    const out = structuredClone(draft);
    out.nav.managed = managed.checked;
    out.nav.hidden = hidden.value.split('\n').map((s) => s.trim()).filter(Boolean);
    out.nav.items = out.nav.items.map((it, i) => ({ ...it, order: i + 1 }));
    out.theme = { light: {}, dark: {} };
    for (const [mode, id, input] of themeInputs) if (input.value.trim()) out.theme[mode][id] = input.value.trim();
    out.branding = {
      productName: productName.value.trim(),
      shortName: shortName.value.trim(),
      tagline: tagline.value.trim(),
    };
    return out;
  }
  const actions = h(
    'div',
    { class: 'sa-actions' },
    h('button', { type: 'button', class: 'btn btn-primary', text: 'Save layout', onclick: async () => {
      try {
        await call('PUT', '/api/site-admin/layout', { layout: collect() });
        say('Layout saved.');
        await renderLayout();
      } catch (err) {
        say(`Could not save layout: ${err.message}`, true);
      }
    } }),
    h('button', { type: 'button', class: 'btn btn-secondary', text: 'Reset to defaults', onclick: async () => {
      if (!(await confirmDialog('Reset layout?', [h('p', { text: `Saved navigation, widgets, theme and branding go back to defaults (product name “${defaults.name}”).` })], 'Reset'))) return;
      try {
        await call('POST', '/api/site-admin/layout/reset', {});
        say('Layout reset.');
        await renderLayout();
      } catch (err) {
        say(`Could not reset: ${err.message}`, true);
      }
    } }),
  );
  view.replaceChildren(sources, branding, nav, regions, theme, actions);
}

// -------------------------------------------------------------- plugins
async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function renderPlugins() {
  titleEl.textContent = 'Plugins';
  const data = await call('GET', '/api/site-admin/plugins');
  const file = h('input', { type: 'file', id: 'sa-zip', accept: '.zip,application/zip', disabled: !data.uploadsEnabled });
  const digest = h('p', { class: 'sa-hint sa-code', id: 'sa-zip-sha' });
  let zipBuf = null;
  file.addEventListener('change', async () => {
    zipBuf = file.files[0] ? await file.files[0].arrayBuffer() : null;
    digest.textContent = zipBuf ? `sha256 ${await sha256Hex(zipBuf)}` : '';
  });
  const upload = h(
    'form',
    { onsubmit: async (e) => {
      e.preventDefault();
      if (!zipBuf) return say('Choose a .zip first.', true);
      try {
        const sum = await sha256Hex(zipBuf);
        const r = await call('POST', '/api/site-admin/plugins/upload', zipBuf, { 'content-type': 'application/zip', 'x-plugin-sha256': sum });
        say(`Installed ${r.plugin.name} ${r.plugin.version}. It is disabled until you review and enable it.`);
        await renderPlugins();
      } catch (err) {
        say(err.code === 'REAUTH_REQUIRED' ? 'Sign in again to install plugins (recent sign-in required).' : `Upload rejected: ${err.message}`, true);
      }
    } },
    h('div', { class: 'sa-field' }, h('label', { for: 'sa-zip', text: 'Plugin .zip' }), file),
    digest,
    h('button', { type: 'submit', class: 'btn btn-primary', text: 'Upload plugin', disabled: !data.uploadsEnabled }),
  );
  const uploadCard = h(
    'section',
    { class: 'sa-card', 'aria-labelledby': 'sa-upload-h' },
    h('h2', { id: 'sa-upload-h', text: 'Install from .zip' }),
    data.uploadsEnabled
      ? h('p', { class: 'sa-hint', text: `Max ${Math.round(data.maxZipBytes / 1024)} KiB. Requires a sign-in within the last ${Math.round(data.reauthWindowSeconds / 60)} minutes. Uploaded plugins start disabled.` })
      : h('p', { class: 'sa-warn', text: 'Uploads are off. The host must set PLUGINS_ALLOW_UPLOAD=1. Plugins in the repo plugins/ folder still load (disabled until enabled here).' }),
    h('p', { class: 'sa-hint', text: 'Server plugins run inside the app with full trust. Install only code you have reviewed.' }),
    upload,
  );

  const rows = data.plugins.map((p) => {
    if (p.invalid) {
      return h('tr', {}, h('td', { text: p.name }), h('td', { colspan: '4', text: `Invalid: ${p.error}` }), h('td'));
    }
    const actions = [];
    if (p.enabled) {
      actions.push(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Disable', 'aria-label': `Disable ${p.displayName}`, onclick: () => act(p, 'disable') }));
    } else {
      actions.push(h('button', { type: 'button', class: 'btn btn-primary', text: 'Enable…', 'aria-label': `Enable ${p.displayName}`, onclick: () => enable(p) }));
    }
    if (p.canUninstall) {
      actions.push(' ', h('button', { type: 'button', class: 'btn btn-secondary', text: 'Uninstall', 'aria-label': `Uninstall ${p.displayName}`, onclick: () => uninstall(p) }));
    }
    return h(
      'tr',
      {},
      h('td', {}, h('strong', { text: p.displayName }), h('br'), h('span', { class: 'sa-code', text: `${p.name}@${p.version}` }), h('p', { class: 'sa-hint', text: p.description })),
      h('td', { text: p.type }),
      h('td', { text: p.source === 'repo' ? 'Repo (plugins/)' : 'Uploaded' }),
      h('td', {}, p.permissions.map((perm) => h('span', { class: 'sa-pill', text: perm }))),
      h('td', {}, h('span', { class: `sa-pill${p.enabled ? ' is-on' : ''}`, text: p.enabled ? (p.running ? 'Enabled' : 'Enabled (error)') : 'Disabled' }), p.error ? h('p', { class: 'sa-hint', text: p.error }) : null),
      h('td', {}, actions),
    );
  });

  async function act(p, verb) {
    try {
      await call('POST', `/api/site-admin/plugins/${encodeURIComponent(p.name)}/${verb}`, {});
      say(`${p.displayName} ${verb}d.`);
      await refreshMe();
      await renderPlugins();
    } catch (err) {
      say(`Could not ${verb} ${p.displayName}: ${err.message}`, true);
    }
  }
  async function enable(p) {
    const ok = await confirmDialog(
      `Enable ${p.displayName}?`,
      [
        h('p', {}, `${p.name}@${p.version} by ${p.author} (${p.license}). `, p.entrypoints.server ? h('strong', { text: 'Includes server code that runs with full trust.' }) : 'Browser code only.'),
        h('p', { text: 'It requests these permissions:' }),
        h('ul', { class: 'sa-perms' }, p.permissionDetails.map((d) => h('li', {}, h('span', { class: 'sa-code', text: d.id }), ` — ${d.description}`))),
        h('p', { class: 'sa-hint sa-code', text: `checksum ${p.checksum}` }),
      ],
      'Grant and enable',
    );
    if (!ok) return;
    try {
      await call('POST', `/api/site-admin/plugins/${encodeURIComponent(p.name)}/enable`, { acceptPermissions: p.permissions });
      say(`${p.displayName} enabled.`);
      await refreshMe();
      await renderPlugins();
    } catch (err) {
      say(`Could not enable ${p.displayName}: ${err.message}`, true);
    }
  }
  async function uninstall(p) {
    if (!(await confirmDialog(`Uninstall ${p.displayName}?`, [h('p', { text: 'Its files and stored settings are deleted.' })], 'Uninstall'))) return;
    try {
      await call('DELETE', `/api/site-admin/plugins/${encodeURIComponent(p.name)}`);
      say(`${p.displayName} uninstalled.`);
      await renderPlugins();
    } catch (err) {
      say(`Could not uninstall: ${err.message}`, true);
    }
  }

  view.replaceChildren(
    h(
      'section',
      { class: 'sa-card', 'aria-labelledby': 'sa-installed-h' },
      h('h2', { id: 'sa-installed-h', text: 'Installed plugins' }),
      h('div', { class: 'sa-table-wrap' }, h('table', { class: 'sa-table' },
        h('caption', { class: 'visually-hidden', text: 'Installed plugins' }),
        h('thead', {}, h('tr', {}, ['Plugin', 'Type', 'Source', 'Permissions', 'Status', 'Actions'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: '6', text: 'No plugins found.' }))),
      )),
    ),
    uploadCard,
  );
}

// ---------------------------------------------------------------- audit
async function renderAudit() {
  titleEl.textContent = 'Audit log';
  const data = await call('GET', '/api/site-admin/audit?limit=100');
  view.replaceChildren(
    h('p', { class: data.verify?.ok ? 'sa-hint' : 'sa-warn', text: data.verify?.ok ? `Hash chain verified (${data.total ?? data.entries.length} entries).` : 'Hash chain verification FAILED.' }),
    h('div', { class: 'sa-table-wrap' }, h('table', { class: 'sa-table' },
      h('caption', { class: 'visually-hidden', text: 'Site admin audit log' }),
      h('thead', {}, h('tr', {}, ['When', 'Who', 'Area', 'Action', 'Result', 'Change'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, data.entries.length
        ? data.entries.map((e) => h('tr', {},
          h('td', { text: new Date(e.timestamp).toLocaleString() }),
          h('td', { text: e.sessionUser || '' }),
          h('td', { text: e.scope }),
          h('td', { class: 'sa-code', text: e.reason }),
          h('td', { text: String(e.result) }),
          h('td', { class: 'sa-code', text: `${e.before ? JSON.stringify(e.before) : ''}${e.before && e.after ? ' → ' : ''}${e.after ? JSON.stringify(e.after) : ''}`.slice(0, 300) }),
        ))
        : h('tr', {}, h('td', { colspan: '6', text: 'No entries yet.' }))),
    )),
  );
}

// ---------------------------------------------------------- plugin page
async function renderPluginPage(name, page) {
  const data = await fetchLayout();
  const plugin = (data?.plugins || []).find((p) => p.name === name);
  const meta = plugin?.adminPages?.find((p) => p.id === page);
  if (!plugin || !meta) {
    titleEl.textContent = 'Plugin page';
    view.replaceChildren(h('p', { text: 'This plugin page is not available (plugin disabled, or you lack its capability).' }));
    return;
  }
  titleEl.textContent = meta.title;
  const host = h('div', { class: 'sa-plugin-page', 'data-plugin': name });
  view.replaceChildren(h('p', { class: 'sa-hint', text: `Provided by plugin ${name}@${plugin.version}.` }), host);
  const ok = await renderSlot(plugin, 'site-admin.page', host, data.layout, { page, user: me.user.handle });
  if (!ok) host.append(h('p', { text: 'The plugin did not render this page.' }));
}

// --------------------------------------------------------------- router
const VIEWS = {
  roles: { cap: 'access_site_admin', render: renderRoles },
  layout: { cap: 'edit_layout', render: renderLayout },
  plugins: { cap: 'manage_plugins', render: renderPlugins },
  audit: { cap: 'view_audit', render: renderAudit },
};

async function refreshMe() {
  me = await call('GET', '/api/site-admin/me');
  const nav = $('#sa-nav');
  for (const li of [...nav.querySelectorAll('li[data-plugin-menu]')]) li.remove();
  for (const a of nav.querySelectorAll('a[data-view]')) {
    a.closest('li').hidden = !can(VIEWS[a.dataset.view].cap);
  }
  for (const m of me.menu || []) {
    nav.append(h('li', { 'data-plugin-menu': m.plugin }, h('a', { href: `/site-admin/plugin/${m.plugin}/${m.page}`, text: m.label })));
  }
  $('#sa-session').textContent = `${me.user.handle} · ${me.user.role}`;
}

async function route() {
  say('');
  const parts = location.pathname.replace(/\/+$/, '').split('/').slice(2);
  for (const a of document.querySelectorAll('#sa-nav a')) {
    if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  try {
    if (parts[0] === 'plugin' && parts[1] && parts[2]) return await renderPluginPage(parts[1], parts[2]);
    let name = parts[0] || 'roles';
    if (!VIEWS[name]) name = 'roles';
    if (!can(VIEWS[name].cap)) {
      const first = Object.entries(VIEWS).find(([, v]) => can(v.cap));
      if (!first) throw new Error('no access');
      name = first[0];
      history.replaceState(null, '', `/site-admin/${name}`);
      return route();
    }
    await VIEWS[name].render();
  } catch (err) {
    say(err.message, true);
  }
  document.title = `${titleEl.textContent} · Site admin · ${document.querySelector('[data-product-name]')?.textContent || brandName()}`;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="/site-admin"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  history.pushState(null, '', a.getAttribute('href'));
  route().then(() => $('#main').focus());
});
window.addEventListener('popstate', () => route());

(async function init() {
  try {
    await refreshMe();
  } catch (err) {
    if (err.status === 401) {
      location.replace(`/signin?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    say(err.message, true);
    return;
  }
  applyLayout({ nav: false, regions: false }).catch(() => {});
  if (!can('access_site_admin')) {
    titleEl.textContent = 'Site admin';
    for (const li of document.querySelectorAll('#sa-nav li')) li.hidden = true;
    view.replaceChildren(h('p', { text: `Signed in as ${me.user.handle} (${me.user.role}). Site admin needs a role with site-admin access. Ask a super admin.` }));
    return;
  }
  await route();
})();
