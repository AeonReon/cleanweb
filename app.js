// --- Storage keys ---
const LS = {
  block:  'cleanweb.blocklist',
  trust:  'cleanweb.trusted',
  prefs:  'cleanweb.prefs',
  family: 'cleanweb.family',    // { code, member }
  ai:     'cleanweb.ai',        // { enabled, url, model }
};

const DEFAULT_BLOCK = [
  'yell.com', 'yelp.com', 'yelp.co.uk', 'thomsonlocal.com', '192.com',
  'scoot.co.uk', 'freeindex.co.uk', 'hotfrog.co.uk', 'hotfrog.com',
  'cylex-uk.co.uk', 'cylex.co.uk', 'mapquest.com', 'tupalo.net',
  'foursquare.com', 'businessfinder.com', 'yellowbot.com', 'manta.com',
  'botw.org', 'brownbook.net', 'citysearch.com', 'localsearch.com',
  'checkatrade.com', 'mybuilder.com', 'ratedpeople.com', 'trustatrader.com',
  'bark.com', 'trustist.com', 'houzz.co.uk', 'houzz.com',
  'trustpilot.com', 'sitejabber.com', 'reviews.io', 'feefo.com',
  'quora.com', 'medium.com', 'pinterest.com', 'pinterest.co.uk',
  'answers.com', 'wikihow.com', 'instructables.com',
  'shutterstock.com', 'gettyimages.com', 'gettyimages.co.uk',
  'istockphoto.com', 'dreamstime.com', '123rf.com', 'alamy.com',
  'depositphotos.com', 'stock.adobe.com',
];

const DEFAULT_TRUST = [
  'wikipedia.org', 'gov.uk', 'nhs.uk', 'bbc.co.uk', 'ac.uk',
  'archive.org', 'github.com', 'stackoverflow.com',
];

const state = {
  view: 'search',       // 'search' | 'collections'
  mode: 'web',
  query: '',
  block: load(LS.block, DEFAULT_BLOCK),
  trust: load(LS.trust, DEFAULT_TRUST),
  prefs: load(LS.prefs, { safe: true }),
  family: load(LS.family, null),
  ai: load(LS.ai, { enabled: false, url: 'http://localhost:1234/v1', model: '' }),
  lastResults: [],
  familySavedMap: {},   // url -> save meta (from /api/collections savedUrls)
  collections: [],
  selected: new Set(),  // for local action bar
  lastLocalItems: [],   // so action bar can reference them
  openPage: null,       // { url, title, host, text } when viewer is open
  viewerMode: 'site',   // 'site' | 'reader'
};

function load(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function save(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

// --- DOM shortcuts ---
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const hero = $('#hero');
const resultsWrap = $('#resultsWrap');
const results = $('#results');
const mapEl = $('#map');
const collectionsWrap = $('#collectionsWrap');
const loader = $('#loader');
const empty = $('#empty');
const errorBox = $('#errorBox');
const resultMeta = $('#resultMeta');
const filteredMeta = $('#filteredMeta');
const viewToggle = $('#viewToggle');
const heroFamily = $('#heroFamily');

// --- Tabs / views ---
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.view === 'collections') {
      switchToCollections();
    } else {
      setMode(tab.dataset.mode);
      switchToSearch();
      if (state.query) runSearch();
    }
  });
});

function setMode(mode) {
  state.mode = mode;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode && !t.dataset.view));
  $('#viewToggle').hidden = mode !== 'local';
  if (mode !== 'local') {
    clearSelection();
    showList();
  }
}

function switchToCollections() {
  state.view = 'collections';
  hero.hidden = true;
  resultsWrap.hidden = true;
  collectionsWrap.hidden = false;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'collections'));
  renderCollectionsHome();
}

function switchToSearch() {
  state.view = 'search';
  collectionsWrap.hidden = true;
  if (state.query) { hero.hidden = true; resultsWrap.hidden = false; }
  else { hero.hidden = false; resultsWrap.hidden = true; }
}

// --- Search forms ---
$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return;
  state.query = q;
  $('#searchInputSlim').value = q;
  switchToSearch();
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
$$('.hint').forEach(h => {
  h.addEventListener('click', () => {
    $('#searchInput').value = h.dataset.q;
    state.query = h.dataset.q;
    if (h.dataset.mode) setMode(h.dataset.mode);
    switchToSearch();
    runSearch();
  });
});

// --- View toggle (list/map) ---
let mapView = false;
let map = null;
let mapMarkers = [];
viewToggle.addEventListener('click', () => {
  mapView = !mapView;
  viewToggle.textContent = mapView ? 'List view' : 'Map view';
  if (mapView) showMap(); else showList();
});
function showList() {
  mapEl.hidden = true;
  results.hidden = false;
  mapView = false;
  viewToggle.textContent = 'Map view';
}
function showMap() {
  results.hidden = true;
  mapEl.hidden = false;
  renderMap(state.lastLocalItems);
}

// --- Search ---
async function runSearch() {
  clearSelection();
  hero.hidden = true;
  resultsWrap.hidden = false;
  collectionsWrap.hidden = true;
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
        q: state.query, mode: state.mode,
        block: state.block, trust: state.trust,
        safe: state.prefs.safe,
      }),
    });
    const data = await res.json();
    loader.hidden = true;
    if (!res.ok) { showError(data.error || `Search failed (${res.status})`); return; }
    state.lastResults = data.items || [];
    if (state.mode === 'local') state.lastLocalItems = state.lastResults;
    await decorateWithFamilySaves(state.lastResults);
    render(data);
  } catch (err) {
    loader.hidden = true;
    showError(err.message || 'Network error');
  }
}

async function decorateWithFamilySaves(items) {
  state.familySavedMap = {};
  if (!state.family || !items.length) return;
  try {
    const urls = items.map(i => i.url).filter(Boolean).slice(0, 50);
    const r = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'savedUrls', code: state.family.code, urls }),
    });
    if (r.ok) {
      const { saved } = await r.json();
      state.familySavedMap = saved || {};
    }
  } catch { /* non-fatal */ }
}

