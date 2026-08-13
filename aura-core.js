/* ============================================================
   Aura — core
   Auth, persistent cache, FLAC metadata, queue, player, ambient
   visualiser. Shared by every page and cached by the browser
   after the first visit.
   ============================================================ */
'use strict';

const AURA = {
  API: 'https://script.google.com/macros/s/AKfycbyO05GfIiGJlgKEhZwtK9mIxD0Ox5dvXS_H7wMAH8nZWGPPWmzsZSON7w0lGK_i6CTK/exec',
  CLIENT_ID: '1094298397037-l9dt2f7mlnpkk4fh8remr39qmq28q9ot.apps.googleusercontent.com',
  DRIVE_KEY: 'AIzaSyCQKib3-SorQYL_eeiaNCpVxE-So6gIn_c',

  K: {
    session: 'aura_session', order: 'aura_order:', localArt: 'aura_local_art',
    info: 'aura_info_seen', ambient: 'aura_ambient', dsp: 'aura_dspset',
    presets: 'aura_presets', bg: 'aura_bgpriority'
  },

  HEADER_BYTES: 1024 * 1024,
  isTouch: matchMedia('(pointer: coarse)').matches,
  isIOS: /iP(hone|ad|od)/.test(navigator.platform) ||
         (navigator.userAgent.includes('Mac') && 'ontouchend' in document),

  me: null,
  tracks: [], queue: [], overrides: {}, localArt: {},
  currentId: null, folder: 'all', shuffle: false, lastSync: null,
  meta: new Map(),
  audio: null,
  onTrackChange: null,     // hook for the DSP layer
  onGraphNeeded: null      // hook so DSP can attach before playback
};

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}
function fmtTime(s) {
  if (!isFinite(s) || isNaN(s) || s < 0) return '0:00';
  return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0');
}
function fmtDur(s) {
  if (!isFinite(s) || s < 0) return '—';
  return s < 60 ? Math.ceil(s) + 's'
    : Math.floor(s/60) + 'm ' + String(Math.round(s%60)).padStart(2,'0') + 's';
}
function fmtWhen(iso) {
  if (!iso) return 'never';
  const d = new Date(iso), diff = (Date.now() - d) / 1000;
  if (diff < 90) return 'just now';
  if (diff < 3600) return Math.round(diff/60) + ' min ago';
  if (diff < 86400) return Math.round(diff/3600) + ' hr ago';
  return d.toLocaleString(undefined, { day:'numeric', month:'short', hour:'numeric', minute:'2-digit' });
}
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} }

function toast(msg, kind) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg;
  t.className = 'on' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, 3300);
}

async function api(params) {
  const q = new URLSearchParams(params);
  if (AURA.me && AURA.me.session) q.set('s', AURA.me.session);
  const r = await fetch(AURA.API + '?' + q.toString());
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const driveUrl = t => `https://www.googleapis.com/drive/v3/files/${t.id}?alt=media&key=${AURA.DRIVE_KEY}`;

/* ============================================================
   INFO POPOVERS

   Tap-driven rather than title= tooltips, which do nothing on a
   phone. Any element with data-info gets one.
   ============================================================ */
const INFO = {};
function registerInfo(map) { Object.assign(INFO, map); }

function initPopovers() {
  let pop = $('pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'pop';
    document.body.appendChild(pop);
  }
  let openBtn = null;

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-info]');
    if (!btn) {
      if (openBtn) { pop.classList.remove('on'); openBtn.classList.remove('on'); openBtn = null; }
      return;
    }
    e.stopPropagation();
    if (openBtn === btn) { pop.classList.remove('on'); btn.classList.remove('on'); openBtn = null; return; }
    if (openBtn) openBtn.classList.remove('on');

    const info = INFO[btn.dataset.info];
    if (!info) return;
    pop.innerHTML = `<b>${esc(info.t)}</b>${info.d}` + (info.w ? `<em>${info.w}</em>` : '');
    pop.classList.add('on');
    btn.classList.add('on');
    openBtn = btn;

    const r = btn.getBoundingClientRect(), pr = pop.getBoundingClientRect();
    let left = clamp(r.left + r.width/2 - pr.width/2, 8, innerWidth - pr.width - 8);
    let top = r.bottom + 8;
    if (top + pr.height > innerHeight - 8) top = Math.max(8, r.top - pr.height - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  });

  addEventListener('scroll', () => {
    if (openBtn) { pop.classList.remove('on'); openBtn.classList.remove('on'); openBtn = null; }
  }, true);
}

/* ============================================================
   PERSISTENT CACHE (IndexedDB)

   Blob URLs die with the document, so the old in-memory cache
   was lost on every reload and navigation. Storing the bytes in
   IndexedDB means a track downloads once and stays until you
   press Purge — across reloads and browser restarts.
   ============================================================ */
