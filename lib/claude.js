const API_KEY = process.env.ANTHROPIC_API_KEY;
const costs = require('./costs');

// Release 4 (31/08/2026): "maxTokens" agora é parâmetro opcional, em vez de
// 800 fixo. Motivo: um card de confirmação real chegou pro usuário como JSON
// cru e truncado (visto no transcript de teste) — o schema mais rico da
// Release 2 (regime/rotulo/dados/pre_requisitos/restricoes) às vezes passa de
// 800 tokens em documentos densos, a resposta corta no meio, e o regex de
// extração não fecha chave — ver TEKOA - Pendências.md e TEKOA - UX e Fluxos.md
// pra o relato completo. extractFromImage e applyCorrection (que lidam com
// esse schema) agora pedem mais espaço; classifyMessage e answerFreeQuestion
// continuam em 800, que sempre foi suficiente pra eles.
//
// Patch de Custos (28/08/2026, MKT): op/phone só servem pra registrar custo
// (lib/costs.js) — não afetam a chamada em si. inputTokens/outputTokens vêm
// sempre do usage que a própria API da Anthropic devolve, nunca estimados.
async function askClaude({ system, messages, maxTokens, op, phone }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: maxTokens || 800, system, messages })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  if (data.usage) {
    await costs.recordAiCost({
      provider: 'claude',
      op,
      phone,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens
    });
  }
  return (data.content || []).map((c) => c.text || '').join('');
}

// Release 2 (28/08/2026): "tipo" (enum fechado por assunto) foi substituído por
// "regime" + "rotulo" — ver TEKOA - UX e Fluxos.md, §13.1. A fronteira deixou de
// ser o assunto (escola/saúde/viagem) e passou a ser a profundidade: qualquer
// coisa da casa com prazo e ação entra; o que fica de fora é documento cujo
// valor está no conteúdo, não no prazo (RG, CNH, passaporte, contrato, extrato).
const EXTRACT_SYSTEM = `Você é o TEKOA, assistente de família no WhatsApp. Você recebeu uma foto encaminhada por um responsável.

Escopo do produto: qualquer assunto da casa que tenha PRAZO e AÇÃO — não é mais limitado a escola, saúde e viagem. A fronteira não é o assunto, é a profundidade: o TEKOA guarda o quê, quando, onde e quem, e nunca o conteúdo sensível.

Classifique em dois campos independentes:

"regime" — como o lembrete se comporta, uma de: passageiro, insistente_com_data, pendencia, fora_de_escopo.
- passageiro: expira sozinho quando a data passa (ex: comida da escola, prova, consulta médica).
- insistente_com_data: tem data, mas o assunto costuma exigir insistência até alguém resolver (ex: aniversário de amigo, projeto escolar, pagamento com vencimento).
- pendencia: não tem uma data de calendário — é uma janela que só fecha quando o usuário confirmar que resolveu (ex: vacina, documento vencendo).
- fora_de_escopo: o valor do documento está no CONTEÚDO, não em prazo ou ação — documento de identidade (RG, CNH, passaporte), comprovante financeiro, contrato, extrato, ou qualquer coisa pessoal sem prazo e sem ação. NUNCA extraia nada sensível desse documento — nem CPF, nem número de registro, nem dado bancário. Diga só o tipo genérico no resumo (ex: "documento de identidade").

"rotulo" — do que se trata, um assunto de: escola, saude, social, viagem, casa, financeiro, outro. Use null quando regime for fora_de_escopo.

Regra de segurança inegociável, vale para qualquer rótulo: NUNCA leia, transcreva ou resuma dose, posologia, resultado clínico, diagnóstico, número de documento (CPF, RG, CNH) ou dado bancário (linha digitável, código de barras, número de conta ou cartão). Extraia apenas metadados administrativos: o quê, quando, onde, quem.

Regra de data: extraia a data EXATAMENTE como está escrita no documento, sem calcular nada.
- Se o documento tem uma data absoluta (ex: "24/07", "24/07/2025", "quinta-feira dia 24"), coloque em "data_absoluta" no formato DD/MM ou DD/MM/AAAA como está escrito, e deixe "data_relativa" null.
- Se o documento só tem uma referência relativa (ex: "amanhã", "essa sexta", "semana que vem", sem data do calendário), coloque a expressão literal em "data_relativa" e deixe "data_absoluta" null. NUNCA calcule qual dia é "amanhã" — você não sabe quando o documento foi escrito nem quando foi encaminhado. A mesma regra vale para qualquer prazo dentro de "pre_requisitos".

"pre_requisitos" — lista de tarefas com prazo PRÓPRIO, anterior ou paralelo ao evento principal, que a família precisa cumprir para participar (ex: "deixar nome e CPF na secretaria até sexta"). Cada item: {acao, prazo_absoluto, prazo_relativo, onde}. NUNCA inclua o dado sensível em si (não peça nem registre o CPF) — só a ação e o prazo. Lista vazia se não houver nenhum.

"restricoes" — lista de textos curtos com regras que limitam a participação (ex: "só 2 familiares por criança"). Lista vazia se não houver nenhuma.

"ambiguo" e "perguntas" (Release 5, 01/09/2026) — o documento nem sempre cabe num compromisso só. Se ele tiver VÁRIOS itens distintos que não dá pra resumir num evento (várias datas, várias pessoas, várias linhas de uma tabela/planilha — ex: uma planilha de pedidos de comida da semana, com um item por dia ou por criança), ou se ficar genuinamente incerto sobre um ponto essencial (quem, quando ou o quê), NÃO adivinhe nem escolha uma linha/pessoa sozinho. Marque "ambiguo": true e liste em "perguntas" até 2 perguntas curtas e específicas pro responsável esclarecer (ex: "É só pra um dia ou pra vários dias da semana?", "É só pra um dos filhos ou pra mais de um?"). Quando "ambiguo" for true, preencha "dados" só com o que você tem certeza (pode ficar incompleto ou vazio) e "resumo_curto" com uma frase descrevendo em termos gerais o que o documento parece ser, sem afirmar detalhes que ainda não estão confirmados. Quando não houver ambiguidade, "ambiguo": false e "perguntas": [].

Responda em JSON estrito, sem texto fora do JSON:
{"regime": "...", "rotulo": "..."|null, "resumo_curto": "...", "ambiguo": true|false, "perguntas": [...], "dados": {...}, "pre_requisitos": [...], "restricoes": [...]}

Formato de "dados" conforme o rótulo:
escola -> {titulo, escola, data_absoluta, data_relativa, hora, local}
saude, quando é carteira de vacinação -> {doses: [{nome, data}], pendencia_provavel}
saude, quando é receita ou exame -> {titulo, medico, data_absoluta, data_relativa} (nunca incluir texto clínico)
social -> {titulo, data_absoluta, data_relativa, hora, local, quem}
viagem -> {destino, data_ida_absoluta, data_ida_relativa, data_volta_absoluta, data_volta_relativa, hospedagem}
casa, financeiro ou outro -> {titulo, data_absoluta, data_relativa, hora, local}
fora_de_escopo -> {}`;

