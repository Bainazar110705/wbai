function createTemplatesRepository(db) {
  return {
    listByUserId: userId => db.allAsync('SELECT * FROM templates WHERE user_id = ? ORDER BY id DESC', [userId]),
    replaceByName: async (userId, template) => {
      await db.runAsync('DELETE FROM templates WHERE user_id = ? AND name = ?', [userId, template.name]);
      return db.runAsync(
        'INSERT INTO templates (user_id, name, category, chars, length, width, height, weight, price, kw, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          userId, template.name, template.category || '', template.chars || '', template.length || '',
          template.width || '', template.height || '', template.weight || '', template.price || '',
          template.kw || '', template.date || ''
        ]
      );
    },
    deleteByName: (userId, name) => db.runAsync('DELETE FROM templates WHERE user_id = ? AND name = ?', [userId, name])
  };
}

module.exports = { createTemplatesRepository };
