function createUsersRepository(db) {
  return {
    findById: id => db.getAsync('SELECT * FROM users WHERE id = ?', [id]),
    findByEmail: email => db.getAsync('SELECT * FROM users WHERE email = ?', [email]),
    findPublicById: id => db.getAsync(
      'SELECT id, email, name, subscription_end, ai_requests_count, plan, photo_credits FROM users WHERE id = ?',
      [id]
    ),
    create: ({ email, password, name }) => db.runAsync(
      'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
      [email, password, name]
    ),
    updatePassword: (id, password) => db.runAsync('UPDATE users SET password = ? WHERE id = ?', [password, id]),
    findCreditsById: id => db.getAsync('SELECT photo_credits FROM users WHERE id = ?', [id]),
    reserveCredits: (id, amount) => db.getAsync(
      `UPDATE users
       SET photo_credits = COALESCE(photo_credits, 0) - ?
       WHERE id = ? AND COALESCE(photo_credits, 0) >= ?
       RETURNING photo_credits`,
      [amount, id, amount]
    ),
    releaseCredits: (id, amount) => db.runAsync(
      'UPDATE users SET photo_credits = COALESCE(photo_credits, 0) + ? WHERE id = ?',
      [amount, id]
    )
  };
}

module.exports = { createUsersRepository };
