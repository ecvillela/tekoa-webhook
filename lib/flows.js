const { kvGet, kvSet } = require('./state');
const wa = require('./whatsapp');
const claude = require('./claude');

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
  bilhete_escolar: (d) => `📌 ${d.titulo || 'Aviso da escola'}\n🗓️ ${d.data || '-'} ${d.hora || ''}\n📍 ${d.local || ''}`,
  carteira_vacinacao: (d) =>
    `💉 Registrei ${d.doses ? d.doses.length : 0} doses.${d.pendencia_provavel ? `\n⚠️ ${d.pendencia_provavel}` : ''}`,
  receita_medica: (d) =>
    `📄 Receita — ${d.medico || 'médico'}, ${d.data || '-'}\nNão leio a dose por segurança. Peça "mostra a receita" quando precisar.`,
  exame_medico: (d) => `🧪 Exame — ${d.medico || 'médico'}, ${d.data || '-'}\nNão interpreto resultados.`,
  outro: (d, resumo) => resumo || 'Recebi o documento.'
};

async function handleMessage(phone, message) {
  const state = await getState(phone);

  if (message.type === 'interactive' && message.interactive && message.interactive.type === 'button_reply') {
    return handleButton(phone, state, message.interactive.button_reply.title);
  }

  if (state.stage === 'new') {
    state.stage = 'onboarding_child';
    await setState(phone, state);
    return wa.sendText(
      phone,
      'Oi! Sou o TEKOA, o assistente da sua família aqui no WhatsApp. Cuido de duas coisas: a ESCOLA das crianças (bilhetes, avisos, agenda) e a SAÚDE (vacinas, exames, consultas). Pra começar, qual o nome e a idade do seu filho ou filha?'
    );
  }

  if (state.stage === 'onboarding_child' && message.type === 'text') {
    state.family.children.push({ raw: message.text.body });
    state.stage = 'onboarding_school';
    await setState(phone, state);
    return wa.sendText(phone, 'Anotado. Ele(a) estuda em qual escola?');
  }

  if (state.stage === 'onboarding_school' && message.type === 'text') {
    state.family.children[state.family.children.length - 1].school = message.text.body;
    state.stage = 'ready';
    await setState(phone, state);
    return wa.sendText(
      phone,
      'Pronto! A partir de agora é só me mandar bilhetes, fotos e áudios da escola e da saúde que eu organizo tudo. Pode testar agora mesmo — manda uma foto de um bilhete ou pergunta algo.'
    );
  }

  if (message.type === 'image') {
    const { base64, mimeType } = await wa.downloadMediaBase64(message.image.id);
    const extraction = await claude.extractFromImage(base64, mimeType);
    state.pendingAction = { type: 'confirm_extraction', data: extraction };
    await setState(phone, state);
    const labelFn = CARD_LABELS[extraction.tipo] || CARD_LABELS.outro;
    const body = labelFn(extraction.dados || {}, extraction.resumo_curto);
    return wa.sendButtons(phone, `${body}\n\nConfirma?`, ['Sim, agendar', 'Editar', 'Descartar']);
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
  if (title.startsWith('Sim')) {
    state.log = state.log || [];
    if (state.pendingAction && state.pendingAction.data) state.log.push(state.pendingAction.data);
    state.pendingAction = null;
    await setState(phone, state);
    return wa.sendText(phone, 'Feito ✅ Já está registrado na família.');
  }
  if (title === 'Descartar') {
    state.pendingAction = null;
    await setState(phone, state);
    return wa.sendText(phone, 'Ok, descartei.');
  }
  return wa.sendText(phone, 'Beleza, me conta o que ajustar em texto.');
}

module.exports = { handleMessage, getState, setState };