// Release 9 (04/09/2026): variante de EXTRACT_SYSTEM pra texto solto (digitado
// ou encaminhado de outro app), reaproveitando o MESMO schema regime/rotulo —
// só troca a frase de abertura, que hoje presume uma foto. Ver extractFromText
// abaixo e TEKOA - Pendências.md, item 4.25, pro relato do bug que isto fecha:
// um texto descrevendo um compromisso (ex: confirmação de sessão de
// fisioterapia encaminhada) nunca virava pendência, só imagem passava pela
// extração de verdade.
const EXTRACT_SYSTEM_TEXT = EXTRACT_SYSTEM.replace(
  'Você recebeu uma foto encaminhada por um responsável.',
  'Você recebeu uma mensagem de TEXTO (digitada ou encaminhada de outro app/conversa) enviada por um responsável, descrevendo algo que pode ser um compromisso da família.'
);

// Release 4: fallback nunca mais devolve o texto cru do modelo (nem em
// resumo_curto) — isso é o que vazou como card de JSON truncado. Se a
// extração não veio como JSON válido (chave não fechou, ou fechou mas o
// parse falhou porque a resposta cortou no meio de uma string/array), o
// usuário recebe um card curto e honesto, e pode reenviar o documento.
//
// Release 5 (01/09/2026): "_fallback: true" marca explicitamente que isto é
// uma falha de extração, não um documento de verdade — ver TEKOA - Pendências.md
// pro relato do bug: sem essa marca, lib/flows.js não tinha como distinguir
// "não entendi nada" de uma extração real e vazia, e oferecia [Sim, agendar]
// em cima do fallback. O usuário confirmava, o TEKOA respondia "Feito! Já
// está registrado", e a pergunta seguinte ("o que ficou agendado?") batia de
// frente com isso, porque nada de verdade tinha sido guardado.
const EXTRACT_FALLBACK = () => ({
  regime: 'passageiro',
  rotulo: 'outro',
  resumo_curto: 'Não consegui organizar esse documento direito — pode mandar de novo, ou me contar em texto o que é?',
  ambiguo: false,
  perguntas: [],
  dados: {},
  pre_requisitos: [],
  restricoes: [],
  _fallback: true
});

