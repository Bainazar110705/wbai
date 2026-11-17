// Несколько магазинов WB на одном аккаунте. Все данные магазина привязаны
// к wb_shops.id: удаление магазина каскадом стирает всё, что с ним связано,
// и данные разных магазинов не смешиваются.
const crypto = require('node:crypto');

// Таблица → новый ключ (вместо user_id) и индексы.
const SHOP_TABLES = [
  { table: 'product_costs', key: 'UNIQUE (shop_id, supplier_article)' },
  { table: 'manager_campaigns', key: 'UNIQUE (shop_id, campaign_id)', indexes: ['(shop_id, manager_name)'] },
  { table: 'wb_analytics_source_cache', key: 'UNIQUE (shop_id, source, date_from, date_to)', indexes: ['(shop_id, source, fetched_at DESC)'], cache: true },
  { table: 'wb_analytics_snapshots', key: 'UNIQUE (shop_id, date_from, date_to)', indexes: ['(shop_id, calculated_at DESC)'], cache: true },
  { table: 'wb_orders', key: 'PRIMARY KEY (shop_id, srid)', indexes: ['(shop_id, order_date)'] },
  { table: 'wb_sales', key: 'PRIMARY KEY (shop_id, sale_id)', indexes: ['(shop_id, sale_date)'] },
  { table: 'wb_ad_spend_daily', key: 'PRIMARY KEY (shop_id, day, advert_id, nm_id)' },
  { table: 'wb_rnp_sync', key: 'PRIMARY KEY (shop_id)' },
  { table: 'rnp_plans', key: 'PRIMARY KEY (shop_id, month, nm_id)' },
  { table: 'wb_products', key: 'PRIMARY KEY (shop_id, nm_id)' },
  { table: 'rnp_labels', key: 'PRIMARY KEY (shop_id, nm_id)' },
  { table: 'wb_finance_rows', key: 'PRIMARY KEY (shop_id, rrd_id)', indexes: ['(shop_id, rr_date)'] },
  { table: 'wb_storage_daily', key: 'PRIMARY KEY (shop_id, day, nm_id)' }
];

function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

module.exports = {
  id: '008_wb_shops',
  SHOP_TABLES,
  async up(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_shops (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL DEFAULT '',
        seller_id VARCHAR(64),
        token TEXT NOT NULL,
        token_fingerprint VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, seller_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS wb_shops_user_idx ON wb_shops (user_id, id)');

    // Каждый подключённый токен становится первым магазином пользователя.
    const users = await pool.query('SELECT id, wb_api_token FROM users WHERE wb_api_token IS NOT NULL AND wb_api_token <> \'\'');
    for (const user of users.rows) {
      await pool.query(
        'INSERT INTO wb_shops (user_id, name, token, token_fingerprint) VALUES ($1, $2, $3, $4)',
        [user.id, 'Мой магазин', user.wb_api_token, fingerprint(user.wb_api_token)]
      );
    }

    for (const { table, key, indexes = [], cache } of SHOP_TABLES) {
      // Кэш ответов WB не переносим — он соберётся заново по магазину.
      if (cache) await pool.query(`TRUNCATE ${table}`);
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES wb_shops(id) ON DELETE CASCADE`);
      await pool.query(`UPDATE ${table} t SET shop_id = s.id FROM wb_shops s WHERE s.user_id = t.user_id AND t.shop_id IS NULL`);
      // Данные аккаунтов без токена не к чему привязать.
      await pool.query(`DELETE FROM ${table} WHERE shop_id IS NULL`);
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN shop_id SET NOT NULL`);
      // Старые ключи и индексы по user_id уходят вместе с колонкой.
      await pool.query(`ALTER TABLE ${table} DROP COLUMN user_id CASCADE`);
      await pool.query(`ALTER TABLE ${table} ADD ${key}`);
      for (const [index, columns] of indexes.entries()) {
        await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_shop_${index}_idx ON ${table} ${columns}`);
      }
    }

    // Токен теперь хранится у магазина.
    await pool.query('UPDATE users SET wb_api_token = NULL WHERE wb_api_token IS NOT NULL');
  }
};
