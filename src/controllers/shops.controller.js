function createShopsController(shopsService) {
  return {
    async list(req, res) {
      res.json(await shopsService.list(req.user.id));
    },

    async add(req, res) {
      res.json({ ok: true, shop: await shopsService.add(req.user.id, req.body?.token) });
    },

    async replaceToken(req, res) {
      res.json({ ok: true, shop: await shopsService.replaceToken(req.user.id, req.params.id, req.body?.token) });
    },

    async rename(req, res) {
      res.json({ ok: true, shop: await shopsService.rename(req.user.id, req.params.id, req.body?.name) });
    },

    async remove(req, res) {
      await shopsService.remove(req.user.id, req.params.id);
      res.json({ ok: true });
    }
  };
}

module.exports = { createShopsController };
