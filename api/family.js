// Create or verify a family.
//   POST { action: "create", name: "Mum" }  -> { code, member }
//   POST { action: "join",   code, name }   -> { ok, code, member }
//   POST { action: "info",   code }         -> { code, members, collections }

import { kv, isConfigured, newFamilyCode, normCode, K } from './_kv.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isConfigured()) return res.status(500).json({ error: 'KV not configured' });

  const body = await readJson(req);
  const action = body.action;

  try {
    if (action === 'create') {
      const name = (body.name || 'Me').trim().slice(0, 40);
      let code;
      for (let i = 0; i < 5; i++) {
        code = newFamilyCode();
        const exists = await kv.exists(K.family(code));
        if (!exists) break;
      }
      await kv.hset(K.family(code), { code, created: Date.now() });
      await kv.sadd(K.members(code), name);
      return res.status(200).json({ code, member: name });
    }

    if (action === 'join') {
      const code = normCode(body.code);
      const name = (body.name || 'Me').trim().slice(0, 40);
      if (!code) return res.status(400).json({ error: 'Missing code' });
      const exists = await kv.exists(K.family(code));
      if (!exists) return res.status(404).json({ error: 'Family code not found' });
      await kv.sadd(K.members(code), name);
      return res.status(200).json({ ok: true, code, member: name });
    }

    if (action === 'info') {
      const code = normCode(body.code);
      if (!code) return res.status(400).json({ error: 'Missing code' });
      const exists = await kv.exists(K.family(code));
      if (!exists) return res.status(404).json({ error: 'Family code not found' });
      const [members, collections] = await Promise.all([
        kv.smembers(K.members(code)),
        kv.smembers(K.collections(code)),
      ]);
      return res.status(200).json({ code, members: members || [], collections: collections || [] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
