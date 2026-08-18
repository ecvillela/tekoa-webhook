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
let nextClassification = { crianca: null, viagem: null };
let claudeCallCount = 0;
let classifyCallCount = 0;
const claudeMock = {
  extractFromImage: async () => {
    claudeCallCount++;
    return nextExtraction;
  },
  classifyMessage: async () => {
    classifyCallCount++;
    return nextClassification;
  },
  answerFreeQuestion: async (q, ctx) => `Resposta simulada para: ${q} (contexto: ${JSON.stringify(ctx)})`
};

require.cache[waMockPath] = { id: waMockPath, filename: waMockPath, loaded: true, exports: waMock };
require.cache[claudeMockPath] = { id: claudeMockPath, filename: claudeMockPath, loaded: true, exports: claudeMock };

const { handleMessage, getState } = require('../lib/flows');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok  -', msg);
}

function btn(title) {
  return { type: 'interactive', interactive: { type: 'button_reply', button_reply: { title } } };
}

async function main() {
  const phone = '5511999990000';

  // 1. Primeira mensagem -> onboarding curto (3 mensagens), sem pedir nome/idade do filho
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'Oi' } });
  assert(sent.length === 3, 'onboarding manda 3 mensagens curtas, não um parágrafo único');
  assert(sent[0].body.includes('Sou o TEKOA'), 'primeira mensagem se apresenta');
  assert(sent[1].body.includes('VIAGENS'), 'onboarding já menciona o domínio de viagem');
  assert(sent[2].body.toLowerCase().includes('apagar meus dados'), 'onboarding menciona direito de exclusão (LGPD)');
  assert(!sent.some((s) => s.kind === 'buttons'), 'onboarding não pergunta nome nem idade com botões');

  let state = await getState(phone);
  assert(state.stage === 'ready' && state.family.children.length === 0, 'onboarding termina em "ready" sem criar filho nenhum');

  // 2. Filho mencionado naturalmente (nome + idade, alta confiança) -> é novo -> confirma antes de gravar
  nextClassification = { crianca: { nome: 'Joca', idade: 4, confianca: 'alta' }, viagem: null };
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'meu filho Joca tem 4 anos' } });
  assert(sent[0].kind === 'buttons' && sent[0].body.includes('Joca'), 'primeira menção a um filho novo gera confirmação');
  assert(sent[0].buttons.includes('Sim, confere'), 'botão de confirmação presente');

  sent.length = 0;
  await handleMessage(phone, btn('Sim, confere'));
  assert(sent[0].kind === 'text' && sent[0].body.includes('Anotado'), 'confirmação grava o filho');
  state = await getState(phone);
  assert(state.family.children.length === 1 && state.family.children[0].name === 'Joca' && state.family.children[0].age === '4', 'Joca fica cadastrado com nome e idade');

  // 3. Mesmo filho mencionado de novo, sem novidade, alta confiança -> NÃO confirma de novo
  nextClassification = { crianca: { nome: 'Joca', idade: 4, confianca: 'alta' }, viagem: null };
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'o Joca foi pra escola hoje' } });
  assert(sent.length === 1 && sent[0].kind === 'text' && sent[0].body.includes('Entendido'), 'filho já conhecido não gera confirmação de novo');

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

  // 8. Pergunta livre pura (sem filho nem viagem) -> cai no Claude com contexto da família
  nextClassification = { crianca: null, viagem: null };
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'o que o joca precisa levar essa semana?' } });
  assert(sent[0].body.includes('Resposta simulada'), 'pergunta livre é roteada para o Claude com contexto da família');

  // 9. Áudio -> stub honesto
  sent.length = 0;
  await handleMessage(phone, { type: 'audio', audio: { id: 'audio123' } });
  assert(sent[0].body.includes('ainda não transcrevo'), 'áudio recebe resposta de stub, não quebra');

  // 9b. Filho já conhecido (Joca) mencionado junto com uma viagem nova -> confirma
  // só a viagem, não repete a apresentação do filho que já está cadastrado.
  nextClassification = {
    crianca: { nome: 'Joca', idade: 4, confianca: 'alta' },
    viagem: {
      destino: 'Portugal',
      data_ida_absoluta: null,
      data_ida_relativa: 'em outubro',
      data_volta_absoluta: null,
      data_volta_relativa: null,
      viajantes: ['Joca'],
      hospedagem: null,
      confianca: 'alta'
    }
  };
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'o Joca vai viajar pra Portugal com a gente em outubro' } });
  assert(sent[0].kind === 'buttons' && sent[0].body.includes('Portugal'), 'filho já conhecido + viagem nova gera confirmação (só da viagem)');
  assert(!sent[0].body.includes('chamado(a) Joca'), 'não repete a apresentação do filho já cadastrado, só confirma a viagem');

  sent.length = 0;
  await handleMessage(phone, btn('Sim, confere'));
  assert(sent[0].kind === 'text' && sent[0].body.includes('Portugal'), 'confirmação grava a viagem e devolve o checklist');
  state = await getState(phone);
  assert(state.family.children.length === 1, 'não duplica o filho já cadastrado');
  assert(
    state.trips.length === 1 && state.trips[0].destino === 'Portugal' && state.trips[0].viajantes.includes('Joca'),
    'viagem pra Portugal gravada com Joca como viajante'
  );

  // 9c. Botão "Corrigir" cancela a confirmação pendente sem gravar nada.
  nextClassification = {
    crianca: null,
    viagem: {
      destino: 'Argentina',
      data_ida_absoluta: null,
      data_ida_relativa: null,
      data_volta_absoluta: null,
      data_volta_relativa: null,
      viajantes: ['Joca'],
      hospedagem: null,
      confianca: 'alta'
    }
  };
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'ah, e também pra Argentina ano que vem' } });
  assert(sent[0].kind === 'buttons', 'segunda viagem nova também pede confirmação antes de gravar');

  sent.length = 0;
  await handleMessage(phone, btn('Corrigir'));
  assert(sent[0].kind === 'text', 'ao escolher "Corrigir", TEKOA responde em texto pedindo a correção');
  state = await getState(phone);
  assert(state.trips.length === 1, 'nada é gravado quando o usuário escolhe "Corrigir" — continua só a viagem de Portugal');

  // 10. Viagem mencionada num número novo (estado limpo), criança sem nome -> TEKOA
  // não afirma nada, pergunta o nome antes de gravar qualquer coisa.
  const tripPhone = '5511777770000';
  nextClassification = {
    crianca: { nome: null, idade: 3, confianca: 'baixa' },
    viagem: {
      destino: 'Colômbia',
      data_ida_absoluta: null,
      data_ida_relativa: null,
      data_volta_absoluta: null,
      data_volta_relativa: null,
      viajantes: ['menino de 3 anos'],
      hospedagem: null,
      confianca: 'baixa'
    }
  };
  sent.length = 0;
  await handleMessage(tripPhone, { type: 'text', text: { body: 'Oi' } }); // onboarding primeiro
  sent.length = 0;
  await handleMessage(tripPhone, { type: 'text', text: { body: 'vamos viajar pra Colômbia com o menino de 3 anos' } });
  assert(sent.length === 1 && sent[0].kind === 'text', 'viagem com criança sem nome não usa botões, pergunta o nome em texto');
  assert(sent[0].body.includes('Colômbia') && sent[0].body.toLowerCase().includes('nome'), 'pergunta o nome da criança antes de gravar a viagem');
  let tripState = await getState(tripPhone);
  assert((tripState.trips || []).length === 0, 'nada é gravado antes do nome ser confirmado');

  // 11. Responde o nome -> cadastra o filho, grava a viagem e devolve checklist consultivo
  sent.length = 0;
  await handleMessage(tripPhone, { type: 'text', text: { body: 'Lucas' } });
  assert(sent.length === 1 && sent[0].kind === 'text', 'resposta final é um texto único com o resumo');
  assert(sent[0].body.includes('Lucas') && sent[0].body.includes('Colômbia'), 'confirma nome e destino no mesmo texto');
  assert(sent[0].body.toLowerCase().includes('passaporte') && sent[0].body.toLowerCase().includes('vacina'), 'checklist consultivo menciona passaporte e vacina sem afirmar regra como fato');
  tripState = await getState(tripPhone);
  assert(tripState.family.children.length === 1 && tripState.family.children[0].name === 'Lucas' && tripState.family.children[0].age === '3', 'Lucas fica cadastrado com 3 anos');
  assert(tripState.trips.length === 1 && tripState.trips[0].destino === 'Colômbia' && tripState.trips[0].viajantes.includes('Lucas'), 'viagem pra Colômbia gravada com Lucas como viajante');

  // 12. Exclusão de dados (LGPD) -> apaga e reinicia
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'quero apagar meus dados' } });
  assert(sent[0].body.toLowerCase().includes('apaguei'), 'comando de exclusão confirma a remoção');
  sent.length = 0;
  await handleMessage(phone, { type: 'text', text: { body: 'oi' } });
  assert(sent[0].body.includes('Sou o TEKOA'), 'depois de apagar, onboarding recomeça do zero');

  // 13. Terceiro usuário -> onboarding do zero (estado isolado por telefone)
  sent.length = 0;
  await handleMessage('5511888880000', { type: 'text', text: { body: 'oi' } });
  assert(sent[0].body.includes('Sou o TEKOA'), 'novo número inicia onboarding independente');

  console.log('\nclaude.extractFromImage foi chamado', claudeCallCount, 'vezes');
  console.log('claude.classifyMessage foi chamado', classifyCallCount, 'vezes');
}

main().catch((e) => { console.error('ERRO NÃO TRATADO:', e); process.exitCode = 1; });