const DB = {
  name: 'aura-cache', store: 'tracks', db: null,
  urls: new Map(),        // id -> live object URL for this document
  index: new Map(),       // id -> { size, at }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const rq = indexedDB.open(this.name, 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains(this.store)) {
          d.createObjectStore(this.store, { keyPath: 'id' });
        }
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return this.db;
  },

  async tx(mode) {
    const db = await this.open();
    return db.transaction(this.store, mode).objectStore(this.store);
  },

  /** Load the index (ids + sizes) without pulling any audio into memory. */
  async loadIndex() {
    try {
      const st = await this.tx('readonly');
      const rows = await new Promise((res, rej) => {
        const rq = st.getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
      this.index.clear();
      rows.forEach(r => this.index.set(r.id, { size: r.size, at: r.at }));
    } catch (e) { console.warn('[Aura] cache index failed:', e); }
  },

  has(id) { return this.index.has(id); },
  get totalBytes() { let n = 0; for (const v of this.index.values()) n += v.size || 0; return n; },
  get count() { return this.index.size; },

  /** Returns an object URL, minting one from stored bytes if needed. */
  async url(id) {
    if (this.urls.has(id)) return this.urls.get(id);
    if (!this.index.has(id)) return null;
    try {
      const st = await this.tx('readonly');
      const row = await new Promise((res, rej) => {
        const rq = st.get(id);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      if (!row || !row.blob) { this.index.delete(id); return null; }
      const u = URL.createObjectURL(row.blob);
      this.urls.set(id, u);
      return u;
    } catch (e) { return null; }
  },

  /** Read just the first n bytes of a stored track, for tag parsing. */
  async head(id, n) {
    if (!this.index.has(id)) return null;
    try {
      const st = await this.tx('readonly');
      const row = await new Promise((res, rej) => {
        const rq = st.get(id);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      if (!row || !row.blob) return null;
      return new Uint8Array(await row.blob.slice(0, n).arrayBuffer());
    } catch (e) { return null; }
  },

  async put(id, blob) {
    try {
      const st = await this.tx('readwrite');
      await new Promise((res, rej) => {
        const rq = st.put({ id, blob, size: blob.size, at: Date.now() });
        rq.onsuccess = res; rq.onerror = () => rej(rq.error);
      });
      this.index.set(id, { size: blob.size, at: Date.now() });
      if (this.urls.has(id)) URL.revokeObjectURL(this.urls.get(id));
      this.urls.set(id, URL.createObjectURL(blob));
      return true;
    } catch (e) {
      console.warn('[Aura] cache write failed:', e);
      toast('Could not cache that track — storage may be full', 'err');
      return false;
    }
  },

  async remove(id) {
    try {
      const st = await this.tx('readwrite');
      await new Promise(res => { const rq = st.delete(id); rq.onsuccess = res; rq.onerror = res; });
    } catch (e) {}
    if (this.urls.has(id)) { URL.revokeObjectURL(this.urls.get(id)); this.urls.delete(id); }
    this.index.delete(id);
  },

  async purge() {
    try {
      const st = await this.tx('readwrite');
      await new Promise(res => { const rq = st.clear(); rq.onsuccess = res; rq.onerror = res; });
    } catch (e) {}
    this.urls.forEach(u => URL.revokeObjectURL(u));
    this.urls.clear(); this.index.clear();
  },

  async quota() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try { return await navigator.storage.estimate(); } catch (e) { return null; }
  }
};

/* ============================================================
   DOWNLOAD
   ============================================================ */
async function downloadTrack(track, onProgress, signal) {
  const res = await fetch(driveUrl(track), { signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('Content-Length')) || track.sizeBytes || 0;
  if (total) track.sizeBytes = total;

  if (!res.body || !res.body.getReader) {
    const b = await res.blob();
    return b;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  const t0 = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress) {
      const el = (performance.now() - t0) / 1000;
      onProgress(got, total, el > 0 ? got/el : 0);
    }
  }
  return new Blob(chunks, { type: 'audio/flac' });
}

/* ============================================================
   FLAC / WAV TAGS + EMBEDDED ART
   ============================================================ */
function parseVorbis(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const vl = dv.getUint32(p, true); p += 4 + vl;
  const n = dv.getUint32(p, true); p += 4;
  const tags = {}, dec = new TextDecoder();
  for (let i = 0; i < n && p + 4 <= bytes.length; i++) {
    const l = dv.getUint32(p, true); p += 4;
    if (p + l > bytes.length) break;
    const s = dec.decode(bytes.subarray(p, p + l)); p += l;
    const e = s.indexOf('=');
    if (e > 0) { const k = s.slice(0, e).toUpperCase(); if (!tags[k]) tags[k] = s.slice(e + 1); }
  }
  return tags;
}
function parsePicture(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 4;
  const ml = dv.getUint32(p); p += 4;
  const mime = new TextDecoder().decode(bytes.subarray(p, p + ml)); p += ml;
  const dl = dv.getUint32(p); p += 4; p += dl;
  p += 16;
  const len = dv.getUint32(p); p += 4;
  if (p + len > bytes.length) return null;
  return { mime, data: bytes.subarray(p, p + len) };
}
function parseFlac(bytes) {
  const o = { format:'FLAC', tags:{}, picture:null };
  let p = 4;
  while (p + 4 <= bytes.length) {
    const h = bytes[p], last = (h & 0x80) !== 0, type = h & 0x7f;
    const len = (bytes[p+1] << 16) | (bytes[p+2] << 8) | bytes[p+3];
    p += 4;
    if (p + len > bytes.length) break;
    const b = bytes.subarray(p, p + len);
    if (type === 0 && len >= 18) {
      o.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      o.channels = ((b[12] >> 1) & 7) + 1;
      o.bits = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
      const ts = ((b[13] & 15) * 4294967296) + (b[14]*16777216) + (b[15]*65536) + (b[16]*256) + b[17];
      o.duration = o.sampleRate > 0 ? ts / o.sampleRate : 0;
    } else if (type === 4) {
      try { o.tags = parseVorbis(b); } catch(e) {}
    } else if (type === 6 && !o.picture) {
      try {
        const pic = parsePicture(b);
        if (pic && pic.data.length) {
          o.picture = URL.createObjectURL(new Blob([pic.data], { type: pic.mime || 'image/jpeg' }));
        }
      } catch(e) {}
    }
    p += len;
    if (last) break;
  }
  return o;
}
function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { format:'WAV', tags:{}, picture:null,
    channels: dv.getUint16(22, true), sampleRate: dv.getUint32(24, true),
    bits: dv.getUint16(34, true), byteRate: dv.getUint32(28, true) };
}

async function readMeta(track) {
  if (AURA.meta.has(track.id)) return AURA.meta.get(track.id);
  let info = { format: track.format || null, tags: {}, picture: null, measured: false };
  try {
    let bytes, total = track.sizeBytes || null;
    const cached = await DB.head(track.id, AURA.HEADER_BYTES);
    if (cached) {
      bytes = cached;
      total = DB.index.get(track.id).size;
    } else {
      const r = await fetch(driveUrl(track), { headers: { Range: `bytes=0-${AURA.HEADER_BYTES-1}` } });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      bytes = new Uint8Array(await r.arrayBuffer());
      const cr = r.headers.get('Content-Range');
      if (cr) { const m = cr.match(/\/(\d+)$/); if (m) total = parseInt(m[1], 10); }
    }
    if (total) track.sizeBytes = total;

    if (bytes.length > 8 && bytes[0]===0x66 && bytes[1]===0x4c && bytes[2]===0x61 && bytes[3]===0x43) info = parseFlac(bytes);
    else if (bytes.length > 36 && bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46) info = parseWav(bytes);

    if (info.duration && total) info.bitrate = Math.round(total*8/info.duration/1000);
    else if (info.byteRate) info.bitrate = Math.round(info.byteRate*8/1000);
    info.measured = true;
  } catch (e) {
    console.warn('[Aura] tag read failed:', track.title, e.message);
  }
  const t = info.tags || {};
  info.title = t.TITLE || null;
  info.artist = t.ARTIST || t.ALBUMARTIST || null;
  info.album = t.ALBUM || null;
  info.year = (t.DATE || '').slice(0,4) || null;
  AURA.meta.set(track.id, info);
  return info;
}

/** override > this visitor's own pick > embedded tag > filename */
function display(track) {
  const m = AURA.meta.get(track.id) || {};
  const ov = AURA.overrides[track.id] || {};
  const lo = AURA.localArt[track.id] || {};
  return {
    title:  ov.title  || lo.title  || m.title  || track.title || 'Unknown',
    artist: ov.artist || lo.artist || m.artist || 'Unknown Artist',
    album:  ov.album  || lo.album  || m.album  || null,
    cover:  ov.cover  || lo.cover  || m.picture || null,
    source: ov.cover ? 'override' : (lo.cover ? 'local' : (m.picture ? 'embedded' : 'none'))
  };
}

/* ============================================================
   AMBIENT VISUALISER

   A soft mirrored spectrum behind everything, tinted from the
   album art. It's atmosphere, not a readout — heavily smoothed
   so it drifts instead of flickering.
   ============================================================ */
const Ambient = {
  cv: null, cx: null, analyser: null, on: true, raf: null,
  smooth: new Float32Array(0),

  init() {
    this.cv = $('ambient');
    if (!this.cv) return;
    this.cx = this.cv.getContext('2d');
    this.on = lsGet(AURA.K.ambient, true);
    this.cv.classList.toggle('off', !this.on);
    this.size();
    addEventListener('resize', () => this.size());
    this.loop();
  },
  size() {
    if (!this.cv) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = Math.floor(innerWidth * dpr);
    this.cv.height = Math.floor(innerHeight * dpr);
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },
  attach(analyser) { this.analyser = analyser; },
  toggle() {
    this.on = !this.on;
    lsSet(AURA.K.ambient, this.on);
    this.cv.classList.toggle('off', !this.on);
    if (!this.on) this.cx.clearRect(0, 0, innerWidth, innerHeight);
    return this.on;
  },

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    if (!this.on || !this.analyser || !this.cx) return;

    const w = innerWidth, h = innerHeight;
    const bins = this.analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    this.analyser.getByteFrequencyData(data);

    const N = 96;
    if (this.smooth.length !== N) this.smooth = new Float32Array(N);

    // log-spaced sampling so bass isn't crammed into a few pixels
    for (let i = 0; i < N; i++) {
      const f0 = 24 * Math.pow(18000/24, i/N);
      const f1 = 24 * Math.pow(18000/24, (i+1)/N);
      const nyq = 24000;
      const b0 = Math.floor(f0/nyq*bins), b1 = Math.max(b0+1, Math.floor(f1/nyq*bins));
      let pk = 0;
      for (let b = b0; b < b1 && b < bins; b++) if (data[b] > pk) pk = data[b];
      // heavy smoothing — a jittery backdrop is unusable
      this.smooth[i] += ((pk/255) - this.smooth[i]) * 0.09;
    }

    this.cx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement);
    const R = cs.getPropertyValue('--accent-r').trim() || 192;
    const G = cs.getPropertyValue('--accent-g').trim() || 132;
    const B = cs.getPropertyValue('--accent-b').trim() || 252;
    const mid = h * 0.62;
    const amp = h * 0.42;

    for (let pass = 0; pass < 2; pass++) {
      const dir = pass ? -1 : 1;      // pass 1 is the mirrored reflection
      const trace = () => {
        this.cx.beginPath();
        this.cx.moveTo(0, mid);
        for (let i = 0; i < N; i++) {
          const x = (i/(N-1)) * w;
          const y = mid - dir * this.smooth[i] * amp;
          if (i === 0) this.cx.lineTo(x, y);
          else {
            const px = ((i-1)/(N-1)) * w;
            const py = mid - dir * this.smooth[i-1] * amp;
            this.cx.bezierCurveTo(px + (x-px)/2, py, px + (x-px)/2, y, x, y);
          }
        }
        this.cx.lineTo(w, mid);
      };

      // Fill first, then stroke over it, so the line stays crisp
      trace();
      this.cx.lineTo(w, mid); this.cx.lineTo(0, mid); this.cx.closePath();
      const g = this.cx.createLinearGradient(0, mid - dir*amp, 0, mid);
      g.addColorStop(0, `rgba(${R},${G},${B},${pass ? .10 : .26})`);
      g.addColorStop(1, 'rgba(34,211,238,0)');
      this.cx.fillStyle = g;
      this.cx.fill();

      trace();
      this.cx.save();
      this.cx.shadowColor = `rgba(${R},${G},${B},${pass ? .35 : .7})`;
      this.cx.shadowBlur = pass ? 6 : 14;
      this.cx.strokeStyle = `rgba(${R},${G},${B},${pass ? .5 : .88})`;
      this.cx.lineWidth = pass ? 1.3 : 2.1;
      this.cx.lineJoin = 'round';
      this.cx.stroke();
      this.cx.restore();
    }
  }
};

/* Pull the dominant colour off the cover so the page shifts hue per track */
function tintFromCover(url) {
  if (!url) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const rr = d[i], gg = d[i+1], bb = d[i+2];
        const mx = Math.max(rr,gg,bb), mn = Math.min(rr,gg,bb);
        // skip near-greys and near-blacks so the tint stays saturated
        if (mx - mn < 26 || mx < 48) continue;
        r += rr; g += gg; b += bb; n++;
      }
      if (!n) return;
      r = Math.round(r/n); g = Math.round(g/n); b = Math.round(b/n);
      // lift toward a usable accent brightness
      const mx = Math.max(r,g,b);
      if (mx < 170) { const k = 170/mx; r = Math.min(255,r*k)|0; g = Math.min(255,g*k)|0; b = Math.min(255,b*k)|0; }
      const root = document.documentElement.style;
      root.setProperty('--accent-r', r);
      root.setProperty('--accent-g', g);
      root.setProperty('--accent-b', b);
      root.setProperty('--primary', `rgb(${r},${g},${b})`);
    } catch (e) { /* tainted canvas — leave the default accent */ }
  };
  img.src = url;
}

