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
  outro: (d, resumo) => resumo || 'Recebi o documento.'
};

const DELETE_INTENT = /apagar (meus|minhas) dados|esquecer meus dados|apagar meu cadastro/i;

async function sendConfirmationCard(phone, state, extraction) {
  state.pendingAction = { type: 'confirm_extraction', data: extraction };
  const labelFn = CARD_LABELS[extraction.tipo] || CARD_LABELS.outro;
  const body = labelFn(extraction.dados || {}, extraction.resumo_curto);
  return sendButtons(state, phone, `${body}\n\nConfirma?`, ['Sim, agendar', 'Editar', 'Descartar']);
}

async function finishAgeStep(phone, state, ageText) {
  const lastChild = state.family.children[state.family.children.length - 1];
  if (lastChild) lastChild.age = ageText;
  state.stage = 'ready';
  return sendText(
    state,
    phone,
    'Pronto! A partir de agora é só me mandar bilhetes, fotos e áudios da escola e da saúde que eu organizo tudo. Pode testar agora mesmo — manda uma foto de um bilhete ou pergunta algo.'
  );
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
      const isButtonReply = true;
      if (isButtonReply && state.stage === 'onboarding_age') {
        return await finishAgeStep(phone, state, message.interactive.button_reply.title);
      }
      return await handleButton(phone, state, message.interactive.button_reply.title);
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
      state.stage = 'onboarding_child';
      return await sendText(
        state,
        phone,
        'Oi! Sou o TEKOA, o assistente da sua família aqui no WhatsApp. Cuido de duas coisas: a ESCOLA das crianças (bilhetes, avisos, agenda) e a SAÚDE (vacinas, exames, consultas). Ao continuar, você concorda que eu vou guardar os documentos que você mandar pra esses dois fins — pode apagar tudo a qualquer momento só pedindo "apagar meus dados". Pra começar, qual o nome do seu filho ou filha?'
      );
    }

    if (state.stage === 'onboarding_child' && message.type === 'text') {
      state.family.children.push({ name: message.text.body, raw: message.text.body });
      state.stage = 'onboarding_age';
      return await sendButtons(
        state,
        phone,
        `Anotado, ${message.text.body}! Mais ou menos que idade ele(a) tem? (pode digitar certinho se preferir)`,
        ['0–2 anos', '3–6 anos', '7+ anos']
      );
    }

    if (state.stage === 'onboarding_age' && message.type === 'text') {
      return await finishAgeStep(phone, state, message.text.body);
    }

    if (message.type === 'image') {
      const { base64, mimeType } = await wa.downloadMediaBase64(message.image.id);
      const extraction = await claude.extractFromImage(base64, mimeType);

      if (extraction.tipo === 'fora_de_escopo') {
        return await sendText(
          state,
          phone,
          `Isso não parece bilhete de escola nem documento de saúde (${extraction.resumo_curto || 'documento pessoal'}) — não vou guardar isso aqui, é fora do que o TEKOA cuida. Posso ajudar com outra coisa?`
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
      const answer = await claude.answerFreeQuestion(message.text.body, state.family);
      return await sendText(state, phone, answer);
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

  return sendText(state, phone, 'Beleza, me conta o que ajustar em texto.');
}

module.exports = { handleMessage, getState, setState };
