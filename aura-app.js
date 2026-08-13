/* ============================================================
   Aura — app wiring
   Binds the markup to core + DSP. Page-specific glue only.
   ============================================================ */
'use strict';

/* ---------- boot ---------- */
initPopovers();
startClock(false);
Presence.start();
Player.init();
Ambient.init();
Dust.init();

$('g-retry').onclick = () => Auth.recheck();
$('g-out').onclick = () => Auth.signOut();
$('acct-out').onclick = () => Auth.signOut();
Auth.resume();

async function onSignedIn() {
  AURA.localArt = lsGet(AURA.K.localArt, {});
  $('btn-me').style.display = 'flex';
  $('me-img').src = AURA.me.picture || '';

  DSP.load();
  buildBands();
  syncSpatial(); syncGain(); renderPresets();
  DSP.bg = lsGet(AURA.K.bg, false);
  paintToggles();

  await DB.loadIndex();
  updateCacheLine();

  fitCanvas($('eq-cv')); fitCanvas($('viz-cv'));
  DSP.drawCurve();
  vizLoop();
  probeCapabilities();

  try {
    if (!await loadLibrary()) return;
    buildTabs();
    loadFolder('all');
    renderQueue();
    updateSync();
    hydrateMeta(() => { renderQueue(); updateSpecs(); });
    maybeInfo();
    updateSpecs();
    refreshBadge();
  } catch (e) {
    $('lib').innerHTML = `<div class="empty" style="color:#f87171">Could not load library.<br>${esc(e.message)}</div>`;
  }
}

/* ============================================================
   SIDEBAR + QUEUE
   ============================================================ */
const openSb = () => { $('sb').classList.add('on'); $('sb-back').classList.add('on'); };
const closeSb = () => { $('sb').classList.remove('on'); $('sb-back').classList.remove('on'); };
$('btn-lib').onclick = openSb;
$('sb-close').onclick = closeSb;
$('sb-back').onclick = closeSb;

function buildTabs() {
  const folders = new Set();
  AURA.tracks.forEach(t => { if (t.folder) folders.add(t.folder); });
  const host = $('tabs');
  host.innerHTML = '';
  const mk = (key, label, icon) => {
    const el = document.createElement('div');
    el.className = 'tab' + (key === AURA.folder ? ' on' : '');
    el.innerHTML = `<i class="fa-solid ${icon}"></i> ${esc(label)}`;
    el.onclick = () => {
      [...host.children].forEach(c => c.classList.remove('on'));
      el.classList.add('on');
      loadFolder(key); renderQueue();
    };
    host.appendChild(el);
  };
  mk('all', 'All Tracks', 'fa-music');
  folders.forEach(f => mk(f, f, 'fa-folder'));
}

function renderQueue() {
  const lib = $('lib');
  if (!AURA.queue.length) { lib.innerHTML = '<div class="empty">No tracks here.</div>'; return; }
  lib.innerHTML = '';
  AURA.queue.forEach((t, i) => {
    const d = display(t), m = AURA.meta.get(t.id) || {};
    const row = document.createElement('div');
    row.className = 'tr' + (t.id === AURA.currentId ? ' on' : '') +
      (DB.has(t.id) ? ' cached' : '') + (Player.pfId === t.id ? ' pf' : '');
    row.dataset.id = t.id;
    const sub = [fmtBytes(t.sizeBytes), m.duration ? fmtTime(m.duration) : null]
      .filter(Boolean).join(' · ');
    row.innerHTML =
      `<div class="grip"><i class="fa-solid fa-grip-vertical"></i></div>` +
      `<span class="pos">${i+1}</span>` +
      (d.cover ? `<img src="${esc(d.cover)}" alt="">`
               : `<div class="noart"><i class="fa-solid fa-compact-disc"></i></div>`) +
      `<div class="b"><b>${esc(d.title)}</b><span>${esc(d.artist)}</span><em>${esc(sub)}</em></div>` +
      `<div class="a">` +
        `<span class="cch"><i class="fa-solid fa-circle-check"></i></span>` +
        `<button class="rb b-art" title="Fix artwork"><i class="fa-solid fa-pen"></i></button>` +
        `<button class="rb b-nx" title="Play next"><i class="fa-solid fa-arrow-turn-down"></i></button>` +
        `<span class="pd"></span>` +
      `</div>`;
    row.querySelector('.b').onclick = () => { Player.play(t.id); if (AURA.isTouch) closeSb(); };
    row.querySelector('.b-nx').onclick = e => { e.stopPropagation(); playNext(t.id); };
    row.querySelector('.b-art').onclick = e => { e.stopPropagation(); openArt(t.id); };
    attachDrag(row.querySelector('.grip'), row);
    lib.appendChild(row);
  });
}

function playNext(id) {
  const from = AURA.queue.findIndex(t => t.id === id);
  if (from === -1) return;
  const cur = Player.idx();
  let to = cur === -1 ? 0 : cur + 1;
  if (from === to) return;
  const [item] = AURA.queue.splice(from, 1);
  if (from < to) to--;
  AURA.queue.splice(to, 0, item);
  saveOrder(); renderQueue();
  Player.cancelPrefetch(); Player.prefetchNext();
}

/* drag reorder — pointer events, so touch works */
let drag = null;
function attachDrag(handle, row) {
  handle.addEventListener('pointerdown', e => {
    if (drag) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const ph = document.createElement('div');
    ph.className = 'ph'; ph.style.height = r.height + 'px';
    drag = { row, ph, pid: e.pointerId, dy: e.clientY - r.top };
    row.after(ph);
    row.classList.add('float');
    row.style.width = r.width + 'px';
    row.style.left = r.left + 'px';
    row.style.top = (e.clientY - drag.dy) + 'px';
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener('pointermove', dragMove);
    handle.addEventListener('pointerup', dragEnd);
    handle.addEventListener('pointercancel', dragEnd);
  });
}
function dragMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  e.preventDefault();
  const { row, ph, dy } = drag;
  row.style.top = (e.clientY - dy) + 'px';
  const lib = $('lib'), lr = lib.getBoundingClientRect();
  if (e.clientY < lr.top + 44) lib.scrollTop -= 8;
  else if (e.clientY > lr.bottom - 44) lib.scrollTop += 8;
  const mid = e.clientY - dy + row.getBoundingClientRect().height/2;
  let before = null;
  for (const o of lib.querySelectorAll('.tr:not(.float)')) {
    const r = o.getBoundingClientRect();
    if (mid < r.top + r.height/2) { before = o; break; }
  }
  before ? lib.insertBefore(ph, before) : lib.appendChild(ph);
}
function dragEnd(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const { row, ph } = drag;
  const h = row.querySelector('.grip');
  h.removeEventListener('pointermove', dragMove);
  h.removeEventListener('pointerup', dragEnd);
  h.removeEventListener('pointercancel', dragEnd);
  ph.replaceWith(row);
  row.classList.remove('float');
  row.style.width = row.style.left = row.style.top = '';
  drag = null;
  const ids = [...$('lib').querySelectorAll('.tr')].map(r => r.dataset.id);
  const byId = new Map(AURA.queue.map(t => [t.id, t]));
  AURA.queue = ids.map(id => byId.get(id)).filter(Boolean);
  saveOrder(); renderQueue();
  Player.cancelPrefetch(); Player.prefetchNext();
}