function showError(msg) {
  errorBox.hidden = false;
  if (msg && msg.toLowerCase().includes('serper_api_key')) {
    errorBox.innerHTML = `
      <strong>Serper API key not set.</strong>
      <p>Add <code>SERPER_API_KEY</code> in Vercel env vars. Free tier: 2,500 searches, no card required.</p>
      <a href="https://serper.dev" target="_blank" rel="noopener">Get a key →</a>`;
  } else if (msg && msg.toLowerCase().includes('kv not configured')) {
    errorBox.innerHTML = `<strong>Family storage not yet set up.</strong><p>Provision Vercel KV from the project dashboard — env vars will auto-populate.</p>`;
  } else {
    errorBox.textContent = msg;
  }
}

function render(data) {
  const items = data.items || [];
  filteredMeta.innerHTML = data.filtered
    ? `<strong>${data.filtered}</strong> noisy result${data.filtered === 1 ? '' : 's'} filtered`
    : '';
  if (!items.length) { empty.hidden = false; return; }

  if (state.mode === 'images' || state.mode === 'videos') {
    showList();
    renderGrid(items);
  } else if (state.mode === 'local' && mapView) {
    showMap();
  } else {
    showList();
    renderList(items, state.mode === 'local');
  }
}

// --- List rendering ---
function renderList(items, isLocal) {
  results.innerHTML = '';
  items.forEach((it, idx) => {
    const el = document.createElement('article');
    el.className = 'result';
    const host = (it.host || '').replace(/^www\./, '');
    const fav = it.favicon || (host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : '');
    const saved = state.familySavedMap[it.url];
    const phoneLinks = (isLocal && it.phone) ? phoneButtons(it.phone, it.title) : '';

    el.innerHTML = `
      ${isLocal ? `<label class="pick"><input type="checkbox" data-idx="${idx}" /><span></span></label>` : ''}
      <div class="result-body">
        <div class="dom">
          ${fav ? `<img class="fav" src="${esc(fav)}" alt="" onerror="this.style.display='none'"/>` : ''}
          <span>${esc(host || '')}</span>
          ${it.trusted ? '<span class="badge trusted">Trusted</span>' : ''}
          ${saved ? `<span class="badge family" title="Saved by ${esc(saved.by)} · ${esc(saved.collection || '')}">★ ${esc(saved.by)}</span>` : ''}
        </div>
        <h3><a href="${escAttr(it.url)}" target="_blank" rel="noopener">${esc(it.title || '')}</a></h3>
        <p>${esc(it.description || '')}</p>
        ${saved && saved.note ? `<div class="family-note">📌 ${esc(saved.note)}</div>` : ''}
        ${phoneLinks}
        <div class="actions">
          <button data-act="save" data-idx="${idx}">${saved ? 'Edit save' : 'Save to collection'}</button>
          <button data-act="block" data-host="${escAttr(host)}">Block ${esc(host)}</button>
        </div>
      </div>`;
    results.appendChild(el);
  });

  // Route result-title clicks into the in-app viewer instead of a new tab
  results.querySelectorAll('.result h3 a').forEach((a, i) => {
    a.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      const it = items[i];
      openInViewer(it.url, it.title, it);
    });
  });

  results.querySelectorAll('button[data-act="save"]').forEach(b =>
    b.addEventListener('click', () => openSaveModal(items[+b.dataset.idx])));
  results.querySelectorAll('button[data-act="block"]').forEach(b =>
    b.addEventListener('click', () => { addBlock(b.dataset.host); runSearch(); }));
  results.querySelectorAll('input[type="checkbox"][data-idx]').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = +cb.dataset.idx;
      if (cb.checked) state.selected.add(idx);
      else state.selected.delete(idx);
      renderActionBar();
    });
  });
}

function phoneButtons(phone, label) {
  const clean = phone.replace(/[^\d+]/g, '');
  const international = toInternational(clean);
  const isMobile = /^(\+?44)?7/.test(international.replace('+','')) || /^07/.test(clean);
  const links = [`<a class="call" href="tel:${escAttr(clean)}">☎ ${esc(phone)}</a>`];
  if (isMobile && international) {
    links.push(`<a class="wa" href="https://wa.me/${encodeURIComponent(international.replace('+',''))}?text=${encodeURIComponent('Hi, saw you on cleanweb — ')}" target="_blank" rel="noopener">WhatsApp</a>`);
  }
  return `<div class="phone-row">${links.join('')}</div>`;
}

function toInternational(num) {
  const digits = num.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07')) return '+44' + digits.slice(1);
  if (digits.startsWith('0')) return '+44' + digits.slice(1);
  return digits;
}

function renderGrid(items) {
  results.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  items.forEach((it, idx) => {
    const card = document.createElement('div');
    card.className = 'card';
    const thumb = it.thumbnail || it.image || '';
    const isImage = state.mode === 'images';
    const saved = state.familySavedMap[it.url];
    card.innerHTML = `
      <a class="card-link" href="${escAttr(it.url)}" target="_blank" rel="noopener">
        <div class="thumb ${isImage ? 'image' : ''}" style="background-image:url('${escAttr(thumb)}')">
          ${!isImage ? '<div class="play">▶</div>' : ''}
          ${saved ? `<div class="thumb-badge">★ ${esc(saved.by)}</div>` : ''}
        </div>
      </a>
      <div class="meta">
        <div class="t">${esc(it.title || '')}</div>
        <div class="d">${esc((it.host || '').replace(/^www\./, ''))}</div>
        <button class="mini" data-act="save" data-idx="${idx}">${saved ? 'Edit save' : 'Save'}</button>
      </div>`;
    grid.appendChild(card);
  });
  results.appendChild(grid);
  results.querySelectorAll('.card .card-link').forEach((a, i) => {
    a.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      const it = items[i];
      openInViewer(it.url, it.title, it);
    });
  });
  results.querySelectorAll('button[data-act="save"]').forEach(b =>
    b.addEventListener('click', () => openSaveModal(items[+b.dataset.idx])));
}

