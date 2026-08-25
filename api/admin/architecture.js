const { isAuthorized } = require('../../lib/admin');
const { checkKV, checkWhatsAppToken, checkAnthropicKey, checkEnvPresence } = require('../../lib/health');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function dot(ok) {
  const color = ok === true ? '#1e8449' : ok === false ? '#c0392b' : '#95a5a6';
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle;"></span>`;
}

function box(title, subtitle, statusOk, detail) {
  const borderColor = statusOk === true ? '#1e8449' : statusOk === false ? '#c0392b' : '#d8d4c8';
  return `
  <div style="border:2px solid ${borderColor};border-radius:10px;padding:14px 16px;background:#fff;min-width:190px;max-width:230px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
    <div style="font-weight:600;font-size:14px;margin-bottom:2px;">${dot(statusOk)}${esc(title)}</div>
    <div style="font-size:11px;color:#888;margin-bottom:6px;">${esc(subtitle)}</div>
    <div style="font-size:11px;color:#444;line-height:1.4;">${esc(detail)}</div>
  </div>`;
}

const arrowDown = `<div style="text-align:center;font-size:20px;color:#aaa;line-height:1;margin:2px 0;">↓</div>`;
const arrowRight = `<div style="display:flex;align-items:center;justify-content:center;font-size:20px;color:#aaa;padding:0 6px;">→</div>`;

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(401).send('<p style="font-family:sans-serif">Não autorizado. Acesse com <code>?token=SEU_ADMIN_TOKEN</code> na URL.</p>');
    return;
  }

  const token = req.query.token;
  const [kv, wa] = await Promise.all([checkKV(), checkWhatsAppToken()]);
  const claude = checkAnthropicKey();

  const envRows = checkEnvPresence([
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'ANTHROPIC_API_KEY',
    'ADMIN_TOKEN',
    'TEKOA_BASE_URL',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'ASAAS_API_KEY',
    'ASAAS_WEBHOOK_TOKEN'
  ]);

  const envNotes = {
    WHATSAPP_VERIFY_TOKEN: 'Precisa ser IDÊNTICO ao "Verificar token" salvo no Meta (app 1425427812730921, aba Webhooks → Whatsapp Business Account). Se um lado mudar sem sincronizar o outro, a verificação falha silenciosamente.',
    WHATSAPP_ACCESS_TOKEN: '⚠️ Se for o token temporário do WhatsApp Manager, expira em 24h. Trocar por token permanente de System User assim que possível.',
    WHATSAPP_PHONE_NUMBER_ID: 'ID do número, não confundir com o WABA ID (1083067681382657).',
    ANTHROPIC_API_KEY: 'Precisa de saldo em console.anthropic.com. Sem crédito, mensagens chegam mas o TEKOA não responde (erro "invalid x-api-key" nos logs).',
    ADMIN_TOKEN: 'Protege este painel e o /api/admin/dashboard. Não compartilhar o link com o token.',
    TEKOA_BASE_URL: 'Usado pra montar o link do .ics de calendário.',
    KV_REST_API_URL: 'Upstash Redis — guarda o estado de cada família.',
    KV_REST_API_TOKEN: 'Token do Upstash Redis.',
    ASAAS_API_KEY: 'Cobrança — integração ainda em andamento.',
    ASAAS_WEBHOOK_TOKEN: 'Cobrança — integração ainda em andamento.'
  };

  const envTableRows = envRows
    .map(
      (e) => `<tr>
        <td style="font-family:monospace;font-size:12px;">${esc(e.name)}</td>
        <td>${dot(e.ok)}${e.ok ? 'configurada' : 'ausente'}</td>
        <td style="font-size:12px;color:#555;">${esc(envNotes[e.name] || '')}</td>
      </tr>`
    )
    .join('');

  const links = [
    ['App Meta (TEKOA / MTG consultoria)', 'https://developers.facebook.com/apps/1425427812730921/dashboard/'],
    ['Webhooks do app (URL + token + campos)', 'https://developers.facebook.com/apps/1425427812730921/use_cases/customize/webhooks/'],
    ['WhatsApp Manager — números', 'https://business.facebook.com/wa/manage/phone-numbers/'],
    ['Business Manager (MTG consultoria)', 'https://business.facebook.com/settings/'],
    ['Vercel — projeto tekoa-webhook', 'https://vercel.com/ecvillelas-projects/tekoa-webhook'],
    ['Vercel — variáveis de ambiente', 'https://vercel.com/ecvillelas-projects/tekoa-webhook/settings/environment-variables'],
    ['Vercel — logs em tempo real', 'https://vercel.com/ecvillelas-projects/tekoa-webhook/logs'],
    ['Vercel — Deployment Protection', 'https://vercel.com/ecvillelas-projects/tekoa-webhook/settings/deployment-protection'],
    ['GitHub — repo tekoa-webhook', 'https://github.com/ecvillela/tekoa-webhook'],
    ['GitHub — repo tekoa-site', 'https://github.com/ecvillela/tekoa-site'],
    ['Site institucional', 'https://tekoaapp.com.br'],
    ['Console Anthropic (billing/API key)', 'https://console.anthropic.com/settings/billing']
  ];

  const linksHtml = links
    .map((l) => `<li><a href="${esc(l[1])}" target="_blank" rel="noopener">${esc(l[0])}</a></li>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>TEKOA — Arquitetura e Saúde do Sistema</title>
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
  th, td { padding: 8px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #0f6e56; color: #fff; font-weight: 600; }
  .diagram { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin: 16px 0 28px; }
  .diagram-col { display: flex; flex-direction: column; align-items: center; }
  .card { background:#fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 16px; }
  .checklist li { margin-bottom: 6px; font-size: 13px; }
  .refresh { font-size: 12px; color: #888; margin-top: 16px; }
  a { color: #0f6e56; }
</style>
</head>
<body>
  <h1>TEKOA — Arquitetura e Saúde do Sistema</h1>
  <div class="sub">Status ao vivo dos componentes, mapa de onde cada coisa mora, e checklist de quando algo quebrar. Nunca mostra valores de credenciais — só se estão presentes e (quando dá) se a chamada funciona.</div>

  <nav>
    <a href="/api/admin/dashboard?token=${esc(token)}">← Painel interno (famílias)</a>
    <a href="/api/admin/architecture?token=${esc(token)}">Arquitetura e Saúde</a>
  </nav>

  <h2>Fluxo de uma mensagem</h2>
  <div class="diagram">
    <div class="diagram-col">
      ${box('Usuário', 'App do WhatsApp', null, 'Manda "oi", foto, áudio...')}
    </div>
    ${arrowRight}
    <div class="diagram-col">
      ${box('Meta / WhatsApp Business API', `App 1425427812730921 · WABA 1083067681382657`, wa.ok, wa.detail)}
    </div>
    ${arrowRight}
    <div class="diagram-col">
      ${box('Webhook Vercel', '/api/webhook · projeto tekoa-webhook', true, 'Recebendo esta página = função rodando')}
      ${arrowDown}
      <div style="display:flex;gap:8px;">
        ${box('Upstash Redis', 'estado de cada família', kv.ok, kv.detail)}
        ${box('Claude API', 'entende a mensagem', claude.ok, claude.detail)}
      </div>
    </div>
    ${arrowRight}
    <div class="diagram-col">
      ${box('Resposta', 'volta pelo mesmo caminho', null, 'Meta entrega ao usuário no WhatsApp')}
    </div>
  </div>

  <h2>Variáveis de ambiente (Vercel)</h2>
  <table>
    <thead><tr><th>Nome</th><th>Status</th><th>Nota</th></tr></thead>
    <tbody>${envTableRows}</tbody>
  </table>

  <h2>Links rápidos</h2>
  <div class="card">
    <ul class="checklist">${linksHtml}</ul>
  </div>

  <h2>Quando quebrar, comece por aqui (lição de 25/08/2026)</h2>
  <div class="card">
    <ol class="checklist">
      <li>O app Meta certo é o <strong>1425427812730921</strong> (Business "MTG consultoria") — existe um outro "TEKOA" (1615679436948218, Business "Tekoa") que NÃO é o usado. Confirme com <code>GET /{WABA_ID}/subscribed_apps</code> no Graph API Explorer se tiver dúvida.</li>
      <li><strong>WHATSAPP_VERIFY_TOKEN</strong> no Vercel precisa ser idêntico ao "Verificar token" salvo no Meta. Se o Meta pedir pra reinserir o token ao clicar "Verificar e salvar", é sinal de dessincronia.</li>
      <li>O app precisa estar <strong>Publicado</strong> (não "Não publicado") — sem isso, dados de produção reais não chegam no webhook, só testes manuais do painel. Publicar exige URL de Política de Privacidade válida (confira se não tem erro de digitação) e ícone do app.</li>
      <li><strong>Vercel → Deployment Protection → Vercel Authentication</strong> precisa estar DESLIGADO. Se estiver ligado, até em "Standard Protection", o domínio padrão <code>*.vercel.app</code> fica protegido e bloqueia a Meta silenciosamente (sem aparecer nem no log, nem no firewall).</li>
      <li><strong>ANTHROPIC_API_KEY</strong> precisa existir e ter saldo — sem isso, a mensagem chega mas o TEKOA não consegue processar (erro "invalid x-api-key" nos logs).</li>
      <li><strong>WHATSAPP_ACCESS_TOKEN</strong> temporário expira em 24h — se parar de funcionar do nada depois de um dia, é isso.</li>
    </ol>
  </div>

  <div class="refresh">Atualiza a cada visita (as checagens ao vivo rodam de novo). <a href="?token=${esc(token)}">Recarregar</a></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