/* ============================================================
   CACHE + SYNC PANEL
   ============================================================ */
async function updateCacheLine() {
  const q = await DB.quota();
  let txt = DB.count ? `Cache: ${DB.count} track${DB.count===1?'':'s'} · ${fmtBytes(DB.totalBytes)}` : 'Cache: empty';
  if (q && q.quota) txt += ` of ${fmtBytes(q.quota)}`;
  $('cache-txt').textContent = txt;
  $('btn-purge').disabled = DB.count === 0;
}
$('btn-purge').onclick = async () => {
  if (!DB.count) return;
  if (!confirm(`Remove all ${DB.count} cached track${DB.count===1?'':'s'} (${fmtBytes(DB.totalBytes)})?\n\nThey'll download again from Drive next time you play them.`)) return;
  await DB.purge();
  updateCacheLine(); renderQueue();
  toast('Cache cleared', 'ok');
};

function updateSync() {
  $('sync-when').textContent = 'Last synced ' + fmtWhen(AURA.lastSync) +
    (AURA.tracks.length ? ` · ${AURA.tracks.length} tracks` : '');
  $('btn-sync').disabled = !(AURA.me && AURA.me.admin);
  $('sync-lbl').textContent = (AURA.me && AURA.me.admin) ? 'Sync library' : 'Sync (admin only)';
}
$('btn-sync').onclick = async () => {
  $('btn-sync').disabled = true;
  $('sync-lbl').textContent = 'Syncing…';
  try {
    const d = await api({ sync: 1 });
    if (d.ok) {
      AURA.tracks = d.tracks || AURA.tracks;
      AURA.lastSync = d.lastSync;
      buildTabs(); loadFolder(AURA.folder); renderQueue();
      hydrateMeta(() => renderQueue());
      toast(`Synced — ${d.count} tracks`, 'ok');
    } else toast(d.error || 'Sync failed', 'err');
  } catch (e) { toast('Sync failed: ' + e.message, 'err'); }
  $('sync-lbl').textContent = 'Sync library';
  updateSync();
};

/* ============================================================
   INFO SHEET
   ============================================================ */
function maybeInfo() {
  if (lsGet(AURA.K.info, null) === 1) return;
  $('ov-info').classList.add('on');
  prefetchFirst();
}
async function prefetchFirst() {
  if (!AURA.queue.length) return;
  const t = AURA.queue[0];
  const done = () => {
    $('info-pf-t').textContent = 'First track ready — press play when you are.';
    $('info-pf').querySelector('i').className = 'fa-solid fa-circle-check';
  };
  if (DB.has(t.id)) { done(); return; }
  Player.pfCtl = new AbortController();
  Player.pfId = t.id; renderQueue();
  try {
    const blob = await downloadTrack(t, (g, tot) => {
      $('info-pf-t').textContent = `Getting the first track ready… ${tot ? Math.round(g/tot*100) : 0}%`;
    }, Player.pfCtl.signal);
    await DB.put(t.id, blob);
    await readMeta(t);
    updateCacheLine(); done();
  } catch (e) {
    if (e.name !== 'AbortError') $('info-pf-t').textContent = 'Could not preload — press play to try again.';
  } finally { Player.pfCtl = null; Player.pfId = null; renderQueue(); }
}
$('btn-info').onclick = () => { $('info-pf').style.display = 'none'; $('ov-info').classList.add('on'); };
$('info-ok').onclick = () => {
  if ($('info-hide').checked) lsSet(AURA.K.info, 1);
  $('ov-info').classList.remove('on');
};
$('ov-info').onclick = e => { if (e.target === $('ov-info')) $('ov-info').classList.remove('on'); };

/* ============================================================
   ART PICKER
   ============================================================ */
let artId = null, artPick = null;

function openArt(id) {
  const t = AURA.queue.find(x => x.id === id);
  if (!t) return;
  artId = id; artPick = null;
  const d = display(t);
  $('art-img').src = d.cover || '';
  $('art-t').textContent = d.title;
  $('art-a').textContent = d.artist;
  $('art-al').textContent = d.album || '';
  const src = $('art-src');
  src.className = d.source;
  src.textContent = ({
    embedded: 'Using the artwork embedded in the file',
    override: 'Using a saved override',
    local: 'Using your own pick — not yet approved',
    none: 'This file has no embedded artwork'
  })[d.source];
  $('art-role').textContent = AURA.me.admin
    ? 'Your change applies for everyone straight away.'
    : 'Your pick shows for you immediately, and goes for approval before others see it.';
  $('art-save').disabled = true;
  $('art-warn').style.display = 'none';
  $('art-grid').innerHTML = '';
  $('art-msg').style.display = 'block';
  $('art-msg').textContent = 'Searching iTunes and Deezer…';
  $('ov-art').classList.add('on');
  searchArt(t, d);
}

function simScore(gotT, gotA, wantT, wantA) {
  const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
  const sim = (a,b) => {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aw = new Set(a.split(' ')), bw = b.split(' ');
    let hit = 0; bw.forEach(w => { if (aw.has(w)) hit++; });
    return hit / Math.max(aw.size, bw.length);
  };
  return sim(gotT, wantT)*0.65 + sim(gotA, wantA)*0.35;
}

