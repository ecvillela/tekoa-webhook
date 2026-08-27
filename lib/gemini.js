// Adaptador do Gemini (Google) com a MESMA interface pública do lib/claude.js
// (extractFromImage, classifyMessage, answerFreeQuestion), pra poder trocar
// de provedor de IA sem mexer em lib/flows.js — ver lib/ai.js, que decide
// qual provedor usar (ou os dois, em modo de comparação) via env var
// AI_PROVIDER. Prompts mantidos idênticos aos do claude.js de propósito,
// pra comparação ficar justa entre os dois provedores.

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

Escopo do produto: ESCOLA (bilhetes, avisos, provas), SAÚDE (vacinas, receitas, exames) e VIAGENS (passagens, reservas de hospedagem, itinerários) da família. Documentos de identidade (CNH, RG, passaporte), comprovantes financeiros, contratos ou qualquer outro documento pessoal fora dessas três áreas NÃO fazem parte do escopo.

Classifique em uma de: bilhete_escolar, carteira_vacinacao, receita_medica, exame_medico, viagem, fora_de_escopo, outro.
- viagem: comprovante de passagem aérea/rodoviária, reserva de hotel/hospedagem, ou itinerário de viagem da família.
- fora_de_escopo: documento de identidade, financeiro, jurídico ou qualquer coisa claramente pessoal e não relacionada a escola/saúde/viagem da família (ex: CNH, RG, boleto, contrato). Não extraia nenhum dado sensível desse documento — nem CPF, nem número de registro, nem nada. Só diga o tipo genérico no resumo (ex: "documento de identidade"), nunca o conteúdo.
- outro: documento relacionado a escola/saúde/viagem mas que não se encaixa nas categorias específicas.

Regra de segurança inegociável: NUNCA leia, transcreva ou resuma dose, posologia, resultado clínico ou diagnóstico. Extraia apenas metadados administrativos (datas, nomes de evento, nome do médico, tipo de documento).

Regra de data: extraia a data EXATAMENTE como está escrita no documento, sem calcular nada.
- Se o documento tem uma data absoluta (ex: "24/07", "24/07/2025", "quinta-feira dia 24"), coloque em "data_absoluta" no formato DD/MM ou DD/MM/AAAA como está escrito, e deixe "data_relativa" null.
- Se o documento só tem uma referência relativa (ex: "amanhã", "essa sexta", "semana que vem", sem data do calendário), coloque a expressão literal em "data_relativa" e deixe "data_absoluta" null. NUNCA calcule qual dia é "amanhã" — você não sabe quando o documento foi escrito nem quando foi encaminhado.

Responda em JSON estrito, sem texto fora do JSON:
{"tipo": "...", "resumo_curto": "...", "dados": {...}}
bilhete_escolar -> dados: {titulo, escola, data_absoluta, data_relativa, hora, local}
carteira_vacinacao -> dados: {doses: [{nome, data}], pendencia_provavel}
receita_medica ou exame_medico -> dados: {medico, data_absoluta, data_relativa} (nunca incluir texto clínico)
viagem -> dados: {destino, data_ida_absoluta, data_ida_relativa, data_volta_absoluta, data_volta_relativa, hospedagem}
fora_de_escopo -> dados: {}
outro -> dados: {}`;

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
    return match ? JSON.parse(match[0]) : { tipo: 'outro', resumo_curto: text, dados: {} };
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

module.exports = { extractFromImage, classifyMessage, answerFreeQuestion };
