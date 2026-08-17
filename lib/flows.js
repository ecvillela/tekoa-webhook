const crypto = require('crypto');
const { kvGet, kvSet, kvDel } = require('./state');
const wa = require('./whatsapp');
const claude = require('./claude');
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

// Wrappers finos em volta de wa.sendText/sendButtons só pra contar mensagem
// de saída no state — usados pelo painel interno (§ contagens).
async function sendText(state, phone, body) {
  state.messagesOut = (state.messagesOut || 0) + 1;
  return wa.sendText(phone, body);
}

async function sendButtons(state, phone, body, buttons) {
  state.messagesOut = (state.messagesOut || 0) + 1;
  return wa.sendButtons(phone, body, buttons);
}

const CARD_LABELS = {
  bilhete_escolar: (d) =>
    `📌 ${d.titulo || 'Aviso da escola'}\n🗓️ ${d.data_absoluta || d.data_relativa || '-'} ${d.hora || ''}\n📍 ${d.local || ''}`,
  carteira_vacinacao: (d) =>
    `💉 Registrei ${d.doses ? d.doses.length : 0} doses.${d.pendencia_provavel ? `\n⚠️ ${d.pendencia_provavel}` : ''}`,
  receita_medica: (d) =>
    `📄 Receita — ${d.medico || 'médico'}, ${d.data_absoluta || d.data_relativa || '-'}\nNão leio a dose por segurança. Peça "mostra a receita" quando precisar.`,
  exame_medico: (d) =>
    `🧪 Exame — ${d.medico || 'médico'}, ${d.data_absoluta || d.data_relativa || '-'}\nNão interpreto resultados.`,
  viagem: (d) =>
    `✈️ Viagem${d.destino ? ` — ${d.destino}` : ''}\n🗓️ ${d.data_ida_absoluta || d.data_ida_relativa || '-'}${
      d.data_volta_absoluta || d.data_volta_relativa ? ` até ${d.data_volta_absoluta || d.data_volta_relativa}` : ''
    }\n🏨 ${d.hospedagem || 'hospedagem não informada'}`,
  outro: (d, resumo) => resumo || 'Recebi o documento.'
};

const DELETE_INTENT = /apagar (meus|minhas) dados|esquecer meus dados|apagar meu cadastro/i;

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
  const classification = await claude.classifyMessage(text, state.family);
  const { crianca, viagem } = classification || {};

  if (!crianca && !viagem) {
    const answer = await claude.answerFreeQuestion(text, state.family);
    return sendText(state, phone, answer);
  }

  return processFamilyUpdate(phone, state, { crianca, viagem });
}

async function sendConfirmationCard(phone, state, extraction) {
  state.pendingAction = { type: 'confirm_extraction', data: extraction };
  const labelFn = CARD_LABELS[extraction.tipo] || CARD_LABELS.outro;
  const body = labelFn(extraction.dados || {}, extraction.resumo_curto);
  return sendButtons(state, phone, `${body}\n\nConfirma?`, ['Sim, agendar', 'Editar', 'Descartar']);
}

async function handleMessage(phone, message) {
  const state = await getState(phone);

  // Comando de exclusão de dados (LGPD) — funciona em qualquer estágio, e
  // fica fora do try/finally abaixo de propósito: não pode "ressuscitar" o
  // registro da família com o touch de contagem depois de apagar.
  if (message.type === 'text' && DELETE_INTENT.test(message.text.body)) {
    await kvDel(`state:${phone}`);
    return wa.sendText(phone, 'Prontinho — apaguei todos os seus dados do TEKOA. Se quiser recomeçar, é só mandar um oi.');
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

  try {
    if (message.type === 'interactive' && message.interactive && message.interactive.type === 'button_reply') {
      return await handleButton(phone, state, message.interactive.button_reply.title);
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
      await sendText(state, phone, 'Oi! Sou o TEKOA, o assistente da sua família aqui no WhatsApp.');
      await sendText(
        state,
        phone,
        'Cuido de três coisas: a ESCOLA das crianças (bilhetes, avisos, agenda), a SAÚDE (vacinas, exames, consultas) e VIAGENS da família (datas, hospedagem, checklist).'
      );
      return await sendText(
        state,
        phone,
        'Pode ir me contando naturalmente — nome e idade dos seus filhos eu vou entendendo pelo caminho, sem formulário. Guardo o que você mandar só pra isso, e você apaga tudo quando quiser só pedindo "apagar meus dados". Pode mandar um bilhete, uma foto, ou só me contar o que está rolando.'
      );
    }

    if (message.type === 'image') {
      const { base64, mimeType } = await wa.downloadMediaBase64(message.image.id);
      const extraction = await claude.extractFromImage(base64, mimeType);

      if (extraction.tipo === 'fora_de_escopo') {
        return await sendText(
          state,
          phone,
          `Isso não parece bilhete de escola, documento de saúde nem de viagem (${extraction.resumo_curto || 'documento pessoal'}) — não vou guardar isso aqui, é fora do que o TEKOA cuida. Posso ajudar com outra coisa?`
        );
      }

      const dadosExtraidos = extraction.dados || {};
      const dataAmbigua =
        extraction.tipo === 'bilhete_escolar' && !dadosExtraidos.data_absoluta && dadosExtraidos.data_relativa;

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
      state.log = state.log || [];
      state.log.push(extraction);

      // Escola inferida do primeiro bilhete — sem perguntar no onboarding.
      if (extraction.tipo === 'bilhete_escolar' && extraction.dados && extraction.dados.escola) {
        const lastChild = state.family.children[state.family.children.length - 1];
        if (lastChild && !lastChild.school) lastChild.school = extraction.dados.escola;
      }

      state.pendingAction = null;

      await sendText(state, phone, 'Feito ✅ Já está registrado na família.');

      // Link de calendário — só quando dá pra montar um evento com data real.
      if (extraction.tipo === 'bilhete_escolar' && extraction.dados && extraction.dados.data_absoluta) {
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
    return sendText(state, phone, 'Beleza, me conta o que ajustar em texto.');
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