// --- Map view ---
function renderMap(items) {
  if (!map) {
    map = L.map(mapEl, { scrollWheelZoom: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);
  }
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];
  const withCoords = items.filter(i => i.lat && i.lng);
  if (!withCoords.length) {
    map.setView([54.5, -6.5], 7); // UK fallback
    return;
  }
  withCoords.forEach(it => {
    const saved = state.familySavedMap[it.url];
    const marker = L.marker([it.lat, it.lng]).addTo(map);
    marker.bindPopup(`
      <strong>${esc(it.title)}</strong><br/>
      ${it.address ? esc(it.address) + '<br/>' : ''}
      ${it.phone ? `☎ <a href="tel:${escAttr(it.phone)}">${esc(it.phone)}</a><br/>` : ''}
      ${it.rating ? `★ ${it.rating}<br/>` : ''}
      ${saved ? `<span style="color:#D4A44C">Saved by ${esc(saved.by)}</span><br/>` : ''}
      <a href="${escAttr(it.url)}" target="_blank" rel="noopener">Open</a>
    `);
    mapMarkers.push(marker);
  });
  const group = L.featureGroup(mapMarkers);
  map.fitBounds(group.getBounds().pad(0.15));
  setTimeout(() => map.invalidateSize(), 50);
}

// --- Action bar (local mode) ---
const actionBar = $('#actionBar');
function renderActionBar() {
  const n = state.selected.size;
  actionBar.hidden = n === 0;
  $('#abCount').textContent = `${n} selected`;
}
function clearSelection() {
  state.selected.clear();
  actionBar.hidden = true;
  $$('input[type="checkbox"][data-idx]').forEach(cb => cb.checked = false);
}
$('#abClear').addEventListener('click', clearSelection);
$('#abWhatsapp').addEventListener('click', () => {
  const picks = selectedItems();
  if (!picks.length) return;
  const withPhone = picks.filter(p => p.phone);
  if (!withPhone.length) { toast('None have phone numbers'); return; }
  // Open each in sequence via user confirmation — browsers block bulk popups.
  const first = withPhone[0];
  const intl = toInternational(first.phone).replace('+','');
  window.open(`https://wa.me/${encodeURIComponent(intl)}?text=${encodeURIComponent('Hi, saw you on cleanweb — ')}`, '_blank');
  if (withPhone.length > 1) toast(`Opened ${first.title}. Click each result's WhatsApp link for the rest.`);
});
$('#abEmail').addEventListener('click', () => {
  const picks = selectedItems();
  if (!picks.length) return;
  const subject = `Enquiry: ${state.query}`;
  const lines = picks.map(p => `${p.title}\n${p.address || ''}\n${p.phone || ''}\n${p.url}\n`);
  const body = `Hi,\n\nI'm getting quotes for "${state.query}". Could you let me know your availability and prices?\n\nShortlist I'm contacting:\n\n${lines.join('\n')}\n\nThanks`;
  const to = ''; // Serper places rarely include emails — leave blank, user adds.
  location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});
$('#abCsv').addEventListener('click', () => {
  const picks = selectedItems();
  if (!picks.length) return;
  const rows = [['Title','Address','Phone','Rating','Website']];
  picks.forEach(p => rows.push([p.title||'', p.address||'', p.phone||'', p.rating||'', p.url||'']));
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
  download(`cleanweb-${slug(state.query)}.csv`, csv, 'text/csv');
});
$('#abCopy').addEventListener('click', () => {
  const picks = selectedItems();
  if (!picks.length) return;
  const text = picks.map(p =>
    `${p.title}\n${p.address || ''}\n${p.phone || ''}\n${p.url}\n`
  ).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Contacts copied'));
});
$('#abSave').addEventListener('click', () => {
  const picks = selectedItems();
  if (!picks.length) return;
  openSaveModal(null, picks);
});
function selectedItems() {
  return [...state.selected].sort((a,b)=>a-b).map(i => state.lastLocalItems[i]).filter(Boolean);
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function download(name, data, type) {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// --- Escape helpers ---
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return esc(s); }
function slug(s) { return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }

// --- Drawer ---
const drawer = $('#drawer');
$('#settingsBtn').addEventListener('click', openDrawer);
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerScrim').addEventListener('click', closeDrawer);
$('#noFamilyOpenSettings')?.addEventListener('click', openDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeDrawer(); closeSaveModal(); closeAiSidebar();
  }
});
function openDrawer() {
  drawer.setAttribute('aria-hidden', 'false');
  renderChips();
  renderFamilyUI();
  renderAiSettings();
}
function closeDrawer() { drawer.setAttribute('aria-hidden', 'true'); }

function renderChips() {
  renderChipSet('#blockChips', state.block, '#blockCount', removeBlock);
  renderChipSet('#trustChips', state.trust, '#trustCount', removeTrust);
}
function renderChipSet(container, list, countEl, onRemove) {
  const c = $(container); c.innerHTML = '';
  list.forEach(d => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${esc(d)}<button aria-label="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => { onRemove(d); renderChips(); });
    c.appendChild(chip);
  });
  $(countEl).textContent = list.length;
}

function addBlock(d) { d = norm(d); if (!d || state.block.includes(d)) return; state.block.push(d); save(LS.block, state.block); }
function removeBlock(d) { state.block = state.block.filter(x => x !== d); save(LS.block, state.block); }
function addTrust(d) { d = norm(d); if (!d || state.trust.includes(d)) return; state.trust.push(d); save(LS.trust, state.trust); }
function removeTrust(d) { state.trust = state.trust.filter(x => x !== d); save(LS.trust, state.trust); }
function norm(d) { return String(d||'').trim().toLowerCase().replace(/^www\./, ''); }

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