/* ============================================================
   AUTH GATE
   ============================================================ */
const Auth = {
  gmsg(html, kind) {
    const e = $('gmsg'); if (!e) return;
    e.innerHTML = html;
    e.className = 'on' + (kind ? ' ' + kind : '');
  },

  renderButton() {
    if (!window.google || !google.accounts || !google.accounts.id) {
      setTimeout(() => this.renderButton(), 300); return;
    }
    try {
      google.accounts.id.initialize({
        client_id: AURA.CLIENT_ID,
        callback: r => this.onCredential(r),
        auto_select: false, cancel_on_tap_outside: true
      });
      google.accounts.id.renderButton($('gsi'),
        { theme:'filled_black', size:'large', shape:'pill', text:'signin_with' });
    } catch (e) {
      this.gmsg('Google sign-in could not load. Check that this domain is an authorised JavaScript origin on the OAuth client.', 'err');
    }
  },

  async onCredential(resp) {
    $('gsi').innerHTML = '<div class="spin"></div>';
    this.gmsg('Verifying…');
    try {
      const r = await fetch(`${AURA.API}?auth=1&token=${encodeURIComponent(resp.credential)}`);
      const d = await r.json();
      if (!d.ok) {
        $('gsi').innerHTML = ''; this.renderButton();
        this.gmsg('Sign-in failed: ' + esc(d.error || 'unknown'), 'err');
        return;
      }
      AURA.me = { session:d.session, email:d.email, name:d.name, picture:d.picture,
                  admin:!!d.admin, approver:!!d.approver, access:d.access };
      lsSet(AURA.K.session, AURA.me);
      this.apply();
    } catch (e) {
      $('gsi').innerHTML = ''; this.renderButton();
      this.gmsg('Could not reach the server: ' + esc(e.message), 'err');
    }
  },

  apply() {
    const me = AURA.me;
    if (!me) { this.renderButton(); return; }

    $('g-avatar').src = me.picture || '';
    $('g-name').textContent = me.name || me.email;
    $('g-email').textContent = me.email;
    $('guser').classList.add('on');
    $('gsi').innerHTML = '';
    $('g-out').style.display = 'inline-flex';

    if (me.access === 'approved') {
      $('gate').style.display = 'none';
      document.body.classList.add('signed-in');
      if (typeof onSignedIn === 'function') onSignedIn();
      return;
    }
    if (me.access === 'blocked') {
      $('g-copy').textContent = 'This account does not have access.';
      this.gmsg('Access was declined. If that seems wrong, ask the owner to re-enable it.', 'err');
    } else {
      $('g-copy').textContent = 'Your request has been sent.';
      this.gmsg('Waiting for approval. The page won\'t update on its own — check back once the owner has approved this account.', 'wait');
      $('g-retry').style.display = 'inline-flex';
    }
  },

  async recheck() {
    if (!AURA.me) return;
    try {
      const d = await api({ meta: 1 });
      if (d.access) { AURA.me.access = d.access; lsSet(AURA.K.session, AURA.me); this.apply(); }
      if (AURA.me.access !== 'approved') this.gmsg('Still waiting for approval.', 'wait');
    } catch (e) { this.gmsg('Could not check: ' + esc(e.message), 'err'); }
  },

  signOut() {
    try { localStorage.removeItem(AURA.K.session); } catch(e) {}
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    location.reload();
  },

  async resume() {
    const saved = lsGet(AURA.K.session, null);
    if (!saved || !saved.session) { this.renderButton(); return; }
    AURA.me = saved;
    try {
      const d = await api({ meta: 1 });
      if (d.needAuth || (!d.ok && !d.access)) { AURA.me = null; this.renderButton(); return; }
      if (d.access) AURA.me.access = d.access;
      if (typeof d.admin === 'boolean') AURA.me.admin = d.admin;
      if (typeof d.approver === 'boolean') AURA.me.approver = d.approver;
      lsSet(AURA.K.session, AURA.me);
      this.apply();
    } catch (e) {
      AURA.me = null; this.renderButton();
      this.gmsg('Session could not be restored. Sign in again.', 'err');
    }
  }
};