async function searchArt(track, d) {
  const m = AURA.meta.get(track.id) || {};
  const artist = m.artist || d.artist || '';
  const title = m.title || d.title || '';
  const term = [artist, title].filter(Boolean).join(' ').trim();
  const out = [];

  try {
    const r = await fetch('https://itunes.apple.com/search?country=IN&media=music&limit=10&term=' + encodeURIComponent(term));
    const j = await r.json();
    (j.results||[]).forEach(x => {
      if (!x.artworkUrl100) return;
      out.push({ src:'itunes', cover:x.artworkUrl100.replace('100x100bb','1000x1000bb'),
        title:x.trackName, artist:x.artistName, album:x.collectionName,
        score: simScore(x.trackName, x.artistName, title, artist) });
    });
  } catch (e) { console.warn('[Aura] iTunes failed:', e.message); }

  try {
    const r = await fetch('https://api.deezer.com/search?limit=10&q=' + encodeURIComponent(term));
    const j = await r.json();
    (j.data||[]).forEach(x => {
      const cov = x.album && (x.album.cover_xl || x.album.cover_big);
      if (!cov) return;
      out.push({ src:'deezer', cover:cov, title:x.title,
        artist:x.artist && x.artist.name, album:x.album && x.album.title,
        score: simScore(x.title, x.artist && x.artist.name, title, artist) });
    });
  } catch (e) { console.warn('[Aura] Deezer failed:', e.message); }

  const seen = new Set();
  const uniq = out.sort((a,b) => b.score - a.score).filter(x => {
    const k = ((x.album||'') + '|' + (x.artist||'')).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  $('art-msg').style.display = 'none';
  const grid = $('art-grid');
  if (!uniq.length) {
    $('art-msg').style.display = 'block';
    $('art-msg').innerHTML = `No matches for <b>${esc(term)}</b>.<br><br>` +
      `Neither catalogue has this track. Tagging the file with a cover in something like MusicBrainz Picard is the only fix for this one.`;
    return;
  }
  if (uniq[0].score < 0.4) {
    $('art-warn').style.display = 'block';
    $('art-warn').textContent = 'None of these look like a close match — check the artist and album before saving, or a wrong cover ends up stored.';
  }

  grid.innerHTML = '';
  uniq.slice(0,12).forEach(c => {
    const el = document.createElement('div');
    el.className = 'cand';
    el.innerHTML = `<span class="s">${c.src}</span><img src="${esc(c.cover)}" alt="" loading="lazy">` +
      `<div class="c">${esc(c.album||c.title||'')}<br><span style="color:var(--tx3)">${esc(c.artist||'')}</span></div>`;
    el.onclick = () => {
      grid.querySelectorAll('.cand').forEach(x => x.classList.remove('on'));
      el.classList.add('on'); artPick = c; $('art-save').disabled = false;
    };
    grid.appendChild(el);
  });
}

$('art-cancel').onclick = () => $('ov-art').classList.remove('on');
$('ov-art').onclick = e => { if (e.target === $('ov-art')) $('ov-art').classList.remove('on'); };

$('art-revert').onclick = async () => {
  if (!artId) return;
  delete AURA.localArt[artId];
  lsSet(AURA.K.localArt, AURA.localArt);
  if (AURA.me.admin && AURA.overrides[artId]) {
    try {
      const b = b64url({ id: artId, clear: true });
      const d = await api({ save: b });
      if (d.ok) { AURA.overrides = d.overrides || {}; toast('Override removed', 'ok'); }
      else toast(d.error || 'Could not remove', 'err');
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  } else toast('Using embedded artwork', 'ok');
  renderQueue(); Player.refreshNP();
  $('ov-art').classList.remove('on');
};

function b64url(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

$('art-save').onclick = async () => {
  if (!artId || !artPick) return;
  const btn = $('art-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  const t = AURA.queue.find(x => x.id === artId);

  // Apply for this visitor immediately — nobody should be stuck
  // looking at art they've just said is wrong.
  AURA.localArt[artId] = { cover: artPick.cover, album: artPick.album || null };
  lsSet(AURA.K.localArt, AURA.localArt);
  renderQueue(); Player.refreshNP();

  try {
    const d = await api({ save: b64url({
      id: artId, cover: artPick.cover, album: artPick.album || null,
      trackTitle: display(t).title
    }) });
    if (!d.ok) toast(d.error || 'Save failed', 'err');
    else if (d.applied === 'global') {
      AURA.overrides = d.overrides || {};
      delete AURA.localArt[artId];
      lsSet(AURA.K.localArt, AURA.localArt);
      toast('Artwork updated for everyone', 'ok');
    } else toast('Sent for approval — you can see it now', 'ok');
  } catch (e) { toast('Saved for you only: ' + e.message, 'err'); }

  btn.textContent = 'Save';
  renderQueue(); Player.refreshNP(); refreshBadge();
  $('ov-art').classList.remove('on');
};

/* ============================================================
   ACCOUNT / APPROVALS
   ============================================================ */
$('btn-me').onclick = () => {
  $('acct-t').textContent = AURA.me.approver ? 'Approvals' : 'Account';
  $('acct-sub').innerHTML = `Signed in as <b>${esc(AURA.me.name)}</b> — ${esc(AURA.me.email)}` +
    (AURA.me.admin ? (AURA.me.approver ? ' · admin &amp; approver' : ' · admin') : '');
  $('ov-acct').classList.add('on');
  if (AURA.me.approver) { $('acct-seg').style.display = 'flex'; loadUsers(); loadSuggestions(); }
  else {
    $('acct-seg').style.display = 'none';
    $('pane-users').innerHTML = '<div class="empty">Nothing to manage here.<br>You can still fix artwork from the pencil beside any track.</div>';
  }
};
$('acct-close').onclick = () => $('ov-acct').classList.remove('on');
$('ov-acct').onclick = e => { if (e.target === $('ov-acct')) $('ov-acct').classList.remove('on'); };
document.querySelectorAll('#acct-seg button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#acct-seg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('pane-users').classList.toggle('on', b.dataset.p === 'users');
    $('pane-art').classList.toggle('on', b.dataset.p === 'art');
  };
});

async function loadUsers() {
  const p = $('pane-users');
  p.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api({ users: 1 });
    if (!d.ok) { p.innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
    if (!d.users.length) { p.innerHTML = '<div class="empty">Nobody has signed in yet.</div>'; return; }
    p.innerHTML = '';
    d.users.forEach(u => {
      const row = document.createElement('div');
      row.className = 'urow';
      const acts = u.admin ? '<span class="pill approved">admin</span>'
        : u.status === 'pending'
          ? '<button class="tiny ok" data-a="1">Approve</button><button class="tiny no" data-a="0">Block</button>'
          : u.status === 'approved'
            ? '<span class="pill approved">approved</span><button class="tiny no" data-a="0">Block</button>'
            : '<span class="pill blocked">blocked</span><button class="tiny ok" data-a="1">Allow</button>';
      row.innerHTML =
        (u.picture ? `<img src="${esc(u.picture)}" alt="">` : '<div style="width:33px;height:33px;border-radius:50%;background:#222;flex-shrink:0"></div>') +
        `<div class="i"><b>${esc(u.name)}</b><span>${esc(u.email)}</span>` +
        `<span>seen ${esc(fmtWhen(u.lastSeen))}</span></div>` +
        `<div style="display:flex;gap:.3rem;align-items:center;flex-shrink:0">${acts}</div>`;
      row.querySelectorAll('.tiny').forEach(btn => {
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            const r = await api({ grant: u.email, ok: btn.dataset.a });
            if (r.ok) { toast(`${u.email} ${r.status}`, 'ok'); loadUsers(); refreshBadge(); }
            else toast(r.error || 'Failed', 'err');
          } catch (e) { toast('Failed: ' + e.message, 'err'); }
        };
      });
      p.appendChild(row);
    });
  } catch (e) { p.innerHTML = `<div class="empty">Could not load: ${esc(e.message)}</div>`; }
}

async function loadSuggestions() {
  const p = $('pane-art');
  p.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api({ pending: 1 });
    if (!d.ok) { p.innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
    if (!d.pending.length) { p.innerHTML = '<div class="empty">No artwork suggestions waiting.</div>'; return; }
    p.innerHTML = '';
    d.pending.forEach(s => {
      const row = document.createElement('div');
      row.className = 'srow';
      row.innerHTML =
        `<img src="${esc(s.cover||'')}" alt="">` +
        `<div class="i"><b>${esc(s.trackTitle || s.id)}</b><span>${esc(s.album||'')}</span>` +
        `<span>by ${esc(s.byName || s.by)} · ${esc(fmtWhen(s.at))}</span></div>` +
        `<div style="display:flex;gap:.3rem;flex-shrink:0"><button class="tiny ok" data-a="1">Approve</button><button class="tiny no" data-a="0">Reject</button></div>`;
      row.querySelectorAll('.tiny').forEach(btn => {
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            const r = await api({ decide: s.sid, ok: btn.dataset.a });
            if (r.ok) {
              if (r.overrides) AURA.overrides = r.overrides;
              toast('Suggestion ' + r.status, 'ok');
              loadSuggestions(); renderQueue(); Player.refreshNP(); refreshBadge();
            } else toast(r.error || 'Failed', 'err');
          } catch (e) { toast('Failed: ' + e.message, 'err'); }
        };
      });
      p.appendChild(row);
    });
  } catch (e) { p.innerHTML = `<div class="empty">Could not load: ${esc(e.message)}</div>`; }
}

