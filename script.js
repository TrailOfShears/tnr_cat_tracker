// ══════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════
let cats        = [];   // [{ id, name, colony, color, sex, age, bio }]
let observations= [];   // [{ id, cat_id, date, time, gps, location, bcs, fixed, trap, health, notes }]
let colonies    = [];   // [{ name, bounds? }]
let activeColony = localStorage.getItem('tnr_active_colony') || '';

let currentObsPhotos = [];
let currentPrimaryPhoto = null;
let linkedCatId = null;
let editingObsId = null;
const healthSelections = new Set();
let currentFilter = '';
let currentSearch = '';
let relationships  = [];

let colonyTileMap = null;
let logTileMap = null;
let colonyMapEditingIdx = null;
let catDetailTileMap = null;
let colonyOverviewMap = null;
let colonyOverviewMapIdx = null;

// ══════════════════════════════════════════════════════════════════
// DATABASE — IndexedDB via Dexie.js
// ══════════════════════════════════════════════════════════════════
const db = new Dexie('TNRTracker');
db.version(1).stores({
  cats:         'id',
  observations: 'id, cat_id',
  colonies:     'id',
  photos:       'key'
});
db.version(2).stores({
  relationships: '++id, catAId, catBId'
});

// In-memory photo cache — keeps render functions synchronous
const photoCache = new Map();

async function saveCats() {
  try { await db.cats.bulkPut(cats); return true; }
  catch(e) {
    alert('⚠ DATA NOT SAVED — Storage error!\n\nYour cat records could not be saved. Export your data immediately from the Stats tab before closing this page.');
    return false;
  }
}
async function saveObs() {
  try { await db.observations.bulkPut(observations); return true; }
  catch(e) {
    alert('⚠ DATA NOT SAVED — Storage error!\n\nYour observation could not be saved. Export your data immediately from the Stats tab before closing this page.');
    return false;
  }
}
async function saveColonies() {
  try { await db.colonies.bulkPut(colonies); }
  catch(e) { showToast('⚠ Colony save failed: ' + e.message); }
}

async function savePhotoCat(id, dataUrl) {
  const key = 'cat_' + id;
  if(!dataUrl) { photoCache.delete(key); await db.photos.delete(key); return true; }
  photoCache.set(key, dataUrl);
  try { await db.photos.put({ key, data: dataUrl }); return true; }
  catch(e) { showToast('⚠ Photo not saved — storage full. Export data from Stats tab.'); return false; }
}
function loadPhotoCat(id) { return photoCache.get('cat_' + id) || null; }
function deletePhotoCat(id) { savePhotoCat(id, null); }

async function savePhotosObs(id, photos) {
  const key = 'obs_' + id;
  if(!photos || !photos.length) { photoCache.delete(key); await db.photos.delete(key); return true; }
  photoCache.set(key, photos);
  try { await db.photos.put({ key, data: photos }); return true; }
  catch(e) { showToast('⚠ Observation photos not saved — storage full.'); return false; }
}
function loadPhotosObs(id) {
  const cached = photoCache.get('obs_' + id);
  return Array.isArray(cached) ? cached : [];
}
function deletePhotosObs(id) { savePhotosObs(id, []); }

async function loadAll() {
  const [dbCats, dbObs, dbColonies, dbPhotos, dbRels] = await Promise.all([
    db.cats.toArray(),
    db.observations.toArray(),
    db.colonies.toArray(),
    db.photos.toArray(),
    db.relationships.toArray()
  ]);

  // One-time migration from localStorage if IndexedDB is empty
  if(!dbCats.length && !dbObs.length) {
    await migrateFromLocalStorage();
    return;
  }

  cats = dbCats;
  observations = dbObs;
  colonies = dbColonies;
  relationships = dbRels;

  // Pre-populate photo cache for synchronous render access
  photoCache.clear();
  dbPhotos.forEach(p => photoCache.set(p.key, p.data));

  // Migrate legacy neutered/eartip → fixed (in-place, one-time)
  let migrated = false;
  observations.forEach(o => {
    if(!o.fixed && (o.neutered === 'Yes' || o.eartip === 'Yes')) {
      o.fixed = 'Yes'; migrated = true;
    }
  });
  if(migrated) saveObs();
}

async function migrateFromLocalStorage() {
  let lsCats = [], lsObs = [], lsColonies = [];
  try { lsCats = JSON.parse(localStorage.getItem('tnr_cats') || '[]'); } catch(e) {}
  try { lsObs  = JSON.parse(localStorage.getItem('tnr_obs')  || '[]'); } catch(e) {}
  try {
    const raw = JSON.parse(localStorage.getItem('tnr_colonies') || '[]');
    lsColonies = raw.map((c, i) => typeof c === 'string' ? { id: 'col_' + i, name: c } : { id: c.id || 'col_' + i, ...c });
  } catch(e) {}

  // v3 flat format: cats key has merged cat+obs data, obs key absent
  if(lsCats.length && !lsObs.length) {
    migrateFromV3(lsCats);   // populates cats[] and observations[] synchronously
    lsCats = cats; lsObs = observations;
  } else {
    cats = lsCats;
    observations = lsObs;
  }
  colonies = lsColonies;

  // Fix legacy neutered/eartip
  observations.forEach(o => {
    if(!o.fixed && (o.neutered === 'Yes' || o.eartip === 'Yes')) o.fixed = 'Yes';
  });

  // Migrate photos from localStorage keys → IndexedDB + photoCache
  const photoEntries = [];
  for(let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if(!k || !k.startsWith('tnr_photo')) continue;
    const raw = localStorage.getItem(k);
    if(!raw) continue;
    let idbKey, data;
    if(k.startsWith('tnr_photo_cat_')) {
      idbKey = 'cat_' + k.slice('tnr_photo_cat_'.length);
      data = raw;
    } else if(k.startsWith('tnr_photo_obs_')) {
      idbKey = 'obs_' + k.slice('tnr_photo_obs_'.length);
      try { data = JSON.parse(raw); } catch { data = raw; }
    } else if(k.startsWith('tnr_photo_')) {
      // v3 legacy: tnr_photo_<id>
      idbKey = 'legacy_' + k.slice('tnr_photo_'.length);
      try { data = JSON.parse(raw); } catch { data = raw; }
    } else continue;
    photoEntries.push({ key: idbKey, data });
    photoCache.set(idbKey, data);
  }

  if(lsCats.length || lsObs.length) {
    await Promise.all([
      db.cats.bulkPut(cats),
      db.observations.bulkPut(observations),
      db.colonies.bulkPut(colonies.filter(c => c.id)),
      db.photos.bulkPut(photoEntries)
    ]);
    showToast(`✓ Migrated ${cats.length} cats, ${observations.length} obs to database`);
  }
}

function migrateFromV3(oldCats) {
  cats = []; observations = [];
  const catsByName = new Map();
  oldCats.forEach(old => {
    const key = (old.name || '').toLowerCase().trim() || old.id;
    let cat;
    if(catsByName.has(key)) {
      cat = catsByName.get(key);
    } else {
      cat = { id: 'cat_' + old.id, name: old.name || 'Unknown', colony: old.colony || '', color: old.color || '', sex: old.sex || '', age: old.age || '' };
      cats.push(cat);
      catsByName.set(key, cat);
      const oldPhotos = loadPhotosObs_legacy(old.id);
      if(oldPhotos && oldPhotos.length) {
        savePhotoCat(cat.id, oldPhotos[0]);
        if(oldPhotos.length > 1) savePhotosObs('obs_' + old.id, oldPhotos.slice(1));
      }
    }
    observations.push({
      id: 'obs_' + old.id,
      cat_id: cat.id,
      date: old.date || '', time: old.time || '',
      gps: old.gps || '', location: old.location || '',
      bcs: old.bcs || '',
      fixed: (old.neutered === 'Yes' || old.eartip === 'Yes') ? 'Yes' : (old.neutered || old.eartip || ''),
      trap: old.trap || '',
      health: old.health || '', notes: old.notes || '',
    });
  });
  showToast(`✓ Migrated ${oldCats.length} records`);
}

