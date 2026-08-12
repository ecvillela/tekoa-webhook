// Gera .ics — funciona com Google Calendar, Apple Calendar e Outlook, sem OAuth
// e sem integração de calendário nenhuma. Cada pessoa clica no próprio link e
// adiciona na própria agenda.

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIcsDate(date) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    '00Z'
  );
}

function escapeText(s) {
  return String(s || '').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
}

function buildIcs({ uid, title, start, end, location, description }) {
  const now = toIcsDate(new Date());
  const dtStart = toIcsDate(start);
  const dtEnd = toIcsDate(end || new Date(start.getTime() + 60 * 60 * 1000));
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TEKOA//tekoa-webhook//PT-BR',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}@tekoaapp.com.br`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeText(title)}`,
    location ? `LOCATION:${escapeText(location)}` : null,
    description ? `DESCRIPTION:${escapeText(description)}` : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ]
    .filter(Boolean)
    .join('\r\n');
}

module.exports = { buildIcs };
