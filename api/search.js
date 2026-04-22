// Cleanweb search proxy — calls Brave Search API, applies user blocklist + trusted boosts,
// and returns a shape the frontend can render.
//
// Required env var: BRAVE_API_KEY  (https://api.search.brave.com/app/keys)

const ENDPOINTS = {
  web:    'https://api.search.brave.com/res/v1/web/search',
  local:  'https://api.search.brave.com/res/v1/web/search',   // local = web search with locality bias
  news:   'https://api.search.brave.com/res/v1/news/search',
  videos: 'https://api.search.brave.com/res/v1/videos/search',
  images: 'https://api.search.brave.com/res/v1/images/search',
};

// Spam signals: titles/snippets containing these phrases are heavily downweighted.
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

  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'BRAVE_API_KEY not set' });
  }

  const body = await readJson(req);
  const q = (body.q || '').trim();
  const mode = ENDPOINTS[body.mode] ? body.mode : 'web';
  const block = normList(body.block);
  const trust = normList(body.trust);
  const safe = body.safe !== false;

  if (!q) return res.status(400).json({ error: 'Missing query' });

  const url = new URL(ENDPOINTS[mode]);
  url.searchParams.set('q', q);
  url.searchParams.set('count', mode === 'images' || mode === 'videos' ? '30' : '20');
  url.searchParams.set('safesearch', safe ? 'moderate' : 'off');
  if (mode === 'local') {
    url.searchParams.set('country', 'GB');
  }

  let braveRes;
  try {
    braveRes = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });
  } catch (e) {
    return res.status(502).json({ error: `Upstream error: ${e.message}` });
  }

  if (!braveRes.ok) {
    const text = await braveRes.text().catch(() => '');
    return res.status(braveRes.status).json({
      error: `Brave API ${braveRes.status}: ${text.slice(0, 240) || braveRes.statusText}`,
    });
  }

  const data = await braveRes.json();
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
  if (mode === 'web' || mode === 'local') {
    const web = (data.web && data.web.results) || [];
    return web.map(r => ({
      title: r.title,
      url: r.url,
      description: r.description || (r.extra_snippets && r.extra_snippets[0]) || '',
      host: hostOf(r.url),
      favicon: r.meta_url && r.meta_url.favicon,
      age: r.age,
    }));
  }
  if (mode === 'news') {
    const news = (data.results) || [];
    return news.map(r => ({
      title: r.title,
      url: r.url,
      description: r.description || '',
      host: hostOf(r.url),
      age: r.age,
    }));
  }
  if (mode === 'videos') {
    const vids = (data.results) || [];
    return vids.map(r => ({
      title: r.title,
      url: r.url,
      host: hostOf(r.url),
      thumbnail: r.thumbnail && (r.thumbnail.src || r.thumbnail.original),
      duration: r.video && r.video.duration,
    }));
  }
  if (mode === 'images') {
    const imgs = (data.results) || [];
    return imgs.map(r => ({
      title: r.title,
      url: r.url, // source page
      host: hostOf(r.url),
      image: r.properties && (r.properties.url || r.properties.placeholder),
      thumbnail: r.thumbnail && r.thumbnail.src,
    }));
  }
  return [];
}

function applyFilters(items, { block, trust, mode }) {
  const seen = new Set();
  const trusted = [];
  const normal = [];
  let filtered = 0;

  for (const it of items) {
    if (!it.url) { filtered++; continue; }
    // Dedupe by URL (strip trailing slash + query for a crude canonical form)
    const canon = it.url.replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seen.has(canon)) { filtered++; continue; }
    seen.add(canon);

    // Blocklist
    if (matches(it.host, block)) { filtered++; continue; }

    // Spam phrase filter (web/local/news only, not image/video titles)
    if ((mode === 'web' || mode === 'local' || mode === 'news') &&
        isSpammy(it.title, it.description)) {
      filtered++;
      continue;
    }

    it.trusted = matches(it.host, trust);
    if (it.trusted) trusted.push(it);
    else normal.push(it);
  }

  // Dedupe per host so one domain can't flood results (keep first 2 per host)
  const perHost = new Map();
  const dedupedNormal = [];
  for (const it of normal) {
    const n = perHost.get(it.host) || 0;
    if (n >= 2) { filtered++; continue; }
    perHost.set(it.host, n + 1);
    dedupedNormal.push(it);
  }

  return { kept: [...trusted, ...dedupedNormal], filtered };
}

function isSpammy(title, desc) {
  const hay = `${title || ''} ${desc || ''}`.toLowerCase();
  let hits = 0;
  for (const p of SPAM_PHRASES) if (hay.includes(p)) hits++;
  return hits >= 2; // only drop if multiple spam signals
}
