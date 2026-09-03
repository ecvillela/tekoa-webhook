const crypto = require('crypto');
const { kvGet, kvSet, kvDel } = require('./state');
const wa = require('./whatsapp');
const claude = require('./ai');
const dates = require('./dates');

const TRIAL_DAYS = 7;
const PLAN_VALUE = 29;

async function getState(phone) {
  return (
    (await kvGet(`state:${phone}`)) || {
      stage: 'new',
      family: { children: [], guardians: [] },
      trips: [],
      log: [],
      pendingAction: null,
      createdAt: null,
      lastContactAt: null,
      messagesIn: 0,
      messagesOut: 0,
      subscription: { status: 'trial', planValue: PLAN_VALUE, trialEndsAt: null }
    }
  );
}

async function setState(phone, state) {
  await kvSet(`state:${phone}`, state);
}

// Release 3 (30/08/2026): transcript de teste. Guarda as últimas mensagens de
// cada família (o que o usuário mandou e o que o TEKOA respondeu) pra dar pra
// acompanhar um teste em tempo quase real, em texto, sem depender de print de
// tela — ver api/admin/transcript.js. Cap em 200 evita estourar o tamanho do
// valor no KV; é sobre acompanhar um teste, não é histórico permanente.
const TRANSCRIPT_LIMIT = 200;

function logTranscript(state, direction, text) {
  state.transcript = state.transcript || [];
  state.transcript.push({ ts: new Date().toISOString(), direction, text: String(text == null ? '' : text) });
  if (state.transcript.length > TRANSCRIPT_LIMIT) {
    state.transcript = state.transcript.slice(-TRANSCRIPT_LIMIT);
  }
}

// Descreve a mensagem recebida em uma linha, pro transcript — inclusive
// botão apertado, foto e áudio, que não têm "texto" no sentido literal.
function describeInbound(message) {
  if (message.type === 'text') return message.text.body;
  if (message.type === 'image') return '[foto]';
  if (message.type === 'audio') return '[áudio]';
  if (message.type === 'interactive' && message.interactive && message.interactive.type === 'button_reply') {
    return `[botão] ${message.interactive.button_reply.title}`;
  }
  return `[mensagem tipo: ${message.type}]`;
}

// Wrappers finos em volta de wa.sendText/sendButtons só pra contar mensagem
// de saída no state — usados pelo painel interno (§ contagens) — e agora
// também pra alimentar o transcript.
async function sendText(state, phone, body) {
  state.messagesOut = (state.messagesOut || 0) + 1;
  logTranscript(state, 'out', body);
  return wa.sendText(phone, body);
}

async function sendButtons(state, phone, body, buttons) {
  state.messagesOut = (state.messagesOut || 0) + 1;
  const linha = buttons && buttons.length ? `${body}\n[botões: ${buttons.join(' · ')}]` : body;
  logTranscript(state, 'out', linha);
  return wa.sendButtons(phone, body, buttons);
}

// Release 2 (28/08/2026): CARD_LABELS (chaveado por "tipo") virou formatCard,
// chaveado por "rotulo" — ver TEKOA - UX e Fluxos.md, §13.1. O rótulo "saude"
// agora cobre tanto vacina (dados.doses) quanto receita/exame (dados.medico);
// o formatador escolhe pelo formato dos dados, não por um tipo separado.
// pre_requisitos e restricoes (novos campos da extração) aparecem sempre que
// existirem, em qualquer rótulo — é o que resolve a lacuna da §22 (o prazo de
// deixar CPF na secretaria antes do evento, que antes não sobrevivia à
// extração).
const ROTULO_ICON = {
  escola: '📌',
  saude: '💉',
  social: '🎉',
  viagem: '✈️',
  casa: '🏠',
  financeiro: '💳',
  outro: '📄'
};