/* ============================================================
   PRESENCE — open endpoint, works on the gate too
   ============================================================ */
const Presence = {
  uid: null, fails: 0, timer: null,
  start() {
    try {
      this.uid = sessionStorage.getItem('aura_uid');
      if (!this.uid) { this.uid = 'u' + Math.floor(Math.random()*1e9); sessionStorage.setItem('aura_uid', this.uid); }
    } catch(e) { this.uid = 'u' + Math.floor(Math.random()*1e9); }
    this.beat();
  },
  async beat() {
    if (!document.hidden) {
      try {
        const r = await fetch(`${AURA.API}?uid=${encodeURIComponent(this.uid)}`);
        const d = await r.json();
        if (Array.isArray(d)) throw new Error('stale deployment');
        const n = $('onl-n'); if (n) n.textContent = Number(d.online) || 1;
        const dot = $('onl-d'); if (dot) dot.classList.remove('off');
        this.fails = 0;
      } catch (e) {
        this.fails++;
        if (this.fails >= 2) {
          const n = $('onl-n'); if (n) n.textContent = '–';
          const dot = $('onl-d'); if (dot) dot.classList.add('off');
        }
      }
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.beat(), 25000 * Math.pow(2, Math.min(4, this.fails)));
  }
};

/* ============================================================
   CLOCK
   ============================================================ */
