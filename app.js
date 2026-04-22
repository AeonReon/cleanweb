// --- State ---
const LS = {
  block: 'cleanweb.blocklist',
  trust: 'cleanweb.trusted',
  notes: 'cleanweb.notes',
  prefs: 'cleanweb.prefs',
};

const DEFAULT_BLOCK = [
  // UK directory / aggregator spam
  'yell.com', 'yelp.com', 'yelp.co.uk', 'thomsonlocal.com', '192.com',
  'scoot.co.uk', 'freeindex.co.uk', 'hotfrog.co.uk', 'hotfrog.com',
  'cylex-uk.co.uk', 'cylex.co.uk', 'mapquest.com', 'tupalo.net',
  'foursquare.com', 'businessfinder.com', 'yellowbot.com', 'manta.com',
  'botw.org', 'brownbook.net', 'citysearch.com', 'localsearch.com',
  // Trade aggregators
  'checkatrade.com', 'mybuilder.com', 'ratedpeople.com', 'trustatrader.com',
  'bark.com', 'trustist.com', 'houzz.co.uk', 'houzz.com',
  // Review farms
  'trustpilot.com', 'sitejabber.com', 'reviews.io', 'feefo.com',
  // AI/SEO slop
  'quora.com', 'medium.com', 'pinterest.com', 'pinterest.co.uk',
  'answers.com', 'wikihow.com', 'instructables.com',
  // Image slop
  'shutterstock.com', 'gettyimages.com', 'gettyimages.co.uk',
  'istockphoto.com', 'dreamstime.com', '123rf.com', 'alamy.com',
  'depositphotos.com', 'adobe.stock.com', 'stock.adobe.com',
];

const DEFAULT_TRUST = [
  'wikipedia.org', 'gov.uk', 'nhs.uk', 'bbc.co.uk', 'ac.uk',
  'archive.org', 'github.com', 'stackoverflow.com',
];

const state = {
  mode: 'web',
  query: '',
  block: load(LS.block, DEFAULT_BLOCK),
  trust: load(LS.trust, DEFAULT_TRUST),
  notes: load(LS.notes, {}),
  prefs: load(LS.prefs, { safe: true, family: false }),
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
function save(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

// --- DOM ---
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const stage = $('#stage');
const hero = $('#hero');
const resultsWrap = $('#resultsWrap');
const results = $('#results');
const loader = $('#loader');
const empty = $('#empty');
const errorBox = $('#errorBox');
const resultMeta = $('#resultMeta');
const filteredMeta = $('#filteredMeta');

// --- Tabs ---
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    setMode(tab.dataset.mode);
    if (state.query) runSearch();
  });
});

function setMode(mode) {
  state.mode = mode;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
}

// --- Search forms ---
$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return;
  state.query = q;
  $('#searchInputSlim').value = q;
  runSearch();
});
$('#searchFormSlim').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#searchInputSlim').value.trim();
  if (!q) return;
  state.query = q;
  $('#searchInput').value = q;
  runSearch();
});

// --- Hints ---
$$('.hint').forEach(h => {
  h.addEventListener('click', () => {
    $('#searchInput').value = h.dataset.q;
    state.query = h.dataset.q;
    if (h.dataset.mode) setMode(h.dataset.mode);
    runSearch();
  });
});

// --- Search ---
async function runSearch() {
  hero.hidden = true;
  resultsWrap.hidden = false;
  results.innerHTML = '';
  errorBox.hidden = true;
  empty.hidden = true;
  loader.hidden = false;
  resultMeta.textContent = `${state.mode} · "${state.query}"`;
  filteredMeta.textContent = '';

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: state.query,
        mode: state.mode,
        block: state.block,
        trust: state.trust,
        safe: state.prefs.safe,
      }),
    });
    const data = await res.json();
    loader.hidden = true;
    if (!res.ok) {
      showError(data.error || `Search failed (${res.status})`);
      return;
    }
    render(data);
  } catch (err) {
    loader.hidden = true;
    showError(err.message || 'Network error');
  }
}

function showError(msg) {
  errorBox.hidden = false;
  if (msg && msg.toLowerCase().includes('brave_api_key')) {
    errorBox.innerHTML = `
      <strong>Brave API key not set.</strong>
      <p>Add <code>BRAVE_API_KEY</code> in Vercel env vars (or <code>.env</code> locally). Free tier: 2,000 queries/month.</p>
      <a href="https://api.search.brave.com/app/keys" target="_blank" rel="noopener">Get a key →</a>
    `;
  } else {
    errorBox.textContent = msg;
  }
}

function render(data) {
  const items = data.items || [];
  filteredMeta.innerHTML = data.filtered
    ? `<strong>${data.filtered}</strong> noisy result${data.filtered === 1 ? '' : 's'} filtered`
    : '';

  if (!items.length) {
    empty.hidden = false;
    return;
  }

  if (state.mode === 'images' || state.mode === 'videos') {
    renderGrid(items);
  } else {
    renderList(items);
  }
}

