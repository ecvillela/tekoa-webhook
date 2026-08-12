// Resolução de data leve para o MVP. Não usa timezone real (assume o
// timezone do servidor Vercel, geralmente UTC) — suficiente para o teste,
// mas vale revisar antes de produção real (America/Sao_Paulo).

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatBR(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getDate())}/${p(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// Resolve "Hoje" / "Amanhã" vindos dos botões de confirmação de data ambígua.
function resolveKeyword(label) {
  const norm = label.trim().toLowerCase();
  if (norm === 'hoje') return today();
  if (norm === 'amanhã' || norm === 'amanha') return addDays(today(), 1);
  return null;
}

// Tenta interpretar texto livre de data (DD/MM, DD/MM/AAAA). Sem ano, assume
// o ano corrente, ou o próximo se a data já passou.
function parseFreeDate(text) {
  const m = String(text).match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  if (year < 100) year += 2000;
  let d = new Date(year, month, day);
  if (!m[3] && d < today()) d = new Date(year + 1, month, day);
  return d;
}

// Interpreta hora tipo "19h", "19h00", "8h30", "9:00" — default 09:00 se
// não conseguir interpretar.
function parseHora(text) {
  if (!text) return { h: 9, m: 0 };
  const match = String(text).match(/(\d{1,2})[h:](\d{2})?/i);
  if (!match) return { h: 9, m: 0 };
  return { h: parseInt(match[1], 10), m: match[2] ? parseInt(match[2], 10) : 0 };
}

function combineDateTime(date, horaText) {
  const { h, m } = parseHora(horaText);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

module.exports = { today, addDays, formatBR, resolveKeyword, parseFreeDate, parseHora, combineDateTime };