$('#prefSafe').checked = state.prefs.safe;
$('#prefSafe').addEventListener('change', e => {
  state.prefs.safe = e.target.checked; save(LS.prefs, state.prefs);
});

$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Reset block/trust/preferences to defaults? Your family code is kept.')) return;
  state.block = [...DEFAULT_BLOCK];
  state.trust = [...DEFAULT_TRUST];
  state.prefs = { safe: true };
  save(LS.block, state.block); save(LS.trust, state.trust); save(LS.prefs, state.prefs);
  $('#prefSafe').checked = true;
  renderChips();
});

// --- Family ---
function renderFamilyUI() {
  if (state.family) {
    $('#familyIdle').hidden = true;
    $('#familyActive').hidden = false;
    $('#familyMeName').textContent = state.family.member;
    $('#familyCodeText').textContent = state.family.code;
    fetchFamilyInfo();
    renderHeroFamily();
  } else {
    $('#familyIdle').hidden = false;
    $('#familyActive').hidden = true;
    heroFamily.hidden = true;
  }
}

async function fetchFamilyInfo() {
  if (!state.family) return;
  try {
    const r = await fetch('/api/family', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'info', code: state.family.code }),
    });
    if (r.ok) {
      const info = await r.json();
      $('#familyMembers').textContent = (info.members || []).join(', ');
    }
  } catch {}
}

function renderHeroFamily() {
  if (!state.family) { heroFamily.hidden = true; return; }
  heroFamily.hidden = false;
  heroFamily.innerHTML = `Signed in as <strong>${esc(state.family.member)}</strong> · <code>${esc(state.family.code)}</code>`;
}

$('#familyCreateBtn').addEventListener('click', async () => {
  const name = $('#familyName').value.trim() || 'Me';
  try {
    const r = await fetch('/api/family', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', name }),
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || 'Could not create family'); return; }
    state.family = { code: data.code, member: data.member };
    save(LS.family, state.family);
    renderFamilyUI();
    toast(`Family created: ${data.code}`);
  } catch (e) { toast(e.message); }
});
$('#familyJoinBtn').addEventListener('click', async () => {
  const name = $('#familyName').value.trim() || 'Me';
  const code = $('#familyJoinCode').value.trim();
  if (!code) { toast('Enter a family code'); return; }
  try {
    const r = await fetch('/api/family', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'join', code, name }),
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || 'Could not join'); return; }
    state.family = { code: data.code, member: data.member };
    save(LS.family, state.family);
    renderFamilyUI();
    toast(`Joined family`);
  } catch (e) { toast(e.message); }
});
$('#familyCopyBtn').addEventListener('click', () => {
  if (!state.family) return;
  navigator.clipboard.writeText(state.family.code).then(() => toast('Code copied'));
});
$('#familyLeaveBtn').addEventListener('click', () => {
  if (!confirm('Leave family on this device? Family data is kept on the server — rejoin with the same code any time.')) return;
  state.family = null;
  localStorage.removeItem(LS.family);
  renderFamilyUI();
});

// --- Save modal ---
const saveModal = $('#saveModal');
let savingItem = null;
let savingBatch = null;
let savingRating = 0;

function openSaveModal(item, batch = null) {
  if (!state.family) {
    toast('Set up a family code first (Settings → Family)');
    openDrawer();
    return;
  }
  savingItem = item;
  savingBatch = batch;
  savingRating = 0;
  $('#saveStars').querySelectorAll('button').forEach(b => b.classList.remove('on'));
  if (batch) {
    $('#saveModalTitle').textContent = `Save ${batch.length} to collection`;
    $('#saveModalSub').textContent = batch.map(p => p.title).slice(0,3).join(', ') + (batch.length > 3 ? '…' : '');
  } else {
    const existing = state.familySavedMap[item.url];
    $('#saveModalTitle').textContent = existing ? 'Edit save' : 'Save to collection';
    $('#saveModalSub').textContent = item.title;
    if (existing) {
      $('#saveCollection').value = existing.collection || '';
      $('#saveNote').value = existing.note || '';
      savingRating = existing.rating || 0;
      updateStars();
    } else {
      $('#saveCollection').value = defaultCollectionFor(item);
      $('#saveNote').value = '';
    }
  }
  if (batch) {
    $('#saveCollection').value = defaultCollectionFor(batch[0]);
    $('#saveNote').value = '';
  }
  refreshCollectionSuggest();
  saveModal.hidden = false;
  setTimeout(() => $('#saveCollection').focus(), 10);
}
function closeSaveModal() { saveModal.hidden = true; savingItem = null; savingBatch = null; }
$('#saveCancel').addEventListener('click', closeSaveModal);

function defaultCollectionFor(item) {
  if (item && (item.phone || item.address)) return 'Local Trades';
  if (state.mode === 'images') return 'Images';
  if (state.mode === 'videos') return 'Videos';
  if (state.mode === 'news') return 'News';
  return 'Saved';
}

$('#saveStars').querySelectorAll('button').forEach(b => {
  b.addEventListener('click', () => { savingRating = +b.dataset.v; updateStars(); });
});
function updateStars() {
  $('#saveStars').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', +b.dataset.v <= savingRating);
  });
}

async function refreshCollectionSuggest() {
  if (!state.family) return;
  try {
    const r = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'listCollections', code: state.family.code }),
    });
    if (r.ok) {
      const { collections } = await r.json();
      state.collections = collections || [];
      $('#collectionSuggest').innerHTML = state.collections.map(c => `<option value="${escAttr(c.name)}">`).join('');
    }
  } catch {}
}

