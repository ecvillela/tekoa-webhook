// Adaptador do Gemini (Google) com a MESMA interface pública do lib/claude.js
// (extractFromImage, classifyMessage, answerFreeQuestion, applyCorrection), pra
// poder trocar de provedor de IA sem mexer em lib/flows.js — ver lib/ai.js, que
// decide qual provedor usar (ou os dois, em modo de comparação) via env var
// AI_PROVIDER. Prompts mantidos idênticos aos do claude.js de propósito, pra
// comparação ficar justa entre os dois provedores.
//
// Release 2 (28/08/2026): "tipo" virou "regime" + "rotulo" — ver claude.js e
// TEKOA - UX e Fluxos.md, §13.1. Também adicionado applyCorrection, que faltava
// aqui: lib/ai.js despachava applyCorrection só quando existisse no provedor
// escolhido, e como não existia nem aqui nem no dispatch de ai.js, apertar
// [Editar] e digitar a correção travava a conversa em qualquer AI_PROVIDER
// configurado para gemini ou compare — o mesmo sintoma do Defeito 1 que a
// Release 1 corrigiu, por um caminho diferente.

const API_KEY = process.env.GEMINI_API_KEY;

async function askGemini({ system, contents }) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: 800 }
      })
    }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const candidate = data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

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

Responda em JSON estrito, sem texto fora do JSON:
{"regime": "...", "rotulo": "..."|null, "resumo_curto": "...", "dados": {...}, "pre_requisitos": [...], "restricoes": [...]}

Formato de "dados" conforme o rótulo:
escola -> {titulo, escola, data_absoluta, data_relativa, hora, local}
saude, quando é carteira de vacinação -> {doses: [{nome, data}], pendencia_provavel}
saude, quando é receita ou exame -> {titulo, medico, data_absoluta, data_relativa} (nunca incluir texto clínico)
social -> {titulo, data_absoluta, data_relativa, hora, local, quem}
viagem -> {destino, data_ida_absoluta, data_ida_relativa, data_volta_absoluta, data_volta_relativa, hospedagem}
casa, financeiro ou outro -> {titulo, data_absoluta, data_relativa, hora, local}
fora_de_escopo -> {}`;

async function extractFromImage(base64, mimeType) {
  const text = await askGemini({
    system: EXTRACT_SYSTEM,
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: base64 } },
          { text: 'Classifique e extraia os metadados desta imagem.' }
        ]
      }
    ]
  });
  const match = text.match(/\{[\s\S]*\}/);
  return match
    ? JSON.parse(match[0])
    : { regime: 'passageiro', rotulo: 'outro', resumo_curto: text, dados: {}, pre_requisitos: [], restricoes: [] };
}

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

                               Se nada relevante for identificado em uma categoria, use null para ela. Responda em JSON estrito, sem texto fora do JSON:
                               {"crianca": {...}|null, "viagem": {...}|null}`;
}

async function classifyMessage(text, family) {
  const childrenJson = JSON.stringify((family && family.children) || []);
  const raw = await askGemini({
    system: classifySystem(childrenJson),
    contents: [{ role: 'user', parts: [{ text }] }]
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { crianca: null, viagem: null };
  try {
    const parsed = JSON.parse(match[0]);
    return { crianca: parsed.crianca || null, viagem: parsed.viagem || null };
  } catch {
    return { crianca: null, viagem: null };
  }
}

async function answerFreeQuestion(question, context) {
  const system = `Você é o TEKOA. Responda a pergunta do responsável usando SOMENTE o contexto da família fornecido. Seja direto e curto. Se não souber, diga que ainda não tem essa informação registrada. Nunca invente datas ou eventos que não estão no contexto.`;
  return askGemini({
    system,
    contents: [
      { role: 'user', parts: [{ text: `Contexto da família:\n${JSON.stringify(context)}\n\nPergunta: ${question}` }] }
    ]
  });
}

// Espelha lib/claude.js#applyCorrection — ver o comentário no topo do arquivo
// sobre por que faltava aqui.
async function applyCorrection(extraction, correcao) {
  const system = `Você é o TEKOA. Recebeu uma extração já feita de um documento da família e uma correção escrita pelo responsável. Aplique a correção e devolva a extração corrigida.

Regras:
- Mantenha EXATAMENTE a mesma estrutura de JSON, incluindo os campos "regime" e "rotulo".
- Altere apenas o que a correção pedir. Não invente campos nem preencha o que continua desconhecido.
- Regra de data: se a correção trouxer uma data de calendário, coloque em "data_absoluta" no formato DD/MM ou DD/MM/AAAA. Se ela for relativa ("é amanhã", "essa sexta"), coloque a expressão literal em "data_relativa" e deixe "data_absoluta" null. NUNCA calcule qual dia é.
- Nunca inclua dose, posologia, resultado clínico, diagnóstico, número de documento (CPF, RG) ou dado bancário.

Responda em JSON estrito, sem texto fora do JSON.`;

  const raw = await askGemini({
    system,
    contents: [
      {
        role: 'user',
        parts: [{ text: `Extração atual:\n${JSON.stringify(extraction)}\n\nCorreção do responsável: ${correcao}` }]
      }
    ]
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return extraction;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed.regime) parsed.regime = extraction.regime;
    if (parsed.rotulo === undefined) parsed.rotulo = extraction.rotulo;
    return parsed;
  } catch {
    return extraction;
  }
}

module.exports = { extractFromImage, classifyMessage, answerFreeQuestion, applyCorrection };
