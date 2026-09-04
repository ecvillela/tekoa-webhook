const { kvGet, kvSet, kvKeys } = require('./state');

// Lista de espera da landing page (04/09/2026) — TEKOA - Pendências.md, item
// novo criado junto com este arquivo. Formulário curto e público em
// tekoaapp.com.br/lista-de-espera.html (repo separado, tekoa-site) manda
// aqui: nome, telefone e motivação — nada além disso, de propósito (pedido
// direto do Eduardo: "não deveria ser um form longo"). O Eduardo convida
// manualmente pelo WhatsApp quando decide abrir uma vaga — não dispara
// nenhuma mensagem automática.

const MAX_LEN = { nome: 120, telefone: 30, motivacao: 500 };

// Normaliza pra dígitos só, e assume Brasil (55) quando vier sem DDI — a
// esmagadora maioria vai vir como "DDD + número" (10 ou 11 dígitos), do
// mesmo jeito que qualquer outro telefone deste produto. Deixa o resultado
// no mesmo formato de `message.from` que a Meta manda pro webhook, pra ficar
// consistente com `state:{phone}` se um dia esse contato virar família de
// verdade.
function normalizePhone(telefone) {
  const digits = String(telefone || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function validate({ nome, telefone, motivacao }) {
  const errors = [];
  if (!nome || !String(nome).trim()) errors.push('nome é obrigatório');
  const phone = normalizePhone(telefone);
  if (phone.length < 12 || phone.length > 13) errors.push('telefone inválido');
  if (!motivacao || !String(motivacao).trim()) errors.push('motivação é obrigatória');
  return errors;
}

async function addToWaitlist({ nome, telefone, motivacao }) {
  const errors = validate({ nome, telefone, motivacao });
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.validation = true;
    throw err;
  }

  const phone = normalizePhone(telefone);
  const key = `waitlist:${phone}`;
  const existing = await kvGet(key);

  const entry = {
    nome: String(nome).trim().slice(0, MAX_LEN.nome),
    telefone: String(telefone).trim().slice(0, MAX_LEN.telefone),
    motivacao: String(motivacao).trim().slice(0, MAX_LEN.motivacao),
    // Reenvio do mesmo telefone atualiza a entrada em vez de duplicar, mas
    // preserva a data original de entrada na fila.
    criadoEm: (existing && existing.criadoEm) || new Date().toISOString(),
    atualizadoEm: new Date().toISOString()
  };
  await kvSet(key, entry);
  return entry;
}

async function listWaitlist() {
  const keys = await kvKeys('waitlist:*');
  const entries = [];
  for (const key of keys) {
    const entry = await kvGet(key);
    if (!entry) continue;
    entries.push({ phone: key.replace(/^waitlist:/, ''), ...entry });
  }
  entries.sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
  return entries;
}

module.exports = { addToWaitlist, listWaitlist, normalizePhone };
