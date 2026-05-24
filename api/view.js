// Same-origin page proxy. Fetches the target URL, strips anti-framing headers,
// rewrites links/assets to flow through our own endpoints, and injects a small
// bridge script that posts the rendered DOM back to the parent window.
//
// Because the iframe now loads HTML from OUR origin, cleanweb's JS can read
// iframe.contentDocument directly and the AI sidebar sees the real live DOM.

import { parseHTML } from 'linkedom';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

export default async function handler(req, res) {
  const target = (req.query && req.query.url) || '';
  if (!isSafeUrl(target)) {
    res.status(400).send(errorDoc('Invalid or blocked URL.'));
    return;
  }

  try {
    const r = await fetch(target, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
    });

    const ct = (r.headers.get('content-type') || '').toLowerCase();

    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      // Non-HTML (PDF, images, JSON) — stream as an asset
      res.redirect(302, `/api/asset?url=${encodeURIComponent(target)}`);
      return;
    }

    const html = await r.text();
    const rewritten = rewriteHtml(html, r.url);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // Allow our own page to embed this
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.status(200).send(rewritten);
  } catch (e) {
    res.status(502).send(errorDoc(`Proxy fetch failed: ${escapeHtml(e.message)}`));
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
  // AWS / GCP metadata endpoints
  if (host === '169.254.169.254') return false;
  return true;
}

function rewriteHtml(html, baseUrl) {
  const { document } = parseHTML(html);

  // Strip any existing <meta http-equiv="Content-Security-Policy">
  document.querySelectorAll('meta[http-equiv]').forEach(m => {
    const v = (m.getAttribute('http-equiv') || '').toLowerCase();
    if (v === 'content-security-policy' || v === 'x-frame-options') m.remove();
  });

  // Remove any <base> tags. We cannot inject one pointing to the original
  // site because absolute-path URLs ("/api/asset?...") would then resolve
  // against the ORIGIN of the base (e.g. https://en.wikipedia.org/api/…),
  // 404'ing all of our proxied assets. The bridge script absolutizes any
  // JS-computed relative URLs using BASE at runtime instead.
  document.querySelectorAll('base').forEach(b => b.remove());

  const proxyNav = abs => `/api/view?url=${encodeURIComponent(abs)}`;
  const proxyAsset = abs => `/api/asset?url=${encodeURIComponent(abs)}`;

  const rewriteAttr = (el, attr, kind) => {
    const v = el.getAttribute(attr);
    if (!v) return;
    const lower = v.toLowerCase().trim();
    if (!lower || lower.startsWith('data:') || lower.startsWith('javascript:') ||
        lower.startsWith('blob:') || lower.startsWith('#') ||
        lower.startsWith('mailto:') || lower.startsWith('tel:') ||
        lower.startsWith('about:')) return;
    try {
      const abs = new URL(v, baseUrl).href;
      el.setAttribute(attr, kind === 'nav' ? proxyNav(abs) : proxyAsset(abs));
    } catch {}
  };

  // Navigation: anchors and form actions keep flowing through the proxy
  document.querySelectorAll('a[href]').forEach(el => {
    rewriteAttr(el, 'href', 'nav');
    // Force same-frame navigation so clicks stay inside our viewer
    if (el.hasAttribute('target')) el.removeAttribute('target');
  });
  document.querySelectorAll('form[action]').forEach(el => {
    rewriteAttr(el, 'action', 'nav');
    if (el.hasAttribute('target')) el.removeAttribute('target');
  });

  // Assets
  const assetSelectors = [
    'img[src]', 'script[src]', 'audio[src]', 'video[src]',
    'source[src]', 'iframe[src]', 'embed[src]',
    'link[href]', 'use[href]', 'object[data]',
  ];
  assetSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      const attr = el.hasAttribute('src') ? 'src'
        : el.hasAttribute('href') ? 'href'
        : el.hasAttribute('data') ? 'data' : null;
      if (attr) rewriteAttr(el, attr, 'asset');
    });
  });

  // srcset (img, source)
  document.querySelectorAll('[srcset]').forEach(el => {
    const srcset = el.getAttribute('srcset');
    const parts = srcset.split(',').map(s => {
      const bits = s.trim().split(/\s+/);
      if (!bits[0] || bits[0].toLowerCase().startsWith('data:')) return s;
      try {
        const abs = new URL(bits[0], baseUrl).href;
        bits[0] = proxyAsset(abs);
      } catch {}
      return bits.join(' ');
    });
    el.setAttribute('srcset', parts.join(', '));
  });

  // Inline style url(...)
  document.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style');
    const out = rewriteCssUrls(s, baseUrl);
    if (out !== s) el.setAttribute('style', out);
  });
  // Inline <style>
  document.querySelectorAll('style').forEach(el => {
    el.textContent = rewriteCssUrls(el.textContent || '', baseUrl);
  });

  // Inject bridge script as the FIRST thing in head so it intercepts
  // navigation/fetch calls made by the site's own scripts.
  const bridge = document.createElement('script');
  bridge.textContent = bridgeSource(baseUrl);
  if (document.head) {
    document.head.insertBefore(bridge, document.head.firstChild);
  } else {
    document.documentElement.insertBefore(bridge, document.documentElement.firstChild);
  }

  // Strip meta refresh redirects that would break out of the proxy
  document.querySelectorAll('meta[http-equiv]').forEach(m => {
    const v = (m.getAttribute('http-equiv') || '').toLowerCase();
    if (v === 'refresh') m.remove();
  });

  return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
}

