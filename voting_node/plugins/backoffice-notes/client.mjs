// NOT FOR PROFIT — civic public good, not a commercial product.
// Example back-office admin page. DOM APIs only (CSP-safe).

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

export function register(host) {
  host.slot('site-admin.page', async (root, ctx) => {
    if (ctx.page !== 'notes') return;
    const list = el('ul', { class: 'bn-notes' });
    const log = el('ul', { class: 'bn-log' });
    const summary = el('p', { class: 'bn-summary' });
    const status = el('p', { role: 'status', 'aria-live': 'polite' });
    async function refresh() {
      const data = await ctx.fetchJson('notes');
      summary.textContent = `${data.elections} election(s). Users by role: ${
        Object.entries(data.usersByRole).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'
      }.`;
      list.replaceChildren(
        ...(data.notes.length
          ? data.notes.map((n) => el('li', {}, el('strong', { text: n.by }), ` · ${new Date(n.at).toLocaleString()} — ${n.text}`))
          : [el('li', { text: 'No notes yet.' })]),
      );
      log.replaceChildren(
        ...(data.roleLog.length
          ? data.roleLog.map((r) => el('li', { text: `${r.handle}: ${r.from} → ${r.to} (by ${r.by})` }))
          : [el('li', { text: 'No role changes recorded since this plugin was enabled.' })]),
      );
    }
    const text = el('textarea', { id: 'bn-text', rows: '3', maxlength: '500' });
    const form = el(
      'form',
      {},
      el('div', { class: 'sa-field' }, el('label', { for: 'bn-text', text: 'New note' }), text),
      el('button', { type: 'submit', class: 'btn btn-primary', text: 'Add note' }),
      status,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await ctx.fetchJson('notes', { method: 'POST', body: { text: text.value } });
        text.value = '';
        status.textContent = 'Note added.';
        await refresh();
      } catch (err) {
        status.textContent = `Could not add note: ${err.message}`;
      }
    });
    root.append(
      summary,
      form,
      el('h3', { text: 'Notes' }),
      list,
      el('h3', { text: 'Recent role changes' }),
      log,
    );
    await refresh();
  });

  host.slot('site-admin.dashboard', (root) => {
    root.append(el('p', { text: 'Operator notes plugin is active — see Operator notes in the menu.' }));
  });
}
