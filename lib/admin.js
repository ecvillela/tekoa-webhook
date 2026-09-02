const { kvGet, kvKeys } = require('./state');

function isAuthorized(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false; // nunca libera se o token não foi configurado
  const fromQuery = req.query.token;
  const authHeader = req.headers.authorization || '';
  const fromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return fromQuery === token || fromHeader === token;
}

function subscriptionSummary(sub) {
  if (!sub) return { status: 'trial', diasRestantesTrial: null };
  if (sub.status === 'trial' && sub.trialEndsAt) {
    const diff = new Date(sub.trialEndsAt).getTime() - Date.now();
    const dias = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return { status: 'trial', diasRestantesTrial: dias };
  }
  return { status: sub.status, diasRestantesTrial: null };
}

async function listFamilies() {
  const keys = await kvKeys('state:*');
  const families = [];

  for (const key of keys) {
    const state = await kvGet(key);
    if (!state) continue;
    const phone = key.replace(/^state:/, '');
    const childrenNames = (state.family?.children || []).map((c) => c.name || c.raw).filter(Boolean);
    // Custo acumulado gravado por lib/costs.js (recordAiCost/recordWhatsappSend)
    // — pedido de MKT (backlog 5.8), pra dar visibilidade de custo por família
    // direto na mesma listagem, sem precisar abrir o painel de custos.
    const custo = await kvGet(`cost:family:${phone}`);
    families.push({
      phone,
      stage: state.stage,
      criancas: childrenNames,
      escolas: [...new Set((state.family?.children || []).map((c) => c.school).filter(Boolean))],
      documentosRegistrados: (state.log || []).length,
      createdAt: state.createdAt,
      lastContactAt: state.lastContactAt,
      messagesIn: state.messagesIn || 0,
      messagesOut: state.messagesOut || 0,
      assinatura: subscriptionSummary(state.subscription),
      custoTotalBRL: custo ? custo.totalBRL || 0 : 0
    });
  }

  families.sort((a, b) => new Date(b.lastContactAt || 0) - new Date(a.lastContactAt || 0));
  return families;
}

module.exports = { isAuthorized, listFamilies };