function formatCard(extraction) {
  const rotulo = extraction.rotulo || 'outro';
  const dados = extraction.dados || {};
  const preRequisitos = extraction.pre_requisitos || [];
  const restricoes = extraction.restricoes || [];
  const icon = ROTULO_ICON[rotulo] || '📄';
  const linhas = [];

  if (rotulo === 'saude' && dados.doses) {
    linhas.push(`💉 Registrei ${dados.doses.length} doses.`);
    if (dados.pendencia_provavel) linhas.push(`⚠️ ${dados.pendencia_provavel}`);
  } else if (rotulo === 'saude' && (dados.medico || dados.titulo)) {
    linhas.push(
      `${icon} ${dados.titulo || 'Consulta/Exame'} — ${dados.medico || 'médico'}, ${dados.data_absoluta || dados.data_relativa || '-'}`
    );
    linhas.push('Não leio dose nem resultado por segurança. Peça "mostra a receita" quando precisar.');
  } else if (rotulo === 'viagem') {
    linhas.push(`✈️ Viagem${dados.destino ? ` — ${dados.destino}` : ''}`);
    linhas.push(
      `🗓️ ${dados.data_ida_absoluta || dados.data_ida_relativa || '-'}${
        dados.data_volta_absoluta || dados.data_volta_relativa
          ? ` até ${dados.data_volta_absoluta || dados.data_volta_relativa}`
          : ''
      }`
    );
    linhas.push(`🏨 ${dados.hospedagem || 'hospedagem não informada'}`);
  } else {
    linhas.push(`${icon} ${dados.titulo || extraction.resumo_curto || 'Compromisso'}`);
    if (dados.data_absoluta || dados.data_relativa || dados.hora) {
      linhas.push(`🗓️ ${dados.data_absoluta || dados.data_relativa || '-'} ${dados.hora || ''}`.trim());
    }
    if (dados.local) linhas.push(`📍 ${dados.local}`);
  }

  // Release 9 (04/09/2026): um pre_requisito sem "acao" (classificação errada
  // de uma regra geral, que deveria ter virado restricao — ver applyCorrection
  // em lib/claude.js/lib/gemini.js) chegou a imprimir "⚠️ undefined" cru pro
  // usuário, duas vezes seguidas, no card e no eco do "Feito". formatCard não
  // deveria confiar que a classificação upstream sempre acerta — filtra aqui
  // também, na ponta que o usuário vê. Ver TEKOA - Pendências.md, item 4.23.
  const preRequisitosValidos = preRequisitos.filter((pr) => pr && pr.acao);
  if (preRequisitosValidos.length) {
    linhas.push('');
    for (const pr of preRequisitosValidos) {
      const prazo = pr.prazo_absoluto || pr.prazo_relativo;
      linhas.push(`⚠️ ${pr.acao}${prazo ? ` — até ${prazo}` : ''}${pr.onde ? ` (${pr.onde})` : ''}`);
    }
  }
  if (restricoes.length) {
    linhas.push(...restricoes.map((r) => `ℹ️ ${r}`));
  }

  return linhas.filter(Boolean).join('\n');
}

const DELETE_INTENT = /apagar (meus|minhas) dados|esquecer meus dados|apagar meu cadastro/i;

// Pergunta mais comum que o TEKOA ainda não sabe atender. Sem isto, a pergunta
// cai em answerFreeQuestion e o modelo inventa "configurações do aplicativo" —
// que não existem. Resposta honesta e curta até o convite por token existir.
const INVITE_INTENT =
  /\b(convidar|adicionar|incluir|colocar|cadastrar)\b[^?]{0,40}\b(esposa|marido|mulher|companheir\w*|parceir\w*|c[oô]njuge|respons[áa]vel|bab[áa]|av[óo]|av[óo]s|sogr\w+|outra pessoa|mais algu[ée]m|segundo adulto)\b/i;

const CANCEL_EDIT_INTENT = /^\s*(descartar|cancelar|deixa( pra l[áa])?|esquece|nada)\s*$/i;

// --- Criação implícita de filho e detecção de viagem em texto livre ---
// Filosofia: a família não preenche formulário. Nome/idade de filho e
// viagens são entendidos naturalmente pelo que é dito, e o TEKOA só
// confirma explicitamente quando: (1) é a primeira vez que um filho é
// identificado, (2) a extração é ambígua/baixa confiança, ou (3) a ação
// tem consequência prática (ex: registrar uma viagem). Menção a um filho
// já conhecido, com alta confiança e sem novidade, não gera confirmação —
// só um reconhecimento curto.

function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}

