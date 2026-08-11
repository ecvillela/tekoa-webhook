const { kvGet } = require('../../lib/state');
const wa = require('../../lib/whatsapp');

module.exports = async (req, res) => {
  const phone = process.env.TEST_PHONE;
  if (!phone) {
    res.status(200).send('no TEST_PHONE configured');
    return;
  }
  const state = await kvGet(`state:${phone}`);
  const child = state && state.family && state.family.children && state.family.children[0];
  await wa.sendText(
    phone,
    `Bom dia! O dia de ${child && child.raw ? child.raw : 'hoje'}:\n(resumo de teste — nota: fora da janela de 24h isso precisa de um template aprovado pela Meta)`
  );
  res.status(200).send('sent');
};
