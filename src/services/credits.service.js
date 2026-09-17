function createCreditsService(usersRepository) {
  return {
    reserve(userId, amount) {
      return usersRepository.reserveCredits(userId, amount);
    },
    async release(userId, amount) {
      if (amount <= 0) return;
      await usersRepository.releaseCredits(userId, amount);
    }
  };
}

module.exports = { createCreditsService };