async function refreshBadge() {
  if (!AURA.me || !AURA.me.approver) return;
  try {
    const d = await api({ meta: 1 });
    const n = (d.pendingUsers||0) + (d.pendingArt||0);
    $('me-badge').textContent = n;
    $('me-badge').classList.toggle('on', n > 0);
    const su = $('seg-u'), sa = $('seg-a');
    su.textContent = d.pendingUsers||0; su.style.display = d.pendingUsers ? 'inline-block' : 'none';
    sa.textContent = d.pendingArt||0;   sa.style.display = d.pendingArt ? 'inline-block' : 'none';
    if (d.lastSync) { AURA.lastSync = d.lastSync; updateSync(); }
  } catch (e) {}
}
setInterval(() => { if (AURA.me && AURA.me.approver) refreshBadge(); }, 120000);

/* ============================================================
   DSP PANEL UI
   ============================================================ */
$('btn-dsp').onclick = () => {
  const on = $('d-panel').classList.toggle('on');
  $('d-top').classList.toggle('on', on);
  $('btn-dsp').classList.toggle('on', on);
  if (on) { requestAnimationFrame(() => { fitCanvas($('eq-cv')); fitCanvas($('viz-cv')); DSP.drawCurve(); }); }
};
$('d-close').onclick = () => $('btn-dsp').onclick();

/* --- toggles --- */
function paintToggles() {
  $('d-bg').classList.toggle('on', DSP.bg);
  $('d-bg').querySelector('span').textContent = DSP.bg ? 'Background' : 'Background off';
  $('d-on').classList.toggle('on', DSP.on);
  $('d-on').querySelector('span').textContent = DSP.on ? 'DSP On' : 'DSP Off';
  $('d-amb').classList.toggle('on', Ambient.on);
  $('d-dust').classList.toggle('on', Dust.on);
  document.querySelectorAll('.dcard').forEach(c => c.classList.toggle('off', !DSP.on));
  DSP.chainLine();
}

$('d-bg').onclick = () => {
  DSP.bg = !DSP.bg;
  lsSet(AURA.K.bg, DSP.bg);
  if (DSP.bg && DSP.on) { DSP.on = false; DSP.apply(); }
  paintToggles();
  if (DSP.bg) {
    toast(DSP.built || DSP.monitorOnly
      ? 'Background priority on — reload for it to fully take effect'
      : 'Background priority on — DSP and visualisers off');
  } else {
    toast('DSP and visualisers available');
    if (!DSP.built && !DSP.monitorOnly && AURA.audio.src) DSP.buildMonitor();
  }
};

$('d-on').onclick = async () => {
  if (!DSP.on) {
    if (DSP.bg) {
      if (AURA.isIOS && !confirm(
        'Background priority keeps audio playing when your screen locks.\n\n' +
        'Turning DSP on may stop playback when iOS suspends the engine.\n\nContinue?')) return;
      DSP.bg = false; lsSet(AURA.K.bg, false);
    }
    if (!await DSP.build()) return;
    if (DSP.ctx.state === 'suspended') await DSP.ctx.resume();
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch(e) {}
    DSP.on = true;
  } else DSP.on = false;
  DSP.apply(); paintToggles();
};

$('d-amb').onclick = () => { Ambient.toggle(); paintToggles(); };
$('d-dust').onclick = () => { Dust.toggle(); paintToggles(); };

const abDown = () => { if (DSP.on) { DSP.bypass = true; DSP.apply(); $('d-ab').classList.add('warn'); } };
const abUp = () => { if (DSP.on) { DSP.bypass = false; DSP.apply(); $('d-ab').classList.remove('warn'); } };
['pointerdown'].forEach(e => $('d-ab').addEventListener(e, abDown));
['pointerup','pointerleave','pointercancel'].forEach(e => $('d-ab').addEventListener(e, abUp));

function onResumeContext() { if (DSP.ctx && DSP.ctx.state === 'suspended') DSP.ctx.resume(); }
AURA.onGraphNeeded = async () => {
  // Attach a transparent monitor graph so the spectrum and particles
  // have something to read. Skipped entirely when the user has asked
  // for background priority.
  if (!DSP.bg && !DSP.built && !DSP.monitorOnly) await DSP.buildMonitor();
};
AURA.onTrackChange = (track, url) => { DSP.buildWave(url); DSP.gramReady = false; };
function onPlayTick() { if (DSP.view === 'wave') DSP.drawWave(); }
function onPlayState() {}
function onTrackEnd() {
  if (DSP.sleepEOT) {
    DSP.sleepEOT = false; $('d-sleep').value = '0'; $('v-sleep').textContent = '—';
    toast('Sleep timer — stopped', 'ok');
    return true;
  }
  return false;
}

