function createTemplatesService(templatesRepository) {
  return {
    list: userId => templatesRepository.listByUserId(userId),
    save: (userId, template) => templatesRepository.replaceByName(userId, template),
    remove: (userId, name) => templatesRepository.deleteByName(userId, name)
  };
}

module.exports = { createTemplatesService };
