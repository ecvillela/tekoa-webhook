const { isAuthorized, listFamilies } = require('../../lib/admin');

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Não autorizado. Passe ?token=SEU_ADMIN_TOKEN.' });
    return;
  }
  const families = await listFamilies();
  res.status(200).json({ total: families.length, families });
};
