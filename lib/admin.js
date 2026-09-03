const { kvGet, kvKeys } = require('./state');

// Release 10 (04/09/2026): sessão do painel admin por cookie, em vez de só
// query string — pedido de segurança da arquitetura (item 5.12/5.13,
// TEKOA - Pendências.md). O token continua aceito por header
// (Authorization: Bearer) e, só na primeira visita, por ?token= na URL —
// establishSession() abaixo promove essa primeira visita pra um cookie
// httpOnly/secure, e a partir daí o token para de aparecer em cada link, em
// cada linha de log de acesso e no histórico do navegador.
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthorized(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false; // nunca libera se o token não foi configurado
  const authHeader = req.headers.authorization || '';
  const fromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (fromHeader === token) return true;
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.tekoa_admin === token) return true;
  // Só aceito aqui pra permitir a primeira visita (antes de existir cookie).
  // establishSession() abaixo é quem transforma essa visita num cookie, pra
  // não precisar de query string de novo depois.
  return req.query.token === token;
}

// Chamado pelos endpoints HTML logo depois de isAuthorized() já ter liberado
// o acesso. Se a autorização desta requisição veio de ?token= na URL (não
// do cookie), grava um cookie httpOnly/secure de 24h — as próximas
// requisições (recarregar, navegar entre painéis) não precisam mais do
// token na querystring, então ele para de aparecer em cada linha de log e
// de ficar salvo no histórico do navegador a cada clique. Idempotente: se a
// sessão já veio do cookie, não faz nada.
function establishSession(req, res) {
  const token = process.env.ADMIN_TOKEN;
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.tekoa_admin === token) return;
  if (req.query.token === token) {
    res.setHeader(
      'Set-Cookie',
      `tekoa_admin=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`
    );
  }
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

module.exports = { isAuthorized, establishSession, listFamilies };
