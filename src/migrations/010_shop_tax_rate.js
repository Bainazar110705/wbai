// Налог продавца, % от продаж (упрощёнка и т. п.) — свой у каждого магазина.
// По умолчанию 0: продавец вводит ставку сам в окне «Себестоимость товаров».
module.exports = {
  id: '010_shop_tax_rate',
  async up(pool) {
    await pool.query('ALTER TABLE wb_shops ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0');
  }
};