function renderList(items) {
  results.innerHTML = '';
  items.forEach(it => {
    const el = document.createElement('article');
    el.className = 'result';
    const host = (it.host || '').replace(/^www\./, '');
    const fav = it.favicon || `https://icons.duckduckgo.com/ip3/${host}.ico`;
    const isTrusted = it.trusted;
    const noteKey = it.url;
    const note = state.notes[noteKey];

    el.innerHTML = `
      <div class="dom">
        <img class="fav" src="${fav}" alt="" onerror="this.style.display='none'"/>
        <span>${host}</span>
        ${isTrusted ? '<span class="trusted-badge">Trusted</span>' : ''}
      </div>
      <h3><a href="${escapeAttr(it.url)}" target="_blank" rel="noopener">${escape(it.title)}</a></h3>
      <p>${escape(it.description || '')}</p>
      ${state.prefs.family && note ? `<div class="family-note">📌 ${escape(note)}</div>` : ''}
      <div class="actions">
        <button data-act="note" data-url="${escapeAttr(it.url)}">${note ? 'Edit note' : 'Add family note'}</button>
        <button data-act="block" data-host="${escapeAttr(host)}">Block ${host}</button>
      </div>
    `;
    results.appendChild(el);
  });

  results.querySelectorAll('button[data-act="note"]').forEach(b => {
    b.addEventListener('click', () => openNote(b.dataset.url));
  });
  results.querySelectorAll('button[data-act="block"]').forEach(b => {
    b.addEventListener('click', () => {
      addBlock(b.dataset.host);
      runSearch();
    });
  });
}

function renderGrid(items) {
  results.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  items.forEach(it => {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = it.url;
    card.target = '_blank';
    card.rel = 'noopener';
    const thumb = it.thumbnail || it.image || '';
    const isImage = state.mode === 'images';
    card.innerHTML = `
      <div class="thumb ${isImage ? 'image' : ''}" style="background-image:url('${escapeAttr(thumb)}')">
        ${!isImage ? '<div class="play">▶</div>' : ''}
      </div>
      <div class="meta">
        <div class="t">${escape(it.title || '')}</div>
        <div class="d">${escape((it.host || '').replace(/^www\./, ''))}</div>
      </div>
    `;
    grid.appendChild(card);
  });
  results.appendChild(grid);
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escape(s); }

// --- Drawer ---
const drawer = $('#drawer');
$('#settingsBtn').addEventListener('click', () => openDrawer());
$('#drawerClose').addEventListener('click', () => closeDrawer());
$('#drawerScrim').addEventListener('click', () => closeDrawer());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDrawer(); closeNote(); }
});

function openDrawer() {
  drawer.setAttribute('aria-hidden', 'false');
  renderChips();
}
function closeDrawer() {
  drawer.setAttribute('aria-hidden', 'true');
}

function renderChips() {
  renderChipSet('#blockChips', state.block, '#blockCount', removeBlock);
  renderChipSet('#trustChips', state.trust, '#trustCount', removeTrust);
}
function renderChipSet(container, list, countEl, onRemove) {
  const c = $(container);
  c.innerHTML = '';
  list.forEach(d => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escape(d)}<button aria-label="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      onRemove(d);
      renderChips();
    });
    c.appendChild(chip);
  });
  $(countEl).textContent = list.length;
}

function addBlock(d) {
  d = d.trim().toLowerCase().replace(/^www\./, '');
  if (!d || state.block.includes(d)) return;
  state.block.push(d);
  save(LS.block, state.block);
}
function removeBlock(d) {
  state.block = state.block.filter(x => x !== d);
  save(LS.block, state.block);
}
function addTrust(d) {
  d = d.trim().toLowerCase().replace(/^www\./, '');
  if (!d || state.trust.includes(d)) return;
  state.trust.push(d);
  save(LS.trust, state.trust);
}
function removeTrust(d) {
  state.trust = state.trust.filter(x => x !== d);
  save(LS.trust, state.trust);
}

$('#addBlockForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#addBlockInput').value;
  if (v) { addBlock(v); $('#addBlockInput').value = ''; renderChips(); }
});
$('#addTrustForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#addTrustInput').value;
  if (v) { addTrust(v); $('#addTrustInput').value = ''; renderChips(); }
});

// --- Prefs ---
$('#prefSafe').checked = state.prefs.safe;
$('#prefFamily').checked = state.prefs.family;
$('#prefSafe').addEventListener('change', e => {
  state.prefs.safe = e.target.checked;
  save(LS.prefs, state.prefs);
});
$('#prefFamily').addEventListener('change', e => {
  state.prefs.family = e.target.checked;
  save(LS.prefs, state.prefs);
  if (state.query) runSearch();
});

// --- Reset ---
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Reset all settings to defaults?')) return;
  state.block = [...DEFAULT_BLOCK];
  state.trust = [...DEFAULT_TRUST];
  state.notes = {};
  state.prefs = { safe: true, family: false };
  save(LS.block, state.block);
  save(LS.trust, state.trust);
  save(LS.notes, state.notes);
  save(LS.prefs, state.prefs);
  $('#prefSafe').checked = true;
  $('#prefFamily').checked = false;
  renderChips();
});

// --- Notes ---
const noteModal = $('#noteModal');
let noteTarget = null;
function openNote(url) {
  noteTarget = url;
  $('#noteUrl').textContent = url;
  $('#noteText').value = state.notes[url] || '';
  noteModal.hidden = false;
  setTimeout(() => $('#noteText').focus(), 10);
}
function closeNote() {
  noteModal.hidden = true;
  noteTarget = null;
}
$('#noteCancel').addEventListener('click', closeNote);
$('#noteSave').addEventListener('click', () => {
  if (!noteTarget) return;
  const v = $('#noteText').value.trim();
  if (v) state.notes[noteTarget] = v;
  else delete state.notes[noteTarget];
  save(LS.notes, state.notes);
  closeNote();
  if (state.query && state.prefs.family) runSearch();
});

// --- URL state: restore query from ?q= ---
(function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  const m = params.get('mode');
  if (m) setMode(m);
  if (q) {
    $('#searchInput').value = q;
    state.query = q;
    runSearch();
  }
})();
