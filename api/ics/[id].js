const { kvGet } = require('../../lib/state');
const { buildIcs } = require('../../lib/ics');

module.exports = async (req, res) => {
  const { id } = req.query;
  const event = await kvGet(`event:${id}`);
  if (!event) {
    res.status(404).send('Evento não encontrado (ou já expirou).');
    return;
  }
  const ics = buildIcs({
    uid: id,
    title: event.title,
    start: new Date(event.start),
    end: event.end ? new Date(event.end) : null,
    location: event.location,
    description: event.description
  });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tekoa-${id}.ics"`);
  res.status(200).send(ics);
};