// Tenta casar a menção de criança com um filho já cadastrado. Três saídas:
// - { isNew: false, child } -> já conhecido, segue sem perguntar nada
// - { isNew: true, draft }  -> nome novo (com ou sem idade), precisa confirmar
// - { needsName: true }     -> só idade/descrição, sem nome, e não dá pra
//   inferir com segurança qual filho é (nenhum cadastrado, ou mais de um)
function matchOrDraftChild(family, crianca) {
  const children = (family && family.children) || [];
  if (crianca.nome) {
    const alvo = normalizeName(crianca.nome);
    const match = children.find((c) => {
      const nome = normalizeName(c.name);
      return nome && (nome.includes(alvo) || alvo.includes(nome));
    });
    if (match) return { isNew: false, child: match };
    return { isNew: true, draft: { name: crianca.nome, age: crianca.idade != null ? String(crianca.idade) : undefined } };
  }
  if (crianca.idade != null && children.length === 1) {
    return { isNew: false, child: children[0] };
  }
  return { needsName: true };
}

function upsertChild(state, nome, idade) {
  state.family.children = state.family.children || [];
  const child = { name: nome, age: idade != null ? String(idade) : undefined };
  state.family.children.push(child);
  return child;
}

function addTrip(state, viagem, viajantes) {
  state.trips = state.trips || [];
  const trip = {
    id: crypto.randomBytes(4).toString('hex'),
    destino: viagem.destino || null,
    dataIdaAbsoluta: viagem.data_ida_absoluta || null,
    dataIdaRelativa: viagem.data_ida_relativa || null,
    dataVoltaAbsoluta: viagem.data_volta_absoluta || null,
    dataVoltaRelativa: viagem.data_volta_relativa || null,
    viajantes: viajantes || [],
    hospedagem: viagem.hospedagem || null,
    createdAt: new Date().toISOString()
  };
  state.trips.push(trip);
  return trip;
}

// Mensagem consultiva, não afirmativa: TEKOA organiza a viagem e lembra os
// pontos de atenção, mas não afirma regras de passaporte/vacina como fato
// (isso muda por destino e por idade, e errar aqui é pior que não falar).
function tripChecklistMessage(trip) {
  const partes = [];
  const destinoTxt = trip.destino ? ` pra ${trip.destino}` : '';
  const viajantesTxt = trip.viajantes && trip.viajantes.length ? ` — ${trip.viajantes.join(', ')}` : '';
  partes.push(`Viagem${destinoTxt} anotada${viajantesTxt}.`);
  if (!trip.dataIdaAbsoluta && !trip.dataIdaRelativa) {
    partes.push('Ainda não tenho a data — me conta quando tiver.');
  }
  partes.push(
    'Pontos pra você mesmo confirmar (não tenho certeza das regras exatas, então não afirmo): passaporte válido pra todos, se o destino exige alguma vacina, e se a passagem da criança já é obrigatória (costuma valer a partir de 2 anos).'
  );
  if (!trip.hospedagem) {
    partes.push('Quando tiver o hotel/hospedagem, é só me mandar que eu registro.');
  }
  return partes.join('\n\n');
}

function buildFamilyUpdateConfirmMessage(childMatch, viagem) {
  const linhas = [];
  if (childMatch && childMatch.isNew) {
    const idadeTxt = childMatch.draft.age ? ` de ${childMatch.draft.age} anos` : '';
    linhas.push(`Entendi que vocês têm um(a) filho(a)${idadeTxt} chamado(a) ${childMatch.draft.name} — confere?`);
  }
  if (viagem) {
    const destinoTxt = viagem.destino ? ` pra ${viagem.destino}` : '';
    const viajantesTxt = viagem.viajantes && viagem.viajantes.length ? ` com ${viagem.viajantes.join(', ')}` : '';
    linhas.push(`${childMatch && childMatch.isNew ? 'E também' : 'Entendi'} uma viagem${destinoTxt}${viajantesTxt} — registro isso?`);
  }
  return linhas.join('\n\n');
}

