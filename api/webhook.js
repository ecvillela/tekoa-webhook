const { handleMessage } = require('../lib/flows');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('Forbidden');
    return;
  }

  if (req.method === 'POST') {
    try {
      const entry = req.body && req.body.entry && req.body.entry[0];
      const change = entry && entry.changes && entry.changes[0];
      const messages = change && change.value && change.value.messages;
      if (messages && messages.length) {
        const phone = messages[0].from;
        await handleMessage(phone, messages[0]);
      }
    } catch (err) {
      console.error(err);
    }
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  res.status(405).send('Method not allowed');
};