/* --- EQ bands --- */
function buildBands() {
  const host = $('eq-bands');
  host.innerHTML = '';
  DSP.eq.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'bd';
    d.innerHTML =
      `<span class="g" id="bg${i}">${b.g>0?'+':''}${b.g.toFixed(1)}</span>` +
      `<input class="vs" type="range" id="bs${i}" min="-12" max="12" step="0.5" value="${b.g}" orient="vertical">` +
      `<span class="f">${b.f>=1000?(b.f/1000)+'k':b.f}</span>` +
      `<input class="bq" type="range" id="bq${i}" min="0.3" max="6" step="0.1" value="${b.q}">`;
    host.appendChild(d);
    d.querySelector('#bs'+i).addEventListener('input', e => {
      DSP.eq[i].g = parseFloat(e.target.value);
      syncBand(i); DSP.apply(); DSP.save(); clearPresetSel();
    });
    d.querySelector('#bq'+i).addEventListener('input', e => {
      DSP.eq[i].q = parseFloat(e.target.value);
      DSP.apply(); DSP.save();
    });
  });
}
function syncBand(i) {
  const g = DSP.eq[i].g;
  $('bg'+i).textContent = (g>0?'+':'') + g.toFixed(1);
  $('bs'+i).value = g;
  if ($('bq'+i)) $('bq'+i).value = DSP.eq[i].q;
}
function syncBands() { DSP.eq.forEach((_,i) => syncBand(i)); }
function clearPresetSel() { document.querySelectorAll('.pchip').forEach(c => c.classList.remove('on')); }

$('eq-qbtn').onclick = () => {
  const on = $('eq-bands').classList.toggle('showq');
  $('eq-qbtn').classList.toggle('on', on);
};
$('eq-flat').onclick = () => {
  DSP.eq.forEach(b => b.g = 0);
  syncBands(); DSP.apply(); DSP.save(); clearPresetSel();
  toast('Flat');
};

/* drag on the curve grabs the nearest band */
let curveBand = -1;
const eqcv = $('eq-cv');
eqcv.addEventListener('pointerdown', e => {
  if (!DSP.built) return;
  const r = eqcv.getBoundingClientRect();
  const x = e.clientX - r.left;
  let best = -1, bd = 1e9;
  DSP.eq.forEach((b,i) => { const d = Math.abs(xOfF(b.f, r.width) - x); if (d < bd) { bd = d; best = i; } });
  if (bd < 42) { curveBand = best; eqcv.setPointerCapture(e.pointerId); moveCurve(e.clientY - r.top, r.height); }
});
eqcv.addEventListener('pointermove', e => {
  if (curveBand < 0) return;
  const r = eqcv.getBoundingClientRect();
  moveCurve(e.clientY - r.top, r.height);
});
['pointerup','pointercancel'].forEach(ev => eqcv.addEventListener(ev, () => { curveBand = -1; }));
function moveCurve(y, h) {
  const db = clamp(-((y - h/2)/(h/2))*DBR, -12, 12);
  DSP.eq[curveBand].g = Math.round(db*2)/2;
  syncBand(curveBand); DSP.apply(); DSP.save(); clearPresetSel();
}

/* --- spatial + gain --- */
function syncSpatial() {
  $('s-width').value = DSP.width;
  $('v-width').textContent = Math.round(DSP.width*100) + '%';
  $('s-bal').value = DSP.balance;
  $('v-bal').textContent = Math.abs(DSP.balance) < .02 ? 'C'
    : (DSP.balance < 0 ? 'L' : 'R') + Math.round(Math.abs(DSP.balance)*100);
  $('s-xf').value = DSP.xfeed;
  $('v-xf').textContent = DSP.xfeed < .02 ? 'Off' : Math.round(DSP.xfeed*100) + '%';
}
function syncGain() {
  $('s-pre').value = DSP.preamp;
  $('v-pre').textContent = (DSP.preamp>0?'+':'') + DSP.preamp.toFixed(1) + ' dB';
  $('lim-sw').classList.toggle('on', DSP.lim);
  $('v-lim').textContent = DSP.lim ? 'on' : 'off';
}
$('s-width').addEventListener('input', e => { DSP.width = parseFloat(e.target.value); syncSpatial(); DSP.apply(); DSP.save(); });
$('s-bal').addEventListener('input', e => { DSP.balance = parseFloat(e.target.value); syncSpatial(); DSP.apply(); DSP.save(); });
$('s-xf').addEventListener('input', e => { DSP.xfeed = parseFloat(e.target.value); syncSpatial(); DSP.apply(); DSP.save(); });
$('s-pre').addEventListener('input', e => { DSP.preamp = parseFloat(e.target.value); syncGain(); DSP.apply(); DSP.save(); });
$('lim-sw').onclick = () => {
  DSP.lim = !DSP.lim; syncGain();
  if (DSP.built) { DSP.wire(); DSP.apply(); }
  DSP.save();
};

/* Tap a value to type it exactly */
document.querySelectorAll('.val').forEach(el => {
  el.onclick = () => {
    const map = {
      'v-width':['width',0,200,v=>v/100,v=>v*100],
      'v-bal':['balance',-100,100,v=>v/100,v=>v*100],
      'v-xf':['xfeed',0,100,v=>v/100,v=>v*100],
      'v-pre':['preamp',-24,12,v=>v,v=>v]
    };
    const m = map[el.id]; if (!m) return;
    const [key,lo,hi,toVal,toDisp] = m;
    const cur = toDisp(DSP[key]);
    const s = prompt(`${key} (${lo} to ${hi})`, String(Math.round(cur*100)/100));
    if (s === null) return;
    const n = parseFloat(s);
    if (isNaN(n)) { toast('Not a number','err'); return; }
    DSP[key] = toVal(clamp(n, lo, hi));
    syncSpatial(); syncGain(); DSP.apply(); DSP.save();
  };
});

/* --- folds --- */
[['fold-aeq','body-aeq'],['fold-conv','body-conv'],['fold-loud','body-loud'],
 ['fold-out','body-out'],['fold-util','body-util'],['fold-abx','body-abx']].forEach(([h,b]) => {
  $(h).addEventListener('click', e => {
    if (e.target.closest('.sw') || e.target.closest('.rr') || e.target.closest('.ib')) return;
    const on = $(b).classList.toggle('on');
    const chev = $(h).querySelector('.fa-chevron-down');
    if (chev) chev.style.transform = on ? 'rotate(180deg)' : '';
    if (on) requestAnimationFrame(() => fitCanvas($('viz-cv')));
  });
});