// Decide o que fazer com o que foi entendido de uma mensagem de texto livre,
// aplicando a regra de confirmação descrita acima.
async function processFamilyUpdate(phone, state, { crianca, viagem }) {
  let childMatch = null;
  if (crianca) childMatch = matchOrDraftChild(state.family, crianca);

  if (childMatch && childMatch.needsName) {
    state.pendingAction = { type: 'awaiting_child_name', draft: { idade: crianca.idade }, viagem };
    const idadeTxt = crianca.idade != null ? ` de ${crianca.idade} anos` : '';
    return sendText(
      state,
      phone,
      viagem
        ? `Anotando a viagem${viagem.destino ? ` pra ${viagem.destino}` : ''}! Só confirmando: essa criança${idadeTxt} é filho(a) de vocês? Qual o nome?`
        : `Vi que você mencionou uma criança${idadeTxt} — é um(a) filho(a) que eu ainda não tenho cadastrado? Qual o nome?`
    );
  }

  const needsConfirmation = (childMatch && childMatch.isNew) || (crianca && crianca.confianca === 'baixa') || !!viagem;

  if (!needsConfirmation) {
    return sendText(state, phone, 'Entendido ✅');
  }

  state.pendingAction = { type: 'confirm_family_update', crianca: childMatch, viagem };
  const body = buildFamilyUpdateConfirmMessage(childMatch, viagem);
  return sendButtons(state, phone, body, ['Sim, confere', 'Corrigir']);
}

async function handleFreeText(phone, state, text) {
  const classification = await claude.classifyMessage(text, state.family, phone);
  const { crianca, viagem, compromisso } = classification || {};

  // Release 9 (04/09/2026): até aqui, só IMAGEM passava pela extração de
  // verdade (regime/rotulo/pre_requisitos/restricoes) — texto solto (mesmo
  // encaminhado, com conteúdo claro de agendamento) sempre caía em pergunta
  // livre e nunca virava pendência, mesmo com pedido explícito do usuário.
  // Isso contradizia a promessa nova do onboarding (§29 — fisioterapia,
  // prestador de serviço, aviso da concessionária, etc a partir de qualquer
  // formato). Agora, quando classifyMessage marca "compromisso": true, o
  // texto passa pela mesma extração e pelo mesmo fluxo de confirmação que
  // uma imagem — handleExtraction, abaixo. Ver TEKOA - Pendências.md, 4.25.
  if (compromisso) {
    const extraction = await claude.extractFromText(text, phone);
    return handleExtraction(phone, state, extraction, null);
  }

  if (!crianca && !viagem) {
    // Release 5 (01/09/2026): antes só mandava state.family — o TEKOA não
    // tinha como responder "o que ficou agendado?" porque os itens já
    // confirmados (state.log) e as viagens (state.trips) nunca chegavam no
    // contexto de answerFreeQuestion. Ver TEKOA - Pendências.md pro relato.
    const context = { family: state.family, eventos: state.log || [], viagens: state.trips || [] };
    const answer = await claude.answerFreeQuestion(text, context, phone);
    return sendText(state, phone, answer);
  }

  return processFamilyUpdate(phone, state, { crianca, viagem });
}