$('#saveConfirm').addEventListener('click', async () => {
  if (!state.family) return;
  const collection = $('#saveCollection').value.trim() || 'Saved';
  const note = $('#saveNote').value.trim();
  const items = savingBatch || (savingItem ? [savingItem] : []);
  if (!items.length) return;
  try {
    for (const item of items) {
      await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          code: state.family.code,
          member: state.family.member,
          collection, note, rating: savingRating,
          item: {
            url: item.url, title: item.title,
            description: item.description || '',
            host: item.host || '', thumbnail: item.thumbnail || '',
            phone: item.phone || '', address: item.address || '',
            lat: item.lat ?? null, lng: item.lng ?? null,
            kind: state.mode,
          },
        }),
      });
    }
    toast(`Saved ${items.length} to "${collection}"`);
    closeSaveModal();
    if (state.lastResults.length) {
      await decorateWithFamilySaves(state.lastResults);
      render({ items: state.lastResults, filtered: 0 });
    }
  } catch (e) { toast(e.message); }
});

// --- Collections view ---
async function renderCollectionsHome() {
  const list = $('#collectionsList');
  const collectionView = $('#collectionView');
  collectionView.hidden = true;
  list.innerHTML = '';
  if (!state.family) {
    $('#noFamilyBlock').hidden = false;
    return;
  }
  $('#noFamilyBlock').hidden = true;
  list.innerHTML = '<div class="loader"><div class="spinner"></div><span>loading…</span></div>';
  try {
    const r = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'listCollections', code: state.family.code }),
    });
    const { collections } = await r.json();
    state.collections = collections || [];
    if (!collections.length) {
      list.innerHTML = '<div class="empty"><p>No collections yet. Save a result and name a collection — it\'ll show up here.</p></div>';
      return;
    }
    list.innerHTML = '';
    collections.forEach(c => {
      const card = document.createElement('button');
      card.className = 'collection-card';
      card.innerHTML = `<div class="c-name">${esc(c.name)}</div><div class="c-count">${c.count} item${c.count===1?'':'s'}</div>`;
      card.addEventListener('click', () => openCollection(c.name));
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

async function openCollection(name) {
  $('#collectionsList').innerHTML = '';
  $('#collectionView').hidden = false;
  $('#collectionName').textContent = name;
  const box = $('#collectionItems');
  box.innerHTML = '<div class="loader"><div class="spinner"></div><span>loading…</span></div>';
  try {
    const r = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'listCollection', code: state.family.code, name }),
    });
    const { items } = await r.json();
    if (!items.length) { box.innerHTML = '<div class="empty"><p>No items yet.</p></div>'; return; }
    box.innerHTML = '';
    items.forEach(it => {
      const el = document.createElement('article');
      el.className = 'result';
      el.innerHTML = `
        <div class="result-body">
          <div class="dom">
            <span>${esc((it.host||'').replace(/^www\./,''))}</span>
            <span class="badge family">★ ${esc(it.savedBy)}</span>
            ${it.rating ? `<span class="badge rating">${'★'.repeat(+it.rating)}</span>` : ''}
          </div>
          <h3><a href="${escAttr(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
          <p>${esc(it.description || '')}</p>
          ${it.phone ? phoneButtons(it.phone, it.title) : ''}
          ${it.note ? `<div class="family-note">📌 ${esc(it.note)}</div>` : ''}
          <div class="actions">
            <button data-act="remove" data-id="${escAttr(it.id)}">Remove</button>
          </div>
        </div>`;
      box.appendChild(el);
    });
    box.querySelectorAll('button[data-act="remove"]').forEach(b =>
      b.addEventListener('click', () => removeSave(b.dataset.id, name))
    );
  } catch (e) {
    box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

async function removeSave(id, collectionName) {
  if (!confirm('Remove this save?')) return;
  try {
    await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', code: state.family.code, id }),
    });
    openCollection(collectionName);
  } catch (e) { toast(e.message); }
}

$('#collectionBack').addEventListener('click', () => renderCollectionsHome());

// --- In-app page viewer ---
const viewerWrap = $('#viewerWrap');
const viewerFrame = $('#viewerFrame');
const viewerReader = $('#viewerReader');
const viewerReaderInner = $('#viewerReaderInner');
const viewerLoading = $('#viewerLoading');
const viewerBlocked = $('#viewerBlocked');
const viewerTitle = $('#viewerTitle');
const viewerHost = $('#viewerHost');
const viewerFav = $('#viewerFav');
const viewerOpenExt = $('#viewerOpenExt');
const viewerModeSite = $('#viewerModeSite');
const viewerModeReader = $('#viewerModeReader');

let viewerBlockedTimer = null;
let currentFetchId = 0;

function openInViewer(url, title, item) {
  if (!url) return;
  const host = (item && item.host) || safeHost(url);
  const fav = (item && item.favicon) || (host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : '');
  state.openPage = { url, title: title || url, host, text: '', excerpt: '', html: '', byline: '', loading: true };

  viewerWrap.hidden = false;
  document.body.classList.add('with-viewer');
  viewerTitle.textContent = title || url;
  viewerHost.textContent = host || '';
  viewerFav.src = fav || '';
  viewerOpenExt.href = url;
  viewerBlocked.hidden = true;
  viewerLoading.hidden = false;

  // Load the page through our same-origin proxy so the iframe is readable.
  setViewerMode('site');
  viewerFrame.src = `/api/view?url=${encodeURIComponent(url)}`;
  clearTimeout(viewerBlockedTimer);
  viewerFrame.onload = () => { viewerLoading.hidden = true; };

  // Kick the reader-mode pipeline in parallel so toggling Reader is instant
  const fetchId = ++currentFetchId;
  fetch(`/api/fetch?url=${encodeURIComponent(url)}`)
    .then(r => r.json())
    .then(data => {
      if (fetchId !== currentFetchId) return;
      if (!state.openPage || state.openPage.url !== url) return;
      if (data.ok) {
        state.openPage.excerpt = data.excerpt || '';
        state.openPage.html = data.html || '';
        state.openPage.byline = data.byline || '';
        if (data.title && (!title || title === url)) {
          viewerTitle.textContent = data.title;
          state.openPage.title = data.title;
        }
        // If the live DOM bridge hasn't sent text yet, seed from Readability
        if (!state.openPage.text) state.openPage.text = data.text || '';
      }
      state.openPage.loading = false;
      renderReaderView();
    })
    .catch(() => {
      if (state.openPage) state.openPage.loading = false;
      renderReaderView();
    });

  updateAiPlaceholder();
}