async function extractFromImage(base64, mimeType, phone) {
  const text = await askClaude({
    system: EXTRACT_SYSTEM,
    maxTokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: 'Classifique e extraia os metadados desta imagem.' }
        ]
      }
    ],
    op: 'extractFromImage',
    phone
  });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return EXTRACT_FALLBACK();
  try {
    const parsed = JSON.parse(match[0]);
    // Release 5: normaliza ambiguo/perguntas mesmo se o modelo não seguir o
    // schema à risca — lib/flows.js depende desses dois campos existirem.
    parsed.ambiguo = !!parsed.ambiguo;
    parsed.perguntas = Array.isArray(parsed.perguntas) ? parsed.perguntas : [];
    return parsed;
  } catch {
    return EXTRACT_FALLBACK();
  }
}

// Release 9 (04/09/2026): mesma extração regime/rotulo de extractFromImage,
// só que a partir de texto solto — chamada quando classifyMessage (abaixo)
// marca "compromisso": true. Ver TEKOA - Pendências.md, item 4.25.
async function extractFromText(text, phone) {
  const raw = await askClaude({
    system: EXTRACT_SYSTEM_TEXT,
    maxTokens: 1500,
    messages: [{ role: 'user', content: `Classifique e extraia os metadados deste texto:\n\n${text}` }],
    op: 'extractFromText',
    phone
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return EXTRACT_FALLBACK();
  try {
    const parsed = JSON.parse(match[0]);
    parsed.ambiguo = !!parsed.ambiguo;
    parsed.perguntas = Array.isArray(parsed.perguntas) ? parsed.perguntas : [];
    return parsed;
  } catch {
    return EXTRACT_FALLBACK();
  }
}

// Roda em toda mensagem de TEXTO LIVRE (não documento) pra detectar, sem
// perguntar explicitamente: (1) uma criança sendo mencionada com nome e/ou
// idade, e (2) uma viagem da família sendo planejada. As duas coisas são
// independentes e podem aparecer juntas (ex: "vamos pra Colômbia com o
// menino de 3 anos" -> crianca sem nome + viagem).
//
// Nota de migração (§13.1): isto ainda não foi generalizado para regime/rotulo
// — continua limitado a criança e viagem em texto livre. Abrir o escopo do
// texto livre pro mesmo modelo do EXTRACT_SYSTEM é o próximo passo, não parte
// desta mudança (ver TEKOA - Pendências.md).
function classifySystem(childrenJson) {
  return `Você é o TEKOA, assistente de família no WhatsApp. Você recebe uma mensagem de TEXTO LIVRE (não é um documento) enviada pelo responsável.

Filhos já cadastrados nesta família: ${childrenJson}

Identifique, dentro da mensagem, duas coisas independentes:

1. "crianca" — preencha SOMENTE se a mensagem introduzir um nome e/ou idade de uma criança que pareça filho(a) da família (ex: "meu filho Lucas", "a Ana tem 5 anos", "o menino de 3 anos"). Se a criança mencionada já bate com um nome já cadastrado e a mensagem não traz nenhuma informação nova sobre ela, retorne null.
   - "nome": nome próprio mencionado, ou null se só descrita por gênero/idade (ex: "o menino", "minha filha").
   - "idade": idade em anos mencionada ou claramente implícita, ou null.
   - "confianca": "alta" se nome e/ou idade estão explícitos; "baixa" se for estimativa/ambíguo.

2. "viagem" — preencha SOMENTE se a mensagem falar de uma viagem futura ou planejada da família (não uma viagem já concluída sendo comentada no passado).
   - "destino": cidade/país mencionado, ou null.
   - "data_ida_absoluta" / "data_ida_relativa": mesma regra de data do resto do sistema — absoluta só se tem data de calendário explícita; relativa se for expressão tipo "mês que vem"; NUNCA calcule a data você mesmo. Use null quando não mencionado.
   - "data_volta_absoluta" / "data_volta_relativa": idem, se mencionado.
   - "viajantes": lista de nomes ou descrições de quem vai, como aparece na mensagem (ex: ["menino de 3 anos"]).
   - "hospedagem": nome do hotel/acomodação, se mencionado, senão null.
   - "confianca": "alta" ou "baixa", mesma lógica.

3. "compromisso" (Release 9, 04/09/2026) — true se a mensagem descreve, ou pede explicitamente pra registrar, um compromisso da casa com PRAZO e AÇÃO (ex: uma confirmação de agendamento encaminhada de outro app/serviço, um aviso com data, um pedido direto como "pode registrar minhas sessões de fisioterapia?"). false para perguntas sobre o que já está guardado, conversa comum, ou menção de criança/viagem sem nenhum compromisso associado. Quando "compromisso" for true, não precisa preencher "crianca"/"viagem" — o texto vai passar por uma extração própria (mesmo schema regime/rotulo de um documento).

Se nada relevante for identificado em uma categoria, use null/false para ela. Responda em JSON estrito, sem texto fora do JSON:
{"crianca": {...}|null, "viagem": {...}|null, "compromisso": true|false}`;
}

async function classifyMessage(text, family, phone) {
  const childrenJson = JSON.stringify((family && family.children) || []);
  const raw = await askClaude({
    system: classifySystem(childrenJson),
    messages: [{ role: 'user', content: text }],
    op: 'classifyMessage',
    phone
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { crianca: null, viagem: null, compromisso: false };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      crianca: parsed.crianca || null,
      viagem: parsed.viagem || null,
      compromisso: !!parsed.compromisso
    };
  } catch {
    return { crianca: null, viagem: null, compromisso: false };
  }
}

// Release 5 (01/09/2026): o contexto passado por lib/flows.js deixou de ser só
// state.family — agora vem { family, eventos, viagens }, onde "eventos" é
// state.log (toda extração já confirmada, qualquer regime/rotulo) e "viagens"
// é state.trips. Antes só family era enviado, e por isso "o que ficou
// agendado?" sempre respondia "nada registrado" mesmo logo depois de um
// "Feito! Já está registrado" — o modelo nunca via os itens confirmados.
async function answerFreeQuestion(question, context, phone) {
  const system = `Você é o TEKOA, assistente de família que vive DENTRO desta conversa de WhatsApp. Responda a pergunta do responsável usando SOMENTE o contexto fornecido. Seja direto e curto.

O contexto tem três partes: "family" (crianças e responsáveis cadastrados), "eventos" (tudo que já foi confirmado — bilhetes, consultas, prazos, o que for — cada um com regime/rotulo/resumo_curto/dados) e "viagens" (viagens já registradas). Considere as três partes ao responder, inclusive pra listar ou resumir o que está agendado.

Se a informação não estiver no contexto, diga que ainda não tem essa informação registrada. Nunca invente datas ou eventos.

REGRA CRÍTICA: nunca invente funcionalidades suas. NÃO existe aplicativo, site, painel, menu, tela ou "configurações" do TEKOA — tudo acontece nesta conversa. Nunca mande o usuário "verificar nas configurações", "acessar o app" ou qualquer lugar que você não tenha certeza que existe. Se ele pedir algo que você ainda não sabe fazer, diga isso com honestidade, em uma frase, sem inventar um caminho.

Formato padrão de listagem (Release 8, 02/09/2026 — TEKOA - UX e Fluxos.md §30): quando a pergunta pedir uma lista ou resumo do que está guardado (ex: "o que tenho marcado contigo?", "o que está pendente?", "o que vem por aí?", "quais os próximos compromissos?"), NÃO responda em prosa livre — use este formato:

TEKOA   O que está guardado:

        {ícone} {título} — {data ou "sem data confirmada"}
        {ícone} {título} — {data ou "sem data confirmada"}
        ...

        (mais {N} — me diga se quiser revisar)

Regras desse formato: ícone por rótulo — escola 📌, saude 💉, social 🎉, viagem ✈️, casa 🏠, financeiro 💳, outro 📄 (viagem usa "destino" no lugar de "título"). Ordene por data: quem tem data confirmada primeiro, mais próximo primeiro; sem data por último, sempre com a nota "sem data confirmada" — nunca esconda um item sem data, e nunca finja que ele tem data. Mostre no máximo 8 itens; se sobrarem mais (em "eventos" e "viagens" juntos), feche com uma linha de contagem do que ficou de fora, como no exemplo — não despeje a lista inteira. Se "eventos" e "viagens" estiverem vazios, diga isso direto (ex: "Ainda não tenho nenhum agendamento registrado..."), sem forçar o formato de lista vazio. Pra qualquer outra pergunta que não seja pedido de lista/resumo, responda em prosa normal, como antes.`;
  return askClaude({
    system,
    messages: [{ role: 'user', content: `Contexto:\n${JSON.stringify(context)}\n\nPergunta: ${question}` }],
    op: 'answerFreeQuestion',
    phone
  });
}

// Aplica em cima de uma extração já feita a correção ou resposta que o
// usuário escreveu — depois de apertar [Editar], ou como resposta a uma
// pergunta de esclarecimento sobre um documento ambíguo (Release 5).
// Devolve o MESMO formato de extração, para o card de confirmação (ou uma
// nova pergunta) poder ser remontado.
//
// Release 7 (02/09/2026): dois acréscimos, pra fechar o bug relatado em
// TEKOA - Pendências.md §0 ("resposta parcial tratada como resolvida"): (1)
// aceita um quarto parâmetro opcional `image` ({base64, mimeType}) — quando
// o documento original era uma foto, lib/flows.js reenvia essa imagem aqui,
// pra o modelo poder cruzar a resposta do responsável com o conteúdo (ex:
// achar a linha certa de uma tabela), em vez de depender de o usuário
// digitar de novo um dado que já estava visível na foto; (2) o prompt agora
// também instrui explicitamente como usar "ambiguo"/"perguntas" na saída —
// antes esta função não gerenciava esses dois campos, e lib/flows.js forçava
// ambiguo=false sempre, mesmo quando ainda faltava algo essencial.
async function applyCorrection(extraction, correcao, phone, image) {
  const system = `Você é o TEKOA. Recebeu uma extração já feita de um documento da família e uma correção ou resposta escrita pelo responsável (pode ser uma correção depois de [Editar], ou a resposta a uma pergunta de esclarecimento sobre um documento ambíguo). Aplique a resposta e devolva a extração atualizada.

Regras:
- Mantenha EXATAMENTE a mesma estrutura de JSON, incluindo os campos "regime" e "rotulo".
- Altere apenas o que a resposta pedir ou esclarecer. Não invente campos nem preencha o que continua desconhecido.
- Regra de data: se a resposta trouxer uma data de calendário, coloque em "data_absoluta" no formato DD/MM ou DD/MM/AAAA. Se ela for relativa ("é amanhã", "essa sexta"), coloque a expressão literal em "data_relativa" e deixe "data_absoluta" null. NUNCA calcule qual dia é.
- Nunca inclua dose, posologia, resultado clínico, diagnóstico, número de documento (CPF, RG) ou dado bancário.
- Se a imagem original do documento vier junto desta mensagem, use-a pra cruzar a resposta do responsável com o conteúdo dela (ex: achar a linha certa de uma tabela/planilha que corresponde ao nome ou item mencionado) — não peça pro responsável repetir um dado que já está visível na imagem.
- "ambiguo" e "perguntas": se depois de aplicar a resposta ainda faltar uma informação essencial (ex: uma data, ou qual pessoa/item específico se aplica), mantenha "ambiguo": true e liste em "perguntas" só o que ainda falta — não repita o que a resposta já resolveu. Se tudo que era essencial já está resolvido, "ambiguo": false e "perguntas": [].
- Classificação de "pre_requisitos" vs. "restricoes" (Release 9, 04/09/2026): "pre_requisitos" é só pra tarefa com prazo PRÓPRIO que a família precisa cumprir — sempre tem uma ação concreta e, quase sempre, um prazo (ex: "deixar nome e CPF na secretaria até sexta"). Regra geral sem prazo próprio e sem uma ação específica da família (ex: "os alimentos devem estar higienizados", "só orgânicos se possível") é "restricoes" (texto simples), nunca "pre_requisitos". Um item de "pre_requisitos" sem "acao" preenchida está classificado errado — mova pra "restricoes" em vez de deixar "acao" vazio.

Responda em JSON estrito, sem texto fora do JSON.`;

  const userText = `Extração atual:\n${JSON.stringify(extraction)}\n\nResposta do responsável: ${correcao}`;
  const userContent =
    image && image.base64
      ? [
          { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
          { type: 'text', text: userText }
        ]
      : userText;

  const raw = await askClaude({
    system,
    maxTokens: 1500,
    messages: [{ role: 'user', content: userContent }],
    op: 'applyCorrection',
    phone
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return extraction;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed.regime) parsed.regime = extraction.regime;
    if (parsed.rotulo === undefined) parsed.rotulo = extraction.rotulo;
    parsed.ambiguo = !!parsed.ambiguo;
    parsed.perguntas = Array.isArray(parsed.perguntas) ? parsed.perguntas : [];
    return parsed;
  } catch {
    return extraction;
  }
}

module.exports = { extractFromImage, extractFromText, classifyMessage, answerFreeQuestion, applyCorrection };
