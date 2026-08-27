const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API = () => `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

async function sendText(to, body) {
  const r = await fetch(API(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });
  const data = await r.json();
  if (data.error) console.error(`[whatsapp] sendText falhou: ${data.error.message || JSON.stringify(data.error)}`);
  return data;
}

async function sendButtons(to, bodyText, buttons) {
  const r = await fetch(API(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((b, i) => ({
            type: 'reply',
            reply: { id: `btn_${i}`, title: b.slice(0, 20) }
          }))
        }
      }
    })
  });
  const data = await r.json();
  if (data.error) console.error(`[whatsapp] sendButtons falhou: ${data.error.message || JSON.stringify(data.error)}`);
  return data;
}

async function getMediaUrl(mediaId) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const data = await r.json();
  return data.url;
}

async function downloadMediaBase64(mediaId) {
  const url = await getMediaUrl(mediaId);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { base64: buf.toString('base64'), mimeType: r.headers.get('content-type') || 'image/jpeg' };
}

module.exports = { sendText, sendButtons, downloadMediaBase64 };