// Listen for live-DOM snapshots posted by the injected bridge in /api/view
window.addEventListener('message', e => {
  const d = e.data;
  if (!d || !d.__cleanweb || d.type !== 'page') return;
  if (!state.openPage) return;
  state.openPage.text = d.text || state.openPage.text;
  if (d.title) {
    state.openPage.title = d.title;
    viewerTitle.textContent = d.title;
  }
  if (d.currentUrl && d.currentUrl !== state.openPage.url) {
    state.openPage.url = d.currentUrl;
    viewerOpenExt.href = d.currentUrl;
    const h = safeHost(d.currentUrl);
    state.openPage.host = h;
    viewerHost.textContent = h;
  }
});

function renderReaderView() {
  if (!state.openPage) { viewerReaderInner.innerHTML = ''; return; }
  const p = state.openPage;
  if (p.loading) {
    viewerReaderInner.innerHTML = '<p class="reader-byline">Fetching page text…</p>';
    return;
  }
  if (p.fetchError) {
    viewerReaderInner.innerHTML = `<p class="reader-byline">Couldn't fetch this page: ${esc(p.fetchError)}</p>`;
    return;
  }

  const header = `
    <h1>${esc(p.title)}</h1>
    <p class="reader-byline">
      ${p.byline ? esc(p.byline) + ' · ' : ''}${esc(p.host || '')} ·
      <a href="${escAttr(p.url)}" target="_blank" rel="noopener">view original</a>
    </p>`;

  if (p.html) {
    viewerReaderInner.innerHTML = header + p.html;
    viewerReaderInner.querySelectorAll('script').forEach(s => s.remove());
    const resolve = (attr) => (el) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      try { el.setAttribute(attr, new URL(v, p.url).href); } catch {}
    };
    viewerReaderInner.querySelectorAll('a[href]').forEach(a => {
      resolve('href')(a);
      a.addEventListener('click', e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        e.preventDefault();
        openInViewer(href, a.textContent.trim().slice(0, 120), { host: safeHost(href) });
      });
    });
    viewerReaderInner.querySelectorAll('img[src]').forEach(resolve('src'));
    viewerReaderInner.querySelectorAll('img[srcset]').forEach(img => {
      const parts = img.getAttribute('srcset').split(',').map(s => {
        const m = s.trim().split(/\s+/);
        try { m[0] = new URL(m[0], p.url).href; } catch {}
        return m.join(' ');
      });
      img.setAttribute('srcset', parts.join(', '));
    });
    return;
  }

  const paras = (p.text || '').split(/\n{2,}/).filter(s => s.trim());
  const body = paras.map(s => `<p>${esc(s).replace(/\n/g, '<br/>')}</p>`).join('');
  viewerReaderInner.innerHTML = header + (body || '<p class="reader-byline">No readable text found.</p>');
}

function setViewerMode(mode) {
  state.viewerMode = mode;
  viewerModeSite.classList.toggle('active', mode === 'site');
  viewerModeReader.classList.toggle('active', mode === 'reader');
  viewerFrame.hidden = mode !== 'site';
  viewerReader.hidden = mode !== 'reader';
  if (mode === 'reader') renderReaderView();
}

function closeViewer() {
  viewerWrap.hidden = true;
  viewerFrame.src = 'about:blank';
  document.body.classList.remove('with-viewer');
  state.openPage = null;
  viewerLoading.hidden = true;
  viewerBlocked.hidden = true;
  clearTimeout(viewerBlockedTimer);
  updateAiPlaceholder();
}

function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function updateAiPlaceholder() {
  const input = $('#aiText');
  if (!input) return;
  input.placeholder = state.openPage ? 'Ask about this page…' : 'Ask about these results…';
}

$('#viewerClose').addEventListener('click', closeViewer);
viewerModeSite.addEventListener('click', () => setViewerMode('site'));
viewerModeReader.addEventListener('click', () => setViewerMode('reader'));

// --- AI sidebar (LM Studio) ---
const aiSidebar = $('#aiSidebar');
const aiBody = $('#aiBody');
const aiStatus = $('#aiStatus');

$('#aiToggleBtn').addEventListener('click', () => {
  if (aiSidebar.getAttribute('aria-hidden') === 'false') closeAiSidebar();
  else openAiSidebar();
});
$('#aiClose').addEventListener('click', closeAiSidebar);

function openAiSidebar() {
  aiSidebar.setAttribute('aria-hidden', 'false');
  document.body.classList.add('with-ai');
  if (state.ai.enabled) testAi();
  else {
    aiStatus.textContent = 'disabled';
    aiBody.innerHTML = '<div class="ai-empty">Enable AI sidebar in Settings first.</div>';
  }
}
function closeAiSidebar() {
  aiSidebar.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('with-ai');
}

function renderAiSettings() {
  $('#aiEnabled').checked = !!state.ai.enabled;
  $('#aiUrl').value = state.ai.url || 'http://localhost:1234/v1';
  $('#aiModel').value = state.ai.model || '';
}
$('#aiEnabled').addEventListener('change', e => { state.ai.enabled = e.target.checked; save(LS.ai, state.ai); });
$('#aiUrl').addEventListener('change', e => { state.ai.url = e.target.value.trim(); save(LS.ai, state.ai); });
$('#aiModel').addEventListener('change', e => { state.ai.model = e.target.value.trim(); save(LS.ai, state.ai); });

