// Asset proxy. Streams images, stylesheets, fonts, scripts, and other
// subresources referenced by proxied pages. Rewrites url(...) references
// inside CSS so nested assets also flow through us.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

export const config = {
  api: { bodyParser: false, responseLimit: false },
};

export default async function handler(req, res) {
  const target = (req.query && req.query.url) || '';
  if (!isSafeUrl(target)) { res.status(400).end(); return; }

  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      redirect: 'follow',
    });

    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (ct.toLowerCase().includes('text/css')) {
      const text = await r.text();
      res.status(r.status).send(rewriteCssUrls(text, r.url));
      return;
    }

    // Streamed passthrough for everything else
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).send(buf);
  } catch {
    res.status(502).end();
  }
}

function isSafeUrl(u) {
  if (!/^https?:\/\//i.test(u)) return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

function rewriteCssUrls(css, baseUrl) {
  if (!css) return css;
  return css
    .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, url) => {
      if (!url || url.toLowerCase().startsWith('data:')) return m;
      try {
        const abs = new URL(url, baseUrl).href;
        return `@import ${q}/api/asset?url=${encodeURIComponent(abs)}${q}`;
      } catch { return m; }
    })
    .replace(/url\((\s*)(['"]?)([^'")\s]+)\2(\s*)\)/g, (m, lead, q, url, trail) => {
      if (!url || url.toLowerCase().startsWith('data:')) return m;
      try {
        const abs = new URL(url, baseUrl).href;
        return `url(${lead}${q}/api/asset?url=${encodeURIComponent(abs)}${q}${trail})`;
      } catch { return m; }
    });
}