function bridgeSource(pageUrl) {
  return `
(function(){
  var BASE = ${JSON.stringify(pageUrl)};
  var NAV = '/api/view?url=';
  var ASSET = '/api/asset?url=';

  function absolutize(u) {
    try { return new URL(u, BASE).href; } catch (e) { return null; }
  }
  function toNav(u) { var a = absolutize(u); return a ? NAV + encodeURIComponent(a) : u; }
  function toAsset(u) { var a = absolutize(u); return a ? ASSET + encodeURIComponent(a) : u; }
  function isAlreadyProxied(u) { return /^\\/api\\/(view|asset)\\?/.test(u); }
  function isSpecial(u) {
    if (!u) return true;
    var l = u.toLowerCase();
    return l.startsWith('javascript:') || l.startsWith('mailto:') || l.startsWith('tel:') ||
           l.startsWith('blob:') || l.startsWith('data:') || l.startsWith('#') || l.startsWith('about:');
  }

  // ---- Navigation interception -------------------------------------------------

  // Catch anchor clicks (including dynamically-added ones) in the capture phase
  document.addEventListener('click', function(e){
    var a = e.target && (e.target.closest ? e.target.closest('a[href]') : null);
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || isSpecial(href) || isAlreadyProxied(href)) return;
    // If still unproxied (e.g. set by JS after our rewrite), route it through.
    e.preventDefault();
    top.location.href === location.href; // no-op just to reference top
    location.href = toNav(href);
  }, true);

  // Intercept form submits that weren't rewritten
  document.addEventListener('submit', function(e){
    var f = e.target;
    if (!f || !f.action) return;
    var action = f.getAttribute('action');
    if (!action || isAlreadyProxied(action) || isSpecial(action)) return;
    f.setAttribute('action', toNav(action));
  }, true);

  // Patch assign/replace so JS navigation stays inside the proxy
  try {
    var origAssign = location.assign.bind(location);
    var origReplace = location.replace.bind(location);
    location.assign = function(u){ return origAssign(isSpecial(u) || isAlreadyProxied(u) ? u : toNav(u)); };
    location.replace = function(u){ return origReplace(isSpecial(u) || isAlreadyProxied(u) ? u : toNav(u)); };
  } catch(e){}

  // Patch window.open so popups flow through proxy too
  try {
    var origOpen = window.open;
    window.open = function(u, name, feat){
      if (u && !isSpecial(u) && !isAlreadyProxied(u)) u = toNav(u);
      return origOpen.call(window, u, '_self', feat); // force same-frame
    };
  } catch(e){}

  // ---- Network interception ----------------------------------------------------
  // Route the site's own fetch() and XHR through the asset proxy so API calls
  // hit the real origin instead of our Vercel functions.

  try {
    var origFetch = window.fetch && window.fetch.bind(window);
    if (origFetch) {
      window.fetch = function(input, init){
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url && !isSpecial(url) && !isAlreadyProxied(url)) {
            var proxied = toAsset(url);
            if (typeof input === 'string') input = proxied;
            else input = new Request(proxied, input);
          }
        } catch(e){}
        return origFetch(input, init);
      };
    }
  } catch(e){}

  try {
    var origOpenXhr = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      try {
        if (url && !isSpecial(url) && !isAlreadyProxied(url)) {
          url = toAsset(url);
        }
      } catch(e){}
      return origOpenXhr.apply(this, [method, url].concat([].slice.call(arguments, 2)));
    };
  } catch(e){}

  // ---- Dynamic element patching ------------------------------------------------
  // When JS inserts <img>, <script>, <link>, <iframe>, <source> with cross-origin
  // URLs after page load, rewrite them on the fly.

  function patchNode(n) {
    if (!n || n.nodeType !== 1) return;
    var tag = n.tagName && n.tagName.toLowerCase();
    if (!tag) return;
    var pairs = {
      a: ['href','nav'], img: ['src','asset'], script: ['src','asset'],
      link: ['href','asset'], iframe: ['src','asset'], source: ['src','asset'],
      video: ['src','asset'], audio: ['src','asset'], use: ['href','asset'],
      form: ['action','nav'], object: ['data','asset'], embed: ['src','asset'],
    };
    var pair = pairs[tag];
    if (pair) {
      var attr = pair[0], kind = pair[1];
      var v = n.getAttribute && n.getAttribute(attr);
      if (v && !isSpecial(v) && !isAlreadyProxied(v)) {
        n.setAttribute(attr, kind === 'nav' ? toNav(v) : toAsset(v));
      }
    }
    // srcset
    if (n.getAttribute && n.getAttribute('srcset')) {
      var ss = n.getAttribute('srcset');
      if (!/\\/api\\/asset/.test(ss)) {
        var parts = ss.split(',').map(function(s){
          var bits = s.trim().split(/\\s+/);
          if (bits[0] && !isSpecial(bits[0]) && !isAlreadyProxied(bits[0])) bits[0] = toAsset(bits[0]);
          return bits.join(' ');
        });
        n.setAttribute('srcset', parts.join(', '));
      }
    }
    if (n.children) for (var i=0; i<n.children.length; i++) patchNode(n.children[i]);
  }
  try {
    var mo2 = new MutationObserver(function(muts){
      muts.forEach(function(m){
        if (m.addedNodes) for (var i=0; i<m.addedNodes.length; i++) patchNode(m.addedNodes[i]);
        if (m.type === 'attributes') patchNode(m.target);
      });
    });
    if (document.documentElement) {
      mo2.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href','src','action','data','srcset'] });
    }
  } catch(e){}

  // ---- DOM snapshot to parent (AI context) -------------------------------------

  var lastText = '';
  function snapshot(){
    try {
      var text = (document.body && document.body.innerText) || '';
      if (text === lastText) return;
      lastText = text;
      parent.postMessage({
        __cleanweb: true,
        type: 'page',
        url: BASE,
        currentUrl: location.href,
        title: document.title || '',
        text: text.slice(0, 40000),
        length: text.length,
      }, '*');
    } catch (e) {}
  }
  function onReady(){ snapshot(); setTimeout(snapshot, 800); setTimeout(snapshot, 2500); setTimeout(snapshot, 6000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
  try {
    var mo = new MutationObserver(function(){
      clearTimeout(window.__cleanwebDebounce);
      window.__cleanwebDebounce = setTimeout(snapshot, 400);
    });
    if (document.body || document.documentElement) {
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    } else {
      document.addEventListener('DOMContentLoaded', function(){
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
    }
  } catch(e){}
})();
`;
}

function rewriteCssUrls(css, baseUrl) {
  if (!css) return css;
  return css.replace(/url\((\s*)(['"]?)([^'")\s]+)\2(\s*)\)/g, (m, lead, q, url, trail) => {
    if (!url || url.toLowerCase().startsWith('data:')) return m;
    try {
      const abs = new URL(url, baseUrl).href;
      return `url(${lead}${q}/api/asset?url=${encodeURIComponent(abs)}${q}${trail})`;
    } catch { return m; }
  });
}

function errorDoc(msg) {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;color:#333;background:#fafafa"><h3>Cleanweb proxy</h3><p>${escapeHtml(msg)}</p></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