$('#aiTestBtn').addEventListener('click', async () => {
  const el = $('#aiTestResult');
  el.textContent = 'testing…';
  try {
    const r = await fetch(`${state.ai.url.replace(/\/$/,'')}/models`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const count = (data.data || []).length;
    el.textContent = `✓ Connected · ${count} model${count===1?'':'s'} loaded`;
    el.style.color = '#6ECB8A';
  } catch (e) {
    el.textContent = `✗ ${e.message} (is LM Studio running + CORS on?)`;
    el.style.color = '#E55A5A';
  }
});

async function testAi() {
  aiStatus.textContent = 'checking…';
  try {
    const r = await fetch(`${state.ai.url.replace(/\/$/,'')}/models`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    aiStatus.textContent = 'connected';
    aiStatus.style.color = '#6ECB8A';
  } catch {
    aiStatus.textContent = 'offline';
    aiStatus.style.color = '#E55A5A';
  }
}

$$('button[data-preset]').forEach(b => {
  b.addEventListener('click', () => {
    const preset = b.dataset.preset;
    let q = '';
    if (preset === 'summarise') q = 'Give me a 3-bullet summary of the top results and which are worth clicking.';
    if (preset === 'compare') q = 'Compare the top 3 results side-by-side — strengths, weaknesses, who should pick which.';
    if (preset === 'recommend') q = 'Which result would you pick and why? Be direct.';
    $('#aiText').value = q;
    aiSubmit();
  });
});
$('#aiForm').addEventListener('submit', e => { e.preventDefault(); aiSubmit(); });

async function aiSubmit() {
  if (!state.ai.enabled) { toast('Enable AI sidebar in Settings'); return; }
  const q = $('#aiText').value.trim();
  if (!q) return;
  $('#aiText').value = '';

  const { userPrompt, systemPrompt } = buildAiPrompt(q);
  appendAiMessage('user', q);
  const assistantEl = appendAiMessage('assistant', '…');

  try {
    const r = await fetch(`${state.ai.url.replace(/\/$/,'')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.ai.model || 'local-model',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        stream: false,
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '(no response)';
    assistantEl.textContent = text;
  } catch (e) {
    assistantEl.textContent = `Error: ${e.message}`;
    assistantEl.style.color = '#E55A5A';
  }
}

function buildAiPrompt(question) {
  const p = state.openPage;
  if (p && (p.text || p.excerpt)) {
    const pageText = (p.text || p.excerpt || '').slice(0, 12000);
    return {
      systemPrompt: 'You are a succinct assistant inside cleanweb, a private research browser. Answer questions about the page the user is currently viewing. Be direct and terse. Quote relevant lines when useful. If the page text is incomplete or missing, say so.',
      userPrompt: `Currently viewing: ${p.title}\nURL: ${p.url}\n\nPage content:\n"""\n${pageText}\n"""\n\nQuestion: ${question}`,
    };
  }
  if (p && p.loading) {
    return {
      systemPrompt: 'You are a succinct assistant inside cleanweb.',
      userPrompt: `The user is opening ${p.url} but the page text hasn't finished loading yet. Ask them to wait a second or answer from the title/URL if you can.\n\nQuestion: ${question}`,
    };
  }
  const items = state.lastResults.slice(0, 10);
  const context = items.map((it, i) =>
    `${i+1}. ${it.title}\n   ${it.host || ''} ${it.phone ? '· ' + it.phone : ''}${it.rating ? ' · ★' + it.rating : ''}\n   ${it.description || ''}`
  ).join('\n\n');
  return {
    systemPrompt: 'You are a succinct assistant inside cleanweb, a private search app. Be direct and terse. Use the provided search results to answer.',
    userPrompt: `Search query: "${state.query}"\nMode: ${state.mode}\n\nResults:\n${context}\n\nQuestion: ${question}`,
  };
}

function appendAiMessage(role, text) {
  if (aiBody.querySelector('.ai-empty')) aiBody.innerHTML = '';
  const el = document.createElement('div');
  el.className = `ai-msg ai-${role}`;
  el.textContent = text;
  aiBody.appendChild(el);
  aiBody.scrollTop = aiBody.scrollHeight;
  return el;
}

// --- Toast ---
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 3200);
}

// --- URL state restore ---
(function initFromUrl() {
  renderHeroFamily();
  const params = new URLSearchParams(location.search);
  const q = params.get('q'), m = params.get('mode'), v = params.get('view');
  if (v === 'collections') { switchToCollections(); return; }
  if (m) setMode(m);
  if (q) { $('#searchInput').value = q; state.query = q; runSearch(); }
})();

// =============================================================
// Launcher tiles — surface the product's real capabilities
// from the home page. Each tile maps to one of the existing
// engine endpoints (watches / skills / drive mode).
// =============================================================

const ENGINE_LS_KEY = 'cleanweb.drive';
function getEngineUrl() {
  try {
    const raw = localStorage.getItem(ENGINE_LS_KEY);
    if (!raw) return 'https://cleanweb-engine.aiprofits.cc';
    const cfg = JSON.parse(raw);
    return (cfg.engineUrl || 'https://cleanweb-engine.aiprofits.cc').replace(/\/$/, '');
  } catch { return 'https://cleanweb-engine.aiprofits.cc'; }
}
async function engineFetch(path, opts = {}) {
  return fetch(getEngineUrl() + path, { ...opts, credentials: 'include' });
}

// Tile dispatch
document.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile[data-action]');
  if (!tile) return;
  const action = tile.dataset.action;
  switch (action) {
    case 'search':
      $('#searchInput').focus();
      $('#searchInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    case 'watch-price':       openWatchPreset('price'); break;
    case 'watch-stock':       openWatchPreset('stock'); break;
    case 'watch-social':
    case 'watch-page':        openWatchPreset('change'); break;
    case 'watch-events':      openEventsSkill(); break;
    case 'watches-list':      openWatchesList(); break;
    case 'drive':             openDriveMode(); break;
    case 'collections':       switchToCollections(); break;
  }
});

