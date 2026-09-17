function createTemplatesController(templatesService) {
  return {
    async list(req, res) {
      res.json({ templates: await templatesService.list(req.user.id) });
    },

    async save(req, res) {
      const result = await templatesService.save(req.user.id, req.body);
      res.json({ ok: true, id: result.lastID });
    },

    async remove(req, res) {
      await templatesService.remove(req.user.id, decodeURIComponent(req.params.name));
      res.json({ ok: true });
    }
  };
}

module.exports = { createTemplatesController };
