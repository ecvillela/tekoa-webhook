const { isAuthorized, establishSession, listFamilies } = require('../../lib/admin');

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Não autorizado. Use header Authorization: Bearer SEU_ADMIN_TOKEN, ou visite /api/admin/dashboard?token=... uma vez pra criar a sessão.' });
    return;
  }
  establishSession(req, res);
  const families = await listFamilies();
  res.status(200).json({ total: families.length, families });
};
