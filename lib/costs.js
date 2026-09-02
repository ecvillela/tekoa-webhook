// Rastreamento de custo do TEKOA — grava um evento por chamada de IA e por
// mensagem de WhatsApp cobrada, em KV (mesmo Upstash/Map de lib/state.js), e
// agrega por dia e por família pro painel /api/admin/costs.
//
// Origem: pedido de MKT (backlog 5.8/5.9/5.10) — "custo por família" para não
// deixar o preço fixo de R$29/casa virar prejuízo silencioso conforme o
// número de membros ativos cresce. Ver TEKOA - Custos.md no Project.
//
// IMPORTANTE — os preços abaixo são estimativas por token/mensagem, NÃO
// faturas reais dos provedores. Todos são configuráveis por env var; os que
// não têm um número confiável ficam null de propósito, e o painel mostra
// "não configurado" em vez de inventar um valor:
//
// - IA (Anthropic/Gemini): preço por milhão de tokens, calibrado com preços
//   de mercado em 28/08/2026. Confirme em
//   console.anthropic.com/settings/billing e ai.google.dev/gemini-api/docs/pricing
//   antes de usar esse número pra decisão de preço — pode estar desatualizado.
// - WhatsApp: a Meta migrou de "por conversa" pra "por mensagem" em jul/2025,
//   com valor por categoria de template (Utility/Marketing/Authentication) e
//   por país. Os valores em BRL para o Brasil NÃO vêm preenchidos aqui —
//   configure via WHATSAPP_PRICE_*_BRL antes de confiar nesse número. Uma
//   mensagem de SESSÃO (resposta dentro da janela de 24h a algo que o usuário
//   mandou — a maioria das respostas do TEKOA hoje) é tratada como gratuita;
//   confirme se ainda vale pra sua conta em
//   developers.facebook.com/documentation/business-messaging/whatsapp/pricing
// - Vercel e Asaas: não são medidos por chamada. Entre com um valor mensal
//   fixo (Vercel) ou uma taxa percentual (Asaas) via env var; o painel
//   divide o valor mensal pelos dias do período, só como referência visual.

const { kvGet, kvSet, kvKeys } = require('./state');

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const PRICE = {
  usdBrl: num(process.env.USD_BRL_RATE, 5.3),
  claude: {
    inputPerMTok: num(process.env.CLAUDE_PRICE_INPUT_USD_PER_MTOK, 3.0),
    outputPerMTok: num(process.env.CLAUDE_PRICE_OUTPUT_USD_PER_MTOK, 15.0)
  },
  gemini: {
    inputPerMTok: num(process.env.GEMINI_PRICE_INPUT_USD_PER_MTOK, 0.1),
    outputPerMTok: num(process.env.GEMINI_PRICE_OUTPUT_USD_PER_MTOK, 0.4)
  },
  // BRL por mensagem de template, por categoria. null = não configurado.
  whatsappTemplateBRL: {
    utility: num(process.env.WHATSAPP_PRICE_UTILITY_BRL, null),
    marketing: num(process.env.WHATSAPP_PRICE_MARKETING_BRL, null),
    authentication: num(process.env.WHATSAPP_PRICE_AUTH_BRL, null)
  },
  vercelMonthlyBRL: num(process.env.VERCEL_MONTHLY_COST_BRL, null),
  asaasFeePercent: num(process.env.ASAAS_FEE_PERCENT, null)
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD em UTC — chave estável pra agregação
}

async function appendEvent(dateKey, event) {
  const key = `cost:${dateKey}`;
  const day = (await kvGet(key)) || [];
  day.push(event);
  await kvSet(key, day);

  if (event.phone) {
    const famKey = `cost:family:${event.phone}`;
    const fam = (await kvGet(famKey)) || { totalBRL: 0, events: 0, since: new Date().toISOString() };
    fam.totalBRL = round2((fam.totalBRL || 0) + event.amountBRL);
    fam.events = (fam.events || 0) + 1;
    fam.lastAt = new Date().toISOString();
    await kvSet(famKey, fam);
  }
}

// Chamado de dentro de lib/claude.js e lib/gemini.js logo após cada resposta
// da API, com o uso de tokens que a própria API devolve (nunca estimado).
async function recordAiCost({ provider, op, phone, inputTokens, outputTokens }) {
  const price = provider === 'gemini' ? PRICE.gemini : PRICE.claude;
  const usd =
    ((inputTokens || 0) / 1e6) * price.inputPerMTok + ((outputTokens || 0) / 1e6) * price.outputPerMTok;
  const amountBRL = round2(usd * PRICE.usdBrl);

  try {
    await appendEvent(todayKey(), {
      ts: new Date().toISOString(),
      source: 'ia',
      provider,
      op: op || null,
      phone: phone || null,
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      amountUSD: round2(usd),
      amountBRL
    });
  } catch (err) {
    console.error(`[costs] falha ao gravar custo de IA: ${err.message}`);
  }

  return amountBRL;
}

