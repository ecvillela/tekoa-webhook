// Release 3 (30/08/2026): endpoint de transcript de teste. Devolve as últimas
// mensagens de uma família em texto puro — feito pra ser lido rápido (por uma
// pessoa ou por uma automação de navegador), sem precisar de print de tela.
// Não substitui o painel de famílias (api/admin/dashboard.js), que continua
// sendo a visão de "o que cada família tem cadastrado"; este é "o que foi
// dito, mensagem por mensagem".
const { isAuthorized } = require('../../lib/admin');
const { kvGet } = require('../../lib/state');

function fmtTime(iso) {
  if (!iso) return '--:--:--';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!isAuthorized(req)) {
    res.status(401).send('Não autorizado. Acesse com ?token=SEU_ADMIN_TOKEN na URL.');
    return;
  }

  const phone = req.query.phone || process.env.TEST_PHONE;
  if (!phone) {
    res.status(400).send('Informe ?phone=55XXXXXXXXXXX (ou configure TEST_PHONE na Vercel pra usar como padrão).');
    return;
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
  const state = await kvGet(`state:${phone}`);

  if (!state) {
    res.status(200).send(`(sem estado registrado para ${phone})`);
    return;
  }

  const transcript = (state.transcript || []).slice(-limit);
  if (!transcript.length) {
    res
      .status(200)
      .send(
        `(sem transcript registrado ainda para ${phone} — precisa da Release 3 estar em produção e pelo menos uma mensagem nova depois do deploy)`
      );
    return;
  }

  const lines = transcript.map((e) => {
    const quem = e.direction === 'in' ? 'Você ' : 'TEKOA';
    return `[${fmtTime(e.ts)}] ${quem}: ${e.text}`;
  });

  res.status(200).send(lines.join('\n'));
};
