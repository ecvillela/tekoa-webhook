const API_KEY = process.env.ANTHROPIC_API_KEY;

async function askClaude({ system, messages }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 800, system, messages })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return (data.content || []).map((c) => c.text || '').join('');
}

const EXTRACT_SYSTEM = `Você é o TEKOA, assistente de família no WhatsApp. Você recebeu uma foto encaminhada por um responsável.

Escopo do produto: só ESCOLA (bilhetes, avisos, provas) e SAÚDE (vacinas, receitas, exames) das crianças da família. Documentos de identidade (CNH, RG, passaporte), comprovantes financeiros, contratos ou qualquer outro documento pessoal NÃO fazem parte do escopo.

Classifique em uma de: bilhete_escolar, carteira_vacinacao, receita_medica, exame_medico, fora_de_escopo, outro.
- fora_de_escopo: documento de identidade, financeiro, jurídico ou qualquer coisa claramente pessoal e não relacionada a escola/saúde de criança (ex: CNH, RG, boleto, contrato). Não extraia nenhum dado sensível desse documento — nem CPF, nem número de registro, nem nada. Só diga o tipo genérico no resumo (ex: "documento de identidade"), nunca o conteúdo.
- outro: documento relacionado a escola/saúde mas que não se encaixa nas 4 categorias específicas.

Regra de segurança inegociável: NUNCA leia, transcreva ou resuma dose, posologia, resultado clínico ou diagnóstico. Extraia apenas metadados administrativos (datas, nomes de evento, nome do médico, tipo de documento).

Regra de data: extraia a data EXATAMENTE como está escrita no documento, sem calcular nada.
- Se o documento tem uma data absoluta (ex: "24/07", "24/07/2025", "quinta-feira dia 24"), coloque em "data_absoluta" no formato DD/MM ou DD/MM/AAAA como está escrito, e deixe "data_relativa" null.
- Se o documento só tem uma referência relativa (ex: "amanhã", "essa sexta", "semana que vem", sem data do calendário), coloque a expressão literal em "data_relativa" e deixe "data_absoluta" null. NUNCA calcule qual dia é "amanhã" — você não sabe quando o documento foi escrito nem quando foi encaminhado.

Responda em JSON estrito, sem texto fora do JSON:
{"tipo": "...", "resumo_curto": "...", "dados": {...}}
bilhete_escolar -> dados: {titulo, escola, data_absoluta, data_relativa, hora, local}
carteira_vacinacao -> dados: {doses: [{nome, data}], pendencia_provavel}
receita_medica ou exame_medico -> dados: {medico, data_absoluta, data_relativa} (nunca incluir texto clínico)
fora_de_escopo -> dados: {}
outro -> dados: {}`;

async function extractFromImage(base64, mimeType) {
  const text = await askClaude({
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: 'Classifique e extraia os metadados desta imagem.' }
        ]
      }
    ]
  });
  const match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : { tipo: 'outro', resumo_curto: text, dados: {} };
}

async function answerFreeQuestion(question, context) {
  const system = `Você é o TEKOA. Responda a pergunta do responsável usando SOMENTE o contexto da família fornecido. Seja direto e curto. Se não souber, diga que ainda não tem essa informação registrada. Nunca invente datas ou eventos que não estão no contexto.`;
  return askClaude({
    system,
    messages: [
      { role: 'user', content: `Contexto da família:\n${JSON.stringify(context)}\n\nPergunta: ${question}` }
    ]
  });
}

module.exports = { extractFromImage, answerFreeQuestion };
