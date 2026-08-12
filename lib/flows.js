const crypto = require('crypto');
const { kvGet, kvSet, kvDel } = require('./state');
const wa = require('./whatsapp');
const claude = require('./claude');
const dates = require('./dates');

async function getState(phone) {
  return (
    (await kvGet(`state:${phone}`)) || {
      stage: 'new',
      family: { children: [], guardians: [] },
      log: [],
      pendingAction: null
    }
  );
}

async function setState(phone, state) {
  await kvSet(`state:${phone}`, state);
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
  await setState(phone, state);
  const labelFn = CARD_LABELS[extraction.tipo] || CARD_LABELS.outro;
  const body = labelFn(extraction.dados || {}, extraction.resumo_curto);
  return wa.sendButtons(phone, `${body}\n\nConfirma?`, ['Sim, agendar', 'Editar', 'Descartar']);
}

async function finishAgeStep(phone, state, ageText) {
  const lastChild = state.family.children[state.family.children.length - 1];
  if (lastChild) lastChild.age = ageText;
  state.stage = 'ready';
  await setState(phone, state);
  return wa.sendText(
    phone,
    'Pronto! A partir de agora é só me mandar bilhetes, fotos e áudios da escola e da saúde que eu organizo tudo. Pode testar agora mesmo — manda uma foto de um bilhete ou pergunta algo.'
  );
}

async function handleMessage(phone, message) {
  const state = await getState(phone);

  // Comando de exclusão de dados (LGPD) — funciona em qualquer estágio.
  if (message.type === 'text' && DELETE_INTENT.test(message.text.body)) {
    await kvDel(`state:${phone}`);
    return wa.sendText(phone, 'Prontinho — apaguei todos os seus dados do TEKOA. Se quiser recomeçar, é só mandar um oi.');
  }

  const isButtonReply = message.type === 'interactive' && message.interactive && message.interactive.type === 'button_reply';

  // Botão de faixa etária no onboarding — trata igual a ter digitado a idade.
  if (isButtonReply && state.stage === 'onboarding_age') {
    return finishAgeStep(phone, state, message.interactive.button_reply.title);
  }

  if (isButtonReply) {
    return handleButton(phone, state, message.interactive.button_reply.title);
  }

  // Usuário escolheu "Outra data" e agora está digitando a data certinha.
  if (state.pendingAction && state.pendingAction.type === 'awaiting_date_text' && message.type === 'text') {
    const extraction = state.pendingAction.extraction;
    const parsed = dates.parseFreeDate(message.text.body);
    extraction.dados = extraction.dados || {};
    extraction.dados.data_absoluta = parsed ? dates.formatBR(parsed) : message.text.body;
    extraction.dados.data_relativa = null;
    return sendConfirmationCard(phone, state, extraction);
  }

  if (state.stage === 'new') {
    state.stage = 'onboarding_child';
    await setState(phone, state);
    return wa.sendText(
      phone,
      'Oi! Sou o TEKOA, o assistente da sua família aqui no WhatsApp. Cuido de duas coisas: a ESCOLA das crianças (bilhetes, avisos, agenda) e a SAÚDE (vacinas, exames, consultas). Ao continuar, você concorda que eu vou guardar os documentos que você mandar pra esses dois fins — pode apagar tudo a qualquer momento só pedindo "apagar meus dados". Pra começar, qual o nome do seu filho ou filha?'
    );
  }

  if (state.stage === 'onboarding_child' && message.type === 'text') {
    state.family.children.push({ name: message.text.body, raw: message.text.body });
    state.stage = 'onboarding_age';
    await setState(phone, state);
    return wa.sendButtons(
      phone,
      `Anotado, ${message.text.body}! Mais ou menos que idade ele(a) tem? (pode digitar certinho se preferir)`,
      ['0–2 anos', '3–6 anos', '7+ anos']
    );
  }

  if (state.stage === 'onboarding_age' && message.type === 'text') {
    return finishAgeStep(phone, state, message.text.body);
  }

  if (message.type === 'image') {
    const { base64, mimeType } = await wa.downloadMediaBase64(message.image.id);
    const extraction = await claude.extractFromImage(base64, mimeType);

    if (extraction.tipo === 'fora_de_escopo') {
      return wa.sendText(
        phone,
        `Isso não parece bilhete de escola nem documento de saúde (${extraction.resumo_curto || 'documento pessoal'}) — não vou guardar isso aqui, é fora do que o TEKOA cuida. Posso ajudar com outra coisa?`
      );
    }

    const dadosExtraidos = extraction.dados || {};
    const dataAmbigua =
      extraction.tipo === 'bilhete_escolar' && !dadosExtraidos.data_absoluta && dadosExtraidos.data_relativa;

    if (dataAmbigua) {
      state.pendingAction = { type: 'confirm_date', extraction };
      await setState(phone, state);
      return wa.sendButtons(
        phone,
        `O bilhete fala em "${dadosExtraidos.data_relativa}", mas não sei quando isso foi escrito — pode confirmar quando é?`,
        ['Hoje', 'Amanhã', 'Outra data']
      );
    }

    return sendConfirmationCard(phone, state, extraction);
  }

  if (message.type === 'audio') {
    return wa.sendText(
      phone,
      'Recebi o áudio — nesta versão de teste ainda não transcrevo áudio automaticamente. Me conta em texto o que você precisa que eu faça com isso?'
    );
  }

  if (message.type === 'text') {
    const answer = await claude.answerFreeQuestion(message.text.body, state.family);
    return wa.sendText(phone, answer);
  }

  return null;
}

async function handleButton(phone, state, title) {
  const pending = state.pendingAction;

  // Resposta ao "quando é isso mesmo?" de data ambígua.
  if (pending && pending.type === 'confirm_date') {
    const extraction = pending.extraction;
    if (title === 'Outra data') {
      state.pendingAction = { type: 'awaiting_date_text', extraction };
      await setState(phone, state);
      return wa.sendText(phone, 'Pode digitar a data certinha (ex: 24/07)?');
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
      await setState(phone, state);

      await wa.sendText(phone, 'Feito ✅ Já está registrado na família.');

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
        return wa.sendText(
          phone,
          `Quer adicionar isso na sua agenda pessoal também? Cada um usa o próprio link: ${base}/api/ics/${id}`
        );
      }
      return null;
    }
    if (title === 'Descartar') {
      state.pendingAction = null;
      await setState(phone, state);
      return wa.sendText(phone, 'Ok, descartei.');
    }
    return wa.sendText(phone, 'Beleza, me conta o que ajustar em texto.');
  }

  return wa.sendText(phone, 'Beleza, me conta o que ajustar em texto.');
}

module.exports = { handleMessage, getState, setState };
