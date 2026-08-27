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

// Além de checar o número, chama /debug_token pra saber se o
// WHATSAPP_ACCESS_TOKEN é permanente ou temporário, quando expira, e —
// crucialmente — para QUAL APP esse token foi de fato emitido. Um token
// gerado no lugar errado (ex: Graph API Explorer, Business Settings de um
// jeito genérico, ou outro app) pode ter permissão suficiente pra chamadas
// de leitura/envio funcionarem, mas não é garantia de que é o mesmo app que
// está inscrito na WABA — por isso essa checagem existe separada.
async function checkWhatsAppToken() {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneId) {
          return { ok: false, detail: 'WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados', tokenInfo: null };
    }

  let tokenInfo = null;
    try {
          const dbg = await fetch(
                  `https://graph.facebook.com/v21.0/debug_token?input_token=${token}&access_token=${token}`
                );
          const dbgData = await dbg.json();
          const d = dbgData.data;
          if (d) {
                  const expiresAt = d.expires_at === 0 ? null : d.expires_at;
                  tokenInfo = {
                            valid: !!d.is_valid,
                            type: d.type || '?',
                            expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
                            neverExpires: d.expires_at === 0,
                            dataAccessExpiresAt: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : null,
                            appId: d.app_id || null,
                            appName: d.application || null,
                            scopes: Array.isArray(d.scopes) ? d.scopes : null
                  };
          }
    } catch (err) {
          // Se o debug_token falhar, seguimos sem essa info — não é crítico.
    }

  try {
        const r = await fetch(
                `https://graph.facebook.com/v21.0/${phoneId}?fields=display_phone_number,quality_rating,status,account_mode`,
          { headers: { Authorization: `Bearer ${token}` } }
              );
        const data = await r.json();
        if (data.error) return { ok: false, detail: `Graph API: ${data.error.message}`, tokenInfo };
        return {
                ok: true,
                detail: `${data.display_phone_number || phoneId} — status ${data.status || '?'} — quality ${data.quality_rating || '?'} — modo ${data.account_mode || '?'}`,
                tokenInfo
        };
  } catch (err) {
        return { ok: false, detail: err.message, tokenInfo };
  }
}

// Confirma se a WABA está de fato inscrita para receber webhooks do nosso
// app (a causa raiz mais comum de "mensagem chega no WhatsApp mas nunca
// aparece no webhook" — ver checklist na página de arquitetura). Também
// retorna os IDs dos apps inscritos, pra comparar com o app_id do token.
async function checkWabaSubscription() {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (!token || !wabaId) {
          return { ok: null, detail: 'WHATSAPP_BUSINESS_ACCOUNT_ID não configurado — não dá pra checar automaticamente. Confirme manualmente no Graph API Explorer.', appIds: [] };
    }
    try {
          const r = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
                  headers: { Authorization: `Bearer ${token}` }
          });
          const data = await r.json();
          if (data.error) return { ok: false, detail: `Graph API: ${data.error.message}`, appIds: [] };
          const list = data.data || [];
          const apps = list.map((a) => a.whatsapp_business_api_data?.name || a.id);
          const appIds = list.map((a) => String(a.whatsapp_business_api_data?.id || a.id));
          return {
                  ok: apps.length > 0,
                  detail: apps.length ? `App(s) inscrito(s): ${apps.join(', ')}` : 'Nenhum app inscrito — esta é a causa mais comum de mensagens reais não chegarem no webhook.',
                  appIds
          };
    } catch (err) {
          return { ok: false, detail: err.message, appIds: [] };
    }
}

function checkAnthropicKey() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { ok: false, detail: 'ANTHROPIC_API_KEY não configurada' };
    if (!key.startsWith('sk-ant-')) return { ok: false, detail: 'valor presente mas com formato inesperado' };
    return { ok: true, detail: 'presente (não fazemos chamada real aqui pra não gastar crédito — teste mandando uma mensagem real)' };
}

function checkGeminiKey() {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return { ok: false, detail: 'GEMINI_API_KEY não configurada — só relevante se AI_PROVIDER usa gemini ou compare' };
      return { ok: true, detail: 'presente (não fazemos chamada real aqui pra não gastar cota — teste mandando uma mensagem real com AI_PROVIDER=gemini)' };
}


// Só checa presença, nunca o valor. Usado pra tabela de variáveis do painel.
function checkEnvPresence(names) {
    return names.map((name) => ({ name, ok: !!process.env[name] }));
}

module.exports = { checkKV, checkWhatsAppToken, checkWabaSubscription, checkAnthropicKey, checkGeminiKey, checkEnvPresence };
