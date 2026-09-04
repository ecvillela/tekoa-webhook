const { isAuthorized, establishSession } = require('../../lib/admin');
const { listWaitlist } = require('../../lib/waitlist');

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

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(401).send('<p style="font-family:sans-serif">Não autorizado. Acesse com <code>?token=SEU_ADMIN_TOKEN</code> na URL (só na primeira visita — depois fica salvo num cookie).</p>');
    return;
  }
  establishSession(req, res);

  const entries = await listWaitlist();

  const rows = entries
    .map(
      (e) => `
    <tr>
      <td>${esc(e.nome)}</td>
      <td><a href="https://wa.me/${esc(e.phone)}" target="_blank" rel="noopener">${esc(e.telefone)}</a></td>
      <td>${esc(e.motivacao)}</td>
      <td>${fmtDate(e.criadoEm)}</td>
    </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Tekoa — Lista de espera</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f6f2; color: #1a2e2a; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  nav { margin-bottom: 18px; font-size: 13px; }
  nav a { color: #0f6e56; text-decoration: none; margin-right: 16px; }
  nav a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding: 10px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #0f6e56; color: #fff; font-weight: 600; position: sticky; top: 0; }
  tr:hover { background: #f1f8f5; }
  .empty { padding: 40px; text-align: center; color: #888; }
  td a { color: #0f6e56; }
  .refresh { font-size: 12px; color: #888; margin-top: 16px; }
</style>
</head>
<body>
  <nav>
    <a href="/api/admin/dashboard">Painel interno (famílias)</a>
    <a href="/api/admin/waitlist">Lista de espera →</a>
    <a href="/api/admin/costs">Custos →</a>
    <a href="/api/admin/architecture">Arquitetura e Saúde do Sistema →</a>
    <a href="/api/admin/transcript">Transcript de teste (texto puro) →</a>
  </nav>
  <h1>Tekoa — Lista de espera</h1>
  <div class="sub">${entries.length} pessoa(s) cadastradas pelo formulário da landing page. Convite é manual, pelo WhatsApp — nada aqui dispara mensagem sozinho.</div>
  ${
    entries.length
      ? `<table>
    <thead>
      <tr>
        <th>Nome</th>
        <th>Telefone</th>
        <th>Motivação</th>
        <th>Entrou em</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
      : `<div class="empty">Ninguém na lista de espera ainda.</div>`
  }
  <div class="refresh">Atualiza a cada visita. <a href="/api/admin/waitlist">Recarregar</a></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
