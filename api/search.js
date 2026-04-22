// Cleanweb search proxy — calls Serper.dev (Google-powered), applies user
// blocklist + trusted boosts, and returns a shape the frontend can render.
//
// Required env var: SERPER_API_KEY  (https://serper.dev)

const ENDPOINTS = {
  web:    'https://google.serper.dev/search',
  local:  'https://google.serper.dev/places',
  news:   'https://google.serper.dev/news',
  videos: 'https://google.serper.dev/videos',
  images: 'https://google.serper.dev/images',
};

const SPAM_PHRASES = [
  'top 10', 'top ten', 'best of', 'near you', 'near me',
  'find local', 'compare prices', 'quotes from',
  'directory of', 'business directory', 'local listings',
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'SERPER_API_KEY not set' });
  }

  const body = await readJson(req);
  const q = (body.q || '').trim();
  const mode = ENDPOINTS[body.mode] ? body.mode : 'web';
  const block = normList(body.block);
  const trust = normList(body.trust);
  const safe = body.safe !== false;

  if (!q) return res.status(400).json({ error: 'Missing query' });

  const payload = {
    q,
    gl: 'gb',
    hl: 'en',
    num: mode === 'images' || mode === 'videos' ? 30 : 20,
  };
  if (safe) payload.safe = 'active';

  let upstream;
  try {
    upstream = await fetch(ENDPOINTS[mode], {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return res.status(502).json({ error: `Upstream error: ${e.message}` });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({
      error: `Serper API ${upstream.status}: ${text.slice(0, 240) || upstream.statusText}`,
    });
  }

  const data = await upstream.json();
  const normalised = normaliseResults(data, mode);
  const { kept, filtered } = applyFilters(normalised, { block, trust, mode });

  return res.status(200).json({
    mode,
    query: q,
    items: kept,
    filtered,
    total: kept.length,
  });
}

// --- Helpers ---

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function normList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(s => String(s || '').trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function matches(host, list) {
  if (!host) return false;
  return list.some(d => host === d || host.endsWith('.' + d));
}

function normaliseResults(data, mode) {
  if (mode === 'web') {
    const organic = data.organic || [];
    return organic.map(r => ({
      title: r.title,
      url: r.link,
      description: r.snippet || '',
      host: hostOf(r.link),
      favicon: r.favicon,
    }));
  }

  if (mode === 'local') {
    // Serper /places — actual business listings. This is the killer feature.
    const places = data.places || [];
    return places.map(p => {
      const parts = [];
      if (p.address) parts.push(p.address);
      if (p.phoneNumber) parts.push(p.phoneNumber);
      if (p.rating) parts.push(`★ ${p.rating}${p.ratingCount ? ` (${p.ratingCount})` : ''}`);
      if (p.category) parts.push(p.category);
      const website = p.website || mapsUrlFor(p);
      return {
        title: p.title,
        url: website,
        description: parts.join(' · '),
        host: hostOf(website),
        phone: p.phoneNumber,
        address: p.address,
        rating: p.rating,
      };
    });
  }

  if (mode === 'news') {
    const news = data.news || [];
    return news.map(r => ({
      title: r.title,
      url: r.link,
      description: [r.source, r.date, r.snippet].filter(Boolean).join(' · '),
      host: hostOf(r.link),
      thumbnail: r.imageUrl,
    }));
  }

  if (mode === 'videos') {
    const vids = data.videos || [];
    return vids.map(r => ({
      title: r.title,
      url: r.link,
      host: hostOf(r.link),
      thumbnail: r.imageUrl,
      duration: r.duration,
    }));
  }

  if (mode === 'images') {
    const imgs = data.images || [];
    return imgs.map(r => ({
      title: r.title,
      url: r.link || r.imageUrl,
      host: hostOf(r.link || r.source || r.domain || ''),
      image: r.imageUrl,
      thumbnail: r.thumbnailUrl || r.imageUrl,
    }));
  }

  return [];
}

function mapsUrlFor(p) {
  const q = encodeURIComponent([p.title, p.address].filter(Boolean).join(' '));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function applyFilters(items, { block, trust, mode }) {
  const seen = new Set();
  const trusted = [];
  const normal = [];
  let filtered = 0;

  for (const it of items) {
    if (!it.url) { filtered++; continue; }
    const canon = it.url.replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seen.has(canon)) { filtered++; continue; }
    seen.add(canon);

    // Places results don't always have a website host — keep them regardless of blocklist.
    if (mode !== 'local' && matches(it.host, block)) { filtered++; continue; }

    if ((mode === 'web' || mode === 'news') &&
        isSpammy(it.title, it.description)) {
      filtered++;
      continue;
    }

    it.trusted = matches(it.host, trust);
    if (it.trusted) trusted.push(it);
    else normal.push(it);
  }

  // Dedupe per host — one domain can't flood results (only for web/news).
  if (mode === 'web' || mode === 'news') {
    const perHost = new Map();
    const deduped = [];
    for (const it of normal) {
      const n = perHost.get(it.host) || 0;
      if (n >= 2) { filtered++; continue; }
      perHost.set(it.host, n + 1);
      deduped.push(it);
    }
    return { kept: [...trusted, ...deduped], filtered };
  }

  return { kept: [...trusted, ...normal], filtered };
}

function isSpammy(title, desc) {
  const hay = `${title || ''} ${desc || ''}`.toLowerCase();
  let hits = 0;
  for (const p of SPAM_PHRASES) if (hay.includes(p)) hits++;
  return hits >= 2;
}