function startClock(use24) {
  const t = $('clock-t'), d = $('clock-d');
  if (!t) return;
  const tick = () => {
    const n = new Date();
    let h = n.getHours();
    const m = String(n.getMinutes()).padStart(2,'0');
    const s = String(n.getSeconds()).padStart(2,'0');
    let mer = '';
    if (!use24) { mer = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; }
    t.innerHTML = `${use24 ? String(h).padStart(2,'0') : h}:${m}<span class="s">${s}</span>` +
      (mer ? `<span class="m">${mer}</span>` : '');
    if (d) d.textContent = n.toLocaleDateString(undefined, { weekday:'short', day:'numeric', month:'short' });
  };
  tick(); setInterval(tick, 1000);
}

/* ============================================================
   PLAYER
   ============================================================ */
const Player = {
  dlCtl: null, pfCtl: null, pfId: null,
  RING: 2 * Math.PI * 50,

  init() {
    AURA.audio = $('audio');
    AURA.audio.crossOrigin = 'anonymous';
    const a = AURA.audio;

    a.volume = 0.8;
    let tick = 0;

    a.ontimeupdate = () => {
      $('t-cur').textContent = fmtTime(a.currentTime);
      if (isFinite(a.duration)) {
        const p = a.currentTime / a.duration * 100;
        $('s-fg').style.width = p + '%';
        $('s-kn').style.left = p + '%';
        $('t-tot').textContent = fmtTime(a.duration);
      }
      if (++tick % 4 === 0) this.setPos();
      if (typeof onPlayTick === 'function') onPlayTick();
    };
    a.onprogress = () => {
      if (a.buffered.length && isFinite(a.duration))
        $('s-buf').style.width = (a.buffered.end(a.buffered.length-1)/a.duration*100) + '%';
    };
    a.onloadedmetadata = () => { $('t-tot').textContent = fmtTime(a.duration); this.setPos(); };
    a.onplay = () => {
      $('pp-i').className = 'fa-solid fa-pause';
      const img = $('np-img'); if (img) img.style.animationPlayState = 'running';
      $('np-a').classList.remove('err');
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      this.setPos();
      if (typeof onPlayState === 'function') onPlayState(true);
    };
    a.onpause = () => {
      $('pp-i').className = 'fa-solid fa-play';
      const img = $('np-img'); if (img) img.style.animationPlayState = 'paused';
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      if (typeof onPlayState === 'function') onPlayState(false);
    };
    a.onended = () => {
      if (typeof onTrackEnd === 'function' && onTrackEnd() === true) return;
      this.next();
    };
    a.onerror = () => {
      console.error('[Aura] audio error', a.error && a.error.code);
      $('np-a').textContent = 'Playback failed';
      $('np-a').classList.add('err');
    };

    $('c-pp').onclick = () => this.toggle();
    $('c-next').onclick = () => this.next();
    $('c-prev').onclick = () => this.prev();
    $('c-shuf').onclick = () => {
      AURA.shuffle = !AURA.shuffle;
      $('c-shuf').classList.toggle('on', AURA.shuffle);
    };
    $('c-mute').onclick = () => { a.muted = !a.muted; this.muteIcon(); };
    $('l-cancel').onclick = () => { if (this.dlCtl) this.dlCtl.abort(); this.hideLoad(); };

    this.wireSeek(); this.wireVol(); this.mediaSession();

    document.addEventListener('keydown', e => {
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
      if (e.code === 'ArrowRight' && isFinite(a.duration)) a.currentTime += 5;
      if (e.code === 'ArrowLeft' && isFinite(a.duration)) a.currentTime -= 5;
    });
  },

  toggle() {
    const a = AURA.audio;
    if (!a.src) { if (AURA.queue.length) this.playIdx(0); return; }
    if ($('np-a').classList.contains('err') && AURA.currentId) { this.play(AURA.currentId); return; }
    if (typeof onResumeContext === 'function') onResumeContext();
    a.paused ? a.play().catch(()=>{}) : a.pause();
  },
  idx() { return AURA.queue.findIndex(t => t.id === AURA.currentId); },
  playIdx(i) { if (i >= 0 && i < AURA.queue.length) this.play(AURA.queue[i].id); },
  next() {
    if (!AURA.queue.length) return;
    if (AURA.shuffle) return this.playIdx(Math.floor(Math.random()*AURA.queue.length));
    const i = this.idx();
    this.playIdx(i + 1 >= AURA.queue.length ? 0 : i + 1);
  },
  prev() {
    if (!AURA.queue.length) return;
    if (AURA.audio.currentTime > 3) { AURA.audio.currentTime = 0; return; }
    const i = this.idx();
    this.playIdx(i - 1 < 0 ? AURA.queue.length - 1 : i - 1);
  },

  async play(id) {
    const track = AURA.queue.find(t => t.id === id);
    if (!track) return;

    if (this.dlCtl) this.dlCtl.abort();
    this.cancelPrefetch();

    AURA.currentId = id;
    await readMeta(track);
    this.refreshNP();
    if (typeof renderQueue === 'function') renderQueue();

    $('s-fg').style.width = '0%';
    $('s-buf').style.width = '0%';

    let url = await DB.url(id);

    if (!url) {
      this.showLoad(track);
      this.dlCtl = new AbortController();
      try {
        const blob = await downloadTrack(track, (g,t,r) => this.onProgress(g,t,r), this.dlCtl.signal);
        await DB.put(id, blob);
        url = await DB.url(id);
        if (typeof updateCacheLine === 'function') updateCacheLine();
      } catch (err) {
        this.dlCtl = null; this.hideLoad();
        if (err.name === 'AbortError') return;
        console.error('[Aura] download failed:', err.message);
        $('np-a').textContent = 'Download failed — press play to retry';
        $('np-a').classList.add('err');
        return;
      }
      this.dlCtl = null; this.hideLoad();
    }

    if (typeof AURA.onGraphNeeded === 'function') await AURA.onGraphNeeded();

    AURA.audio.src = url;
    AURA.audio.load();
    if (typeof onResumeContext === 'function') onResumeContext();

    const p = AURA.audio.play();
    if (p && p.catch) p.catch(e => {
      if (e.name === 'NotAllowedError') $('np-a').textContent = 'Press play to start';
    });

    if (typeof AURA.onTrackChange === 'function') AURA.onTrackChange(track, url);
    if (typeof renderQueue === 'function') renderQueue();
    setTimeout(() => this.prefetchNext(), 1400);
  },

  refreshNP() {
    const t = AURA.queue.find(x => x.id === AURA.currentId);
    if (!t) return;
    const d = display(t);
    $('np-t').textContent = d.title;
    $('np-a').textContent = d.artist;
    $('np-a').classList.remove('err');
    const img = $('np-img');
    if (d.cover) { img.src = d.cover; img.style.display = 'block'; }
    else img.style.display = 'none';

    const bg = $('bg-art');
    if (bg) bg.style.backgroundImage = d.cover ? `url("${d.cover}")` : '';
    tintFromCover(d.cover);

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: d.title, artist: d.artist,
          album: d.album || t.folder || 'Aura Audiophile Space',
          artwork: d.cover ? [
            { src:d.cover, sizes:'96x96', type:'image/jpeg' },
            { src:d.cover, sizes:'256x256', type:'image/jpeg' },
            { src:d.cover, sizes:'512x512', type:'image/jpeg' }
          ] : []
        });
      } catch(e) {}
    }
  },

  setPos() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const a = AURA.audio;
    if (!isFinite(a.duration) || a.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: a.duration, playbackRate: a.playbackRate,
        position: Math.min(a.currentTime, a.duration)
      });
    } catch(e) {}
  },

  mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const a = AURA.audio;
    const h = (act, fn) => { try { navigator.mediaSession.setActionHandler(act, fn); } catch(e) {} };
    h('play', () => a.play());
    h('pause', () => a.pause());
    h('previoustrack', () => this.prev());
    h('nexttrack', () => this.next());
    h('seekbackward', d => { a.currentTime = Math.max(0, a.currentTime - (d.seekOffset||10)); });
    h('seekforward', d => { a.currentTime = Math.min(a.duration||0, a.currentTime + (d.seekOffset||10)); });
    h('seekto', d => { a.currentTime = d.seekTime; this.setPos(); });
    h('stop', () => { a.pause(); a.currentTime = 0; });
  },

  /* --- loading ring --- */
  showLoad(track) {
    const d = display(track);
    $('l-t').textContent = d.title;
    $('lr-n').textContent = '0';
    $('lr-fg').style.strokeDashoffset = this.RING;
    $('l-size').textContent = $('l-speed').textContent = $('l-eta').textContent = '—';
    $('load').classList.add('on');
    $('dock-load').classList.add('on');
  },
  onProgress(got, total, rate) {
    const p = total ? Math.min(100, got/total*100) : 0;
    $('lr-n').textContent = Math.round(p);
    $('lr-fg').style.strokeDashoffset = this.RING * (1 - p/100);
    $('l-size').textContent = total ? `${fmtBytes(got)} / ${fmtBytes(total)}` : fmtBytes(got);
    $('l-speed').textContent = rate ? fmtBytes(rate) + '/s' : '—';
    $('l-eta').textContent = (rate && total) ? fmtDur((total-got)/rate) : '—';
  },
  hideLoad() {
    $('load').classList.remove('on');
    $('dock-load').classList.remove('on');
  },

  /* --- prefetch --- */
  cancelPrefetch() {
    if (this.pfCtl) { this.pfCtl.abort(); this.pfCtl = null; }
    this.pfId = null;
    if (typeof renderQueue === 'function') renderQueue();
  },
  async prefetchNext() {
    const i = this.idx();
    if (i === -1 || AURA.queue.length < 2) return;
    const nxt = AURA.queue[(i+1) % AURA.queue.length];
    if (!nxt || DB.has(nxt.id) || this.pfId === nxt.id) return;

    this.cancelPrefetch();
    this.pfCtl = new AbortController();
    this.pfId = nxt.id;
    if (typeof renderQueue === 'function') renderQueue();
    try {
      const blob = await downloadTrack(nxt, null, this.pfCtl.signal);
      await DB.put(nxt.id, blob);
      await readMeta(nxt);
      if (typeof updateCacheLine === 'function') updateCacheLine();
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[Aura] prefetch failed:', e.message);
    } finally {
      this.pfCtl = null; this.pfId = null;
      if (typeof renderQueue === 'function') renderQueue();
    }
  },

  /* --- seek + volume --- */
  wireSeek() {
    const sk = $('seek'), a = AURA.audio;
    let pid = null;
    const at = x => {
      const r = sk.getBoundingClientRect();
      const p = clamp((x - r.left)/r.width, 0, 1);
      if (isFinite(a.duration)) { a.currentTime = p * a.duration; this.setPos(); }
      return p;
    };
    const tip = (x, p) => {
      if (!isFinite(a.duration)) return;
      const r = sk.getBoundingClientRect(), el = $('s-tip');
      el.style.left = (x - r.left) + 'px';
      el.textContent = fmtTime(p * a.duration);
      el.style.display = 'block';
    };
    sk.addEventListener('pointerdown', e => {
      pid = e.pointerId; sk.setPointerCapture(e.pointerId);
      sk.classList.add('drag'); tip(e.clientX, at(e.clientX));
    });
    sk.addEventListener('pointermove', e => {
      if (pid === e.pointerId) tip(e.clientX, at(e.clientX));
      else if (!AURA.isTouch && isFinite(a.duration)) {
        const r = sk.getBoundingClientRect();
        tip(e.clientX, clamp((e.clientX-r.left)/r.width, 0, 1));
      }
    });
    const end = e => {
      if (pid === e.pointerId) { pid = null; sk.classList.remove('drag'); $('s-tip').style.display = 'none'; }
    };
    sk.addEventListener('pointerup', end);
    sk.addEventListener('pointercancel', end);
    sk.addEventListener('pointerleave', () => { if (pid === null) $('s-tip').style.display = 'none'; });
  },
  wireVol() {
    const vb = $('volbar'), a = AURA.audio;
    let pid = null;
    const at = x => {
      const r = vb.getBoundingClientRect();
      const p = clamp((x - r.left)/r.width, 0, 1);
      a.volume = p; $('vol-fg').style.width = p*100 + '%';
      a.muted = false; this.muteIcon();
    };
    vb.addEventListener('pointerdown', e => { pid = e.pointerId; vb.setPointerCapture(e.pointerId); at(e.clientX); });
    vb.addEventListener('pointermove', e => { if (pid === e.pointerId) at(e.clientX); });
    vb.addEventListener('pointerup', e => { if (pid === e.pointerId) pid = null; });
  },
  muteIcon() {
    const a = AURA.audio;
    $('m-i').className = (a.muted || a.volume === 0) ? 'fa-solid fa-volume-xmark'
      : a.volume < 0.5 ? 'fa-solid fa-volume-low' : 'fa-solid fa-volume-high';
  }
};