// =============================================================
// Watch-preset modal — pre-fills the watch form for one of
// three common intents, then POSTs to the engine's /api/watches.
// =============================================================

const WATCH_PRESETS = {
  price: {
    title: 'Watch a price drop',
    explain: "Paste the product page URL. Optionally narrow it to the price element (e.g. .product-price). We'll re-check on your chosen schedule and ping you when it falls below your target.",
    namePh: 'e.g. Sonos Era 100 deal',
    selectorPh: 'e.g. .product-price (leave blank to scan the whole page)',
    valueLabel: 'Target price (£)',
    valuePh: 'e.g. 250',
    valueType: 'number',
    showValue: true,
    showSelector: true,
    condition: 'price-below'
  },
  stock: {
    title: 'Back in stock alert',
    explain: "Paste the product URL. We watch the page and ping you the moment the words “Out of stock” disappear. Change the wording below if the site uses different language.",
    namePh: 'e.g. PS5 stock at Currys',
    selectorPh: 'e.g. .availability (leave blank to scan the whole page)',
    valueLabel: 'Phrase that means "unavailable"',
    valuePh: 'Out of stock',
    valueType: 'text',
    valueDefault: 'Out of stock',
    showValue: true,
    showSelector: true,
    condition: 'text-not-contains'
  },
  change: {
    title: 'Watch a page for changes',
    explain: "Paste any page URL — a social feed, a blog index, a board, a council page. We re-check on your schedule and ping you the moment something on the page is different from last time.",
    namePh: 'e.g. Council planning page',
    selectorPh: 'e.g. main (leave blank to watch the whole page)',
    showValue: false,
    showSelector: true,
    condition: 'change'
  }
};

let activePreset = null;
function openWatchPreset(kind) {
  const preset = WATCH_PRESETS[kind];
  if (!preset) return;
  activePreset = preset;
  $('#wpTitle').textContent = preset.title;
  $('#wpExplain').textContent = preset.explain;
  $('#wpName').value = '';
  $('#wpName').placeholder = preset.namePh;
  $('#wpUrl').value = '';
  $('#wpSelector').value = '';
  $('#wpSelector').placeholder = preset.selectorPh;
  $('#wpSelectorWrap').hidden = !preset.showSelector;
  if (preset.showValue) {
    $('#wpValueWrap').hidden = false;
    $('#wpValueLabel').textContent = preset.valueLabel;
    $('#wpValue').placeholder = preset.valuePh || '';
    $('#wpValue').type = preset.valueType || 'text';
    $('#wpValue').value = preset.valueDefault || '';
  } else {
    $('#wpValueWrap').hidden = true;
  }
  $('#wpSchedule').value = kind === 'price' ? '6h' : '1h';
  $('#wpNotify').value = 'todo';
  $('#watchPresetModal').hidden = false;
  setTimeout(() => $('#wpUrl').focus(), 50);
}

function closeWatchPreset() {
  $('#watchPresetModal').hidden = true;
  activePreset = null;
}

$('#wpCancel').addEventListener('click', closeWatchPreset);
$('#watchPresetModal').addEventListener('click', e => {
  if (e.target === $('#watchPresetModal')) closeWatchPreset();
});

$('#wpCreate').addEventListener('click', async () => {
  if (!activePreset) return;
  const url = $('#wpUrl').value.trim();
  if (!url) { toast('Paste a URL first'); $('#wpUrl').focus(); return; }
  const name = $('#wpName').value.trim() || activePreset.namePh.replace(/^e\.g\.\s*/, '');
  const selector = $('#wpSelector').value.trim() || null;
  const condition = { type: activePreset.condition };
  if (activePreset.showValue) condition.value = $('#wpValue').value.trim();
  const body = {
    name, url, selector,
    schedule: $('#wpSchedule').value,
    condition,
    notify: [$('#wpNotify').value]
  };
  const btn = $('#wpCreate');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const r = await engineFetch('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.ok || r.ok) {
      closeWatchPreset();
      toast('Watch created. You can manage it from My watches.');
    } else if (r.status === 401) {
      toast('Drive Mode locked — open Drive and enter the PIN, then try again.');
      openDriveMode();
    } else {
      toast('Could not create watch: ' + (j.error || r.status));
    }
  } catch (e) {
    toast('Could not reach engine: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create watch';
  }
});

// =============================================================
// Cross-into-drive helpers — open Drive Mode, jump to Watches
// list, jump to Skills (events). Implemented as thin wrappers
// that click the buttons drive.js already wired up.
// =============================================================

function openDriveMode() {
  const btn = document.getElementById('driveToggleBtn');
  if (btn) { btn.click(); return; }
  // drive.js hasn't injected yet — wait a tick
  setTimeout(openDriveMode, 100);
}
function openWatchesList() {
  openDriveMode();
  setTimeout(() => {
    const w = document.getElementById('drvWatches');
    if (w) w.click();
  }, 220);
}
function openEventsSkill() {
  openDriveMode();
  setTimeout(() => {
    const s = document.getElementById('drvSkills');
    if (s) s.click();
  }, 220);
}

// =============================================================
// First-visit onboarding card — shown until dismissed.
// =============================================================

const ONBOARD_KEY = 'cleanweb.onboarded';
(function showOnboardingIfNew() {
  let onboarded = false;
  try { onboarded = localStorage.getItem(ONBOARD_KEY) === '1'; } catch {}
  if (!onboarded) {
    const wrap = $('#onboardWrap');
    if (wrap) wrap.hidden = false;
  }
})();
$('#onboardDismiss')?.addEventListener('click', () => {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch {}
  $('#onboardWrap').hidden = true;
});
$('#onboardLater')?.addEventListener('click', () => {
  $('#onboardWrap').hidden = true;
});
