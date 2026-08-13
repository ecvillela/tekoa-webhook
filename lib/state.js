const BASE = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;
const mem = new Map();

async function kvGet(key) {
  if (!BASE) return mem.get(key) || null;
  const r = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const data = await r.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function kvSet(key, value) {
  if (!BASE) { mem.set(key, value); return; }
  await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(value)
  });
}

async function kvDel(key) {
  if (!BASE) { mem.delete(key); return; }
  await fetch(`${BASE}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
}

// Lista chaves por padrão (ex: 'state:*'). Usa o comando KEYS do Upstash —
// custa O(N), aceitável na escala do MVP. Sem KV configurado, varre o Map em
// memória com um match simples de prefixo (só suporta padrão 'prefixo:*').
async function kvKeys(pattern) {
  if (!BASE) {
    const prefix = pattern.replace(/\*$/, '');
    return Array.from(mem.keys()).filter((k) => k.startsWith(prefix));
  }
  const r = await fetch(`${BASE}/keys/${encodeURIComponent(pattern)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const data = await r.json();
  return data.result || [];
}

module.exports = { kvGet, kvSet, kvDel, kvKeys };