/* ============================================================
   LIBRARY
   ============================================================ */
async function loadLibrary() {
  const d = await api({});
  if (!d.ok) {
    if (d.access) { AURA.me.access = d.access; Auth.apply(); return false; }
    throw new Error(d.error || 'Feed failed');
  }
  AURA.tracks = d.tracks || [];
  AURA.overrides = d.overrides || {};
  AURA.lastSync = d.lastSync;
  return true;
}

function loadFolder(folder) {
  AURA.folder = folder;
  const base = folder === 'all' ? AURA.tracks.slice() : AURA.tracks.filter(t => t.folder === folder);
  const saved = lsGet(AURA.K.order + folder, null);
  if (Array.isArray(saved)) {
    const byId = new Map(base.map(t => [t.id, t]));
    const out = [];
    saved.forEach(id => { if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); } });
    byId.forEach(t => out.push(t));
    AURA.queue = out;
  } else AURA.queue = base;
}
function saveOrder() { lsSet(AURA.K.order + AURA.folder, AURA.queue.map(t => t.id)); }

/** Read tags for the whole library, two at a time. */
async function hydrateMeta(onEach) {
  const list = AURA.queue.slice();
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const t = list[i++];
      await readMeta(t);
      if (onEach) onEach();
    }
  };
  await Promise.all([worker(), worker()]);
}