/* --- AutoEq --- */
$('aeq-go').onclick = () => {
  const r = DSP.applyAutoEq($('aeq').value);
  if (!r.ok) { toast(r.msg, 'err'); return; }
  syncBands(); syncGain(); DSP.apply(); DSP.save(); clearPresetSel();
  $('aeq-note').className = r.shelves ? 'hint w' : 'hint';
  $('aeq-note').textContent = `Applied ${r.used} filter${r.used===1?'':'s'}.` +
    (r.shelves ? ` ${r.shelves} shelf filter${r.shelves===1?'':'s'} skipped — these are ten peaking bands, so the result is close but not identical to AutoEq's target.` : '');
  toast('Correction applied', 'ok');
};
$('aeq-clear').onclick = e => {
  e.stopPropagation();
  $('aeq').value = ''; $('aeq-note').textContent = '';
  DSP.eq.forEach((b,i) => { b.g = 0; b.q = EQ_DEF[i].q; });
  DSP.preamp = 0;
  syncBands(); syncGain(); DSP.apply(); DSP.save();
  toast('Correction cleared');
};

/* --- convolution --- */
$('ir-pick').onclick = () => $('ir-file').click();
$('ir-file').onchange = async () => {
  const f = $('ir-file').files[0];
  if (!f) return;
  if (!DSP.built) { toast('Switch DSP on first', 'err'); return; }
  $('ir-info').textContent = 'Decoding…';
  try {
    const buf = await DSP.ctx.decodeAudioData(await f.arrayBuffer());
    DSP.ir = buf;
    $('ir-info').innerHTML = `<b>${esc(f.name)}</b> · ${buf.numberOfChannels}ch · ` +
      `${(buf.duration*1000).toFixed(0)} ms · ${(buf.sampleRate/1000).toFixed(1)} kHz`;
    DSP.conv = true; $('conv-sw').classList.add('on');
    DSP.wire(); DSP.apply(); DSP.save();
    toast('Impulse response loaded', 'ok');
  } catch (e) {
    $('ir-info').textContent = 'Could not decode that file.';
  }
};
$('conv-sw').onclick = e => {
  e.stopPropagation();
  if (!DSP.ir) { toast('Load an impulse response first', 'err'); return; }
  DSP.conv = !DSP.conv;
  $('conv-sw').classList.toggle('on', DSP.conv);
  if (DSP.built) { DSP.wire(); DSP.apply(); }
  DSP.save();
};

/* --- presets --- */
function renderPresets() {
  const b = $('p-built'); b.innerHTML = '';
  Object.keys(PRESETS).forEach(name => {
    const c = document.createElement('button');
    c.className = 'pchip'; c.textContent = name;
    c.onclick = () => {
      PRESETS[name].forEach((g,i) => DSP.eq[i].g = g);
      syncBands(); DSP.apply(); DSP.save();
      clearPresetSel(); c.classList.add('on');
      toast(name, 'ok');
    };
    b.appendChild(c);
  });
  const mine = lsGet(AURA.K.presets, {});
  const m = $('p-mine'); m.innerHTML = '';
  const names = Object.keys(mine);
  if (!names.length) { m.innerHTML = '<span class="hint" style="margin:0">Nothing saved yet.</span>'; return; }
  names.forEach(name => {
    const c = document.createElement('button');
    c.className = 'pchip';
    c.innerHTML = esc(name) + ' <span class="x"><i class="fa-solid fa-xmark"></i></span>';
    c.onclick = ev => {
      if (ev.target.closest('.x')) {
        const all = lsGet(AURA.K.presets, {}); delete all[name]; lsSet(AURA.K.presets, all);
        renderPresets(); toast('Deleted "' + name + '"'); return;
      }
      const p = mine[name];
      DSP.eq = p.eq.map(x => ({...x}));
      DSP.preamp = p.preamp||0; DSP.width = p.width??1;
      DSP.balance = p.balance||0; DSP.xfeed = p.xfeed||0; DSP.lim = !!p.lim;
      buildBands(); syncBands(); syncSpatial(); syncGain();
      if (DSP.built) DSP.wire();
      DSP.apply(); DSP.save();
      clearPresetSel(); c.classList.add('on');
      toast(name, 'ok');
    };
    m.appendChild(c);
  });
}
$('p-save').onclick = () => {
  const name = $('p-name').value.trim();
  if (!name) { toast('Give it a name first', 'err'); return; }
  const all = lsGet(AURA.K.presets, {});
  all[name] = { eq: DSP.eq.map(b => ({...b})), preamp: DSP.preamp,
    width: DSP.width, balance: DSP.balance, xfeed: DSP.xfeed, lim: DSP.lim, at: Date.now() };
  lsSet(AURA.K.presets, all);
  $('p-name').value = '';
  renderPresets(); toast('Saved "' + name + '"', 'ok');
};
$('p-exp').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ v:1, presets: lsGet(AURA.K.presets, {}) }, null, 2)], { type:'application/json' }));
  a.download = 'aura-presets.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('p-imp').onclick = () => {
  const f = document.createElement('input');
  f.type = 'file'; f.accept = 'application/json';
  f.onchange = () => {
    const file = f.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        const inc = j.presets || j;
        const all = lsGet(AURA.K.presets, {});
        let n = 0;
        Object.keys(inc).forEach(k => { if (inc[k] && Array.isArray(inc[k].eq)) { all[k] = inc[k]; n++; } });
        lsSet(AURA.K.presets, all); renderPresets();
        toast(`Imported ${n} preset${n===1?'':'s'}`, 'ok');
      } catch (e) { toast('That file could not be read', 'err'); }
    };
    rd.readAsText(file);
  };
  f.click();
};

/* --- analysis tabs --- */
document.querySelectorAll('#viz-tabs button').forEach(b => {
  b.onclick = e => {
    if (e.target.closest('.ib')) return;
    document.querySelectorAll('#viz-tabs button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    DSP.view = b.dataset.v;
    DSP.gramReady = false;
    const c = $('viz-cv').getContext('2d');
    const r = $('viz-cv').getBoundingClientRect();
    c.clearRect(0, 0, r.width, r.height);
    DSP.save();
  };
});
$('viz-cv').addEventListener('pointerdown', e => {
  if (DSP.view !== 'wave' || !isFinite(AURA.audio.duration)) return;
  const r = $('viz-cv').getBoundingClientRect();
  AURA.audio.currentTime = clamp((e.clientX - r.left)/r.width, 0, 1) * AURA.audio.duration;
});

function vizLoop() { requestAnimationFrame(vizLoop); DSP.drawViz(); }

/* --- output --- */
async function probeCapabilities() {
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const outs = devs.filter(d => d.kind === 'audiooutput');
      const sel = $('d-sink');
      sel.innerHTML = '<option value="">System default</option>';
      outs.forEach(d => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || ('Output ' + d.deviceId.slice(0,6));
        sel.appendChild(o);
      });
    } catch (e) {}
  }
  if (!AURA.audio.setSinkId) $('d-sink').disabled = true;
  if (!('wakeLock' in navigator)) { $('wake-sw').disabled = true; $('v-wake').textContent = 'n/a'; }
  if (!navigator.requestMIDIAccess) { $('midi-sw').disabled = true; $('v-midi').textContent = 'n/a'; }
}
$('d-sink').onchange = async () => {
  if (!AURA.audio.setSinkId) { toast('This browser cannot choose an output', 'err'); return; }
  try { await AURA.audio.setSinkId($('d-sink').value); toast('Output switched', 'ok'); }
  catch (e) { toast('Could not switch: ' + e.message, 'err'); }
};
$('d-rate').onchange = () => { DSP.save(); if (DSP.built) toast('Sample rate applies on reload', 'err'); };
$('d-buf').onchange = () => { DSP.save(); if (DSP.built) toast('Buffer applies on reload', 'err'); };

