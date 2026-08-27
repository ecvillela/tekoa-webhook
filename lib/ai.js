// Decide qual provedor de IA usar, sem o resto do código (lib/flows.js)
// precisar saber a diferença — mesma interface pública de lib/claude.js e
// lib/gemini.js: extractFromImage, classifyMessage, answerFreeQuestion.
//
// Controlado por AI_PROVIDER no Vercel:
//   'claude'  (padrão) — só Anthropic.
//   'gemini'            — só Google Gemini.
//   'compare'           — roda os dois em paralelo em toda chamada. Só o
//                         resultado do provedor primário (AI_COMPARE_PRIMARY,
//                         padrão 'claude') é usado de verdade; o resultado do
//                         outro só é logado (nunca mandado pra família), pra
//                         comparar qualidade/latência lado a lado sem
//                         duplicar mensagem no WhatsApp.
//
// Em qualquer modo de provedor único, se a chamada falhar (ex: sem crédito,
// API fora do ar), tenta automaticamente o outro provedor antes de desistir
// — assim um provedor sem saldo não trava a família inteira.
const claude = require('./claude');
const gemini = require('./gemini');

const PROVIDER = (process.env.AI_PROVIDER || 'claude').toLowerCase();

function implFor(name) {
    return name === 'gemini' ? gemini : claude;
}

function otherOf(name) {
    return name === 'gemini' ? 'claude' : 'gemini';
}

async function runCompare(fnName, args) {
    const primary = (process.env.AI_COMPARE_PRIMARY || 'claude').toLowerCase();
    const secondary = otherOf(primary);
    const started = Date.now();

  const [primaryResult, secondaryResult] = await Promise.allSettled([
        implFor(primary)[fnName](...args),
        implFor(secondary)[fnName](...args)
      ]);

  const ms = Date.now() - started;
    const fmt = (r) => (r.status === 'fulfilled' ? JSON.stringify(r.value) : `ERRO: ${r.reason && r.reason.message}`);
    console.log(`[ai-compare] ${fnName} (${ms}ms) primário=${primary}`);
    console.log(`[ai-compare] ${primary} -> ${fmt(primaryResult)}`);
    console.log(`[ai-compare] ${secondary} -> ${fmt(secondaryResult)}`);

  if (primaryResult.status === 'fulfilled') return primaryResult.value;
    if (secondaryResult.status === 'fulfilled') {
          console.log(`[ai-compare] primário (${primary}) falhou, usando ${secondary} como resposta real`);
          return secondaryResult.value;
    }
    throw primaryResult.reason;
}

async function dispatch(fnName, args) {
    if (PROVIDER === 'compare') return runCompare(fnName, args);

  const impl = implFor(PROVIDER);
    try {
          return await impl[fnName](...args);
    } catch (err) {
          const fallbackName = otherOf(PROVIDER);
          console.log(`[ai] ${PROVIDER} falhou em ${fnName} (${err.message}) — tentando fallback ${fallbackName}`);
          return implFor(fallbackName)[fnName](...args);
    }
}

module.exports = {
    extractFromImage: (...args) => dispatch('extractFromImage', args),
    classifyMessage: (...args) => dispatch('classifyMessage', args),
    answerFreeQuestion: (...args) => dispatch('answerFreeQuestion', args)
};
