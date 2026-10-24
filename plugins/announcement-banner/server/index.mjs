// NOT FOR PROFIT — civic public good, not a commercial product.
// Example server half of the announcement-banner plugin. Runs in-process with
// full trust (see docs/plugins/README.md); it only uses the scoped plugin API.

const TONES = new Set(['info', 'success', 'warning']);

export function register(api) {
  const router = api.routes();

  router.get('/message', (_req, res) => {
    const msg = api.storage.get('message') || null;
    res.set('Cache-Control', 'no-store');
    res.json({ message: msg && msg.enabled ? msg : null });
  });

  router.get('/settings', ...api.requireCapability('edit_layout'), (_req, res) => {
    res.json({ message: api.storage.get('message') || { enabled: false, text: '', tone: 'info' } });
  });

  router.put('/settings', ...api.requireCapability('edit_layout'), api.json({ limitBytes: 4096 }), async (req, res) => {
    const text = String(req.body?.text ?? '').trim().slice(0, 280);
    const tone = TONES.has(req.body?.tone) ? req.body.tone : 'info';
    const enabled = Boolean(req.body?.enabled) && text.length > 0;
    const message = { enabled, text, tone, updatedAt: new Date().toISOString(), updatedBy: req.user.handle };
    await api.storage.set('message', message);
    res.json({ message });
  });
}
