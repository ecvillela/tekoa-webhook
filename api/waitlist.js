const { addToWaitlist } = require('../lib/waitlist');

// Endpoint público (sem token de admin) pro formulário de lista de espera da
// landing page — repo separado (tekoa-site), por isso o CORS explícito
// abaixo. Só aceita nome/telefone/motivação; nada sensível (sem senha, sem
// pagamento) passa por aqui.
const ALLOWED_ORIGIN = 'https://tekoaapp.com.br';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    // Preflight do navegador antes do POST com Content-Type: application/json.
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};

  // Honeypot: campo escondido no formulário real (nunca preenchido por
  // gente de verdade). Se veio preenchido, é bot — responde 200 normal, sem
  // gravar nada, pra não entregar que foi filtrado.
  if (body.empresa) {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    await addToWaitlist({
      nome: body.nome,
      telefone: body.telefone,
      motivacao: body.motivacao
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err.validation) {
      res.status(400).json({ ok: false, error: err.message });
      return;
    }
    console.error('[waitlist] erro ao gravar entrada', err);
    res.status(500).json({ ok: false, error: 'Erro interno. Tenta de novo em instantes.' });
  }
};
