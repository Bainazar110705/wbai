function createAuthService({ usersRepository, bcrypt, jwt, jwtSecret }) {
  return {
    async register({ email, password, name }) {
      const passwordHash = await bcrypt.hash(password, 10);
      await usersRepository.create({ email: email.toLowerCase(), password: passwordHash, name: name || '' });
    },

    async login({ email, password }) {
      const user = await usersRepository.findByEmail(email?.toLowerCase());
      if (!user || !(await bcrypt.compare(password, user.password))) return null;
      const token = jwt.sign({ id: user.id, email: user.email }, jwtSecret, { expiresIn: '30d' });
      return { token, user };
    },

    getProfile: id => usersRepository.findPublicById(id),

    async changePassword({ userId, oldPassword, newPassword }) {
      const user = await usersRepository.findById(userId);
      if (!user || !(await bcrypt.compare(oldPassword, user.password))) return false;
      await usersRepository.updatePassword(userId, await bcrypt.hash(newPassword, 10));
      return true;
    }
  };
}

module.exports = { createAuthService };
