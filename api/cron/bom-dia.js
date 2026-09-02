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
  // Release 9 (04/09/2026): pedido do Eduardo — a mesma dica de encaminhar
  // bilhetes/avisos (ver onboarding em lib/flows.js) também deve aparecer no
  // bom dia. IMPORTANTE: isto ainda é o texto de teste do cron (item 5.1,
  // "bom dia de verdade", continua pendente) — quando o bom dia virar um
  // template de fato aprovado pela Meta (item 1.3/4.4), esta dica precisa
  // entrar no TEXTO FINAL desse template, não só aqui no stub; registrado
  // também em TEKOA - Pendências.md, item 4.4, pra não se perder.
  await wa.sendText(
    phone,
    `Bom dia! O dia de ${child && child.raw ? child.raw : 'hoje'}:\n(resumo de teste — nota: fora da janela de 24h isso precisa de um template aprovado pela Meta)\n\nDica: encaminha pra mim os bilhetes e avisos assim que chegarem — eu já deixo tudo organizado pro dia certo.`,
    { kind: 'template:utility', meta: { tipo: 'bom_dia' } }
  );
  res.status(200).send('sent');
};
