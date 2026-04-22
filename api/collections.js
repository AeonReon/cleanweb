// Collections + saves CRUD.

import { kv, isConfigured, normCode, newId, canonUrl, K } from './_kv.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isConfigured()) return res.status(500).json({ error: 'KV not configured' });

  const body = await readJson(req);
  const code = normCode(body.code);
  if (!code) return res.status(400).json({ error: 'Missing family code' });
  const exists = await kv.exists(K.family(code));
  if (!exists) return res.status(404).json({ error: 'Family code not found' });

  try {
    switch (body.action) {
      case 'save':           return await doSave(res, code, body);
      case 'remove':         return await doRemove(res, code, body);
      case 'update':         return await doUpdate(res, code, body);
      case 'listCollections':return await doListCollections(res, code);
      case 'listCollection': return await doListCollection(res, code, body);
      case 'savedUrls':      return await doSavedUrls(res, code, body);
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function doSave(res, code, body) {
  const item = body.item || {};
  if (!item.url || !item.title) return res.status(400).json({ error: 'Missing url or title' });
  const member = (body.member || 'Me').trim().slice(0, 40);
  const collection = (body.collection || 'Saved').trim().slice(0, 60);
  const note = (body.note || '').slice(0, 400);
  const rating = Number.isFinite(+body.rating) ? Math.max(0, Math.min(5, +body.rating)) : 0;
  const canon = canonUrl(item.url);

  const existingId = await kv.hget(K.urlIndex(code), canon);
  const id = existingId || newId();
  const now = Date.now();

  const record = {
    id,
    url: item.url,
    canon,
    title: item.title,
    description: item.description || '',
    host: item.host || '',
    thumbnail: item.thumbnail || '',
    kind: item.kind || 'web',
    phone: item.phone || '',
    address: item.address || '',
    lat: item.lat ?? null,
    lng: item.lng ?? null,
    rating,
    note,
    savedBy: member,
    savedAt: existingId ? undefined : now,
    updatedAt: now,
    collection,
  };
  Object.keys(record).forEach(k => record[k] === undefined && delete record[k]);

  await kv.hset(K.save(code, id), record);
  await kv.zadd(K.saves(code), { score: now, member: id });
  await kv.hset(K.urlIndex(code), { [canon]: id });
  await kv.sadd(K.collections(code), collection);
  await kv.zadd(K.collection(code, collection), { score: now, member: id });

  return res.status(200).json({ ok: true, id, record });
}

async function doRemove(res, code, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const record = await kv.hgetall(K.save(code, id));
  if (!record) return res.status(404).json({ error: 'Not found' });

  await kv.del(K.save(code, id));
  await kv.zrem(K.saves(code), id);
  if (record.collection) {
    await kv.zrem(K.collection(code, record.collection), id);
    const remaining = await kv.zcard(K.collection(code, record.collection));
    if (!remaining) {
      await kv.srem(K.collections(code), record.collection);
      await kv.del(K.collection(code, record.collection));
    }
  }
  if (record.canon) await kv.hdel(K.urlIndex(code), record.canon);
  return res.status(200).json({ ok: true });
}

async function doUpdate(res, code, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const record = await kv.hgetall(K.save(code, id));
  if (!record) return res.status(404).json({ error: 'Not found' });
  const patch = { updatedAt: Date.now() };
  if (typeof body.note === 'string') patch.note = body.note.slice(0, 400);
  if (Number.isFinite(+body.rating)) patch.rating = Math.max(0, Math.min(5, +body.rating));
  await kv.hset(K.save(code, id), patch);
  return res.status(200).json({ ok: true });
}

async function doListCollections(res, code) {
  const names = (await kv.smembers(K.collections(code))) || [];
  const collections = await Promise.all(
    names.map(async name => ({ name, count: await kv.zcard(K.collection(code, name)) }))
  );
  collections.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return res.status(200).json({ collections });
}

async function doListCollection(res, code, body) {
  const name = (body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const ids = (await kv.zrange(K.collection(code, name), 0, -1, { rev: true })) || [];
  const items = [];
  for (const id of ids) {
    const r = await kv.hgetall(K.save(code, id));
    if (r) items.push(r);
  }
  return res.status(200).json({ name, items });
}

async function doSavedUrls(res, code, body) {
  const urls = Array.isArray(body.urls) ? body.urls.slice(0, 50) : [];
  if (!urls.length) return res.status(200).json({ saved: {} });
  const canons = urls.map(u => canonUrl(u));
  const ids = await kv.hmget(K.urlIndex(code), ...canons);
  const saved = {};
  for (let i = 0; i < urls.length; i++) {
    const id = ids && ids[i];
    if (!id) continue;
    const r = await kv.hgetall(K.save(code, id));
    if (r) saved[urls[i]] = {
      id: r.id,
      by: r.savedBy,
      note: r.note || '',
      rating: +r.rating || 0,
      collection: r.collection || '',
    };
  }
  return res.status(200).json({ saved });
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
