const { isAuthorized, listFamilies } = require('../../lib/admin');
const { kvGet } = require('../../lib/state');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(assinatura) {
  if (assinatura.status === 'trial') {
    const dias = assinatura.diasRestantesTrial;
    const cor = dias != null && dias <= 2 ? '#c0392b' : '#b8860b';
    const texto = dias != null ? (dias >= 0 ? `teste — ${dias}d restantes` : 'teste vencido') : 'teste';
    return `<span style="background:${cor};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;">${esc(texto)}</span>`;
  }
  if (assinatura.status === 'active') {
    return `<span style="background:#1e8449;color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;">assinante ativo</span>`;
  }
  return `<span style="background:#7f8c8d;color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;">${esc(assinatura.status)}</span>`;
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(401).send('<p style="font-family:sans-serif">Não autorizado. Acesse com <code>?token=SEU_ADMIN_TOKEN</code> na URL.</p>');
    return;
  }

  const families = await listFamilies();
  const token = req.query.token;

  // Detalhe do que foi extraído de cada documento. Sem isto o painel só conta
  // documentos, e não dá pra auditar o que o TEKOA entendeu de cada foto.
  const logs = {};
  for (const f of families) {
    const st = await kvGet(`state:${f.phone}`);
    logs[f.phone] = (st && st.log) || [];
  }

  const logDetail = (f) => {
    const entries = logs[f.phone] || [];
    if (!entries.length) return '—';
    const items = entries
      .map((e, i) => {
        const dados = JSON.stringify(e.dados || {}, null, 1);
        return `<li><b>${esc(e.tipo || 'outro')}</b> — ${esc(e.resumo_curto || '')}<pre>${esc(dados)}</pre></li>`;
      })
      .join('');
    return `<details><summary>${entries.length} doc(s)</summary><ol>${items}</ol></details>`;
  };

  const rows = families
    .map(
      (f) => `
    <tr>
      <td>${esc(f.phone)}</td>
      <td>${statusBadge(f.assinatura)}</td>
      <td>${esc(f.stage)}</td>
      <td>${esc(f.criancas.join(', ') || '—')}</td>
      <td>${esc(f.escolas.join(', ') || '—')}</td>
      <td style="text-align:center">${f.documentosRegistrados}</td>
      <td>${logDetail(f)}</td>
      <td style="text-align:center">${f.messagesIn} / ${f.messagesOut}</td>
      <td>${fmtDate(f.createdAt)}</td>
      <td>${fmtDate(f.lastContactAt)}</td>
    </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>TEKOA — Painel interno</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f6f2; color: #1a2e2a; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  nav { margin-bottom: 18px; font-size: 13px; }
  nav a { color: #0f6e56; text-decoration: none; margin-right: 16px; }
  nav a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding: 10px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #eee; }
  th { background: #0f6e56; color: #fff; font-weight: 600; position: sticky; top: 0; }
  tr:hover { background: #f1f8f5; }
  .empty { padding: 40px; text-align: center; color: #888; }
  .refresh { font-size: 12px; color: #888; margin-top: 16px; }
  details { font-size: 12px; }
  details summary { cursor: pointer; color: #0f6e56; }
  details ol { margin: 6px 0 0 16px; padding: 0; }
  details li { margin-bottom: 6px; }
  details pre { background: #f4f4f2; padding: 6px; border-radius: 4px; margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; }
</style>
</head>
<body>
  <nav>
    <a href="/api/admin/dashboard?token=${esc(token)}">Painel interno (famílias)</a>
    <a href="/api/admin/architecture?token=${esc(token)}">Arquitetura e Saúde do Sistema →</a>
  </nav>
  <h1>TEKOA — Painel interno</h1>
  <div class="sub">${families.length} família(s) cadastrada(s). Só visível com o token de admin — não compartilhe este link.</div>
  ${
    families.length
      ? `<table>
    <thead>
      <tr>
        <th>Telefone</th>
        <th>Assinatura</th>
        <th>Etapa</th>
        <th>Criança(s)</th>
        <th>Escola(s)</th>
        <th>Docs</th>
        <th>O que foi extraído</th>
        <th>Msgs in/out</th>
        <th>Conta aberta em</th>
        <th>Último contato</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
      : `<div class="empty">Nenhuma família cadastrada ainda.</div>`
  }
  <div class="refresh">Atualiza a cada visita. <a href="?token=${esc(token)}">Recarregar</a></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
