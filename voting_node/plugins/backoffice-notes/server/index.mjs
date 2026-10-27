// NOT FOR PROFIT — civic public good, not a commercial product.
// Example back-office plugin. Shared operator notes + role-change log.
// Uses only the scoped plugin API: no DB handle, no crypto, no vote data.

const MAX_NOTES = 50;
const MAX_LOG = 50;

export function register(api) {
  const router = api.routes();
  const gate = api.requireCapability('manage_elections');

  router.get('/notes', ...gate, (_req, res) => {
    res.json({
      notes: api.storage.get('notes') || [],
      roleLog: api.storage.get('roleLog') || [],
      elections: api.elections.listPublic().length,
      usersByRole: api.users.countByRole(),
    });
  });

  router.post('/notes', ...gate, api.json({ limitBytes: 4096 }), async (req, res) => {
    const text = String(req.body?.text ?? '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'text required' });
    const note = { id: Date.now().toString(36), text, by: req.user.handle, at: new Date().toISOString() };
    const notes = [note, ...(api.storage.get('notes') || [])].slice(0, MAX_NOTES);
    await api.storage.set('notes', notes);
    res.status(201).json({ note });
  });

  api.on('user.role_changed', async (evt) => {
    const log = [
      { at: new Date().toISOString(), handle: evt.handle, from: evt.from, to: evt.to, by: evt.by },
      ...(api.storage.get('roleLog') || []),
    ].slice(0, MAX_LOG);
    await api.storage.set('roleLog', log);
  });
}