/* --- utilities --- */
$('s-spd').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  AURA.audio.playbackRate = v;
  AURA.audio.preservesPitch = true;
  $('v-spd').textContent = v.toFixed(2) + '×';
});
$('d-sleep').onchange = () => {
  clearInterval(DSP.sleepT); DSP.sleepT = null; DSP.sleepEOT = false;
  const v = parseInt($('d-sleep').value, 10);
  if (DSP.nodes.out) DSP.nodes.out.gain.value = 1;
  if (v === 0) { $('v-sleep').textContent = '—'; return; }
  if (v === -1) { DSP.sleepEOT = true; $('v-sleep').textContent = 'track end'; return; }
  DSP.sleepEnd = Date.now() + v*60000;
  DSP.sleepT = setInterval(() => {
    const left = DSP.sleepEnd - Date.now();
    if (left <= 0) {
      clearInterval(DSP.sleepT); DSP.sleepT = null;
      $('v-sleep').textContent = '—'; $('d-sleep').value = '0';
      if (DSP.nodes.out && DSP.ctx) {
        const t = DSP.ctx.currentTime;
        DSP.nodes.out.gain.cancelScheduledValues(t);
        DSP.nodes.out.gain.setValueAtTime(DSP.nodes.out.gain.value, t);
        DSP.nodes.out.gain.linearRampToValueAtTime(0, t+3);
        setTimeout(() => { AURA.audio.pause(); DSP.nodes.out.gain.value = 1; }, 3200);
      } else AURA.audio.pause();
      toast('Sleep timer — stopping', 'ok');
      return;
    }
    $('v-sleep').textContent = fmtDur(left/1000);
    if (DSP.nodes.out && left < 20000) DSP.nodes.out.gain.value = clamp(left/20000, 0, 1);
  }, 500);
};
$('wake-sw').onclick = async () => {
  const on = !$('wake-sw').classList.contains('on');
  if (on) {
    try {
      DSP.wake = await navigator.wakeLock.request('screen');
      DSP.wake.addEventListener('release', () => { $('wake-sw').classList.remove('on'); $('v-wake').textContent = 'off'; });
      $('wake-sw').classList.add('on'); $('v-wake').textContent = 'on';
    } catch (e) { toast('Wake lock refused: ' + e.message, 'err'); }
  } else {
    if (DSP.wake) { try { await DSP.wake.release(); } catch(e) {} DSP.wake = null; }
    $('wake-sw').classList.remove('on'); $('v-wake').textContent = 'off';
  }
};
$('midi-sw').onclick = async () => {
  const on = !$('midi-sw').classList.contains('on');
  if (!on) { $('midi-sw').classList.remove('on'); $('v-midi').textContent = 'off'; return; }
  try {
    const acc = await navigator.requestMIDIAccess();
    let n = 0;
    acc.inputs.forEach(inp => {
      n++;
      inp.onmidimessage = m => {
        const [st, cc, val] = m.data;
        if ((st & 0xf0) !== 0xb0) return;
        const i = cc - 1;
        if (i >= 0 && i < 8) { DSP.eq[i].g = Math.round((val/127*24-12)*2)/2; syncBand(i); DSP.apply(); }
        else if (cc === 9) { DSP.preamp = Math.round((val/127*36-24)*2)/2; syncGain(); DSP.apply(); }
      };
    });
    $('midi-sw').classList.add('on');
    $('v-midi').textContent = n ? n + ' in' : 'none';
    toast(n ? `MIDI connected — ${n} input${n===1?'':'s'}` : 'MIDI on, nothing plugged in', 'ok');
  } catch (e) { toast('MIDI refused: ' + e.message, 'err'); }
};

/* --- ABX --- */
function abxMark(id) { ['abx-a','abx-b','abx-x'].forEach(x => $(x).classList.toggle('on', x === id)); }
$('abx-a').onclick = () => { DSP.bypass = false; DSP.apply(); abxMark('abx-a'); };
$('abx-b').onclick = () => { DSP.bypass = true; DSP.apply(); abxMark('abx-b'); };
$('abx-x').onclick = () => {
  if (DSP.abx.x === null) DSP.abx.x = Math.random() < .5 ? 'a' : 'b';
  DSP.bypass = (DSP.abx.x === 'b'); DSP.apply(); abxMark('abx-x');
};
function abxGuess(g) {
  if (DSP.abx.x === null) { toast('Listen to X first', 'err'); return; }
  DSP.abx.trials++;
  if (g === DSP.abx.x) DSP.abx.hits++;
  DSP.abx.x = null; DSP.bypass = false; DSP.apply(); abxMark('');
  $('abx-score').textContent = `${DSP.abx.hits} / ${DSP.abx.trials}`;
  const pct = Math.round(DSP.abx.hits/DSP.abx.trials*100);
  let v = '';
  if (DSP.abx.trials >= 10) {
    v = pct >= 80 ? ' — you can clearly hear it.'
      : pct >= 65 ? ' — probably audible to you.'
      : ' — that\'s near guessing, so the difference may not be audible to you.';
  }
  $('abx-note').textContent = `${pct}% over ${DSP.abx.trials} trial${DSP.abx.trials===1?'':'s'}${v}`;
}
$('abx-isa').onclick = () => abxGuess('a');
$('abx-isb').onclick = () => abxGuess('b');
$('abx-rst').onclick = () => {
  DSP.abx = { trials:0, hits:0, x:null };
  DSP.bypass = false; DSP.apply(); abxMark('');
  $('abx-score').textContent = '0 / 0'; $('abx-note').textContent = '';
};

/* ============================================================
   RESETS — per card, plus one for everything
   ============================================================ */
