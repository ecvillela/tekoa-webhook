const { kvGet, kvSet } = require('./state');

// Checagens de saúde do sistema, usadas pelo painel de arquitetura
// (api/admin/architecture.js). Nunca retornam nem logam o valor de nenhuma
// credencial — só se está presente/ausente e, quando dá pra checar ao vivo,
// se a chamada funcionou.

async function checkKV() {
  try {
    const testKey = '__health_check__';
    await kvSet(testKey, { ts: Date.now() });
    const val = await kvGet(testKey);
    return { ok: !!val, detail: val ? 'leitura/escrita OK (Upstash Redis)' : 'escreveu mas não leu de volta' };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function checkWhatsAppToken() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { ok: false, detail: 'WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados' };
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${phoneId}?fields=display_phone_number,quality_rating,status`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    if (data.error) return { ok: false, detail: `Graph API: ${data.error.message}` };
    return {
      ok: true,
      detail: `${data.display_phone_number || phoneId} — status ${data.status || '?'} — quality ${data.quality_rating || '?'}`
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

function checkAnthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, detail: 'ANTHROPIC_API_KEY não configurada' };
  if (!key.startsWith('sk-ant-')) return { ok: false, detail: 'valor presente mas com formato inesperado' };
  return { ok: true, detail: 'presente (não fazemos chamada real aqui pra não gastar crédito — teste mandando uma mensagem real)' };
}

// Só checa presença, nunca o valor. Usado pra tabela de variáveis do painel.
function checkEnvPresence(names) {
  return names.map((name) => ({ name, ok: !!process.env[name] }));
}

module.exports = { checkKV, checkWhatsAppToken, checkAnthropicKey, checkEnvPresence };