// Release 9 (04/09/2026): extraído do que antes vivia só dentro do ramo
// `message.type === 'image'` de handleMessage, pra poder ser reaproveitado
// por handleFreeText quando o texto descreve um compromisso (item 4.25).
// `imageMeta` é { imageId, mimeType } quando a extração veio de uma foto (pra
// permitir rebaixar a imagem de novo se precisar esclarecer — ver o handler
// de 'awaiting_clarification'), ou null quando veio de texto solto.
async function handleExtraction(phone, state, extraction, imageMeta) {
  if (extraction.regime === 'fora_de_escopo') {
    return await sendText(
      state,
      phone,
      `Isso não parece ter prazo nem ação pra eu guardar (${extraction.resumo_curto || 'documento pessoal'}) — não vou guardar isso aqui, é fora do que o Tekoa cuida. Posso ajudar com outra coisa?`
    );
  }

  // Release 5 (01/09/2026): dois casos que não podem virar um card com
  // [Sim, agendar] — era exatamente isso que causava o "Feito! Já está
  // registrado" seguido de "não tenho nada registrado" quando o usuário
  // perguntava o que tinha ficado agendado (ver TEKOA - Pendências.md).

  // 1) Falha de extração de verdade (Release 4): nenhum JSON válido veio
  // do modelo. Nada foi entendido — não faz sentido oferecer confirmação
  // em cima de nada.
  if (extraction._fallback) {
    return await sendText(state, phone, extraction.resumo_curto);
  }

  // 2) Documento/texto ambíguo ou complexo — várias linhas, várias pessoas,
  // várias datas (ex: planilha de pedidos de comida). Em vez de forçar tudo
  // num card de um evento só (ou escolher uma linha sozinho), pergunta o que
  // falta antes de mostrar qualquer confirmação.
  //
  // Release 7 (02/09/2026): guarda também o id da imagem original (não o
  // base64 — só o id, pra rebaixar de novo se precisar) e um contador de
  // rodadas, quando a extração veio de uma foto. Ver o handler de
  // 'awaiting_clarification' abaixo, e TEKOA - UX e Fluxos.md §27.3 pro
  // relato do bug que isso fecha.
  if (extraction.ambiguo && (extraction.perguntas || []).length) {
    state.pendingAction = {
      type: 'awaiting_clarification',
      extraction,
      imageId: imageMeta ? imageMeta.imageId : null,
      mimeType: imageMeta ? imageMeta.mimeType : null,
      rounds: 0
    };
    const perguntasTxt = extraction.perguntas.map((p) => `• ${p}`).join('\n');
    return await sendText(state, phone, `${extraction.resumo_curto}\n\n${perguntasTxt}`);
  }

  const dadosExtraidos = extraction.dados || {};
  // Ambiguidade de data não é mais exclusiva de bilhete escolar (§13.1
  // abriu o escopo) — qualquer rótulo cujo dados carregue data_relativa
  // sem data_absoluta passa pelo mesmo fluxo de confirmação. Viagem usa
  // campos próprios (data_ida_*/data_volta_*) e não entra aqui, igual
  // já era o caso antes.
  const dataAmbigua = !dadosExtraidos.data_absoluta && dadosExtraidos.data_relativa;

  if (dataAmbigua) {
    state.pendingAction = { type: 'confirm_date', extraction };
    return await sendButtons(
      state,
      phone,
      `O bilhete fala em "${dadosExtraidos.data_relativa}", mas não sei quando isso foi escrito — pode confirmar quando é?`,
      ['Hoje', 'Amanhã', 'Outra data']
    );
  }

  return await sendConfirmationCard(phone, state, extraction);
}

async function sendConfirmationCard(phone, state, extraction) {
  state.pendingAction = { type: 'confirm_extraction', data: extraction };
  const body = formatCard(extraction);
  return sendButtons(state, phone, `${body}\n\nConfirma?`, ['Sim, agendar', 'Editar', 'Descartar']);
}

