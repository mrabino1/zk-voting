// NOT FOR PROFIT — civic public good, not a commercial product.
// Example client half: no eval, no inline HTML; DOM built with textContent.

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
  host.slot('banner', async (root, ctx) => {
    const { message } = await ctx.fetchJson('message');
    if (!message) return;
    const key = `announcement-dismissed:${message.updatedAt}`;
    try {
      if (sessionStorage.getItem(key)) return;
    } catch {
      /* storage blocked */
    }
    const close = el('button', { type: 'button', class: 'ab-close', 'aria-label': 'Dismiss announcement', text: '×' });
    const box = el(
      'div',
      { class: `ab-banner ab-${message.tone}`, role: 'region', 'aria-label': 'Announcement' },
      el('p', { class: 'ab-text', text: message.text }),
      close,
    );
    close.addEventListener('click', () => {
      try {
        sessionStorage.setItem(key, '1');
      } catch {
        /* storage blocked */
      }
      box.remove();
    });
    root.append(box);
  });

  host.slot('site-admin.page', async (root, ctx) => {
    if (ctx.page !== 'settings') return;
    const { message } = await ctx.fetchJson('settings');
    const status = el('p', { class: 'ab-status', role: 'status', 'aria-live': 'polite' });
    const enabled = el('input', { type: 'checkbox', id: 'ab-enabled' });
    enabled.checked = Boolean(message.enabled);
    const text = el('textarea', { id: 'ab-text', rows: '3', maxlength: '280' });
    text.value = message.text || '';
    const tone = el('select', { id: 'ab-tone' });
    for (const t of ['info', 'success', 'warning']) {
      const o = el('option', { value: t, text: t[0].toUpperCase() + t.slice(1) });
      if (t === message.tone) o.selected = true;
      tone.append(o);
    }
    const form = el(
      'form',
      { class: 'ab-form' },
      el('p', { text: `Shown at the top of every ${ctx.productName} page until dismissed.` }),
      el('div', { class: 'sa-field sa-check' }, enabled, el('label', { for: 'ab-enabled', text: 'Show the announcement' })),
      el('div', { class: 'sa-field' }, el('label', { for: 'ab-text', text: 'Message' }), text),
      el('div', { class: 'sa-field' }, el('label', { for: 'ab-tone', text: 'Tone' }), tone),
      el('button', { type: 'submit', class: 'btn btn-primary', text: 'Save announcement' }),
      status,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await ctx.fetchJson('settings', {
          method: 'PUT',
          body: { enabled: enabled.checked, text: text.value, tone: tone.value },
        });
        status.textContent = 'Saved.';
      } catch (err) {
        status.textContent = `Could not save: ${err.message}`;
      }
    });
    root.append(form);
  });
}
