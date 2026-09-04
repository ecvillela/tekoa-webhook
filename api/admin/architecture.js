const { isAuthorized, establishSession } = require('../../lib/admin');
const { checkKV, checkWhatsAppToken, checkWabaSubscription, checkAnthropicKey, checkGeminiKey, checkEnvPresence } = require('../../lib/health');

const TEKOA_APP_ID = '1425427812730921';

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

function fmtDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const arrowDown = `<div style="text-align:center;font-size:20px;color:#aaa;line-height:1;margin:2px 0;">↓</div>`;
const arrowRight = `<div style="display:flex;align-items:center;justify-content:center;font-size:20px;color:#aaa;padding:0 6px;">→</div>`;

module.exports = async (req, res) => {
    if (!isAuthorized(req)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.status(401).send('<p style="font-family:sans-serif">Não autorizado. Acesse com <code>?token=SEU_ADMIN_TOKEN</code> na URL (só na primeira visita — depois fica salvo num cookie).</p>');
          return;
    }
    establishSession(req, res);

    const [kv, wa, waba] = await Promise.all([checkKV(), checkWhatsAppToken(), checkWabaSubscription()]);
    const claude = checkAnthropicKey();

    // Resumo de validade do token, pra mostrar no card e na tabela de env vars.
    let tokenValidityLine = 'não foi possível checar (token ausente ou Graph API indisponível)';
    if (wa.tokenInfo) {
          if (wa.tokenInfo.neverExpires) {
                  tokenValidityLine = `permanente — não expira${wa.tokenInfo.valid ? '' : ' (mas is_valid=false, revogado?)'}`;
          } else if (wa.tokenInfo.expiresAt) {
                  tokenValidityLine = `expira em ${fmtDate(wa.tokenInfo.expiresAt)}${wa.tokenInfo.valid ? '' : ' (já inválido)'}`;
          } else {
                  tokenValidityLine = wa.tokenInfo.valid ? 'válido, validade não informada pela Meta' : 'inválido';
          }
    }

    // Diagnóstico específico: para QUAL app esse token foi emitido, e isso
    // bate com o app TEKOA (1425427812730921) e com o(s) app(s) de fato
    // inscrito(s) na WABA? Isso responde diretamente à dúvida "o token foi
    // gerado no app certo ou em outro lugar (ex: MTG genérico, Graph API
    // Explorer, etc)?".
    let appCheckOk = null;
    let appCheckLine = 'Não foi possível checar — token ausente, sem app_id retornado pelo debug_token, ou Graph API indisponível.';
    if (wa.tokenInfo && wa.tokenInfo.appId) {
          const tokenAppId = String(wa.tokenInfo.appId);
          const isTekoaApp = tokenAppId === TEKOA_APP_ID;
          const subscribedIds = waba.appIds || [];
          const inSubscribed = subscribedIds.includes(tokenAppId);
          appCheckOk = isTekoaApp && (subscribedIds.length === 0 ? null : inSubscribed);

      appCheckLine = `Token emitido para o app "${wa.tokenInfo.appName || '?'}" (app_id ${tokenAppId}).`;
          appCheckLine += isTekoaApp
            ? ' Esse É o app TEKOA correto (1425427812730921).'
                  : ` Esse NÃO é o app TEKOA — o esperado é 1425427812730921. Gere um token novo dentro do app certo: Meta for Developers → app 1425427812730921 → Casos de uso → Personalizar → Etapa 2. Configuração de produção → "Enviar mensagem" → "gere um token".`;
        appCheckLine += ` Escopos do token: ${(wa.tokenInfo.scopes && wa.tokenInfo.scopes.length) ? wa.tokenInfo.scopes.join(', ') : 'nenhum retornado pelo debug_token'}.`;
          if (subscribedIds.length) {
                  appCheckLine += inSubscribed
                    ? ' Esse app_id está na lista de apps inscritos na WABA (bate certinho).'
                            : ` Esse app_id NÃO está entre os inscritos na WABA (${subscribedIds.join(', ')}) — é uma causa raiz muito provável de mensagens reais não chegarem no webhook.`;
          }
    }

    const envRows = checkEnvPresence([
          'WHATSAPP_VERIFY_TOKEN',
          'WHATSAPP_ACCESS_TOKEN',
          'WHATSAPP_PHONE_NUMBER_ID',
          'WHATSAPP_BUSINESS_ACCOUNT_ID',
          'ANTHROPIC_API_KEY',
'GEMINI_API_KEY',
        'AI_PROVIDER',
        'AI_COMPARE_PRIMARY',
        'ADMIN_TOKEN',
          'TEKOA_BASE_URL',
          'KV_REST_API_URL',
          'KV_REST_API_TOKEN',
          'ASAAS_API_KEY',
          'ASAAS_WEBHOOK_TOKEN'
        ]);

    const envNotes = {
          WHATSAPP_VERIFY_TOKEN: 'Precisa ser IDÊNTICO ao "Verificar token" salvo no Meta (app 1425427812730921, aba Webhooks → Whatsapp Business Account). Se um lado mudar sem sincronizar o outro, a verificação falha silenciosamente.',
          WHATSAPP_ACCESS_TOKEN: `Validade ao vivo: ${tokenValidityLine}. ${appCheckLine} Se voltar a expirar, gere um novo em Casos de uso → Personalizar → Etapa 2. Configuração de produção → "Enviar mensagem" → "gere um token" (esse é permanente, não o de 24h da Etapa 1).`,
          WHATSAPP_PHONE_NUMBER_ID: 'ID do número, não confundir com o WABA ID (1083067681382657).',
          WHATSAPP_BUSINESS_ACCOUNT_ID: 'Opcional, mas recomendado: com essa variável o painel consegue checar ao vivo se a WABA está inscrita no app certo (a causa mais comum de "chega no WhatsApp mas não aparece no webhook"). Valor: 1083067681382657.',
          ANTHROPIC_API_KEY: 'Precisa de saldo em console.anthropic.com. Sem crédito, mensagens chegam mas o TEKOA não responde (erro "invalid x-api-key" nos logs).',
GEMINI_API_KEY: 'Chave gratuita do Google AI Studio (aistudio.google.com/apikey). Opcional — só necessária se AI_PROVIDER usa gemini ou compare.',
        AI_PROVIDER: 'Controla qual IA processa as mensagens: claude (padrão), gemini, ou compare (roda os dois em paralelo, usa a resposta do AI_COMPARE_PRIMARY e loga a do outro nos logs do Vercel). Se o provedor escolhido falhar, cai automaticamente pro outro.',
        AI_COMPARE_PRIMARY: 'Só usado quando AI_PROVIDER=compare. Qual resposta é de fato enviada pra família: claude (padrão) ou gemini. A do outro provedor só é logada, pra comparação.',
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
          ['Gerar token de acesso (Etapa 2 → Enviar mensagem)', 'https://developers.facebook.com/apps/1425427812730921/use_cases/customize/wa-configurations-v2/'],
          ['Graph API Explorer (checar WABA, token, subscribed_apps)', 'https://developers.facebook.com/tools/explorer/'],
          ['WhatsApp Manager — números', 'https://business.facebook.com/wa/manage/phone-numbers/'],
          ['Business Manager (MTG consultoria) — quem tem acesso', 'https://business.facebook.com/settings/people'],
          ['Business Manager — usuários do sistema', 'https://business.facebook.com/settings/system-users'],
          ['Vercel — projeto tekoa-webhook', 'https://vercel.com/ecvillelas-projects/tekoa-webhook'],
          ['Vercel — variáveis de ambiente', 'https://vercel.com/ecvillelas-projects/tekoa-webhook/settings/environment-variables'],
          ['Vercel — logs em tempo real', 'https://vercel.com/ecvillelas-projects/tekoa-webhook/logs'],
          ['Vercel — Deployment Protection', 'https://vercel.com/ecvillelas-projects/tekoa-webhook/settings/deployment-protection'],
          ['GitHub — repo tekoa-webhook', 'https://github.com/ecvillela/tekoa-webhook'],
          ['GitHub — repo tekoa-site', 'https://github.com/ecvillela/tekoa-site'],
          ['Site institucional', 'https://tekoaapp.com.br'],
          ['Console Anthropic (billing/API key)', 'https://console.anthropic.com/settings/billing'],
          ['App Meta backup (toca_app / MTG consultoria)', 'https://developers.facebook.com/apps/1081103350954918/dashboard/'],
          ['GitHub — repo toca-webhook (backup)', 'https://github.com/ecvillela/toca-webhook'],
          ['Vercel — projeto toca-webhook (backup)', 'https://vercel.com/ecvillelas-projects/toca-webhook']
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
                                              <a href="/api/admin/dashboard">← Painel interno (famílias)</a>
                                                  <a href="/api/admin/waitlist">Lista de espera</a>
                                                  <a href="/api/admin/costs">Custos</a>
                                                  <a href="/api/admin/architecture">Arquitetura e Saúde</a>
                                                    </nav>

                                                      <h2>Quem tem acesso a tudo isso</h2>
                                                        <div class="diagram">
                                                            <div class="diagram-col">
                                                                  ${box('Login Meta (Eduardo)', 'Conta pessoal do Facebook', null, 'É a partir desse login que existe admin no Business "MTG consultoria", no app TEKOA e na WABA. Se essa conta perder acesso (senha, 2FA, remoção), todo o resto para.')}
                                                                      </div>
                                                                          ${arrowRight}
                                                                              <div class="diagram-col">
                                                                                    ${box('Business Manager', 'MTG consultoria · id 27763707096627490', null, 'Dono do app correto. Existe outro Business ("Tekoa") com um app TEKOA diferente (1615679436948218) — não é esse que usamos.')}
                                                                                        </div>
                                                                                            ${arrowRight}
                                                                                                <div class="diagram-col">
                                                                                                      ${box('App Meta', 'TEKOA · 1425427812730921', true, 'Publicado. Onde ficam configurados o webhook (URL + token) e os campos inscritos (messages).')}
                                                                                                          </div>
                                                                                                              ${arrowRight}
                                                                                                                  <div class="diagram-col">
                                                                                                                        ${box('WABA → App', 'WhatsApp Business Account 1083067681382657', waba.ok, waba.detail)}
                                                                                                                            </div>
                                                                                                                              </div>
                                                                                                                                <div style="font-size:12px;color:#888;margin:-16px 0 8px;">Acesso: <a href="https://business.facebook.com/settings/people" target="_blank" rel="noopener">Business Settings → Pessoas</a> mostra quem é admin. Melhor prática de longo prazo: criar um Usuário do Sistema dedicado (não depende de login pessoal) — ainda pendente, ver checklist abaixo.</div>

                                                                                                                                  <h2>Diagnóstico: o token bate com o app certo?</h2>
                                                                                                                                    <div class="card" style="border:2px solid ${appCheckOk === true ? '#1e8449' : appCheckOk === false ? '#c0392b' : '#d8d4c8'};">
                                                                                                                                        <div style="font-weight:600;font-size:14px;margin-bottom:6px;">${dot(appCheckOk)}${appCheckOk === true ? 'Token bate com o app TEKOA e com a WABA' : appCheckOk === false ? 'Token NÃO bate — provável causa raiz' : 'Não deu pra confirmar automaticamente'}</div>
                                                                                                                                            <div style="font-size:13px;color:#333;line-height:1.5;">${esc(appCheckLine)}</div>
                                                                                                                                              </div>

                                                                                                                                                <h2>Fluxo de uma mensagem</h2>
                                                                                                                                                  <div class="diagram">
                                                                                                                                                      <div class="diagram-col">
                                                                                                                                                            ${box('Usuário', 'App do WhatsApp', null, 'Manda "oi", foto, áudio... pro número certo: +55 11 98935-9155')}
                                                                                                                                                                </div>
                                                                                                                                                                    ${arrowRight}
                                                                                                                                                                        <div class="diagram-col">
                                                                                                                                                                              ${box('Meta / WhatsApp Business API', `Token: ${tokenValidityLine}`, wa.ok && appCheckOk !== false, wa.detail)}
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

                                                                                                                                                                                                                                                                                    <h2>Quando quebrar, comece por aqui (lição de 25-26/08/2026)</h2>
                                                                                                                                                                                                                                                                                      <div class="card">
                                                                                                                                                                                                                                                                                          <ol class="checklist">
                                                                                                                                                                                                                                                                                                <li>O app Meta certo é o <strong>1425427812730921</strong> (Business "MTG consultoria") — existe um outro "TEKOA" (1615679436948218, Business "Tekoa") que NÃO é o usado.</li>
                                                                                                                                                                                                                                                                                                      <li><strong>WHATSAPP_VERIFY_TOKEN</strong> no Vercel precisa ser idêntico ao "Verificar token" salvo no Meta. Se o Meta pedir pra reinserir o token ao clicar "Verificar e salvar", é sinal de dessincronia.</li>
                                                                                                                                                                                                                                                                                                            <li>O app precisa estar <strong>Publicado</strong> (não "Não publicado") — sem isso, dados de produção reais não chegam no webhook, só testes manuais do painel. Publicar exige URL de Política de Privacidade válida (confira se não tem erro de digitação) e ícone do app.</li>
                                                                                                                                                                                                                                                                                                                  <li><strong>Vercel → Deployment Protection → Vercel Authentication</strong> precisa estar DESLIGADO. Se estiver ligado, até em "Standard Protection", o domínio padrão <code>*.vercel.app</code> fica protegido e bloqueia a Meta silenciosamente (sem aparecer nem no log, nem no firewall).</li>
                                                                                                                                                                                                                                                                                                                        <li><strong>ANTHROPIC_API_KEY</strong> precisa existir e ter saldo — sem isso, a mensagem chega mas o TEKOA não consegue processar (erro "invalid x-api-key" nos logs).</li>
                                                                                                                                                                                                                                                                                                                              <li><strong>WHATSAPP_ACCESS_TOKEN</strong>: existem dois jeitos de gerar. O da Etapa 1 (Experimente) é só pro número de teste e expira em 24h. O bom é o de Etapa 2 → Configuração de produção → "Enviar mensagem" → botão "gere um token" — esse sai como permanente (ver validade ao vivo na tabela acima). O caminho de "Usuário do Sistema" (Business Settings) é o ideal a longo prazo mas pode falhar com "Erro ao realizar a consulta" se a empresa não estiver verificada — nesse caso, use a Etapa 2. <strong>Importante: gere sempre dentro do app 1425427812730921</strong> — o painel acima ("Diagnóstico: o token bate com o app certo?") confirma isso automaticamente via <code>debug_token</code>, comparando o <code>app_id</code> do token com o app TEKOA e com os apps de fato inscritos na WABA.</li>
                                                                                                                                                                                                                                                                                                                                    <li><strong>A WABA precisa estar inscrita no app</strong> (<code>GET /{WABA_ID}/subscribed_apps</code> deve retornar o app 1425427812730921). Sem essa inscrição — que é um passo separado da configuração do app e não tem botão óbvio na UI nova da Meta — mensagens reais somem sem deixar rastro em lugar nenhum, mesmo com o botão "Teste" do painel Meta funcionando normalmente. É a causa mais comum e mais escondida de "mensagem chega no WhatsApp mas nunca aparece no log do Vercel".</li>
                                                                                                                                                                                                                                                                                                                                          <li>Se tudo acima checar OK e mesmo assim nada chega: confirme que está mandando mensagem pro número <strong>certo</strong> (já trocamos de número mais de uma vez neste projeto — um contato salvo antigo no seu WhatsApp pode apontar pro número errado).</li>
                                                                                                                                                                                                                                                                                                                                                <li>Canais oficiais de suporte da Meta (bug report, fórum de desenvolvedores) estavam quebrados em 26/08/2026 para submissão — ambos falham silenciosamente ao clicar o botão final, sem disparar nenhuma chamada de rede, reproduzido em duas contas diferentes. Não vale insistir neles enquanto isso não mudar.</li>
                                                                                                                                                                                                                                                                                                                                                      <li>Existe um app backup <strong>toca_app</strong> (1081103350954918, mesma business MTG consultoria), com repo e Vercel próprios e totalmente separados do TEKOA — ver links acima. Ainda sem número de telefone/WABA configurados.</li>
                                                                                                                                                                                                                                                                                                                                                          </ol>
                                                                                                                                                                                                                                                                                                                                                            </div>

                                                                                                                                                                                                                                                                                                                                                              <div class="refresh">Atualiza a cada visita (as checagens ao vivo rodam de novo). <a href="/api/admin/architecture">Recarregar</a></div>
                                                                                                                                                                                                                                                                                                                                                              </body>
                                                                                                                                                                                                                                                                                                                                                              </html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
};
