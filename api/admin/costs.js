// Painel de custos — pedido de Eduardo (28/08/2026): "além do marketing,
// gerencie os custos do projeto" + "uma nova página com a quebra de custos
// por data" no mesmo painel que já existe. Ver claude/TEKOA - Custos.md no
// Project pra contexto completo (fontes, premissas, o que falta configurar).
//
// IMPORTANTE: os valores aqui são ESTIMATIVA calculada a partir de uso
// (tokens de IA, mensagens de WhatsApp por categoria), não fatura real dos
// provedores. lib/costs.js documenta cada premissa. Reconciliar com as
// faturas reais (Anthropic/Google, Meta, Vercel, Asaas) é trabalho futuro —
// por ora isso serve pra visibilidade e alerta, não pra contabilidade.
const { isAuthorized } = require('../../lib/admin');
const costs = require('../../lib/costs');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function brl(n) {
  return `R$ ${Number(n || 0).toFixed(2)}`;
}

function fmtDateShort(key) {
  // key é 'YYYY-MM-DD'
  const [, m, d] = key.split('-');
  return `${d}/${m}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function nivelBadge(nivel) {
  const map = {
    ok: ['#1e8449', 'ok'],
    atencao: ['#b8860b', 'atenção'],
    critico: ['#c0392b', 'crítico']
  };
  const [cor, texto] = map[nivel] || map.ok;
  return `<span style="background:${cor};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;">${texto}</span>`;
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(401).send('<p style="font-family:sans-serif">Não autorizado. Acesse com <code>?token=SEU_ADMIN_TOKEN</code> na URL.</p>');
    return;
  }

  const token = req.query.token;
  const days = Math.min(90, Math.max(7, Number(req.query.dias) || 30));

  const daily = await costs.getDailyBreakdown(days);
  const familyRaw = await costs.getFamilyBreakdown();
  const familyRows = costs.withAlerts(familyRaw);

  const totals = daily.reduce(
    (acc, r) => ({
      ia: acc.ia + r.ia,
      whatsapp: acc.whatsapp + r.whatsapp,
      vercel: acc.vercel + r.vercel,
      asaas: acc.asaas + r.asaas,
      total: acc.total + r.total
    }),
    { ia: 0, whatsapp: 0, vercel: 0, asaas: 0, total: 0 }
  );

  const temNaoConfigurado = daily.some((r) => r.temNaoConfigurado);

  const naoConfiguradoList = [];
  if (costs.PRICE.whatsappTemplateBRL.utility == null) naoConfiguradoList.push('WHATSAPP_PRICE_UTILITY_BRL');
  if (costs.PRICE.whatsappTemplateBRL.marketing == null) naoConfiguradoList.push('WHATSAPP_PRICE_MARKETING_BRL');
  if (costs.PRICE.whatsappTemplateBRL.authentication == null) naoConfiguradoList.push('WHATSAPP_PRICE_AUTH_BRL');
  if (costs.PRICE.vercelMonthlyBRL == null) naoConfiguradoList.push('VERCEL_MONTHLY_COST_BRL');
  if (costs.PRICE.asaasFeePercent == null) naoConfiguradoList.push('ASAAS_FEE_PERCENT');

  const dailyRows = daily
    .map(
      (r) => `
    <tr>
      <td>${fmtDateShort(r.date)}</td>
      <td style="text-align:right">${brl(r.ia)}</td>
      <td style="text-align:right">${brl(r.whatsapp)}</td>
      <td style="text-align:right">${brl(r.vercel)}</td>
      <td style="text-align:right">${brl(r.asaas)}</td>
      <td style="text-align:right;font-weight:600">${brl(r.total)}${r.temNaoConfigurado ? ' <span title="tem fonte não configurada" style="color:#b8860b">*</span>' : ''}</td>
    </tr>`
    )
    .join('');

  const familyTableRows = familyRows
    .map(
      (f) => `
    <tr>
      <td>${esc(f.phone)}</td>
      <td style="text-align:center">${f.events}</td>
      <td style="text-align:right">${brl(f.totalBRL)}</td>
      <td style="text-align:right">${(f.ratio * 100).toFixed(0)}% do plano</td>
      <td>${nivelBadge(f.nivel)}</td>
      <td>${fmtDate(f.lastAt)}</td>
    </tr>`
    )
    .join('');

  const alertas = familyRows.filter((f) => f.nivel !== 'ok');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>TEKOA — Custos</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f6f2; color: #1a2e2a; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin: 28px 0 12px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  nav { margin-bottom: 18px; font-size: 13px; }
  nav a { color: #0f6e56; text-decoration: none; margin-right: 16px; }
  nav a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding: 8px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #eee; }
  th { background: #0f6e56; color: #fff; font-weight: 600; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 28px; }
  .card { background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 14px 18px; min-width: 140px; }
  .card .label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .card .value { font-size: 20px; font-weight: 600; }
  .disclaimer { background: #fdf6e3; border: 1px solid #e8d9a0; border-radius: 8px; padding: 12px 16px; font-size: 12.5px; color: #6b5b1f; margin-bottom: 24px; line-height: 1.5; }
  .alert-box { background: #fdeceb; border: 1px solid #f0b8b3; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #8a2e26; margin-bottom: 24px; }
  .alert-box.empty { background: #eef7f2; border-color: #bfe3cf; color: #1e6b45; }
  .empty { padding: 40px; text-align: center; color: #888; }
  .refresh { font-size: 12px; color: #888; margin-top: 16px; }
  code { background: #f1f0eb; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .config-note { font-size: 12px; color: #888; margin-top: 8px; }
</style>
</head>
<body>
  <nav>
    <a href="/api/admin/dashboard?token=${esc(token)}">← Painel interno (famílias)</a>
    <a href="/api/admin/costs?token=${esc(token)}">Custos</a>
    <a href="/api/admin/architecture?token=${esc(token)}">Arquitetura e Saúde do Sistema</a>
  </nav>
  <h1>TEKOA — Custos</h1>
  <div class="sub">Estimativa de custo operacional (IA, WhatsApp, Vercel, Asaas), calculada a partir de uso — não é fatura. Últimos ${days} dias.</div>

  <div class="disclaimer">
    ⚠️ <strong>Isto é uma estimativa, não a fatura real.</strong> IA (Anthropic/Gemini) usa o número de tokens que a própria API devolve em cada chamada — confiável — multiplicado por um preço por token configurado manualmente aqui (confira se ainda bate com o preço vigente do provedor). WhatsApp usa a categoria de template e um valor em BRL configurado por env var. Vercel e Asaas não são medidos por evento — são um valor fixo/percentual ratelado pelos dias do período, só como referência visual.
    ${
      naoConfiguradoList.length
        ? `<div class="config-note">Fontes ainda sem preço configurado (aparecem como R$ 0,00 acima, marcadas com *): ${naoConfiguradoList
            .map((v) => `<code>${esc(v)}</code>`)
            .join(', ')}. Configure essas env vars no Vercel pra esses números deixarem de ser zero.</div>`
        : ''
    }
  </div>

  <div class="cards">
    <div class="card"><div class="label">IA (${days}d)</div><div class="value">${brl(totals.ia)}</div></div>
    <div class="card"><div class="label">WhatsApp (${days}d)</div><div class="value">${brl(totals.whatsapp)}</div></div>
    <div class="card"><div class="label">Vercel (${days}d)</div><div class="value">${brl(totals.vercel)}</div></div>
    <div class="card"><div class="label">Asaas (${days}d, estimado)</div><div class="value">${brl(totals.asaas)}</div></div>
    <div class="card"><div class="label">Total (${days}d)</div><div class="value">${brl(totals.total)}</div></div>
  </div>

  <h2>Alerta proativo — famílias perto ou acima do plano (R$ ${costs.PLAN_VALUE_BRL}/casa)</h2>
  ${
    alertas.length
      ? `<div class="alert-box">${alertas.length} família(s) já consumindo ${(costs.ALERT_THRESHOLD * 100).toFixed(0)}%+ do valor do plano em custo estimado — ver tabela abaixo. Isso é o sinal de que o preço fixo por casa pode não estar cobrindo o custo daquela família (mais membros ativos = mais custo, receita continua igual).</div>`
      : `<div class="alert-box empty">Nenhuma família acima de ${(costs.ALERT_THRESHOLD * 100).toFixed(0)}% do plano no momento.</div>`
  }

  <h2>Quebra por dia</h2>
  ${
    daily.length
      ? `<table>
    <thead><tr><th>Data</th><th style="text-align:right">IA</th><th style="text-align:right">WhatsApp</th><th style="text-align:right">Vercel</th><th style="text-align:right">Asaas</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${dailyRows}</tbody>
  </table>`
      : `<div class="empty">Sem dados de custo ainda.</div>`
  }

  <h2>Custo por família (acumulado, desde que a instrumentação começou)</h2>
  ${
    familyRows.length
      ? `<table>
    <thead><tr><th>Telefone</th><th style="text-align:center">Eventos</th><th style="text-align:right">Custo total</th><th style="text-align:right">% do plano</th><th>Nível</th><th>Último evento</th></tr></thead>
    <tbody>${familyTableRows}</tbody>
  </table>`
      : `<div class="empty">Sem dados de custo por família ainda.</div>`
  }

  <div class="refresh">Atualiza a cada visita. <a href="?token=${esc(token)}">Recarregar</a> · <a href="?token=${esc(token)}&dias=7">7 dias</a> · <a href="?token=${esc(token)}&dias=30">30 dias</a> · <a href="?token=${esc(token)}&dias=90">90 dias</a></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