// Chamado de dentro de lib/whatsapp.js a cada envio. kind:
//   'session'                 — resposta dentro da janela de 24h (tratada como grátis)
//   'template:utility'        — template categoria Utility (ex: bom dia)
//   'template:marketing'      — template categoria Marketing
//   'template:authentication' — template categoria Authentication
async function recordWhatsappSend({ phone, kind = 'session', meta }) {
  let amountBRL = 0;
  let naoConfigurado = false;

  if (kind.startsWith('template:')) {
    const cat = kind.split(':')[1];
    const price = PRICE.whatsappTemplateBRL[cat];
    if (price == null) naoConfigurado = true;
    else amountBRL = price;
  }

  try {
    await appendEvent(todayKey(), {
      ts: new Date().toISOString(),
      source: 'whatsapp',
      kind,
      phone: phone || null,
      meta: meta || null,
      amountBRL,
      naoConfigurado
    });
  } catch (err) {
    console.error(`[costs] falha ao gravar custo de whatsapp: ${err.message}`);
  }

  return amountBRL;
}

// --- Agregações para o painel ---

function emptyBreakdown() {
  return { ia: 0, whatsapp: 0, vercel: 0, asaas: 0, total: 0, temNaoConfigurado: false };
}

// Asaas não é medido por evento (ainda não existe webhook de cobrança
// instrumentado — ver nota "Cobrança — integração ainda em andamento" no
// painel de Arquitetura). Até isso existir, a única estimativa possível é
// indireta: nº de famílias com assinatura ativa × valor do plano × taxa
// percentual do Asaas, ratelado pelos dias do mês — mesma lógica do Vercel.
// Trocar por dados reais assim que o webhook do Asaas existir.
async function countActiveSubscriptions() {
  const keys = await kvKeys('state:*');
  let count = 0;
  for (const key of keys) {
    const state = await kvGet(key);
    if (state && state.subscription && state.subscription.status === 'active') count++;
  }
  return count;
}

async function getDailyBreakdown(days = 30) {
  const out = [];
  const now = new Date();

  let activeSubscriptions = null;
  if (PRICE.asaasFeePercent != null) {
    activeSubscriptions = await countActiveSubscriptions();
  }

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = todayKey(d);
    const events = (await kvGet(`cost:${key}`)) || [];
    const row = emptyBreakdown();
    row.date = key;
    for (const e of events) {
      if (e.source === 'ia') row.ia = round2(row.ia + e.amountBRL);
      if (e.source === 'whatsapp') {
        row.whatsapp = round2(row.whatsapp + e.amountBRL);
        if (e.naoConfigurado) row.temNaoConfigurado = true;
      }
    }
    const daysInMonth = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();

    // Vercel não é medido por dia — só referência visual dividindo o valor
    // mensal fixo (se configurado) pelos dias do mês corrente.
    if (PRICE.vercelMonthlyBRL != null) {
      row.vercel = round2(PRICE.vercelMonthlyBRL / daysInMonth);
    } else {
      row.temNaoConfigurado = true;
    }

    // Asaas — ver countActiveSubscriptions acima. Estimativa, não fatura real.
    if (PRICE.asaasFeePercent != null) {
      row.asaas = round2((activeSubscriptions * PLAN_VALUE_BRL * (PRICE.asaasFeePercent / 100)) / daysInMonth);
    } else {
      row.temNaoConfigurado = true;
    }

    row.total = round2(row.ia + row.whatsapp + row.vercel + row.asaas);
    out.push(row);
  }
  return out;
}

async function getFamilyBreakdown() {
  const keys = await kvKeys('cost:family:*');
  const rows = [];
  for (const key of keys) {
    const phone = key.replace(/^cost:family:/, '');
    const fam = await kvGet(key);
    if (!fam) continue;
    rows.push({ phone, totalBRL: fam.totalBRL || 0, events: fam.events || 0, lastAt: fam.lastAt });
  }
  rows.sort((a, b) => b.totalBRL - a.totalBRL);
  return rows;
}

// Alerta proativo: família cujo custo acumulado já consome uma fatia grande
// do plano de R$29/casa — sinal de que o preço fixo pode não estar cobrindo
// o custo daquela família (ver MKT §8.1).
const PLAN_VALUE_BRL = 29;
const ALERT_THRESHOLD = num(process.env.COST_ALERT_THRESHOLD_PERCENT, 70) / 100;

function withAlerts(familyRows) {
  return familyRows.map((f) => {
    const ratio = f.totalBRL / PLAN_VALUE_BRL;
    let nivel = 'ok';
    if (ratio >= 1) nivel = 'critico';
    else if (ratio >= ALERT_THRESHOLD) nivel = 'atencao';
    return { ...f, ratio: round2(ratio), nivel };
  });
}

module.exports = {
  recordAiCost,
  recordWhatsappSend,
  getDailyBreakdown,
  getFamilyBreakdown,
  withAlerts,
  PRICE,
  PLAN_VALUE_BRL,
  ALERT_THRESHOLD
};