async function handleMessage(phone, message) {
  const state = await getState(phone);

  // Comando de exclusão de dados (LGPD) — funciona em qualquer estágio, e
  // fica fora do try/finally abaixo de propósito: não pode "ressuscitar" o
  // registro da família com o touch de contagem depois de apagar.
  if (message.type === 'text' && DELETE_INTENT.test(message.text.body)) {
    await kvDel(`state:${phone}`);
    return wa.sendText(phone, 'Prontinho — apaguei todos os seus dados do Tekoa. Se quiser recomeçar, é só mandar um oi.');
  }

  // "Touch" de conta — sempre atualizado, não importa qual ramo trata a
  // mensagem. Alimenta o painel interno (data de abertura, último contato,
  // contagem de mensagens). Persistido no finally, mesmo se algum ramo abaixo
  // já tiver salvo o state por conta própria (grava de novo, sem problema).
  if (!state.createdAt) state.createdAt = new Date().toISOString();
  if (!state.subscription) state.subscription = { status: 'trial', planValue: PLAN_VALUE, trialEndsAt: null };
  if (!state.subscription.trialEndsAt) {
    const trialEnd = new Date(state.createdAt);
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
    state.subscription.trialEndsAt = trialEnd.toISOString();
  }
  state.lastContactAt = new Date().toISOString();
  state.messagesIn = (state.messagesIn || 0) + 1;
  logTranscript(state, 'in', describeInbound(message));

  try {
    if (message.type === 'interactive' && message.interactive && message.interactive.type === 'button_reply') {
      return await handleButton(phone, state, message.interactive.button_reply.title);
    }

    // Convidar outra pessoa para a família — ainda não existe. Responder aqui,
    // e não no fluxo de pergunta livre, evita que o modelo invente um caminho.
    if (message.type === 'text' && INVITE_INTENT.test(message.text.body)) {
      return await sendText(
        state,
        phone,
        'Ainda não consigo incluir outra pessoa — por enquanto sou só entre nós dois, neste número. Estou trabalhando nisso, e quando estiver pronto eu te aviso aqui mesmo. Até lá, o que você me contar fica guardado e disponível quando eu passar a falar com o resto da família.'
      );
    }

    // Texto digitado depois de [Editar] num card de confirmação.
    if (state.pendingAction && state.pendingAction.type === 'awaiting_edit_text' && message.type === 'text') {
      const original = state.pendingAction.data;
      if (CANCEL_EDIT_INTENT.test(message.text.body)) {
        state.pendingAction = null;
        return await sendText(state, phone, 'Ok, descartei.');
      }
      const corrigida = await claude.applyCorrection(original, message.text.body, phone);
      return await sendConfirmationCard(phone, state, corrigida);
    }

    // Release 5 (01/09/2026): resposta às perguntas de esclarecimento sobre
    // um documento ambíguo/complexo (várias linhas, várias pessoas, várias
    // datas — ex: planilha de pedidos de comida). Reaproveita applyCorrection
    // (já existia pro fluxo de [Editar]) pra aplicar a resposta em cima da
    // extração parcial.
    //
    // Release 7 (02/09/2026): a Release 5 considerava uma rodada sempre
    // suficiente e forçava ambiguo=false na saída, mesmo quando a resposta só
    // resolvia parte do que faltava (ex: o nome da criança, sem a data) — o
    // card saía sem data, e "o que foi agendado?" contradizia o "Feito!" logo
    // depois. Achado num teste ao vivo — ver TEKOA - Pendências.md, §0, e
    // TEKOA - UX e Fluxos.md, §27.3. Agora: (1) reenvia a imagem original
    // (rebaixada de novo pelo id, nunca guardada em base64 no state) junto da
    // resposta, pra o modelo poder cruzar a resposta com a linha certa da
    // tabela/planilha; (2) só sai do esclarecimento se o modelo confirmar que
    // não falta mais nada essencial (ambiguo: false) — senão repete só a
    // pergunta que falta, até um teto de rodadas pra nunca travar a conversa
    // num vai-e-volta sem fim.
    if (state.pendingAction && state.pendingAction.type === 'awaiting_clarification' && message.type === 'text') {
      const pending = state.pendingAction;
      const original = pending.extraction;
      if (CANCEL_EDIT_INTENT.test(message.text.body)) {
        state.pendingAction = null;
        return await sendText(state, phone, 'Ok, descartei.');
      }

      let image;
      if (pending.imageId) {
        try {
          image = await wa.downloadMediaBase64(pending.imageId);
        } catch (err) {
          console.error(`[flows] não consegui rebaixar a imagem original pro esclarecimento: ${err && err.message}`);
        }
      }

      const corrigida = await claude.applyCorrection(original, message.text.body, phone, image);
      const rounds = (pending.rounds || 0) + 1;
      const MAX_ROUNDS = 3;

      if (corrigida.ambiguo && (corrigida.perguntas || []).length && rounds < MAX_ROUNDS) {
        state.pendingAction = {
          type: 'awaiting_clarification',
          extraction: corrigida,
          imageId: pending.imageId,
          mimeType: pending.mimeType,
          rounds
        };
        const perguntasTxt = corrigida.perguntas.map((p) => `• ${p}`).join('\n');
        return await sendText(
          state,
          phone,
          `${corrigida.resumo_curto || original.resumo_curto || ''}\n\n${perguntasTxt}`.trim()
        );
      }

      corrigida.ambiguo = false;
      corrigida.perguntas = [];
      return await sendConfirmationCard(phone, state, corrigida);
    }

    // Resposta ao "qual o nome?" depois de uma criança sem nome ter sido
    // mencionada (com ou sem viagem em andamento na mesma conversa).
    if (state.pendingAction && state.pendingAction.type === 'awaiting_child_name' && message.type === 'text') {
      const nome = message.text.body.trim();
      const draft = state.pendingAction.draft || {};
      const viagemDraft = state.pendingAction.viagem;
      state.pendingAction = null;
      const child = upsertChild(state, nome, draft.idade);
      if (viagemDraft) {
        const trip = addTrip(state, viagemDraft, [child.name]);
        return sendText(state, phone, `Entendi, ${nome}! ${tripChecklistMessage(trip)}`);
      }
      const idadeTxt = draft.idade != null ? `${draft.idade} anos` : 'idade não informada';
      return sendText(state, phone, `Entendi, ${nome} (${idadeTxt}) — já está cadastrado(a) ✅`);
    }

    // Usuário escolheu "Outra data" e agora está digitando a data certinha.
    if (state.pendingAction && state.pendingAction.type === 'awaiting_date_text' && message.type === 'text') {
      const extraction = state.pendingAction.extraction;
      const parsed = dates.parseFreeDate(message.text.body);
      extraction.dados = extraction.dados || {};
      extraction.dados.data_absoluta = parsed ? dates.formatBR(parsed) : message.text.body;
      extraction.dados.data_relativa = null;
      return await sendConfirmationCard(phone, state, extraction);
    }

    if (state.stage === 'new') {
      state.stage = 'ready';
      // Release 11 (03/09/2026): nome do produto fechado como "Tekoa", sem
      // caixa alta (TEKOA - Pendências.md, item 4.4/1.1) — grafia de marca
      // fechada em 03/09 (item 4.27). Todo texto voltado pro usuário troca de
      // "TEKOA" pra "Tekoa"; nomes de doc/env var (TEKOA - *.md,
      // TEKOA_BASE_URL) ficam como estão, é outra convenção.
      await sendText(state, phone, 'Oi! Sou o Tekoa, o assistente da sua família aqui no WhatsApp.');
      // Release 7 (02/09/2026): a mensagem antiga prometia só "três coisas:
      // escola, saúde e viagem" — escopo que o produto abandonou na Release 2
      // (regime/rotulo, qualquer assunto da casa com prazo e ação). Texto novo
      // alinhado ao escopo real — ver TEKOA - UX e Fluxos.md, §29.
      await sendText(
        state,
        phone,
        'Cuido de qualquer compromisso da casa que tenha prazo e ação — bilhete da escola, consulta, vacina, fisioterapia, viagem, visita de um prestador de serviço, conta pra pagar, aviso da concessionária. O que tiver data e exigir alguma coisa de vocês, eu guardo e lembro.'
      );
      // Release 9 (04/09/2026): pedido do Eduardo — indicar, na abertura, que
      // um hábito bom é encaminhar pro TEKOA os bilhetes e avisos recebidos.
      // Só faz sentido prometer isso pra QUALQUER formato porque esta mesma
      // release ensina o TEKOA a extrair compromisso de texto solto também,
      // não só de foto (ver extractFromText/handleExtraction abaixo, item
      // 4.25) — antes desta release, a dica teria sido parcialmente falsa
      // pra texto encaminhado.
      await sendText(
        state,
        phone,
        'Pode ir me contando naturalmente — nome e idade dos seus filhos eu vou entendendo pelo caminho, sem formulário. Um hábito bom: encaminha pra mim os bilhetes e avisos que você for recebendo — foto ou texto mesmo, de qualquer app — que eu leio e organizo. Guardo o que você mandar só pra isso, e você apaga tudo quando quiser só pedindo "apagar meus dados".'
      );
      return await sendText(
        state,
        phone,
        'Pra começar: o que está te preocupando essa semana? Manda um bilhete, uma foto, ou só me conta.'
      );
    }

    if (message.type === 'image') {
      const { base64, mimeType } = await wa.downloadMediaBase64(message.image.id);
      const extraction = await claude.extractFromImage(base64, mimeType, phone);
      return await handleExtraction(phone, state, extraction, { imageId: message.image.id, mimeType });
    }

    if (message.type === 'audio') {
      return await sendText(
        state,
        phone,
        'Recebi o áudio — nesta versão de teste ainda não transcrevo áudio automaticamente. Me conta em texto o que você precisa que eu faça com isso?'
      );
    }

    if (message.type === 'text') {
      return await handleFreeText(phone, state, message.text.body);
    }

    return null;
  } finally {
    await setState(phone, state);
  }
}