function loadPhotosObs_legacy(id) {
  try { return JSON.parse(localStorage.getItem('tnr_photo_' + id) || 'null') || []; }
  catch(e) { return []; }
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════
function latestObs(cat_id) {
  const obs = observations.filter(o => o.cat_id === cat_id);
  if(!obs.length) return null;
  return obs.reduce((a, b) => (a.date + a.time) > (b.date + b.time) ? a : b);
}

function derivedStatus(cat_id) {
  const obs = observations.filter(o => o.cat_id === cat_id)
    .sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
  const d = { fixed: '', trap: '', health: '', bcs: '', gps: '', location: '' };
  obs.forEach(o => {
    Object.keys(d).forEach(k => { if(!d[k] && o[k]) d[k] = o[k]; });
    if(o.fixed === 'Yes' || o.neutered === 'Yes' || o.eartip === 'Yes') d.fixed = 'Yes';
  });
  return d;
}

function getCatById(id) { return cats.find(c => c.id === id) || null; }

const TRAP_ORDER = ['Not Trapped', 'Trapped Today', 'Released', 'In Transit', 'At Clinic', 'Returned'];

function filterTrapPills(catId) {
  const group = document.getElementById('pg-trap');
  if(!group) return;
  const currentTrap = catId ? (derivedStatus(catId).trap || '') : '';
  const currentIdx = TRAP_ORDER.indexOf(currentTrap);
  group.querySelectorAll('.pill').forEach(p => {
    const pillIdx = TRAP_ORDER.indexOf(p.dataset.val);
    // Lock pills that are strictly before the current status (only when cat has a trap record)
    p.classList.toggle('pill-locked', currentIdx > 0 && pillIdx < currentIdx);
  });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════
async function init() {
  await loadAll();
  setDateTime();
  setupPillListeners();
  syncColonyDropdowns();
  if(activeColony) document.getElementById('f-colony').value = activeColony;
  renderCats();
  renderColonies();
  renderStats();
  updateColonyBadge();
  checkGPSAvailability();
  renderPrimaryPhotoRow();
  renderObsPhotoRow();
  document.getElementById('f-colony').addEventListener('change', onFormColonyChange);
}

function setDateTime() {
  const now = new Date();
  document.getElementById('f-date').value = now.toISOString().split('T')[0];
  document.getElementById('f-time').value = now.toTimeString().slice(0,5);
}

// ══════════════════════════════════════════════════════════════════
// GPS
// ══════════════════════════════════════════════════════════════════
function checkGPSAvailability() {
  const isFile = location.protocol === 'file:';
  const isInsecure = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  if(isFile || isInsecure) document.getElementById('gps-note').style.display = 'block';
}

function getGPS() {
  const status = document.getElementById('gps-status');
  if(!navigator.geolocation) { status.textContent = '✗ Geolocation not supported.'; return; }
  if(location.protocol === 'file:') {
    document.getElementById('gps-note').style.display = 'block';
    status.textContent = '✗ GPS blocked — file:// protocol. See note below.';
    return;
  }
  status.textContent = '⌛ Acquiring GPS...';
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      document.getElementById('f-gps').value = `${lat}, ${lng}`;
      status.textContent = `✓ Accuracy: ±${Math.round(pos.coords.accuracy)}m`;
    },
    err => {
      let msg = err.message;
      if(err.code === 1) msg = 'Permission denied.';
      if(err.code === 2) msg = 'Position unavailable. Try outdoors.';
      if(err.code === 3) msg = 'Timed out. Try again.';
      status.textContent = '✗ ' + msg;
      document.getElementById('gps-note').style.display = 'block';
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

// ══════════════════════════════════════════════════════════════════
// TILE MAP ENGINE
// ══════════════════════════════════════════════════════════════════
class TileMap {
  constructor(canvasEl, opts = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.tileSize = 256;
    this.minZoom = 2; this.maxZoom = 19;
    this.lat = opts.lat || 39.5;
    this.lng = opts.lng || -98.35;
    this.zoom = opts.zoom || 15;
    this.pinLat = null; this.pinLng = null;
    this.markers = [];
    this.onPan = opts.onPan || null;
    this.onTap = opts.onTap || null;
    this.onMarkerTap = opts.onMarkerTap || null;
    this.showBounds = opts.showBounds || null;
    this._tiles = new Map();
    this._drag = null; this._lastPinch = null; this._hasDragged = false;
    this._dpr = window.devicePixelRatio || 1;
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvasEl.parentElement || canvasEl);
    this._bindEvents();
    this._resize();
  }

  destroy() { this._ro.disconnect(); this._removeEvents && this._removeEvents(); }

  get _w() { return this.canvas.width / this._dpr; }
  get _h() { return this.canvas.height / this._dpr; }

  _latToY(lat, z) {
    const sinLat = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * (this.tileSize << z);
  }
  _lngToX(lng, z) { return (lng / 360 + 0.5) * (this.tileSize << z); }
  _yToLat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / (this.tileSize << z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  _xToLng(x, z) { return (x / (this.tileSize << z) - 0.5) * 360; }

  canvasToLatLng(cx, cy) {
    const worldX = this._lngToX(this.lng, this.zoom) + (cx - this._w / 2);
    const worldY = this._latToY(this.lat, this.zoom) + (cy - this._h / 2);
    return { lat: this._yToLat(worldY, this.zoom), lng: this._xToLng(worldX, this.zoom) };
  }
  latLngToCanvas(lat, lng) {
    return {
      x: this._lngToX(lng, this.zoom) - this._lngToX(this.lng, this.zoom) + this._w / 2,
      y: this._latToY(lat, this.zoom) - this._latToY(this.lat, this.zoom) + this._h / 2,
    };
  }

  getBounds() {
    const sw = this.canvasToLatLng(0, this._h);
    const ne = this.canvasToLatLng(this._w, 0);
    return { sw: [sw.lat, sw.lng], ne: [ne.lat, ne.lng] };
  }

  setView(lat, lng, zoom) {
    this.lat = lat; this.lng = lng;
    if(zoom !== undefined) this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this.draw();
    this.onPan && this.onPan(this);
  }

  fitBounds(sw, ne, minZ) {
    minZ = minZ !== undefined ? minZ : 15;
    this.lat = (sw[0] + ne[0]) / 2;
    this.lng = (sw[1] + ne[1]) / 2;
    const w = this._w || 400, h = this._h || 300;
    for(let z = this.maxZoom; z >= this.minZoom; z--) {
      const dx = Math.abs(this._lngToX(ne[1], z) - this._lngToX(sw[1], z));
      const dy = Math.abs(this._latToY(sw[0], z) - this._latToY(ne[0], z));
      if(dx <= w * 0.85 && dy <= h * 0.85) { this.zoom = Math.max(z, minZ); break; }
    }
    this.draw();
    this.onPan && this.onPan(this);
  }

  setMarkers(markers) { this.markers = markers || []; this.draw(); }

  fitMarkers(markers, minZ) {
    if(!markers || !markers.length) return;
    minZ = minZ !== undefined ? minZ : 15;
    if(markers.length === 1) { this.setView(markers[0].lat, markers[0].lng, minZ); return; }
    const lats = markers.map(m => m.lat);
    const lngs = markers.map(m => m.lng);
    const latPad = (Math.max(...lats) - Math.min(...lats)) * 0.2 || 0.002;
    const lngPad = (Math.max(...lngs) - Math.min(...lngs)) * 0.2 || 0.002;
    this.fitBounds(
      [Math.min(...lats) - latPad, Math.min(...lngs) - lngPad],
      [Math.max(...lats) + latPad, Math.max(...lngs) + lngPad],
      minZ
    );
  }

  zoom_(delta, aroundX, aroundY) {
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + delta));
    if(newZoom === this.zoom) return;
    const ax = aroundX !== undefined ? aroundX : this._w / 2;
    const ay = aroundY !== undefined ? aroundY : this._h / 2;
    const before = this.canvasToLatLng(ax, ay);
    this.zoom = newZoom;
    const after = this.latLngToCanvas(before.lat, before.lng);
    this.lat = this._yToLat(this._latToY(this.lat, this.zoom) + (after.y - ay), this.zoom);
    this.lng = this._xToLng(this._lngToX(this.lng, this.zoom) + (after.x - ax), this.zoom);
    this.draw();
    this.onPan && this.onPan(this);
  }

  setPin(lat, lng) { this.pinLat = lat; this.pinLng = lng; this.draw(); }

  _tileUrl(x, y, z) {
    const s = ['a','b','c'][Math.abs(x + y) % 3];
    return `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
  }
  _loadTile(url) {
    if(this._tiles.has(url)) return this._tiles.get(url);
    this._tiles.set(url, 'loading');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      createImageBitmap(img).then(bm => { this._tiles.set(url, bm); this.draw(); })
                            .catch(() => this._tiles.set(url, 'error'));
    };
    img.onerror = () => { this._tiles.set(url, 'error'); this.draw(); };
    img.src = url;
    return 'loading';
  }

  draw() {
    const ctx = this.ctx;
    const w = this._w, h = this._h;
    if(!w || !h) return;

    ctx.save();
    ctx.fillStyle = '#1a1d27';
    ctx.fillRect(0, 0, w, h);

    const z = this.zoom, ts = this.tileSize;
    const worldX = this._lngToX(this.lng, z);
    const worldY = this._latToY(this.lat, z);
    const originX = w / 2 - worldX;
    const originY = h / 2 - worldY;

    const tileXStart = Math.floor(-originX / ts);
    const tileYStart = Math.floor(-originY / ts);
    const tileXEnd = Math.ceil((w - originX) / ts);
    const tileYEnd = Math.ceil((h - originY) / ts);
    const maxTile = 1 << z;

    let anyMissing = false;
    for(let tx = tileXStart; tx < tileXEnd; tx++) {
      for(let ty = tileYStart; ty < tileYEnd; ty++) {
        const px = originX + tx * ts;
        const py = originY + ty * ts;
        const wtx = ((tx % maxTile) + maxTile) % maxTile;
        if(ty < 0 || ty >= maxTile) {
          ctx.fillStyle = '#232636'; ctx.fillRect(px, py, ts, ts); continue;
        }
        const url = this._tileUrl(wtx, ty, z);
        const tile = this._loadTile(url);
        if(tile && tile !== 'loading' && tile !== 'error') {
          ctx.drawImage(tile, px, py, ts, ts);
        } else {
          anyMissing = true;
          ctx.fillStyle = '#232636'; ctx.fillRect(px, py, ts, ts);
          ctx.strokeStyle = '#2e3248'; ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, ts - 1, ts - 1);
          if(tile !== 'loading') {
            ctx.fillStyle = '#3d4260'; ctx.font = '11px monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(`${z}/${wtx}/${ty}`, px + ts/2, py + ts/2);
          }
        }
      }
    }

    if(anyMissing) {
      ctx.fillStyle = 'rgba(15,17,23,0.62)';
      ctx.fillRect(0, h - 22, w, 22);
      ctx.fillStyle = '#7b819e'; ctx.font = '10px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Map tiles load with internet · Coordinates work offline', w/2, h - 11);
    }

    if(this.showBounds) {
      const { sw, ne } = this.showBounds;
      const p1 = this.latLngToCanvas(sw[0], sw[1]);
      const p2 = this.latLngToCanvas(ne[0], ne[1]);
      ctx.save();
      ctx.strokeStyle = '#f0a500'; ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]); ctx.globalAlpha = 0.7;
      ctx.strokeRect(p1.x, p2.y, p2.x - p1.x, p1.y - p2.y);
      ctx.fillStyle = '#f0a500'; ctx.globalAlpha = 0.06;
      ctx.fillRect(p1.x, p2.y, p2.x - p1.x, p1.y - p2.y);
      ctx.restore();
    }

    if(this.pinLat !== null) {
      const { x, y } = this.latLngToCanvas(this.pinLat, this.pinLng);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#e05c5c'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.restore();
      ctx.beginPath(); ctx.moveTo(x, y + 10); ctx.lineTo(x, y + 18);
      ctx.strokeStyle = '#e05c5c'; ctx.lineWidth = 2; ctx.stroke();
    }

    // Multi-marker rendering
    (this.markers || []).forEach(m => {
      const { x, y } = this.latLngToCanvas(m.lat, m.lng);
      if(x < -20 || x > w + 20 || y < -20 || y > h + 20) return;
      const r = m.size || 8;
      ctx.save();
      ctx.globalAlpha = m.alpha !== undefined ? m.alpha : 1;
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = m.color || '#f0a500'; ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      if(m.label) {
        ctx.save();
        ctx.globalAlpha = m.alpha !== undefined ? m.alpha : 1;
        ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
        const lw = ctx.measureText(m.label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(x - lw/2 - 3, y - r - 17, lw + 6, 13);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
        ctx.fillText(m.label, x, y - r - 11);
        ctx.restore();
      }
    });

    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, h - 14, 160, 14);
    ctx.fillStyle = '#7b819e'; ctx.font = '9px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('© OpenStreetMap contributors', 4, h - 7);

    ctx.restore();
  }

  _resize() {
    this._dpr = window.devicePixelRatio || 1;
    const wrap = this.canvas.parentElement || this.canvas;
    const cssW = wrap.clientWidth;
    // If container has no width, section is still display:none or mid-layout.
    // Return early — ResizeObserver will fire again once the element is visible.
    if(!cssW) return;
    const cssH = parseInt(this.canvas.style.height) || 240;
    this.canvas.width = cssW * this._dpr;
    this.canvas.height = cssH * this._dpr;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    this.draw();
  }

  _clientToCanvas(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  _bindEvents() {
    const c = this.canvas;
    const onMouseDown = e => { e.preventDefault(); const p = this._clientToCanvas(e.clientX, e.clientY); this._drag = p; this._hasDragged = false; };
    const onMouseMove = e => {
      if(!this._drag) return;
      const p = this._clientToCanvas(e.clientX, e.clientY);
      const dx = p.x - this._drag.x, dy = p.y - this._drag.y;
      if(Math.abs(dx) > 3 || Math.abs(dy) > 3) this._hasDragged = true;
      this._drag = p; this._pan(dx, dy);
    };
    const onMouseUp = e => {
      if(!this._hasDragged && this._drag) { const p = this._clientToCanvas(e.clientX, e.clientY); this._tapAt(p.x, p.y); }
      this._drag = null;
    };
    const onWheel = e => {
      e.preventDefault();
      const p = this._clientToCanvas(e.clientX, e.clientY);
      this.zoom_(e.deltaY < 0 ? 1 : -1, p.x, p.y);
    };
    const onTouchStart = e => {
      e.preventDefault();
      if(e.touches.length === 1) {
        const p = this._clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
        this._drag = p; this._hasDragged = false; this._lastPinch = null;
      } else if(e.touches.length === 2) {
        this._drag = null;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this._lastPinch = Math.sqrt(dx*dx + dy*dy);
      }
    };
    const onTouchMove = e => {
      e.preventDefault();
      if(e.touches.length === 1 && this._drag) {
        const p = this._clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
        const dx = p.x - this._drag.x, dy = p.y - this._drag.y;
        if(Math.abs(dx) > 3 || Math.abs(dy) > 3) this._hasDragged = true;
        this._drag = p; this._pan(dx, dy);
      } else if(e.touches.length === 2 && this._lastPinch !== null) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const mid = this._clientToCanvas(midX, midY);
        if(dist / this._lastPinch > 1.3) { this.zoom_(1, mid.x, mid.y); this._lastPinch = dist; }
        else if(dist / this._lastPinch < 0.77) { this.zoom_(-1, mid.x, mid.y); this._lastPinch = dist; }
      }
    };
    const onTouchEnd = e => {
      if(e.changedTouches.length === 1 && !this._hasDragged && this._drag) {
        const p = this._clientToCanvas(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        this._tapAt(p.x, p.y);
      }
      this._drag = null; this._lastPinch = null;
    };

    c.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    c.addEventListener('touchmove', onTouchMove, { passive: false });
    c.addEventListener('touchend', onTouchEnd);

    this._removeEvents = () => {
      c.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('touchstart', onTouchStart);
      c.removeEventListener('touchmove', onTouchMove);
      c.removeEventListener('touchend', onTouchEnd);
    };
  }

  _pan(dx, dy) {
    this.lat = this._yToLat(this._latToY(this.lat, this.zoom) - dy, this.zoom);
    this.lng = this._xToLng(this._lngToX(this.lng, this.zoom) - dx, this.zoom);
    this.draw();
    this.onPan && this.onPan(this);
  }

  _tapAt(cx, cy) {
    const ms = this.markers || [];
    for(let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      const { x, y } = this.latLngToCanvas(m.lat, m.lng);
      if(Math.hypot(cx - x, cy - y) < (m.size || 8) + 8) {
        this.onMarkerTap && this.onMarkerTap(m);
        return;
      }
    }
    this.onTap && this.onTap(this.canvasToLatLng(cx, cy));
  }
}

function tileMapZoom(map, delta) { if(map) map.zoom_(delta); }

// ══════════════════════════════════════════════════════════════════
// COLONY MAP SETUP
// ══════════════════════════════════════════════════════════════════
function openColonyMapSetup(colonyIdx) {
  colonyMapEditingIdx = colonyIdx;
  const col = colonies[colonyIdx];
  document.getElementById('colony-map-modal-title').textContent = `Territory: ${col.name}`;
  document.getElementById('colony-map-status').textContent = '';
  document.getElementById('colony-map-modal').classList.add('open');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if(colonyTileMap) { colonyTileMap.destroy(); colonyTileMap = null; }
    colonyTileMap = new TileMap(document.getElementById('colony-setup-map'), { onPan: updateColonyBoundsDisplay });

    if(col.bounds) {
      colonyTileMap.fitBounds(col.bounds.sw, col.bounds.ne);
    } else if(navigator.geolocation && location.protocol !== 'file:') {
      navigator.geolocation.getCurrentPosition(
        pos => colonyTileMap.setView(pos.coords.latitude, pos.coords.longitude, 17),
        () => colonyTileMap.setView(39.5, -98.35, 17),
        { timeout: 4000 }
      );
    } else {
      colonyTileMap.setView(39.5, -98.35, 17);
    }
    updateColonyBoundsDisplay();
  }));
}

function updateColonyBoundsDisplay(map) {
  const m = map || colonyTileMap;
  if(!m) return;
  const b = m.getBounds();
  document.getElementById('colony-map-bounds-display').textContent =
    `SW: ${b.sw[0].toFixed(5)}, ${b.sw[1].toFixed(5)}  ·  NE: ${b.ne[0].toFixed(5)}, ${b.ne[1].toFixed(5)}`;
}

function searchColonyMapAddress() {
  const q = document.getElementById('colony-map-search').value.trim();
  if(!q) return;
  const status = document.getElementById('colony-map-status');
  status.textContent = 'Searching...';
  fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`)
    .then(r => r.json())
    .then(data => {
      if(data.length) {
        const { lat, lon, boundingbox } = data[0];
        if(boundingbox && colonyTileMap) {
          colonyTileMap.fitBounds(
            [parseFloat(boundingbox[0]), parseFloat(boundingbox[2])],
            [parseFloat(boundingbox[1]), parseFloat(boundingbox[3])]
          );
        } else if(colonyTileMap) {
          colonyTileMap.setView(parseFloat(lat), parseFloat(lon), 17);
        }
        status.textContent = `✓ Found: ${data[0].display_name.split(',').slice(0,3).join(',')}`;
      } else {
        status.textContent = '✗ Address not found.';
      }
    })
    .catch(() => { status.textContent = '✗ No internet — pan the map manually.'; });
}

function saveColonyMapBounds() {
  if(colonyMapEditingIdx === null || !colonyTileMap) return;
  const b = colonyTileMap.getBounds();
  const col = colonies[colonyMapEditingIdx];
  col.bounds = { sw: b.sw, ne: b.ne, zoom: colonyTileMap.zoom, center: [colonyTileMap.lat, colonyTileMap.lng] };
  saveColonies();
  renderColonies();
  syncColonyDropdowns();
  const name = col.name;
  closeColonyMapModal();
  showToast(`✓ Territory saved for ${name}`);
}

function closeColonyMapModal() {
  document.getElementById('colony-map-modal').classList.remove('open');
  colonyMapEditingIdx = null;
}
function closeColonyMapIfOutside(e) {
  if(e.target === document.getElementById('colony-map-modal')) closeColonyMapModal();
}

// ══════════════════════════════════════════════════════════════════
// LOG MAP
// ══════════════════════════════════════════════════════════════════
function updateOwnerList(colony, listId) {
  const colonyCats = colony
    ? cats.filter(c => c.colony === colony)
    : cats;
  const unique = [...new Set(colonyCats.map(c => c.owner).filter(Boolean))];
  const defaults = ['Feral', 'Community', 'Owned'];
  const all = [...new Set([...defaults, ...unique])];
  const el = document.getElementById(listId);
  if(el) el.innerHTML = all.map(v => `<option value="${esc(v)}">`).join('');
}

function onFormColonyChange() {
  const name = document.getElementById('f-colony').value;
  updateOwnerList(name, 'f-owner-list');
  const col = colonies.find(c => c.name === name);
  const section = document.getElementById('colony-map-section');

  if(col && col.bounds) {
    section.style.display = 'block';
    document.getElementById('log-map-hint').textContent =
      `Tap the map to mark where you saw this cat in the ${col.name} territory.`;
    // Double rAF ensures the browser has completed layout after display:block
    // before we read clientWidth in TileMap._resize(). A fixed setTimeout
    // is unreliable on mobile where layout can take longer than 80ms.
    requestAnimationFrame(() => requestAnimationFrame(() => initLogMap(col)));
  } else {
    section.style.display = 'none';
    if(logTileMap) { logTileMap.destroy(); logTileMap = null; }
    document.getElementById('log-map-coords').textContent = '';
    document.getElementById('log-map-label').textContent = 'Tap map to drop pin';
  }
}

function initLogMap(colony) {
  if(logTileMap) { logTileMap.destroy(); logTileMap = null; }
  const b = colony.bounds;
  logTileMap = new TileMap(document.getElementById('log-map'), {
    showBounds: b,
    onTap: ({ lat, lng }) => {
      const coords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      logTileMap.setPin(lat, lng);
      document.getElementById('f-gps').value = coords;
      document.getElementById('log-map-coords').textContent = `📍 ${coords}`;
      document.getElementById('log-map-label').textContent = '✓ Pin placed — tap to move';
      document.getElementById('gps-status').textContent = '✓ Coordinates from map pin';
    },
  });
  logTileMap.fitBounds(b.sw, b.ne);

  const existingGPS = document.getElementById('f-gps').value.trim();
  if(existingGPS) {
    const parts = existingGPS.split(',');
    if(parts.length === 2) {
      const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
      if(!isNaN(lat) && !isNaN(lng)) {
        logTileMap.setPin(lat, lng);
        document.getElementById('log-map-coords').textContent = `📍 ${existingGPS}`;
        document.getElementById('log-map-label').textContent = '✓ Pin placed — tap to move';
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// PILLS
// ══════════════════════════════════════════════════════════════════
function setupPillListeners() {
  const singleGroups = {
    'pg-color': 'f-color',
    'pg-sex': 'f-sex',
    'pg-age': 'f-age',
    'pg-bcs': 'f-bcs',
    'pg-fixed': 'f-fixed',
    'pg-trap': 'f-trap',
  };
  Object.entries(singleGroups).forEach(([groupId, fieldId]) => {
    const group = document.getElementById(groupId);
    if(!group) return;
    group.addEventListener('click', e => {
      const pill = e.target.closest('.pill');
      if(!pill) return;
      const wasActive = pill.classList.contains('active');
      group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      if(!wasActive) {
        pill.classList.add('active');
        document.getElementById(fieldId).value = pill.dataset.val;
        if(groupId === 'pg-color') document.getElementById('f-color').value = pill.dataset.val;
      } else {
        document.getElementById(fieldId).value = '';
      }
    });
  });

  document.getElementById('f-color').addEventListener('input', () => {
    document.getElementById('pg-color').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  });

  // Edit-profile modal pill listeners
  const epGroups = { 'ep-pg-color': 'ep-color', 'ep-pg-sex': 'ep-sex', 'ep-pg-age': 'ep-age' };
  Object.entries(epGroups).forEach(([groupId, fieldId]) => {
    document.getElementById(groupId).addEventListener('click', e => {
      const pill = e.target.closest('.pill');
      if(!pill) return;
      const wasActive = pill.classList.contains('active');
      document.getElementById(groupId).querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      if(!wasActive) {
        pill.classList.add('active');
        document.getElementById(fieldId).value = pill.dataset.val;
        if(groupId === 'ep-pg-color') document.getElementById('ep-color').value = pill.dataset.val;
      } else {
        document.getElementById(fieldId).value = '';
      }
    });
  });

  document.getElementById('ep-color').addEventListener('input', () => {
    document.getElementById('ep-pg-color').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  });

  const healthGroup = document.getElementById('pg-health');
  healthGroup.addEventListener('click', e => {
    const pill = e.target.closest('.pill');
    if(!pill) return;
    pill.classList.toggle('active');
    const val = pill.dataset.val;
    if(pill.classList.contains('active')) healthSelections.add(val);
    else healthSelections.delete(val);
    document.getElementById('f-health').value = [...healthSelections].join(', ');
  });
}

function setPillValue(groupId, val) {
  const group = document.getElementById(groupId);
  if(!group || !val) return;
  group.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.val === val));
}

function setMultiPillValues(groupId, vals) {
  const group = document.getElementById(groupId);
  if(!group || !vals) return;
  const arr = vals.split(', ').map(s => s.trim());
  group.querySelectorAll('.pill').forEach(p => {
    const active = arr.includes(p.dataset.val);
    p.classList.toggle('active', active);
    if(active) healthSelections.add(p.dataset.val);
    else healthSelections.delete(p.dataset.val);
  });
}

// ══════════════════════════════════════════════════════════════════
// CAT PICKER MODAL
// ══════════════════════════════════════════════════════════════════
function openCatPickerModal() {
  if(editingObsId) return;
  if(!cats.length) { showToast('No cats logged yet'); return; }
  const grid = document.getElementById('cat-picker-grid');
  grid.innerHTML = cats.map(cat => {
    const photo = loadPhotoCat(cat.id);
    const avatar = photo ? `<img src="${photo}">` : `<span style="font-size:1.4rem">🐱</span>`;
    return `<div class="known-cat-item" onclick="linkCat('${cat.id}')">
      <div class="known-cat-avatar">${avatar}</div>
      <div class="known-cat-name">${esc(cat.name)}</div>
      <div class="known-cat-detail">${esc(cat.color||'')}${cat.sex?' · '+esc(cat.sex):''}</div>
    </div>`;
  }).join('');
  document.getElementById('cat-picker-modal').classList.add('open');
}

function closeCatPickerModal() { document.getElementById('cat-picker-modal').classList.remove('open'); }
function closeCatPickerIfOutside(e) { if(e.target === document.getElementById('cat-picker-modal')) closeCatPickerModal(); }

function linkCat(catId) {
  closeCatPickerModal();
  const cat = getCatById(catId);
  if(!cat) return;
  linkedCatId = catId;

  document.getElementById('f-name').value = cat.name || '';
  document.getElementById('f-color').value = cat.color || '';
  if(cat.colony) document.getElementById('f-colony').value = cat.colony;
  setPillValue('pg-color', cat.color);
  setPillValue('pg-sex', cat.sex); document.getElementById('f-sex').value = cat.sex || '';
  setPillValue('pg-age', cat.age); document.getElementById('f-age').value = cat.age || '';
  document.getElementById('f-owner').value = cat.owner || 'Feral';
  updateOwnerList(cat.colony, 'f-owner-list');

  const photo = loadPhotoCat(catId);
  currentPrimaryPhoto = photo;
  renderPrimaryPhotoRow();

  lockIdentitySection(true);
  updateCatLinkBar(cat);
  filterTrapPills(catId);
  onFormColonyChange();

  // Pre-fill observation fields from most recent sighting
  const last = latestObs(catId);
  if(last) {
    setPillValue('pg-bcs', last.bcs); document.getElementById('f-bcs').value = last.bcs || '';
    const fixedVal = last.fixed || (last.neutered === 'Yes' || last.eartip === 'Yes' ? 'Yes' : '');
    setPillValue('pg-fixed', fixedVal); document.getElementById('f-fixed').value = fixedVal;
    setPillValue('pg-trap', last.trap); document.getElementById('f-trap').value = last.trap || '';
    if(last.health) {
      healthSelections.clear();
      setMultiPillValues('pg-health', last.health);
      document.getElementById('f-health').value = last.health;
    }
  }

  showToast(`✓ Linked to ${cat.name}`);
}

function unlinkCat() {
  linkedCatId = null;
  lockIdentitySection(false);
  filterTrapPills(null);
  document.getElementById('cat-link-bar').classList.remove('linked');
  document.getElementById('cat-link-sub').textContent = 'Tap to pick from your roster, or fill in below for a new cat';
  document.getElementById('cat-link-arrow').textContent = '›';
  currentPrimaryPhoto = null;
  renderPrimaryPhotoRow();
}

function lockIdentitySection(locked) {
  const section = document.getElementById('identity-section');
  const label = document.getElementById('identity-locked-label');
  if(locked) {
    section.classList.add('linked', 'locked');
    label.classList.add('show');
  } else {
    section.classList.remove('linked', 'locked');
    label.classList.remove('show');
  }
}

function updateCatLinkBar(cat) {
  const bar = document.getElementById('cat-link-bar');
  bar.classList.add('linked');
  document.getElementById('cat-link-sub').textContent = `Linked: ${cat.name} · ${cat.color||''}${cat.sex?' · '+cat.sex:''}`;
  document.getElementById('cat-link-arrow').textContent = '✓';
}

// ══════════════════════════════════════════════════════════════════
// PHOTOS
// ══════════════════════════════════════════════════════════════════
function handlePrimaryPhoto(event) {
  const file = event.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => compressImage(e.target.result, 600, 0.65, compressed => {
    currentPrimaryPhoto = compressed;
    renderPrimaryPhotoRow();
  });
  reader.readAsDataURL(file);
  event.target.value = '';
}

function handleObsPhotos(event) {
  Array.from(event.target.files).forEach(file => {
    const reader = new FileReader();
    reader.onload = e => compressImage(e.target.result, 800, 0.7, compressed => {
      currentObsPhotos.push(compressed);
      renderObsPhotoRow();
      updatePhotoStorageNote();
    });
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

function compressImage(dataUrl, maxDim, quality, callback) {
  const img = new Image();
  img.onload = () => {
    let w = img.width, h = img.height;
    if(w > maxDim || h > maxDim) {
      if(w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
      else { w = Math.round(w * maxDim / h); h = maxDim; }
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    callback(c.toDataURL('image/jpeg', quality));
  };
  img.src = dataUrl;
}

function renderPrimaryPhotoRow() {
  const row = document.getElementById('primary-photo-row');
  row.innerHTML = '';
  if(currentPrimaryPhoto) {
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = currentPrimaryPhoto;
    img.title = 'Tap to remove';
    img.onclick = () => { if(confirm('Remove primary photo?')) { currentPrimaryPhoto = null; renderPrimaryPhotoRow(); } };
    row.appendChild(img);
  }
}

function renderObsPhotoRow() {
  const row = document.getElementById('obs-photo-row');
  row.innerHTML = '';
  currentObsPhotos.forEach((src, i) => {
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = src;
    img.title = 'Tap to remove';
    img.onclick = () => { if(confirm('Remove this photo?')) { currentObsPhotos.splice(i,1); renderObsPhotoRow(); updatePhotoStorageNote(); } };
    row.appendChild(img);
  });
}

function updatePhotoStorageNote() {
  const note = document.getElementById('photo-storage-note');
  const kb = Math.round(currentObsPhotos.reduce((a,p) => a + p.length, 0) * 0.75 / 1024);
  note.textContent = currentObsPhotos.length ? `${currentObsPhotos.length} obs photo(s) · ~${kb}KB` : '';
}

// ══════════════════════════════════════════════════════════════════
// SAVE OBSERVATION
// ══════════════════════════════════════════════════════════════════
function saveObservation() {
  const name = document.getElementById('f-name').value.trim();
  if(!name) { showToast('Please enter a cat name or ID'); return; }

  const isEdit = editingObsId !== null;

  // Find or create cat record
  let catId = linkedCatId;

  if(!catId) {
    const existing = cats.find(c => c.name.toLowerCase() === name.toLowerCase());
    if(existing) {
      catId = existing.id;
      linkedCatId = catId;
    } else {
      catId = 'cat_' + Date.now();
      const newCat = {
        id: catId,
        name,
        colony: document.getElementById('f-colony').value,
        color: document.getElementById('f-color').value,
        sex: document.getElementById('f-sex').value,
        age: document.getElementById('f-age').value,
        bio: document.getElementById('f-bio').value.trim(),
        owner: document.getElementById('f-owner').value.trim() || 'Feral',
      };
      cats.push(newCat);
      saveCats();
    }
  } else {
    // Sync identity fields back to cat record
    const cat = getCatById(catId);
    if(cat) {
      cat.name = name;
      cat.colony = document.getElementById('f-colony').value;
      cat.color = document.getElementById('f-color').value;
      cat.sex = document.getElementById('f-sex').value;
      cat.age = document.getElementById('f-age').value;
      const bioDraft = document.getElementById('f-bio').value.trim();
      if(bioDraft) cat.bio = bioDraft;
      const ownerDraft = document.getElementById('f-owner').value.trim();
      if(ownerDraft) cat.owner = ownerDraft;
      saveCats();
    }
  }

  // Save primary photo to cat record
  if(currentPrimaryPhoto) savePhotoCat(catId, currentPrimaryPhoto);

  // Build observation record
  const obsId = isEdit ? editingObsId : 'obs_' + Date.now();
  const obs = {
    id: obsId,
    cat_id: catId,
    date: document.getElementById('f-date').value,
    time: document.getElementById('f-time').value,
    gps: document.getElementById('f-gps').value,
    location: document.getElementById('f-location').value.trim(),
    bcs: document.getElementById('f-bcs').value,
    fixed: document.getElementById('f-fixed').value,
    trap: document.getElementById('f-trap').value,
    health: document.getElementById('f-health').value,
    notes: document.getElementById('f-notes').value.trim(),
  };

  if(isEdit) {
    const idx = observations.findIndex(o => o.id === obsId);
    if(idx !== -1) {
      observations[idx] = obs;
    } else {
      observations.push(obs);
    }
  } else {
    observations.push(obs);
  }

  saveObs();

  // Save observation photos
  if(currentObsPhotos.length > 0) {
    savePhotosObs(obsId, currentObsPhotos);
  }

  // Flash feedback
  const cat = getCatById(catId);
  const catName = cat ? cat.name : name;
  const obsCount = observations.filter(o => o.cat_id === catId).length;
  showSaveFlash(catName, isEdit ? 'Observation updated' : `Sighting #${obsCount} saved`);

  renderCats();
  renderStats();
  clearForm();
}

// ══════════════════════════════════════════════════════════════════
// EDIT OBSERVATION
// ══════════════════════════════════════════════════════════════════
function editObservation(obsId) {
  const obs = observations.find(o => o.id === obsId);
  if(!obs) return;
  const cat = getCatById(obs.cat_id);
  if(!cat) return;

  closeDetailModal();
  switchTab('log');

  // Set edit state
  editingObsId = obsId;
  document.getElementById('edit-banner').classList.add('active');
  document.getElementById('save-btn').textContent = '💾 UPDATE OBSERVATION';

  // Populate cat identity
  linkedCatId = cat.id;
  document.getElementById('f-name').value = cat.name;
  document.getElementById('f-color').value = cat.color || '';
  document.getElementById('f-colony').value = cat.colony || '';
  document.getElementById('f-bio').value = cat.bio || '';
  setPillValue('pg-color', cat.color);
  setPillValue('pg-sex', cat.sex); document.getElementById('f-sex').value = cat.sex || '';
  setPillValue('pg-age', cat.age); document.getElementById('f-age').value = cat.age || '';
  document.getElementById('f-owner').value = cat.owner || 'Feral';
  lockIdentitySection(true);
  updateCatLinkBar(cat);
  filterTrapPills(cat.id);

  // Load primary photo
  const photo = loadPhotoCat(cat.id);
  currentPrimaryPhoto = photo;
  renderPrimaryPhotoRow();

  // Populate observation fields
  document.getElementById('f-date').value = obs.date;
  document.getElementById('f-time').value = obs.time;
  document.getElementById('f-gps').value = obs.gps || '';
  document.getElementById('f-location').value = obs.location || '';
  document.getElementById('f-notes').value = obs.notes || '';

  setPillValue('pg-bcs', obs.bcs);     document.getElementById('f-bcs').value = obs.bcs || '';
  setPillValue('pg-fixed', obs.fixed || (obs.neutered === 'Yes' || obs.eartip === 'Yes' ? 'Yes' : ''));
  document.getElementById('f-fixed').value = obs.fixed || (obs.neutered === 'Yes' || obs.eartip === 'Yes' ? 'Yes' : '') || '';
  setPillValue('pg-trap', obs.trap);     document.getElementById('f-trap').value = obs.trap || '';

  // Health (multi-select)
  healthSelections.clear();
  setMultiPillValues('pg-health', obs.health || '');
  document.getElementById('f-health').value = obs.health || '';

  // Observation photos
  currentObsPhotos = loadPhotosObs(obsId).slice();
  renderObsPhotoRow();
  updatePhotoStorageNote();

  // Colony map
  onFormColonyChange();

  // Scroll to top of log form
  document.getElementById('view-log').scrollTo(0, 0);
}

function cancelEdit() {
  editingObsId = null;
  document.getElementById('edit-banner').classList.remove('active');
  document.getElementById('save-btn').textContent = '💾 SAVE OBSERVATION';
  clearForm();
}

// ══════════════════════════════════════════════════════════════════
// FORM CLEAR
// ══════════════════════════════════════════════════════════════════
function clearForm() {
  editingObsId = null;
  linkedCatId = null;
  currentObsPhotos = [];
  currentPrimaryPhoto = null;
  healthSelections.clear();

  document.getElementById('edit-banner').classList.remove('active');
  document.getElementById('save-btn').textContent = '💾 SAVE OBSERVATION';

  document.getElementById('f-name').value = '';
  document.getElementById('f-color').value = '';
  document.getElementById('f-colony').value = activeColony || '';
  document.getElementById('f-sex').value = '';
  document.getElementById('f-age').value = '';
  document.getElementById('f-bio').value = '';
  document.getElementById('f-gps').value = '';
  document.getElementById('f-location').value = '';
  document.getElementById('f-notes').value = '';
  document.getElementById('f-bcs').value = '';
  document.getElementById('f-fixed').value = '';
  document.getElementById('f-trap').value = '';
  document.getElementById('f-health').value = '';
  document.getElementById('gps-status').textContent = '';

  // Clear all pill selections
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));

  // Reset owner to default
  document.getElementById('f-owner').value = 'Feral';
  updateOwnerList(activeColony || '', 'f-owner-list');

  unlinkCat();
  renderPrimaryPhotoRow();
  renderObsPhotoRow();
  updatePhotoStorageNote();
  setDateTime();

  // Reset colony map
  document.getElementById('colony-map-section').style.display = 'none';
  if(logTileMap) { logTileMap.destroy(); logTileMap = null; }
  document.getElementById('log-map-coords').textContent = '';
  document.getElementById('log-map-label').textContent = 'Tap map to drop pin';

  // Apply active colony if set
  if(activeColony) {
    document.getElementById('f-colony').value = activeColony;
    onFormColonyChange();
  }
}

// ══════════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((el, i) => {
    el.classList.toggle('active', ['log','cats','social','colonies','stats'][i] === tab);
  });
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + tab).classList.add('active');

  if(tab === 'cats')     renderCats(currentSearch, currentFilter);
  if(tab === 'colonies') renderColonies();
  if(tab === 'stats')    renderStats();
  if(tab === 'social')   renderSocialGraph();
}

// ══════════════════════════════════════════════════════════════════
// CATS LIST
// ══════════════════════════════════════════════════════════════════
function filterCats(val) {
  currentFilter = val;
  renderCats(currentSearch, val);
}

function renderCats(search, filter) {
  if(search !== undefined) currentSearch = search;
  if(filter !== undefined) currentFilter = filter;
  const s = (currentSearch || '').toLowerCase();
  const f = currentFilter || '';
  const list = document.getElementById('cats-list');

  let filtered = cats.filter(cat => {
    if(s && !cat.name.toLowerCase().includes(s) && !(cat.color||'').toLowerCase().includes(s) && !(cat.colony||'').toLowerCase().includes(s)) return false;
    if(f) {
      const status = derivedStatus(cat.id);
      if(f === 'neutered' && status.fixed !== 'Yes') return false;
      if(f === 'not-neutered' && status.fixed === 'Yes') return false;
      if(f === 'trapped' && !['Trapped Today','In Transit','At Clinic'].includes(status.trap)) return false;
      if(f === 'health' && (!status.health || status.health === 'Appears healthy')) return false;
    }
    return true;
  });

  if(!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🐱</div><div class="empty-title">${cats.length ? 'No matches' : 'No cats yet'}</div><div class="empty-sub">${cats.length ? 'Try a different search or filter' : 'Log your first cat from the + LOG CAT tab'}</div></div>`;
    return;
  }

  list.innerHTML = filtered.map(cat => {
    const status = derivedStatus(cat.id);
    const obsCount = observations.filter(o => o.cat_id === cat.id).length;
    const latest = latestObs(cat.id);
    const photo = loadPhotoCat(cat.id);
    const avatar = photo
      ? `<div class="cat-avatar"><img src="${photo}"></div>`
      : `<div class="cat-avatar" style="font-size:1.8rem">🐱</div>`;

    let tags = '';
    if(status.fixed === 'Yes') tags += `<span class="tag neutered">✓ FIXED</span>`;
    else if(status.fixed === 'No') tags += `<span class="tag not-neutered">✗ NOT FIXED</span>`;
    if(cat.colony) tags += `<span class="tag colony">${esc(cat.colony)}</span>`;
    if(obsCount > 0) tags += `<span class="tag obs-count">${obsCount} obs</span>`;

    const meta = [cat.color, cat.sex, cat.age].filter(Boolean).join(' · ');
    const lastSeen = latest ? `Last seen ${latest.date}` : 'No observations';

    return `<div class="cat-card" onclick="openDetailModal('${cat.id}')">
      ${avatar}
      <div class="cat-info">
        <div class="cat-name">${esc(cat.name)}</div>
        <div class="cat-meta">${esc(meta)}<br>${lastSeen}</div>
        <div class="cat-tags">${tags}</div>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════
// CAT DETAIL MODAL
// ══════════════════════════════════════════════════════════════════
function buildRelSection(catId) {
  const rels = getRelationshipsForCat(catId);
  const typeStyle = {
    Friend: 'background:#3fcf6e22;color:#3fcf6e;border-color:#3fcf6e',
    Enemy:  'background:#e05c5c22;color:#e05c5c;border-color:#e05c5c',
    Lover:  'background:#c084fc22;color:#c084fc;border-color:#c084fc'
  };
  const relRows = rels.map(r => {
    const other = getCatById(r.otherId);
    if(!other) return '';
    const photo = loadPhotoCat(r.otherId);
    const thumb = photo
      ? `<img src="${photo}" class="rel-thumb">`
      : `<div class="rel-thumb rel-thumb-empty">🐱</div>`;
    return `<div class="rel-row" onclick="openDetailModal('${r.otherId}')">
      ${thumb}
      <div class="rel-name">${esc(other.name)}</div>
      <span class="rel-badge" style="${typeStyle[r.type]||''}"
            onclick="event.stopPropagation();openRelationPicker('${catId}','${r.otherId}')">${r.type}</span>
    </div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div class="section-label" style="margin:0">Social</div>
      <button class="btn-sm" style="padding:4px 10px;font-size:0.7rem"
              onclick="openRelationPicker('${catId}')">➕ Add Relation</button>
    </div>
    ${relRows || '<div style="font-family:var(--mono);font-size:0.65rem;color:var(--muted);padding:4px 0 12px">No relationships recorded.</div>'}
  `;
}

function openDetailModal(catId) {
  const cat = getCatById(catId);
  if(!cat) return;
  const obs = observations
    .filter(o => o.cat_id === catId)
    .sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
  const status = derivedStatus(catId);
  const photo = loadPhotoCat(catId);

  let obsHtml = obs.length ? obs.map(o => {
    const photos = loadPhotosObs(o.id);
    const photosHtml = photos.length
      ? `<div class="obs-photos">${photos.map(p => `<img src="${p}">`).join('')}</div>`
      : '';
    const healthBadge = o.health
      ? `<span class="tag ${o.health.includes('healthy') ? 'neutered' : 'not-neutered'}">${esc(o.health)}</span>`
      : '';
    const trapBadge = o.trap ? `<span class="tag">${esc(o.trap)}</span>` : '';
    const fixedVal = o.fixed || (o.neutered === 'Yes' || o.eartip === 'Yes' ? 'Yes' : o.neutered || '');
    const fixedBadge = fixedVal === 'Yes'
      ? `<span class="tag neutered">✓ Fixed</span>`
      : fixedVal === 'No' ? `<span class="tag not-neutered">✗ Not Fixed</span>` : '';

    const gpsLink = o.gps
      ? `<a href="https://maps.google.com/?q=${encodeURIComponent(o.gps)}" target="_blank" class="obs-gps-link">📍 ${esc(o.gps)}</a>`
      : '';

    return `<div class="obs-entry">
      <div class="obs-entry-header">
        <div class="obs-date">📅 ${o.date}${o.time ? ' · ' + o.time : ''}</div>
        <div class="obs-actions">
          <button class="obs-edit-btn" onclick="editObservation('${o.id}')">✏️ Edit</button>
          <button class="obs-delete-btn" onclick="deleteObs('${o.id}','${catId}')">✕</button>
        </div>
      </div>
      <div class="obs-tags">${fixedBadge}${trapBadge}${healthBadge}</div>
      ${o.bcs ? `<div class="obs-field"><strong>BCS:</strong> ${esc(o.bcs)}/5</div>` : ''}
      ${o.location ? `<div class="obs-field"><strong>Location:</strong> ${esc(o.location)}</div>` : ''}
      ${gpsLink ? `<div class="obs-field">${gpsLink}</div>` : ''}
      ${o.notes ? `<div class="obs-field">${esc(o.notes)}</div>` : ''}
      ${photosHtml}
    </div>`;
  }).join('') : `<div style="font-family:var(--mono);font-size:0.72rem;color:var(--muted);padding:16px 0">No observations recorded yet.</div>`;

  const photoHtml = photo ? `<img src="${photo}" style="width:80px;height:80px;object-fit:cover;border-radius:10px;border:2px solid var(--border);margin-bottom:10px">` : '';
  const meta = [cat.color, cat.sex, cat.age].filter(Boolean).join(' · ');

  let statusTags = '';
  if(status.fixed === 'Yes') statusTags += `<span class="tag neutered">✓ FIXED</span>`;
  else if(status.fixed === 'No') statusTags += `<span class="tag not-neutered">✗ NOT FIXED</span>`;
  statusTags += `<span class="tag">${esc(cat.owner || 'Feral')}</span>`;
  if(cat.colony) statusTags += `<span class="tag colony">${esc(cat.colony)}</span>`;

  const gpsObs = obs.filter(o => o.gps && o.gps.trim());
  const locMapHtml = gpsObs.length ? `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div class="section-label" style="margin:0">Location History (${gpsObs.length})</div>
    </div>
    <div class="map-picker-wrap" style="margin-bottom:16px">
      <canvas id="cat-detail-map" class="map-canvas" style="height:200px;cursor:default"></canvas>
      <div class="map-zoom-controls">
        <button class="map-zoom-btn" onclick="tileMapZoom(catDetailTileMap,1)">+</button>
        <button class="map-zoom-btn" onclick="tileMapZoom(catDetailTileMap,-1)">−</button>
      </div>
    </div>` : '';

  document.getElementById('detail-content').innerHTML = `
    <div class="modal-handle" onclick="closeDetailModal()"></div>
    ${photoHtml}
    <div class="modal-title">${esc(cat.name)}</div>
    <div style="font-family:var(--mono);font-size:0.65rem;color:var(--muted);margin-bottom:10px">${esc(meta)}</div>
    <div class="cat-tags" style="margin-bottom:16px">${statusTags}</div>
    ${cat.bio ? `<div style="font-size:0.8rem;color:var(--fg);margin-bottom:16px;line-height:1.5;white-space:pre-wrap">${esc(cat.bio)}</div>` : ''}
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <button class="btn-sm" style="flex:1" onclick="startNewObsForCat('${catId}')">➕ New</button>
      <button class="btn-sm" style="flex:1;border-color:var(--purple);color:var(--purple-light)" onclick="openEditProfile('${catId}')">✏️ Edit</button>
      <button class="btn-sm btn-danger" style="flex:1" onclick="deleteCat('${catId}')">🗑 Delete</button>
    </div>
    ${locMapHtml}
    ${buildRelSection(catId)}
    <div class="section-label">Observation History (${obs.length})</div>
    <div class="obs-timeline">${obsHtml}</div>
  `;

  document.getElementById('detail-modal').classList.add('open');

  // Initialise cat location map after DOM is painted
  if(catDetailTileMap) { catDetailTileMap.destroy(); catDetailTileMap = null; }
  if(gpsObs.length) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const canvas = document.getElementById('cat-detail-map');
      if(!canvas) return;
      catDetailTileMap = new TileMap(canvas, {
        onMarkerTap: m => showToast(`📅 ${m.date}${m.location ? ' · ' + m.location : ''}`)
      });
      const markers = gpsObs.map((o, i) => {
        const parts = o.gps.split(',');
        const lat = parseFloat(parts[0].trim()), lng = parseFloat(parts[1].trim());
        if(isNaN(lat) || isNaN(lng)) return null;
        const alpha = Math.max(0.3, 1 - (i / Math.max(gpsObs.length, 1)) * 0.65);
        return { lat, lng, color: '#f0a500', alpha, size: i === 0 ? 10 : 7,
                 label: i === 0 ? o.date : null, date: o.date, location: o.location || '' };
      }).filter(Boolean);
      catDetailTileMap.setMarkers(markers);
      catDetailTileMap.fitMarkers(markers, 15);
    }));
  }
}

function closeDetailModal() {
  document.getElementById('detail-modal').classList.remove('open');
  if(catDetailTileMap) { catDetailTileMap.destroy(); catDetailTileMap = null; }
}
function closeDetailIfOutside(e) { if(e.target === document.getElementById('detail-modal')) closeDetailModal(); }

function openHelp() { document.getElementById('help-modal').classList.add('open'); }
function closeHelp() { document.getElementById('help-modal').classList.remove('open'); }
function closeHelpIfOutside(e) { if(e.target === document.getElementById('help-modal')) closeHelp(); }

// ══════════════════════════════════════════════════════════════════
// RELATIONSHIPS
// ══════════════════════════════════════════════════════════════════
function normalizeRel(aId, bId) {
  return aId < bId ? [aId, bId] : [bId, aId];
}

function getRelationshipsForCat(catId) {
  return relationships
    .filter(r => r.catAId === catId || r.catBId === catId)
    .map(r => ({ otherId: r.catAId === catId ? r.catBId : r.catAId, type: r.type }));
}

async function upsertRelationship(aId, bId, type) {
  const [catAId, catBId] = normalizeRel(aId, bId);
  const existing = relationships.find(r => r.catAId === catAId && r.catBId === catBId);
  if(existing) {
    existing.type = type;
    await db.relationships.put(existing);
  } else {
    const rec = { catAId, catBId, type };
    const id = await db.relationships.add(rec);
    rec.id = id;
    relationships.push(rec);
  }
}

async function deleteRelationship(aId, bId) {
  const [catAId, catBId] = normalizeRel(aId, bId);
  const existing = relationships.find(r => r.catAId === catAId && r.catBId === catBId);
  if(existing) {
    relationships = relationships.filter(r => r !== existing);
    await db.relationships.delete(existing.id);
  }
}

// ── Relation picker ─────────────────────────────────────────────
let relPickerFromId   = null;
let relPickerTargetId = null;

function openRelationPicker(fromCatId, preTargetId) {
  relPickerFromId = fromCatId;
  _renderRelPickerList();
  document.getElementById('relation-picker-modal').classList.add('open');
  if(preTargetId) {
    _selectRelTarget(preTargetId);
  } else {
    document.getElementById('rel-picker-step1').style.display = 'block';
    document.getElementById('rel-picker-step2').style.display = 'none';
    document.getElementById('rel-picker-title').textContent = 'Add Relationship';
  }
}

function _renderRelPickerList() {
  const fromCat  = getCatById(relPickerFromId);
  const colony   = fromCat ? fromCat.colony : activeColony;
  const others   = cats.filter(c => c.id !== relPickerFromId);
  others.sort((a, b) => {
    const ac = a.colony === colony ? 0 : 1, bc = b.colony === colony ? 0 : 1;
    return ac - bc || a.name.localeCompare(b.name);
  });
  const relMap = new Map(getRelationshipsForCat(relPickerFromId).map(r => [r.otherId, r.type]));
  const relCols = { Friend:'#3fcf6e', Enemy:'#e05c5c', Lover:'#c084fc' };

  const html = others.map(c => {
    const photo = loadPhotoCat(c.id);
    const thumb = photo
      ? `<img src="${photo}" class="rel-thumb">`
      : `<div class="rel-thumb rel-thumb-empty">🐱</div>`;
    const t = relMap.get(c.id);
    const badge = t ? `<span style="font-size:0.6rem;font-family:var(--mono);padding:2px 6px;border-radius:3px;border:1px solid ${relCols[t]};color:${relCols[t]}">${t}</span>` : '';
    const col   = c.colony ? `<span style="font-family:var(--mono);font-size:0.58rem;color:var(--muted)">${esc(c.colony)}</span>` : '';
    return `<div class="rel-picker-cat-row" onclick="_selectRelTarget('${c.id}')">
      ${thumb}
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</div>
        <div>${col}</div>
      </div>
      ${badge}
    </div>`;
  }).join('');

  document.getElementById('rel-picker-cat-list').innerHTML = html ||
    '<div style="font-family:var(--mono);font-size:0.65rem;color:var(--muted);padding:16px 0">No other cats recorded.</div>';
}

function _selectRelTarget(targetCatId) {
  relPickerTargetId = targetCatId;
  const cat      = getCatById(targetCatId);
  if(!cat) return;
  const existing = getRelationshipsForCat(relPickerFromId).find(r => r.otherId === targetCatId);
  document.getElementById('rel-picker-title').textContent = existing ? 'Edit Relationship' : 'Add Relationship';
  const photo = loadPhotoCat(targetCatId);
  document.getElementById('rel-picker-target-thumb').innerHTML = photo
    ? `<img src="${photo}" class="rel-thumb">`
    : `<div class="rel-thumb rel-thumb-empty">🐱</div>`;
  document.getElementById('rel-picker-target-name').textContent   = cat.name;
  document.getElementById('rel-picker-target-colony').textContent = cat.colony || 'No colony';
  document.getElementById('rel-remove-btn').style.display = existing ? 'block' : 'none';
  document.getElementById('rel-picker-step1').style.display = 'none';
  document.getElementById('rel-picker-step2').style.display = 'block';
}

function backToRelList() {
  relPickerTargetId = null;
  document.getElementById('rel-picker-step1').style.display = 'block';
  document.getElementById('rel-picker-step2').style.display = 'none';
  document.getElementById('rel-picker-title').textContent = 'Add Relationship';
}

async function saveRelationType(type) {
  if(!relPickerFromId || !relPickerTargetId) return;
  if(type === 'Remove') {
    await deleteRelationship(relPickerFromId, relPickerTargetId);
  } else {
    await upsertRelationship(relPickerFromId, relPickerTargetId, type);
  }
  const fromId = relPickerFromId;
  closeRelationPicker();
  openDetailModal(fromId);
}

function closeRelationPicker() { document.getElementById('relation-picker-modal').classList.remove('open'); }
function closeRelPickerIfOutside(e) { if(e.target === document.getElementById('relation-picker-modal')) closeRelationPicker(); }

function startNewObsForCat(catId) {
  closeDetailModal();
  switchTab('log');
  clearForm();
  linkCat(catId);
}

// ══════════════════════════════════════════════════════════════════
// EDIT CAT PROFILE
// ══════════════════════════════════════════════════════════════════
let editProfileCatId = null;
let epPhoto = null; // current photo state in the editor (data URL or null)

function openEditProfile(catId) {
  const cat = getCatById(catId);
  if(!cat) return;
  editProfileCatId = catId;

  // Sync colony dropdown
  const sel = document.getElementById('ep-colony');
  sel.innerHTML = `<option value="">— None / Unknown —</option>` +
    colonies.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');

  // Populate fields
  document.getElementById('ep-name').value = cat.name || '';
  sel.value = cat.colony || '';
  document.getElementById('ep-color').value = cat.color || '';
  document.getElementById('ep-sex').value = cat.sex || '';
  document.getElementById('ep-age').value = cat.age || '';
  document.getElementById('ep-bio').value = cat.bio || '';

  // Set pills
  ['ep-pg-color','ep-pg-sex','ep-pg-age'].forEach(pgId => {
    document.getElementById(pgId).querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  });
  epSetPill('ep-pg-color', cat.color);
  epSetPill('ep-pg-sex', cat.sex);
  epSetPill('ep-pg-age', cat.age);
  document.getElementById('ep-owner').value = cat.owner || 'Feral';
  updateOwnerList(cat.colony, 'ep-owner-list');

  // Load existing photo
  epPhoto = loadPhotoCat(catId);
  renderEpPhotoRow();

  document.getElementById('edit-profile-modal').classList.add('open');
}

function epSetPill(groupId, val) {
  if(!val) return;
  document.getElementById(groupId).querySelectorAll('.pill').forEach(p => {
    p.classList.toggle('active', p.dataset.val === val);
  });
}

function handleEpPhoto(event) {
  const file = event.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => compressImage(e.target.result, 600, 0.65, compressed => {
    epPhoto = compressed;
    renderEpPhotoRow();
  });
  reader.readAsDataURL(file);
  event.target.value = '';
}

function renderEpPhotoRow() {
  const row = document.getElementById('ep-photo-row');
  row.innerHTML = '';
  if(epPhoto) {
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = epPhoto;
    img.title = 'Tap to remove';
    img.onclick = () => { if(confirm('Remove photo?')) { epPhoto = null; renderEpPhotoRow(); } };
    row.appendChild(img);
  }
}

function saveEditProfile() {
  const cat = getCatById(editProfileCatId);
  if(!cat) return;

  const name = document.getElementById('ep-name').value.trim();
  if(!name) { showToast('Name cannot be empty'); return; }

  cat.name   = name;
  cat.colony = document.getElementById('ep-colony').value;
  cat.color  = document.getElementById('ep-color').value;
  cat.sex    = document.getElementById('ep-sex').value;
  cat.age    = document.getElementById('ep-age').value;
  cat.bio    = document.getElementById('ep-bio').value.trim();
  cat.owner  = document.getElementById('ep-owner').value.trim() || 'Feral';

  saveCats();
  if(epPhoto) savePhotoCat(cat.id, epPhoto);

  closeEditProfile();
  renderCats();
  renderStats();
  openDetailModal(cat.id); // refresh detail view
  showToast(`✓ ${cat.name} updated`);
}

function closeEditProfile() {
  document.getElementById('edit-profile-modal').classList.remove('open');
  editProfileCatId = null;
  epPhoto = null;
}

function deleteFromEditProfile() {
  const catId = editProfileCatId;
  closeEditProfile();
  deleteCat(catId);
}

function closeEditProfileIfOutside(e) {
  if(e.target === document.getElementById('edit-profile-modal')) closeEditProfile();
}

// ══════════════════════════════════════════════════════════════════
// DELETE
// ══════════════════════════════════════════════════════════════════
function deleteObs(obsId, catId) {
  if(!confirm('Delete this observation?')) return;
  deletePhotosObs(obsId);
  observations = observations.filter(o => o.id !== obsId);
  saveObs();
  renderCats();
  renderStats();
  openDetailModal(catId); // refresh modal
}

function deleteCat(catId) {
  if(!confirm('Delete this cat and ALL their observations? This cannot be undone.')) return;
  const catObs = observations.filter(o => o.cat_id === catId);
  catObs.forEach(o => deletePhotosObs(o.id));
  deletePhotoCat(catId);
  observations = observations.filter(o => o.cat_id !== catId);
  cats = cats.filter(c => c.id !== catId);
  // Clean up relationships
  const relIds = relationships.filter(r => r.catAId === catId || r.catBId === catId).map(r => r.id);
  relationships = relationships.filter(r => r.catAId !== catId && r.catBId !== catId);
  if(relIds.length) db.relationships.bulkDelete(relIds);
  saveCats();
  saveObs();
  closeDetailModal();
  renderCats();
  renderStats();
  showToast('Cat deleted');
}

// ══════════════════════════════════════════════════════════════════
// COLONIES
// ══════════════════════════════════════════════════════════════════
function addColony() {
  const input = document.getElementById('new-colony-name');
  const name = input.value.trim();
  if(!name) return;
  if(colonies.find(c => c.name.toLowerCase() === name.toLowerCase())) {
    showToast('Colony already exists'); return;
  }
  colonies.push({ name });
  saveColonies();
  syncColonyDropdowns();
  renderColonies();
  input.value = '';
  showToast(`✓ Colony "${name}" added`);
}

function deleteColony(idx) {
  const col = colonies[idx];
  if(!col) return;
  if(!confirm(`Delete colony "${col.name}"? Cats in this colony will be unassigned.`)) return;
  // Unassign cats from this colony
  cats.forEach(c => { if(c.colony === col.name) c.colony = ''; });
  saveCats();
  colonies.splice(idx, 1);
  saveColonies();
  syncColonyDropdowns();
  renderColonies();
  renderCats();
  showToast(`Colony "${col.name}" deleted`);
}

function renderColonies() {
  const list = document.getElementById('colonies-list');
  if(!colonies.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🏘</div><div class="empty-title">No colonies yet</div><div class="empty-sub">Add a colony name above to organize your cats by location</div></div>`;
    return;
  }
  list.innerHTML = colonies.map((col, idx) => {
    const colonyCats = cats.filter(c => c.colony === col.name);
    const fixed = colonyCats.filter(c => derivedStatus(c.id).fixed === 'Yes').length;
    const mapIcon = col.bounds ? '🗺 Map Set ✓' : '🗺 Set Territory';
    const buildMini = cat => {
      const photo = loadPhotoCat(cat.id);
      const thumb = photo
        ? `<img src="${photo}" class="colony-cat-thumb">`
        : `<div class="colony-cat-thumb colony-cat-thumb-empty">🐱</div>`;
      const status = derivedStatus(cat.id);
      const fixedTag = status.fixed === 'Yes' ? `<span class="tag neutered" style="font-size:0.55rem;padding:1px 5px">✓ Fixed</span>` : '';
      const latest = latestObs(cat.id);
      const lastSeen = latest ? latest.date : 'No obs';
      return `<div class="colony-cat-mini" onclick="openDetailModal('${cat.id}')">
        ${thumb}
        <div class="colony-cat-mini-info">
          <div class="colony-cat-mini-name">${esc(cat.name)}</div>
          <div class="colony-cat-mini-sub">${lastSeen} ${fixedTag}</div>
        </div>
      </div>`;
    };
    const knownOrder = ['Feral', 'Community', 'Owned'];
    const allOwners = [...new Set(colonyCats.map(c => c.owner || 'Feral'))];
    const ownerOrder = [
      ...knownOrder.filter(o => allOwners.includes(o)),
      ...allOwners.filter(o => !knownOrder.includes(o)).sort(),
    ];
    const catMinis = ownerOrder.map(ownerLabel => {
      const group = colonyCats.filter(c => (c.owner || 'Feral') === ownerLabel);
      if(!group.length) return '';
      return `<div style="font-size:0.6rem;font-family:var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:0.07em;margin:8px 0 4px">${ownerLabel}</div>`
        + group.map(buildMini).join('');
    }).join('');
    return `<div class="colony-card">
      <div class="colony-card-top" onclick="toggleColony(${idx})" style="cursor:pointer">
        <div class="colony-icon">🏘</div>
        <div class="colony-body">
          <div class="colony-name">${esc(col.name)}</div>
          <div class="colony-count">${colonyCats.length} cat${colonyCats.length !== 1 ? 's' : ''}</div>
          <div class="colony-stats">
            <div class="cstat">Fixed: <span>${fixed}/${colonyCats.length}</span></div>
            <div class="cstat">Sightings: <span>${observations.filter(o => colonyCats.some(c => c.id === o.cat_id)).length}</span></div>
          </div>
        </div>
        <div class="colony-toggle-arrow">▶</div>
      </div>
      <div class="colony-cats">
        ${colonyCats.length ? catMinis : '<div style="font-family:var(--mono);font-size:0.65rem;color:var(--muted);padding:8px 0">No cats in this colony yet.</div>'}
      </div>
      <div class="colony-actions">
        <button class="colony-map-btn" onclick="openColonyMapSetup(${idx})">${mapIcon}</button>
        <button class="colony-map-btn" style="border-color:var(--accent);color:var(--accent)"
                onclick="openColonyOverviewMap(${idx})">📍 Obs Map</button>
        <button class="colony-delete-btn" onclick="deleteColony(${idx})">🗑 Delete</button>
      </div>
    </div>`;
  }).join('');
}

function toggleColony(idx) {
  const cards = document.querySelectorAll('.colony-card');
  if(cards[idx]) cards[idx].classList.toggle('open');
}

function syncColonyDropdowns() {
  const selects = ['f-colony', 'active-colony-select'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if(!sel) return;
    const current = sel.value;
    const defaultOpt = id === 'f-colony' ? '— None / Unknown —' : '— None —';
    sel.innerHTML = `<option value="">${defaultOpt}</option>` +
      colonies.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    if(current && colonies.find(c => c.name === current)) sel.value = current;
  });
}

// ══════════════════════════════════════════════════════════════════
// ACTIVE COLONY (header badge)
// ══════════════════════════════════════════════════════════════════
function openColonyPicker() {
  syncColonyDropdowns();
  const sel = document.getElementById('active-colony-select');
  sel.value = activeColony || '';
  document.getElementById('colony-modal').classList.add('open');
}

function setActiveColony(val) {
  activeColony = val;
  localStorage.setItem('tnr_active_colony', val);
  updateColonyBadge();
  document.getElementById('f-colony').value = val;
  onFormColonyChange();
}

function closeColonyPickerModal() { document.getElementById('colony-modal').classList.remove('open'); }
function closeColonyModal(e) { if(e.target === document.getElementById('colony-modal')) closeColonyPickerModal(); }

function updateColonyBadge() {
  document.getElementById('active-colony-badge').textContent = activeColony || 'NO COLONY';
}

// ══════════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════════
function renderStats() {
  const total = cats.length;
  const allStatuses = cats.map(c => derivedStatus(c.id));
  const neutered = allStatuses.filter(s => s.fixed === 'Yes').length;
  const notNeutered = allStatuses.filter(s => s.fixed === 'No').length;
  const totalObs = observations.length;

  const healthCats = allStatuses.filter(s => s.health && !s.health.includes('Appears healthy')).length;
  const pregnant = allStatuses.filter(s => (s.health||'').includes('Pregnant')).length;

  document.getElementById('stat-grid').innerHTML = `
    <div class="stat-box"><div class="stat-num">${total}</div><div class="stat-label">TOTAL CATS</div></div>
    <div class="stat-box"><div class="stat-num" style="color:var(--green)">${neutered}</div><div class="stat-label">FIXED / TNR DONE</div></div>
    <div class="stat-box"><div class="stat-num" style="color:var(--accent2)">${notNeutered}</div><div class="stat-label">NOT YET FIXED</div></div>
    <div class="stat-box"><div class="stat-num">${totalObs}</div><div class="stat-label">TOTAL SIGHTINGS</div></div>
    <div class="stat-box"><div class="stat-num" style="color:var(--accent2)">${healthCats}</div><div class="stat-label">HEALTH FLAGS</div></div>
  `;

  const neutPct = total ? Math.round(neutered / total * 100) : 0;
  const healthPct = total ? Math.round(healthCats / total * 100) : 0;

  document.getElementById('stat-bars').innerHTML = `
    <div class="progress-bar-wrap">
      <div class="progress-label"><span>TNR Progress (Fixed)</span><span>${neutered}/${total} (${neutPct}%)</span></div>
      <div class="progress-bar"><div class="progress-fill green" style="width:${neutPct}%"></div></div>
    </div>
    <div class="progress-bar-wrap">
      <div class="progress-label"><span>Health Concerns</span><span>${healthCats}/${total} (${healthPct}%)</span></div>
      <div class="progress-bar"><div class="progress-fill red" style="width:${healthPct}%"></div></div>
    </div>
    ${pregnant > 0 ? `<div style="font-family:var(--mono);font-size:0.72rem;color:var(--accent2);padding:8px 0">⚠ ${pregnant} pregnant cat${pregnant>1?'s':''} flagged — prioritize trapping!</div>` : ''}
    ${colonies.length > 0 ? renderColonyStats() : ''}
  `;
}

function renderColonyStats() {
  return `<div class="section-label" style="margin-top:16px">By Colony</div>` + colonies.map(col => {
    const cCats = cats.filter(c => c.colony === col.name);
    const cNeutered = cCats.filter(c => derivedStatus(c.id).fixed === 'Yes').length;
    const pct = cCats.length ? Math.round(cNeutered / cCats.length * 100) : 0;
    return `<div class="progress-bar-wrap">
      <div class="progress-label"><span>${esc(col.name)}</span><span>${cNeutered}/${cCats.length} (${pct}%)</span></div>
      <div class="progress-bar"><div class="progress-fill green" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════════
function exportCSV() {
  if(!cats.length) { showToast('No data to export'); return; }

  const headers = ['Cat ID','Cat Name','Colony','Color','Sex','Age','Bio','Date','Time','BCS','Fixed','Trap Status','Health','Location','GPS','Notes'];
  const rows = observations.map(obs => {
    const cat = getCatById(obs.cat_id) || {};
    const fixedVal = obs.fixed || (obs.neutered === 'Yes' || obs.eartip === 'Yes' ? 'Yes' : obs.neutered || '');
    return [
      cat.id||'', cat.name||'', cat.colony||'', cat.color||'', cat.sex||'', cat.age||'', cat.bio||'',
      obs.date||'', obs.time||'', obs.bcs||'', fixedVal,
      obs.trap||'', obs.health||'', obs.location||'', obs.gps||'', obs.notes||''
    ].map(v => `"${String(v).replace(/"/g,'""')}"`);
  });

  // Also include cats with no observations
  const catsWithObs = new Set(observations.map(o => o.cat_id));
  cats.filter(c => !catsWithObs.has(c.id)).forEach(cat => {
    rows.push([cat.id, cat.name, cat.colony||'', cat.color||'', cat.sex||'', cat.age||'', cat.bio||'',
      '','','','','','','','',''
    ].map(v => `"${String(v).replace(/"/g,'""')}"`));
  });

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  downloadFile(csv, `tnr_export_${new Date().toISOString().split('T')[0]}.csv`, 'text/csv');
}

function exportJSON() {
  if(!cats.length && !observations.length) { showToast('No data to export'); return; }

  // Build joined export (includes base64 photos for full restore)
  const exportData = {
    exported_at: new Date().toISOString(),
    cats: cats.map(cat => ({
      ...cat,
      primary_photo: loadPhotoCat(cat.id) || null,
      observations: observations.filter(o => o.cat_id === cat.id).map(obs => ({
        ...obs,
        photos: loadPhotosObs(obs.id)
      }))
    })),
    colonies,
    stats: {
      total_cats: cats.length,
      total_observations: observations.length,
      fixed: cats.filter(c => derivedStatus(c.id).fixed === 'Yes').length,
    }
  };

  downloadFile(JSON.stringify(exportData, null, 2), `tnr_export_${new Date().toISOString().split('T')[0]}.json`, 'application/json');
}

function downloadFile(content, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`✓ Exported ${filename}`);
}

// ══════════════════════════════════════════════════════════════════
// IMPORT
// ══════════════════════════════════════════════════════════════════
function importJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    let data;
    try { data = JSON.parse(e.target.result); } catch(err) {
      alert('Import failed: invalid JSON file.'); return;
    }
    if (!data.cats || !data.observations) {
      alert('Import failed: JSON does not look like a TNR Tracker export.'); return;
    }
    let catsAdded = 0, catsUpdated = 0, obsAdded = 0, photosRestored = 0;

    // Merge cats
    data.cats.forEach(importedCat => {
      const { primary_photo, observations: _obs, ...catFields } = importedCat;
      const existing = cats.find(c => c.id === catFields.id);
      if (!existing) { cats.push(catFields); catsAdded++; }
      else { Object.assign(existing, catFields); catsUpdated++; }
      if (primary_photo) {
        photoCache.set('cat_' + catFields.id, primary_photo);
        db.photos.put({ key: 'cat_' + catFields.id, data: primary_photo }).catch(() => {});
        photosRestored++;
      }
    });
    saveCats();

    // Merge observations
    data.observations && data.observations.forEach(importedObs => {
      const { photos, ...obsFields } = importedObs;
      const existing = observations.find(o => o.id === obsFields.id);
      if (!existing) { observations.push(obsFields); obsAdded++; }
      else Object.assign(existing, obsFields);
      if (photos && photos.length) {
        const obsPhotoKey = 'obs_' + obsFields.id;
        photoCache.set(obsPhotoKey, photos);
        db.photos.put({ key: obsPhotoKey, data: photos }).catch(() => {});
        photosRestored += photos.filter(Boolean).length;
      }
    });
    saveObs();

    // Also merge colonies if present
    if (data.colonies) {
      data.colonies.forEach(c => {
        if (!colonies.find(x => x.id === c.id)) colonies.push(c);
      });
      saveColonies();
    }

    event.target.value = '';
    showToast(`✓ Import complete: +${catsAdded} new cats, ${catsUpdated} updated, +${obsAdded} obs, ${photosRestored} photos`);
    renderAll();
  };
  reader.readAsText(file);
}

function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    let rows;
    try { rows = parseCSV(e.target.result); } catch(err) {
      alert('Import failed: could not parse CSV.'); return;
    }
    if (!rows.length) { alert('Import failed: CSV is empty.'); return; }

    let catsAdded = 0, catsUpdated = 0, obsAdded = 0;
    rows.forEach(row => {
      const catId = row['Cat ID'];
      if (!catId) return;

      // Upsert cat record
      let cat = cats.find(c => c.id === catId);
      if (!cat) {
        cat = { id: catId };
        cats.push(cat);
        catsAdded++;
      } else { catsUpdated++; }
      if (row['Name'])         cat.name = row['Name'];
      if (row['Colony'])       cat.colony = row['Colony'];
      if (row['Colour'])       cat.colour = row['Colour'];
      if (row['Pattern'])      cat.pattern = row['Pattern'];
      if (row['Sex'])          cat.sex = row['Sex'];
      if (row['Age'])          cat.age = row['Age'];
      if (row['Bio'])          cat.bio = row['Bio'];

      // Build observation from remaining CSV columns
      const obsId = row['Obs ID'] || `${catId}_csv_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      const existing = observations.find(o => o.id === obsId);
      if (!existing) {
        const obs = {
          id: obsId,
          cat_id: catId,
          date: row['Date'] || '',
          time: row['Time'] || '',
          fixed: row['Fixed'] || '',
          trap: row['Trap Status'] || '',
          health: row['Health'] || '',
          bcs: row['BCS'] || '',
          location: row['Location'] || '',
          notes: row['Notes'] || '',
        };
        observations.push(obs);
        obsAdded++;
      }
    });
    saveCats();
    saveObs();

    event.target.value = '';
    showToast(`✓ CSV import: +${catsAdded} new cats, ${catsUpdated} updated, +${obsAdded} obs`);
    renderAll();
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  if (!lines.length) return rows;

  function splitLine(line) {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuote = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') { inQuote = true; }
        else if (ch === ',') { fields.push(cur); cur = ''; }
        else { cur += ch; }
      }
    }
    fields.push(cur);
    return fields;
  }

  const headers = splitLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h.trim()] = (vals[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

// ══════════════════════════════════════════════════════════════════
// CLEAR ALL DATA
// ══════════════════════════════════════════════════════════════════
function clearAll() {
  if(!confirm('⚠ This will permanently delete ALL cats, observations, and colonies. Are you absolutely sure?')) return;
  if(!confirm('Last chance — this cannot be undone. Delete everything?')) return;

  db.cats.clear();
  db.observations.clear();
  db.colonies.clear();
  db.photos.clear();
  db.relationships.clear();
  photoCache.clear();

  cats = []; observations = []; colonies = []; relationships = [];
  activeColony = '';
  renderCats(); renderColonies(); renderStats();
  updateColonyBadge();
  clearForm();
  showToast('All data cleared');
}

// ══════════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════════
function showSaveFlash(name, sub) {
  document.getElementById('save-flash-name').textContent = name;
  document.getElementById('save-flash-sub').textContent = sub || '';
  const el = document.getElementById('save-flash');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ══════════════════════════════════════════════════════════════════
// COLONY OBSERVATION MAP
// ══════════════════════════════════════════════════════════════════
function openColonyOverviewMap(colonyIdx) {
  colonyOverviewMapIdx = colonyIdx;
  const col = colonies[colonyIdx];
  if(!col) return;
  document.getElementById('colony-overview-map-title').textContent = `📍 ${col.name}`;

  // Populate cat filter dropdown
  const colonyCats = cats.filter(c => c.colony === col.name);
  const catSel = document.getElementById('col-map-filter-cat');
  catSel.innerHTML = `<option value="">All cats (${colonyCats.length})</option>` +
    colonyCats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  // Reset filters
  document.getElementById('col-map-filter-status').value = '';
  document.getElementById('col-map-filter-health').value  = '';
  document.getElementById('col-map-filter-show').value   = 'latest';
  document.getElementById('colony-overview-map-popup').style.display = 'none';

  document.getElementById('colony-overview-map-modal').classList.add('open');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if(colonyOverviewMap) { colonyOverviewMap.destroy(); colonyOverviewMap = null; }
    const canvas = document.getElementById('colony-overview-map-canvas');
    colonyOverviewMap = new TileMap(canvas, { onMarkerTap: m => showColonyOverviewPopup(m) });
    if(col.bounds) colonyOverviewMap.fitBounds(col.bounds.sw, col.bounds.ne, 13);
    renderColonyOverviewMap();
  }));
}

function closeColonyOverviewMap() {
  document.getElementById('colony-overview-map-modal').classList.remove('open');
  if(colonyOverviewMap) { colonyOverviewMap.destroy(); colonyOverviewMap = null; }
}
function closeColonyOverviewIfOutside(e) {
  if(e.target === document.getElementById('colony-overview-map-modal')) closeColonyOverviewMap();
}

function renderColonyOverviewMap() {
  if(colonyOverviewMapIdx === null || !colonyOverviewMap) return;
  const col = colonies[colonyOverviewMapIdx];
  if(!col) return;

  const filterCat    = document.getElementById('col-map-filter-cat').value;
  const filterStatus = document.getElementById('col-map-filter-status').value;
  const filterHealth = document.getElementById('col-map-filter-health').value;
  const filterShow   = document.getElementById('col-map-filter-show').value;

  let filtered = cats.filter(c => c.colony === col.name);
  if(filterCat)    filtered = filtered.filter(c => c.id === filterCat);
  if(filterStatus === 'fixed')    filtered = filtered.filter(c => derivedStatus(c.id).fixed === 'Yes');
  if(filterStatus === 'unfixed')  filtered = filtered.filter(c => derivedStatus(c.id).fixed === 'No');
  if(filterHealth === 'concerns') filtered = filtered.filter(c => {
    const s = derivedStatus(c.id); return s.health && !s.health.includes('Appears healthy');
  });
  if(filterHealth === 'healthy')  filtered = filtered.filter(c => {
    const s = derivedStatus(c.id); return s.health && s.health.includes('Appears healthy');
  });

  const markers = [];
  filtered.forEach(cat => {
    const catObs = observations
      .filter(o => o.cat_id === cat.id && o.gps && o.gps.trim())
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const showObs = filterShow === 'all' ? catObs : catObs.slice(0, 1);
    const status = derivedStatus(cat.id);
    const color  = status.fixed === 'Yes' ? '#3fcf6e' : status.fixed === 'No' ? '#e05c5c' : '#f0a500';
    showObs.forEach(o => {
      const parts = o.gps.split(',');
      const lat = parseFloat(parts[0].trim()), lng = parseFloat(parts[1].trim());
      if(isNaN(lat) || isNaN(lng)) return;
      markers.push({ lat, lng, color, label: cat.name, catId: cat.id,
                     date: o.date, location: o.location || '' });
    });
  });

  colonyOverviewMap.setMarkers(markers);
  if(markers.length) colonyOverviewMap.fitMarkers(markers, 13);

  document.getElementById('colony-overview-map-count').textContent =
    `${markers.length} marker${markers.length !== 1 ? 's' : ''} · ${filtered.length} cat${filtered.length !== 1 ? 's' : ''}`;
  document.getElementById('colony-overview-map-popup').style.display = 'none';
}

function showColonyOverviewPopup(m) {
  const cat = getCatById(m.catId);
  if(!cat) return;
  const status = derivedStatus(m.catId);
  const fixedLabel = status.fixed === 'Yes'
    ? '<span style="color:#3fcf6e">✓ Fixed</span>'
    : status.fixed === 'No' ? '<span style="color:#e05c5c">✗ Not Fixed</span>' : '';
  document.getElementById('colony-overview-map-popup').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div>
        <div style="font-weight:700;font-size:0.9rem">${esc(cat.name)}</div>
        <div style="font-family:var(--mono);font-size:0.6rem;color:var(--muted);margin-top:2px">
          ${esc(m.date)}${m.location ? ' · ' + esc(m.location) : ''} ${fixedLabel}
        </div>
      </div>
      <button class="btn-sm" style="padding:6px 10px;white-space:nowrap;flex-shrink:0"
              onclick="closeColonyOverviewMap();openDetailModal('${m.catId}')">View Profile</button>
    </div>`;
  document.getElementById('colony-overview-map-popup').style.display = 'block';
}

// ══════════════════════════════════════════════════════════════════
// SOCIAL GRAPH
// ══════════════════════════════════════════════════════════════════
let d3Loaded = false;

function loadD3(cb) {
  if(d3Loaded) { cb(); return; }
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/d3@7/dist/d3.min.js';
  s.onload = () => { d3Loaded = true; cb(); };
  document.head.appendChild(s);
}

function renderSocialGraph() {
  const wrap   = document.getElementById('social-graph-wrap');
  const empty  = document.getElementById('social-graph-empty');
  const noRels = document.getElementById('social-no-rels');
  const legend = document.getElementById('social-legend');
  if(!wrap) return;

  const showAll   = document.getElementById('social-all-colonies') &&
                    document.getElementById('social-all-colonies').checked;
  const graphCats = (showAll || !activeColony)
    ? cats
    : cats.filter(c => c.colony === activeColony);

  if(!graphCats.length) {
    wrap.innerHTML = '';
    empty.style.display  = 'block';
    noRels.style.display = 'none';
    legend.style.display = 'none';
    return;
  }
  empty.style.display = 'none';

  const catIds   = new Set(graphCats.map(c => c.id));
  const graphRels = relationships.filter(r => catIds.has(r.catAId) && catIds.has(r.catBId));

  noRels.style.display = graphRels.length ? 'none' : 'block';
  legend.style.display = graphRels.length ? 'block' : 'none';

  wrap.innerHTML = '<div style="font-family:var(--mono);font-size:0.65rem;color:var(--muted);padding:24px;text-align:center">Loading graph…</div>';
  loadD3(() => {
    wrap.innerHTML = '';
    _drawD3Graph(wrap, graphCats, graphRels);
  });
}

function _drawD3Graph(container, graphCats, graphRels) {
  const W = container.clientWidth || 340;
  const H = Math.min(W * 1.3, 540);

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H)
    .attr('viewBox', `0 0 ${W} ${H}`)
    .style('touch-action', 'none')
    .style('border-radius', '12px')
    .style('background', 'var(--surface)');

  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.25, 5]).on('zoom', e => g.attr('transform', e.transform)));

  const defs  = svg.append('defs');
  const nodes = graphCats.map(c => ({ id: c.id, name: c.name, photo: loadPhotoCat(c.id) }));
  nodes.forEach(n => {
    defs.append('clipPath').attr('id', `rclip-${n.id}`)
      .append('circle').attr('r', 20).attr('cx', 0).attr('cy', 0);
  });

  // All links (forceLink resolves source/target string → node ref)
  const allLinks = graphRels.map(r => ({ source: r.catAId, target: r.catBId, type: r.type }));

  const linkForce = d3.forceLink(allLinks)
    .id(d => d.id)
    .distance(d => d.type === 'Lover' ? 80 : d.type === 'Friend' ? 110 : 200)
    .strength(d => d.type === 'Enemy' ? 0 : d.type === 'Lover' ? 0.85 : 0.7);

  const simulation = d3.forceSimulation(nodes)
    .force('link',      linkForce)
    .force('charge',    d3.forceManyBody().strength(-200))
    .force('center',    d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide(48));

  // Enemy repulsion custom force (runs after forceLink resolves refs)
  simulation.force('enemy-repel', alpha => {
    allLinks.filter(l => l.type === 'Enemy').forEach(l => {
      const s = l.source, t = l.target;
      if(!s || !t || s.x == null) return;
      const dx = (t.x - s.x) || 0.01, dy = (t.y - s.y) || 0.01;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const threshold = 250;
      if(d < threshold) {
        const k = alpha * 3 * (threshold - d) / threshold;
        s.vx -= dx / d * k;  s.vy -= dy / d * k;
        t.vx += dx / d * k;  t.vy += dy / d * k;
      }
    });
  });

  const linkColors = { Friend: '#3fcf6e', Enemy: '#e05c5c', Lover: '#c084fc' };

  // Draw edges
  const linkEls = g.append('g').selectAll('line')
    .data(allLinks).enter().append('line')
    .attr('stroke', d => linkColors[d.type])
    .attr('stroke-width', 2.5)
    .attr('stroke-opacity', 0.75)
    .attr('stroke-dasharray', d => d.type === 'Enemy' ? '7 4' : null);

  // ♥ on lover edges
  const loverLinks = allLinks.filter(l => l.type === 'Lover');
  const heartEls = g.append('g').selectAll('text')
    .data(loverLinks).enter().append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
    .attr('font-size', '14px').attr('fill', '#c084fc')
    .attr('pointer-events', 'none').text('♥');

  // Draw nodes
  const nodeEls = g.append('g').selectAll('g')
    .data(nodes).enter().append('g')
    .style('cursor', 'pointer')
    .on('click', (e, d) => { e.stopPropagation(); openDetailModal(d.id); })
    .call(d3.drag()
      .on('start', (e, d) => { if(!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if(!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  nodeEls.append('circle').attr('r', 22)
    .attr('fill', 'var(--surface2)').attr('stroke', 'var(--border)').attr('stroke-width', 2);

  nodes.forEach(n => {
    const el = nodeEls.filter(d => d.id === n.id);
    if(n.photo) {
      el.append('image').attr('href', n.photo)
        .attr('x', -20).attr('y', -20).attr('width', 40).attr('height', 40)
        .attr('clip-path', `url(#rclip-${n.id})`);
    } else {
      el.append('text').attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('font-size', '18px').attr('pointer-events', 'none').text('🐱');
    }
  });

  nodeEls.append('text').attr('y', 32).attr('text-anchor', 'middle')
    .attr('font-family', 'var(--font)').attr('font-size', '10px').attr('font-weight', '700')
    .attr('fill', 'var(--text)').attr('pointer-events', 'none')
    .text(d => d.name.length > 10 ? d.name.slice(0, 9) + '…' : d.name);

  simulation.on('tick', () => {
    linkEls
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    heartEls
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
    nodeEls.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// ══════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════
init();