/* ============================================================
   FLOATING PARTICLES

   Slow drifting motes that rise and pulse with bass energy. They
   drift on their own even with no audio attached, so the page
   never looks dead.
   ============================================================ */
const Dust = {
  cv: null, cx: null, on: true, parts: [], analyser: null, energy: 0,

  init() {
    this.cv = $('dust');
    if (!this.cv) return;
    this.cx = this.cv.getContext('2d');
    this.on = lsGet('aura_dust', true);
    this.cv.classList.toggle('off', !this.on);
    this.size();
    addEventListener('resize', () => this.size());
    this.loop();
  },
  size() {
    if (!this.cv) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = Math.floor(innerWidth * dpr);
    this.cv.height = Math.floor(innerHeight * dpr);
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seed();
  },
  seed() {
    const n = innerWidth < 700 ? 34 : 64;
    this.parts = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: 0.6 + Math.random() * 1.9,
      vy: -(0.06 + Math.random() * 0.26),
      vx: (Math.random() - 0.5) * 0.13,
      a: 0.12 + Math.random() * 0.4,
      ph: Math.random() * Math.PI * 2
    }));
  },
  attach(an) { this.analyser = an; },
  toggle() {
    this.on = !this.on;
    lsSet('aura_dust', this.on);
    this.cv.classList.toggle('off', !this.on);
    if (!this.on) this.cx.clearRect(0, 0, innerWidth, innerHeight);
    return this.on;
  },

  loop() {
    requestAnimationFrame(() => this.loop());
    if (!this.on || !this.cx) return;

    // bass energy drives how lively the motes are
    if (this.analyser) {
      const b = new Uint8Array(24);
      this.analyser.getByteFrequencyData(b);
      let s = 0;
      for (let i = 0; i < 24; i++) s += b[i];
      this.energy += ((s / 24 / 255) - this.energy) * 0.08;
    } else this.energy += (0.1 - this.energy) * 0.02;

    const cs = getComputedStyle(document.documentElement);
    const R = cs.getPropertyValue('--accent-r').trim() || 192;
    const G = cs.getPropertyValue('--accent-g').trim() || 132;
    const B = cs.getPropertyValue('--accent-b').trim() || 252;

    const w = innerWidth, h = innerHeight;
    this.cx.clearRect(0, 0, w, h);
    const boost = 1 + this.energy * 2.4;
    const t = performance.now() / 1000;

    this.parts.forEach(p => {
      p.y += p.vy * boost;
      p.x += p.vx * boost + Math.sin(t * 0.35 + p.ph) * 0.14;
      if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
      if (p.x < -8) p.x = w + 8;
      if (p.x > w + 8) p.x = -8;

      const tw = 0.65 + 0.35 * Math.sin(t * 1.1 + p.ph);
      const rad = p.r * (1 + this.energy * 0.7);
      const g = this.cx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 4);
      g.addColorStop(0, `rgba(${R},${G},${B},${p.a * tw})`);
      g.addColorStop(1, `rgba(${R},${G},${B},0)`);
      this.cx.fillStyle = g;
      this.cx.beginPath();
      this.cx.arc(p.x, p.y, rad * 4, 0, Math.PI * 2);
      this.cx.fill();
    });
  }
};
