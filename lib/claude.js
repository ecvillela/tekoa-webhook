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
Classifique em uma de: bilhete_escolar, carteira_vacinacao, receita_medica, exame_medico, outro.
Regra de segurança inegociável: NUNCA leia, transcreva ou resuma dose, posologia, resultado clínico ou diagnóstico. Extraia apenas metadados administrativos (datas, nomes de evento, nome do médico, tipo de documento).
Responda em JSON estrito, sem texto fora do JSON:
{"tipo": "...", "resumo_curto": "...", "dados": {...}}
bilhete_escolar -> dados: {titulo, data, hora, local}
carteira_vacinacao -> dados: {doses: [{nome, data}], pendencia_provavel}
receita_medica ou exame_medico -> dados: {medico, data} (nunca incluir texto clínico)
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
