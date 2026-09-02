const { kvGet, kvKeys } = require('./state');

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

// Header Authorization: Bearer <token> OU cookie de sessão — nunca mais
// query string aceita direto (?token= vazava em histórico de navegador, log
// de acesso do Vercel e referrer). Ver establishSession() abaixo pra como o
// cookie é criado sem quebrar o uso em navegador comum.
function isAuthorized(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false; // nunca libera se o token não foi configurado
  const authHeader = req.headers.authorization || '';
  const fromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (fromHeader === token) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies.tekoa_admin === token;
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
      assinatura: subscriptionSummary(state.subscription)
    });
  }

  families.sort((a, b) => new Date(b.lastContactAt || 0) - new Date(a.lastContactAt || 0));
  return families;
}

module.exports = { isAuthorized, establishSession, listFamilies };
