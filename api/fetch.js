// Fetches a page server-side and returns readable text + basic meta.
// Used by the in-app viewer so the AI can have page context even though
// the iframe is cross-origin and unreadable from the client. Also reports
// whether the page can legally be shown in an <iframe> so the client can
// skip the embed attempt when headers say DENY.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { marked } from 'marked';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MIN_TEXT = 500; // below this, fall back to Jina Reader (JS-rendered)

export default async function handler(req, res) {
  const url = (req.query && req.query.url) || '';
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'missing or invalid url' });
    return;
  }

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
    });

    const ct = r.headers.get('content-type') || '';
    const frameable = isFrameable(r.headers, url);

    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      res.status(200).json({
        url: r.url, title: '', text: '', html: '',
        contentType: ct, ok: false, reason: 'not-html', frameable,
      });
      return;
    }

    const html = await r.text();
    let extracted = extractReadable(html, r.url);
    let via = 'native';

    // SPA / JS-rendered shell? Fall back to Jina Reader (real browser render).
    if (!extracted.text || extracted.text.length < MIN_TEXT) {
      const jina = await fetchViaJina(r.url);
      if (jina && jina.text && jina.text.length > extracted.text.length) {
        extracted = jina;
        via = 'jina';
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json({
      url: r.url,
      title: extracted.title,
      byline: extracted.byline,
      text: extracted.text.slice(0, 20000),
      html: extracted.html,
      excerpt: extracted.excerpt,
      frameable,
      via,
      ok: true,
    });
  } catch (e) {
    // Last-ditch: try Jina directly on the original URL
    try {
      const jina = await fetchViaJina(url);
      if (jina && jina.text) {
        res.status(200).json({
          ok: true, via: 'jina',
          url, title: jina.title, byline: jina.byline,
          text: jina.text.slice(0, 20000), html: jina.html, excerpt: jina.excerpt,
          frameable: true,
        });
        return;
      }
    } catch {}
    res.status(200).json({ ok: false, error: e.message, url, frameable: true });
  }
}

async function fetchViaJina(target) {
  try {
    const r = await fetch(`https://r.jina.ai/${target}`, {
      headers: {
        'Accept': 'application/json',
        'X-Return-Format': 'markdown',
      },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const payload = data && data.data ? data.data : data;
    const md = payload.content || '';
    if (!md) return null;
    const html = marked.parse(md, { breaks: false, gfm: true });
    const text = md
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[#>*`_~]+/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      title: payload.title || '',
      byline: payload.author || '',
      excerpt: text.slice(0, 400),
      text, html,
    };
  } catch { return null; }
}

function isFrameable(headers, url) {
  const xfo = (headers.get('x-frame-options') || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;

  const csp = headers.get('content-security-policy') || '';
  const fa = csp.match(/frame-ancestors\s+([^;]+)/i);
  if (fa) {
    const v = fa[1].trim().toLowerCase();
    if (v === "'none'" || v === 'none') return false;
    if (v === "'self'" || v === 'self') return false;
    // A specific allowlist without wildcard = effectively blocked for us
    if (!v.includes('*') && !v.includes('http')) return false;
  }
  return true;
}

function extractReadable(html, url) {
  try {
    const { document } = parseHTML(html);
    // Readability mutates the DOM, so give it a clone
    const clone = document.cloneNode(true);
    const reader = new Readability(clone, { charThreshold: 200 });
    const article = reader.parse();
    if (article) {
      const text = stripToText(article.content || '');
      return {
        title: article.title || document.title || '',
        byline: article.byline || '',
        excerpt: article.excerpt || text.slice(0, 400),
        html: article.content || '',
        text,
      };
    }
  } catch {}

  // Fallback: strip the whole body
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripToText(titleMatch[1]).trim() : '';
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  const body = bodyMatch ? bodyMatch[0] : html;
  const cleaned = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const text = stripToText(cleaned);
  return { title, byline: '', excerpt: text.slice(0, 400), html: '', text };
}

function stripToText(html) {
  return html
    .replace(/<(p|br|div|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
