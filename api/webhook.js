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
        // Release 9 (04/09/2026): a Meta pode agrupar mais de uma mensagem no
        // mesmo POST de webhook quando chegam próximas o suficiente (ex: uma
        // imagem encaminhada e um texto digitado em seguida). Antes só
        // messages[0] era processada — a(s) demais era(m) descartada(s) em
        // silêncio, sem log nem fallback pro usuário (achado no teste ao
        // vivo da Release 7, ver TEKOA - Pendências.md, item 4.24). Agora
        // processa todas, em ordem, uma de cada vez; se uma falhar, loga e
        // segue pras próximas em vez de travar o lote inteiro.
        for (const message of messages) {
          try {
            await handleMessage(message.from, message);
          } catch (err) {
            console.error(`[webhook] falha ao processar uma mensagem do lote: ${err && err.message}`, err);
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  res.status(405).send('Method not allowed');
};