$('r-spatial').onclick = e => {
  e.stopPropagation();
  DSP.width = 1; DSP.balance = 0; DSP.xfeed = 0;
  syncSpatial(); DSP.apply(); DSP.save(); toast('Spatial reset');
};
$('r-gain').onclick = e => {
  e.stopPropagation();
  DSP.preamp = 0; DSP.lim = false;
  syncGain(); if (DSP.built) DSP.wire(); DSP.apply(); DSP.save();
  if (DSP.nodes.meter) DSP.nodes.meter.port.postMessage('reset');
  $('gain-warn').textContent = ''; toast('Gain reset');
};
$('r-presets').onclick = e => {
  e.stopPropagation();
  const n = Object.keys(lsGet(AURA.K.presets, {})).length;
  if (!n) { toast('Nothing saved'); return; }
  if (!confirm(`Delete all ${n} of your saved presets?\n\nExport them first if you want a copy.`)) return;
  lsSet(AURA.K.presets, {}); renderPresets();
  toast(`Deleted ${n} preset${n===1?'':'s'}`);
};
$('r-viz').onclick = e => {
  e.stopPropagation();
  DSP.gramReady = false; DSP.go = new Float32Array(0);
  const c = $('viz-cv').getContext('2d');
  const r = $('viz-cv').getBoundingClientRect();
  c.clearRect(0, 0, r.width, r.height);
  toast('Cleared');
};
$('r-loud').onclick = e => {
  e.stopPropagation();
  if (DSP.nodes.meter) DSP.nodes.meter.port.postMessage('reset');
  toast('Meters reset');
};
$('r-out').onclick = async e => {
  e.stopPropagation();
  $('d-sink').value = ''; $('d-rate').value = '0'; $('d-buf').value = 'playback';
  if (AURA.audio.setSinkId) { try { await AURA.audio.setSinkId(''); } catch(err) {} }
  DSP.save();
  toast(DSP.built ? 'Defaults set — reload to apply rate and buffer' : 'Output defaults restored');
};
$('r-util').onclick = async e => {
  e.stopPropagation();
  AURA.audio.playbackRate = 1; $('s-spd').value = 1; $('v-spd').textContent = '1.00×';
  clearInterval(DSP.sleepT); DSP.sleepT = null; DSP.sleepEOT = false;
  $('d-sleep').value = '0'; $('v-sleep').textContent = '—';
  if (DSP.nodes.out) DSP.nodes.out.gain.value = 1;
  if (DSP.wake) { try { await DSP.wake.release(); } catch(err) {} DSP.wake = null; }
  $('wake-sw').classList.remove('on');
  if ('wakeLock' in navigator) $('v-wake').textContent = 'off';
  $('midi-sw').classList.remove('on');
  if (navigator.requestMIDIAccess) $('v-midi').textContent = 'off';
  toast('Utilities reset');
};
$('d-resetall').onclick = async () => {
  if (!confirm('Put every control back to default?\n\nYour saved presets are kept.')) return;
  DSP.eq = EQ_DEF.map(b => ({...b}));
  DSP.preamp = 0; DSP.balance = 0; DSP.width = 1; DSP.xfeed = 0;
  DSP.lim = false; DSP.conv = false; DSP.ir = null; DSP.bypass = false;
  $('conv-sw').classList.remove('on');
  $('ir-info').textContent = 'None loaded.';
  $('aeq').value = ''; $('aeq-note').textContent = '';
  await $('r-util').onclick({ stopPropagation(){} });
  $('r-viz').onclick({ stopPropagation(){} });
  $('eq-bands').classList.remove('showq');
  $('eq-qbtn').classList.remove('on');
  DSP.abx = { trials:0, hits:0, x:null };
  $('abx-score').textContent = '0 / 0'; $('abx-note').textContent = ''; abxMark('');
  clearPresetSel();
  buildBands(); syncBands(); syncSpatial(); syncGain();
  if (DSP.built) DSP.wire();
  DSP.apply(); DSP.save();
  toast('Everything back to default', 'ok');
};

addEventListener('resize', () => {
  fitCanvas($('eq-cv')); fitCanvas($('viz-cv'));
  DSP.gramReady = false; DSP.drawCurve();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) onResumeContext();
});
document.addEventListener('keydown', e => {
  if (e.code === 'Escape') document.querySelectorAll('.ov.on').forEach(o => o.classList.remove('on'));
});

/* ============================================================
   TRACK INFO STRIP

   Everything here is measured from the file itself — read out of
   the FLAC header, not guessed. A value shows amber if it came
   from the indexer rather than the header.
   ============================================================ */
function updateSpecs() {
  const t = AURA.queue.find(x => x.id === AURA.currentId);
  const set = (id, v, measured) => {
    const el = $(id);
    if (v) {
      el.textContent = v;
      el.classList.remove('dim');
      el.classList.toggle('warn', measured === false);
      el.title = measured === false ? 'Reported by the indexer, not measured'
        : 'Read from the file header';
    } else {
      el.textContent = '—';
      el.classList.add('dim');
      el.classList.remove('warn');
      el.title = '';
    }
  };

  if (!t) { ['sp-fmt','sp-rate','sp-br','sp-size'].forEach(id => set(id, null)); updateState(); return; }

  const m = AURA.meta.get(t.id) || {};
  set('sp-fmt', (m.format || t.format || '') + (m.channels ? ` ${m.channels}ch` : ''), m.measured);
  set('sp-rate', m.sampleRate ? `${(m.sampleRate/1000).toFixed(1)}k` + (m.bits ? ` / ${m.bits}bit` : '') : null, m.measured);
  set('sp-br', m.bitrate ? m.bitrate + ' kbps' : null, m.measured);
  set('sp-size', fmtBytes(t.sizeBytes), true);
  updateState();
}

function updateState() {
  const el = $('sp-state'), dot = $('sp-dot');
  if (!el) return;
  const loading = $('load').classList.contains('on');
  const err = $('np-a').classList.contains('err');
  let label, cls;

  if (err)              { label = 'Error';   cls = 'bad'; }
  else if (loading)     { label = 'Loading'; cls = 'load'; }
  else if (!AURA.audio.src)      { label = 'Idle'; cls = ''; }
  else if (AURA.audio.paused)    { label = DB.has(AURA.currentId) ? 'Cached' : 'Paused'; cls = ''; }
  else if (DSP.on && !DSP.bypass){ label = 'DSP';    cls = 'play'; }
  else                  { label = 'Direct'; cls = 'play'; }

  el.innerHTML = `<span class="sp-dot ${cls}" id="sp-dot"></span>${label}`;
  el.classList.remove('dim');
}

/* Hook the strip into the events that change it */
const _origTrackChange = AURA.onTrackChange;
AURA.onTrackChange = (track, url) => {
  if (_origTrackChange) _origTrackChange(track, url);
  updateSpecs();
};
const _origPlayState = onPlayState;
onPlayState = function () { if (_origPlayState) _origPlayState(); updateState(); };

const _origHideLoad = Player.hideLoad.bind(Player);
Player.hideLoad = function () { _origHideLoad(); updateSpecs(); };
const _origShowLoad = Player.showLoad.bind(Player);
Player.showLoad = function (t) { _origShowLoad(t); updateState(); };

const _origApply = DSP.apply.bind(DSP);
DSP.apply = function () { _origApply(); updateState(); };
