// Резерв фото перед генерацией и возврат неиспользованных — через пачки
// фото-кредитов со сроком (photo-credits.service).
function createCreditsService(photoCreditsService) {
  return {
    reserve(userId, amount) {
      return photoCreditsService.reserve(userId, amount);
    },
    async release(userId, amount, reservation) {
      if (amount <= 0) return;
      await photoCreditsService.release(userId, amount, reservation);
    }
  };
}

module.exports = { createCreditsService };