async function handleButton(phone, state, title) {
  const pending = state.pendingAction;

  // Resposta ao "quando é isso mesmo?" de data ambígua.
  if (pending && pending.type === 'confirm_date') {
    const extraction = pending.extraction;
    if (title === 'Outra data') {
      state.pendingAction = { type: 'awaiting_date_text', extraction };
      return sendText(state, phone, 'Pode digitar a data certinha (ex: 24/07)?');
    }
    const resolved = dates.resolveKeyword(title);
    if (resolved) {
      extraction.dados = extraction.dados || {};
      extraction.dados.data_absoluta = dates.formatBR(resolved);
      extraction.dados.data_relativa = null;
    }
    return sendConfirmationCard(phone, state, extraction);
  }

  // Confirmação normal do card de extração.
  if (pending && pending.type === 'confirm_extraction') {
    if (title.startsWith('Sim')) {
      const extraction = pending.data;

      // Release 5 (01/09/2026): defesa extra — mesmo que um _fallback chegue
      // até aqui por algum caminho não previsto (o handler de imagem já
      // bloqueia isso antes de mostrar o card), nunca confirma "Feito" em
      // cima de nada. Era exatamente esse o bug relatado em 01/09.
      if (extraction._fallback) {
        state.pendingAction = null;
        return sendText(state, phone, extraction.resumo_curto);
      }

      state.log = state.log || [];
      state.log.push(extraction);

      // Escola inferida do primeiro bilhete — sem perguntar no onboarding.
      if (extraction.rotulo === 'escola' && extraction.dados && extraction.dados.escola) {
        const lastChild = state.family.children[state.family.children.length - 1];
        if (lastChild && !lastChild.school) lastChild.school = extraction.dados.escola;
      }

      state.pendingAction = null;

      // Release 5: o "Feito" agora ecoa o que foi guardado (reaproveitando
      // formatCard) em vez de uma frase genérica — resolve o "Feito! Já está
      // registrado" sem detalhe nenhum, que contradizia a resposta seguinte
      // quando o usuário perguntava o que tinha ficado agendado.
      await sendText(state, phone, `Feito ✅ Guardado:\n${formatCard(extraction)}`);

      // Link de calendário — só quando dá pra montar um evento com data real.
      // Mantido restrito ao rótulo escola (mesma política de antes, só
      // re-chaveada de "tipo" pra "rotulo" — expandir pra saúde/viagem é a
      // pendência 24.2, em aberto).
      if (extraction.rotulo === 'escola' && extraction.dados && extraction.dados.data_absoluta) {
        const baseDate = dates.parseFreeDate(extraction.dados.data_absoluta) || dates.today();
        const start = dates.combineDateTime(baseDate, extraction.dados.hora);
        const id = crypto.randomBytes(6).toString('hex');
        await kvSet(`event:${id}`, {
          title: extraction.dados.titulo || 'Compromisso da família',
          start: start.toISOString(),
          location: extraction.dados.local || '',
          description: extraction.resumo_curto || ''
        });
        const base = process.env.TEKOA_BASE_URL || '';
        return sendText(
          state,
          phone,
          `Quer adicionar isso na sua agenda pessoal também? Cada um usa o próprio link: ${base}/api/ics/${id}`
        );
      }
      return null;
    }
    if (title === 'Descartar') {
      state.pendingAction = null;
      return sendText(state, phone, 'Ok, descartei.');
    }
    // [Editar]: guarda a extração e espera a correção em texto. Antes daqui o
    // pendingAction ficava preso em 'confirm_extraction' e a correção do
    // usuário caía no fluxo de pergunta livre — o card nunca voltava.
    state.pendingAction = { type: 'awaiting_edit_text', data: pending.data };
    return sendText(
      state,
      phone,
      'Beleza — me diz o que está errado (ex: "a data é 30/08", "é no clube", "o título é Festa Junina"). Se apertou sem querer, é só mandar "descartar".'
    );
  }

  // Confirmação de filho novo e/ou viagem detectados implicitamente em texto livre.
  if (pending && pending.type === 'confirm_family_update') {
    if (title.startsWith('Sim')) {
      let child = null;
      if (pending.crianca && pending.crianca.isNew) {
        child = upsertChild(state, pending.crianca.draft.name, pending.crianca.draft.age);
      } else if (pending.crianca) {
        child = pending.crianca.child;
      }
      state.pendingAction = null;
      if (pending.viagem) {
        const viajantes = child ? [child.name] : pending.viagem.viajantes || [];
        const trip = addTrip(state, pending.viagem, viajantes);
        return sendText(state, phone, tripChecklistMessage(trip));
      }
      return sendText(state, phone, 'Anotado ✅');
    }
    state.pendingAction = null;
    return sendText(state, phone, 'Beleza, me conta certinho como corrigir.');
  }

  return sendText(state, phone, 'Beleza, me conta o que ajustar em texto.');
}

module.exports = { handleMessage, getState, setState };
