const path = require('path');

const sent = [];
const waMockPath = path.resolve(__dirname, '../lib/whatsapp.js');
const claudeMockPath = path.resolve(__dirname, '../lib/claude.js');

const waMock = {
  sendText: async (to, body) => { sent.push({ kind: 'text', to, body }); return {}; },
  sendButtons: async (to, body, buttons) => { sent.push({ kind: 'buttons', to, body, buttons }); return {}; },
  downloadMediaBase64: async () => ({ base64: 'FAKEBASE64', mimeType: 'image/jpeg' })
};

let nextExtraction = null;
let claudeCallCount = 0;
const claudeMock = {
  extractFromImage: async () => {
    claudeCallCount++;
    return nextExtraction;
  },
  answerFreeQuestion: async (q, ctx) => `Resposta simulada para: ${q} (contexto: ${JSON.stringify(ctx)})`
};

require.cache[waMockPath] = { id: waMockPath, filename: waMockPath, loaded: true, exports: waMock };
require.cache[claudeMockPath] = { id: claudeMockPath, filename: claudeMockPath, loaded: true, exports: claudeMock };

const { handleMessage } = require('../lib/flows');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok  -', msg);
}

function btn(title) {
  return { type: 'interactive', interactive: { type: 'button_reply', button_reply: { title } } };
}

async function main() {
  const phone = '5511999990000';

  // 1. Primeira mensagem -> onboarding começa, com aviso de consentimento (LGPD)
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'Oi' } });
  assert(sent.length === 1 && sent[0].body.includes('Sou o TEKOA'), 'primeira mensagem dispara onboarding');
  assert(sent[0].body.toLowerCase().includes('apagar meus dados'), 'onboarding menciona direito de exclusão (LGPD)');

  // 2. Nome do filho (sem pedir idade na mesma pergunta)
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'Joca' } });
  assert(sent[0].kind === 'buttons', 'idade é perguntada com botões, não texto livre');
  assert(sent[0].buttons.length === 3, 'no máximo 3 botões de faixa etária (limite do WhatsApp)');

  // 3. Idade via botão
  sent.length = 0;
  await handleMessage(phone, btn('3–6 anos'));
  assert(sent[0].body.includes('Pronto'), 'onboarding conclui sem perguntar escola');

  // 4. Bilhete com data relativa ambígua -> TEKOA pergunta antes de assumir
  nextExtraction = {
    tipo: 'bilhete_escolar',
    resumo_curto: 'Passeio Infantil 3',
    dados: { titulo: 'Passeio Infantil 3', escola: 'Jardim de Infância Tia Lucy', data_absoluta: null, data_relativa: 'amanhã', hora: '8h30', local: 'Relógio das flores' }
  };
  sent.length = 0;
  await handleMessage(phone, { type: 'image', image: { id: 'media1' } });
  assert(sent[0].kind === 'buttons' && sent[0].body.includes('amanhã'), 'data ambígua dispara pergunta de confirmação, não assume');
  assert(sent[0].buttons.includes('Hoje') && sent[0].buttons.includes('Outra data'), 'oferece Hoje/Amanhã/Outra data');

  // 5. Usuário confirma que foi "Hoje" -> agora sim mostra o card normal
  sent.length = 0;
  await handleMessage(phone, btn('Hoje'));
  assert(sent[0].kind === 'buttons' && sent[0].body.includes('Passeio Infantil 3'), 'card de confirmação aparece só depois da data resolvida');
  assert(sent[0].buttons.includes('Sim, agendar'), 'botão Sim, agendar presente');

  // 6. Confirma -> registra, infere escola automaticamente, e manda link de calendário
  sent.length = 0;
  await handleMessage(phone, btn('Sim, agendar'));
  assert(sent[0].body.includes('Feito'), 'confirmação registra e responde Feito');
  assert(sent[1] && sent[1].body.includes('/api/ics/'), 'segunda mensagem traz o link .ics de calendário');

  // 7. Documento fora de escopo (ex: CNH) -> recusa, sem card, sem gravar
  nextExtraction = { tipo: 'fora_de_escopo', resumo_curto: 'documento de identidade', dados: {} };
  sent.length = 0;
  await handleMessage(phone, { type: 'image', image: { id: 'media2' } });
  assert(sent.length === 1 && sent[0].kind === 'text', 'documento fora de escopo não gera card de confirmação');
  assert(sent[0].body.toLowerCase().includes('não'), 'TEKOA explica que não vai guardar o documento');

  // 8. Pergunta livre
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'o que o joca precisa levar essa semana?' } });
  assert(sent[0].body.includes('Resposta simulada'), 'pergunta livre é roteada para o Claude com contexto da família');

  // 9. Áudio -> stub honesto
  sent.length = 0;
  await handleMessage(phone, { type: 'audio', audio: { id: 'audio123' } });
  assert(sent[0].body.includes('ainda não transcrevo'), 'áudio recebe resposta de stub, não quebra');

  // 10. Exclusão de dados (LGPD) -> apaga e reinicia
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'quero apagar meus dados' } });
  assert(sent[0].body.toLowerCase().includes('apaguei'), 'comando de exclusão confirma a remoção');
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'oi' } });
  assert(sent[0].body.includes('Sou o TEKOA'), 'depois de apagar, onboarding recomeça do zero');

  // 11. Segundo usuário -> onboarding do zero (estado isolado por telefone)
  sent.length = 0;
  await handleMessage('5511888880000', { type: 'text', text: { body: 'oi' } });
  assert(sent[0].body.includes('Sou o TEKOA'), 'novo número inicia onboarding independente');

  console.log('\nclaude.extractFromImage foi chamado', claudeCallCount, 'vezes');
}

main().catch((e) => { console.error('ERRO NÃO TRATADO:', e); process.exitCode = 1; });
