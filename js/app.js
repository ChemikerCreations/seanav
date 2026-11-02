// SeaNav – orchestrazione: stato, GPS, navigazione verso waypoint, traccia, schermate.
import * as N from './nav.js';
import { MODES, effectiveMode, targetBearing, OrientFilter } from './orient.js';
import * as db from './db.js';
import { buildGpx, parseGpx } from './gpx.js';
import { Gps, setWakeLock, wakeLockSupported } from './gps.js';
import { Simulator, orbitPath, approachPath } from './sim.js';
import { TrackRecorder, trackStats } from './track.js';
import { SeaMap, WP_ICONS } from './map.js';
import { $, h, toast, openSheet, closeAllSheets, confirmDialog, showAlert, clearAlert, downloadFile, canShareFiles, shareFile, pickFile, unlockAudio, beep } from './ui.js';

const DEFAULTS = {
  speedUnit: 'kn', distUnit: 'nm', coordFmt: 'DM', utc: false,
  arrivalNm: 0.05, xteAlarm: false, xteNm: 0.1,
  trackSeconds: 5, trackMeters: 10, maxAccuracy: 50, gapSeconds: 30,
  boat: 'sail', lockOrient: false, wake: true, boatFromBottom: 0.33,
  baseStyle: 'https://tiles.openfreemap.org/styles/liberty',
  seamark: true, seamarkOpacity: 1,
  lastBackup: 0,
};

const S = {
  settings: { ...DEFAULTS },
  waypoints: [],
  fix: null,
  mode: 'north', // modalita' di orientamento scelta
  follow: true,
  orientSuspended: false,
  goto: null, // {wpId, name, lat, lon, start:{lat,lon}|null, arrived:boolean, xteAlertAt:number}
  pick: null, // {type:'add'|'move', id?}
  measure: null, // null | []
  shownTracks: new Set(),
  recSegs: [],
  firstFix: true,
  tab: 'map',
  lastNav: null,
};

const gps = new Gps();
const filter = new OrientFilter({ alpha: 0.3, threshold: 3 });
let seaMap;
let recorder;
let sim;

// ---------- formattazione ----------
const sp = (kn) => (kn == null ? '--' : (S.settings.speedUnit === 'kmh' ? kn * 1.852 : kn).toFixed(1));
const spUnit = () => (S.settings.speedUnit === 'kmh' ? 'km/h' : 'kn');
function dist(m) {
  if (m == null) return { v: '--', u: S.settings.distUnit === 'km' ? 'km' : 'mn' };
  if (S.settings.distUnit === 'km') return { v: m < 10000 ? (m / 1000).toFixed(2) : (m / 1000).toFixed(1), u: 'km' };
  const nm = m / N.NM;
  return { v: nm < 10 ? nm.toFixed(2) : nm.toFixed(1), u: 'mn' };
}
const distStr = (m) => {
  const d = dist(m);
  return `${d.v} ${d.u}`;
};
const deg = (a) => (a == null ? '---' : String(Math.round(N.normDeg(a)) % 360).padStart(3, '0'));
const coordsStr = (lat, lon) => {
  const c = N.formatCoords(lat, lon, S.settings.coordFmt);
  return `${c.lat}  ${c.lon}`;
};
function clock(ms) {
  const d = new Date(ms);
  return S.settings.utc
    ? d.toISOString().slice(11, 16) + 'Z'
    : d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// ---------- impostazioni ----------
async function loadSettings() {
  const saved = await db.kvGet('settings');
  S.settings = { ...DEFAULTS, ...(saved || {}) };
}
const saveSettings = () => db.kvSet('settings', S.settings);

// ---------- avvio ----------
async function init() {
  await loadSettings();
  S.waypoints = await db.getWaypoints();

  seaMap = new SeaMap('map', S.settings, {
    onTap: onMapTap,
    onLongPress: (ll) => openWaypointEditor({ lat: ll.lat, lon: ll.lng }),
    onWaypointClick: (id) => openWaypointEditor(S.waypoints.find((w) => w.id === id)),
    onUserPan: () => {
      if (S.follow && !S.pick) {
        S.follow = false;
        refreshButtons();
      }
    },
    onUserRotate: () => {
      if (S.settings.lockOrient) return;
      S.orientSuspended = true;
      refreshButtons();
    },
    onRotate: (b) => {
      $('#rose svg').style.transform = `rotate(${-b}deg)`;
    },
    onError: (msg, soft) => toast(msg, { kind: 'warn', ms: soft ? 6000 : 0 }),
  });

  recorder = new TrackRecorder(
    () => S.settings,
    (st) => {
      updateRecUi(st);
      if (st.point) {
        const last = S.recSegs[S.recSegs.length - 1];
        if (last && st.point.seg === S.recSegsSeg) last.push([st.point.lon, st.point.lat]);
        else {
          S.recSegs.push([[st.point.lon, st.point.lat]]);
          S.recSegsSeg = st.point.seg;
        }
        seaMap.setRecordingLine(S.recSegs);
      }
    }
  );

  sim = new Simulator(gps, (st) => {
    $('#gps-dot').classList.toggle('sim', !!st.running);
    if (st.running) toast('Simulazione attiva: il GPS reale e\' ignorato', { kind: 'warn' });
    else toast('Simulazione terminata: GPS reale', {});
  });

  gps.onFix(onFix);
  gps.onError(onGpsError);

  wireUi();
  seaMap.setWaypoints(S.waypoints, null);
  refreshButtons();
  renderGotoUi();

  // ripristina "Vai a" attivo
  const g = await db.kvGet('goto');
  if (g && S.waypoints.some((w) => w.id === g.wpId)) {
    S.goto = g;
    S.mode = 'dest';
    const w = S.waypoints.find((x) => x.id === g.wpId);
    S.goto.lat = w.lat;
    S.goto.lon = w.lon;
    S.goto.name = w.name;
    renderGotoUi();
    seaMap.setWaypoints(S.waypoints, S.goto.wpId);
  }

  if (!(await db.kvGet('accepted'))) showDisclaimer();
  else await afterAccept();

  setInterval(gpsWatchdog, 2000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', () => seaMap.resize());
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  window.seanav = { S, gps, sim, recorder, seaMap, filter }; // utile per debug/test da console
}

async function afterAccept() {
  navigator.storage?.persist?.().catch(() => {});
  gps.start();
  if (S.settings.wake) setWakeLock(true);
  checkOpenTrack();
  backupReminder();
}

function showDisclaimer() {
  openSheet(
    'Avvertenza di sicurezza',
    (body, api) => {
      body.append(
        h('div', { class: 'warnbox' },
          h('p', {}, h('b', {}, 'SeaNav e\' solo un ausilio. '), 'NON sostituisce le carte nautiche ufficiali, gli strumenti di bordo, i bollettini meteo ufficiali ne\' il giudizio del comandante.')),
        h('ul', {},
          h('li', {}, 'Le carte gratuite (OpenSeaMap, batimetria EMODnet) non sono carte ufficiali e possono essere incomplete o errate.'),
          h('li', {}, 'La rotta "Vai a" e\' una linea diretta: NON evita terra, secche o ostacoli.'),
          h('li', {}, 'Il browser non garantisce il GPS con schermo spento o app in background: per registrare la traccia tieni lo schermo acceso e il dispositivo in carica.'),
          h('li', {}, 'I dati restano sul tuo dispositivo. Servizi esterni contattati: tile mappa (OpenFreeMap, OpenSeaMap). Esporta spesso un backup: il browser puo\' cancellare i dati locali.'),
          h('li', {}, 'Tutti gli angoli sono gradi VERI (non magnetici).')),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary grow',
            onclick: async () => {
              await db.kvSet('accepted', Date.now());
              api.close();
              afterAccept();
            },
          }, 'Ho capito, accetto'))
      );
    },
    { dismissable: false }
  );
}

// ---------- GPS ----------
function onGpsError(err) {
  const msg =
    err.code === 1
      ? 'Permesso di posizione negato: l\'app resta utilizzabile per pianificare (waypoint, tracce). Abilitalo dalle impostazioni del browser per usare il GPS.'
      : err.code === 3
        ? 'Nessun fix GPS (timeout). Cerco ancora...'
        : 'Posizione non disponibile: ' + (err.message || 'errore');
  toast(msg, { kind: 'warn', ms: err.code === 1 ? 0 : 6000 });
}

function gpsWatchdog() {
  const f = S.fix;
  const dot = $('#gps-dot');
  if (gps.simulated) return;
  if (!f || Date.now() - f.t > 10000) {
    dot.className = 'dot';
    $('#v-acc').textContent = f ? 'GPS perso' : 'nessun fix';
  }
}

function onFix(fix) {
  S.fix = fix;
  const cog = fix.cog ?? gps.lastGoodCog;
  const moving = (fix.sog ?? 0) >= 0.5;
  seaMap.setBoat(fix, cog, cog != null && (moving || fix.cog != null));

  // HUD
  $('#v-sog').textContent = sp(fix.sog);
  $('#u-sog').textContent = spUnit();
  $('#v-cog').textContent = deg(fix.cog ?? (moving ? cog : null));
  const c = N.formatCoords(fix.lat, fix.lon, S.settings.coordFmt);
  $('#v-lat').textContent = c.lat;
  $('#v-lon').textContent = c.lon;
  const acc = fix.acc;
  $('#gps-dot').className = 'dot ' + (fix.sim ? 'sim' : acc == null || acc > 50 ? '' : acc > 15 ? 'weak' : 'good');
  $('#v-acc').textContent = fix.sim ? 'SIM' : acc == null ? 'GPS' : `±${Math.round(acc)} m`;

  recorder.onFix(fix);
  if (S.goto && S.goto.start === null) S.goto.start = { lat: fix.lat, lon: fix.lon }; // partenza = prima posizione utile
  updateNav(fix);
  updateCamera(fix);
  updateDim(fix);
  if (S.measure) updateMeasure();
}

// ---------- navigazione verso waypoint ----------
function computeNav(fix) {
  const g = S.goto;
  if (!g) return null;
  const pos = { lat: fix.lat, lon: fix.lon };
  const dest = { lat: g.lat, lon: g.lon };
  const brg = N.rhumbBearing(pos, dest);
  const dst = N.distance(pos, dest);
  const sog = fix.sog ?? 0;
  const cog = fix.cog ?? gps.lastGoodCog;
  const xte = g.start ? N.crossTrack(g.start, dest, pos) : 0;
  const v = sog >= 0.3 && cog != null ? N.vmg(sog, cog, brg) : null;
  const eta = N.etaSeconds(dst, v);
  return { brg, dst, xte, vmg: v, eta, sog, cog };
}

function updateNav(fix) {
  const g = S.goto;
  if (!g) {
    S.lastNav = null;
    return;
  }
  const n = (S.lastNav = computeNav(fix));
  const d = dist(n.dst);
  $('#g-brg').textContent = deg(n.brg);
  $('#g-dst').textContent = `${d.v} ${d.u}`;
  $('#g-eta').textContent = n.eta == null ? '--:--' : N.formatDuration(n.eta);
  const x = dist(Math.abs(n.xte));
  $('#g-xte').textContent = `${x.v} ${x.u} ${n.xte > 0.5 ? 'dx' : n.xte < -0.5 ? 'sx' : ''}`;

  $('#n-brg').textContent = deg(n.brg);
  $('#n-dst').textContent = d.v;
  $('#n-dstu').textContent = d.u;
  $('#n-eta').textContent = n.eta == null ? '--:--' : N.formatDuration(n.eta);
  $('#n-etaclk').textContent = n.eta == null ? (n.sog < 0.3 ? 'SOG ~ 0: ETA non calcolabile' : n.vmg != null && n.vmg <= 0 ? 'ti stai allontanando' : '') : 'arrivo ' + clock(Date.now() + n.eta * 1000);
  $('#n-xte').textContent = x.v;
  $('#n-xteu').textContent = x.u;
  $('#n-xtes').textContent = n.xte > 0.5 ? 'a DESTRA della rotta → vira a sinistra' : n.xte < -0.5 ? 'a SINISTRA della rotta → vira a destra' : 'sulla rotta';
  $('#n-vmg').textContent = n.vmg == null ? '--' : sp(n.vmg);
  $('#n-sog').textContent = sp(n.sog);
  $('#n-cog').textContent = n.cog == null ? 'COG ---' : 'COG ' + deg(n.cog) + '°';
  const rel = n.cog == null ? n.brg : N.angleDiff(n.cog, n.brg);
  $('#nv-needle').setAttribute('transform', `rotate(${rel})`);
  $('#nv-hint').textContent = 'La freccia indica dove andare rispetto alla tua prua/COG (dritta in alto = in rotta). Angoli veri.';

  // linee sulla mappa
  seaMap.setGoto({ boat: { lat: fix.lat, lon: fix.lon }, start: g.start, dest: { lat: g.lat, lon: g.lon } });

  // allarme arrivo
  const radius = S.settings.arrivalNm * N.NM;
  if (!g.arrived && n.dst <= radius) {
    g.arrived = true;
    beep(4);
    showAlert(`ARRIVATO: ${g.name}`, [
      { label: 'OK', run: () => {} },
      { label: 'Termina navigazione', cls: 'primary', run: stopGoto },
    ]);
  } else if (g.arrived && n.dst > radius * 1.5) {
    g.arrived = false;
  }
  // allarme XTE (al massimo ogni 30 s)
  if (S.settings.xteAlarm && Math.abs(n.xte) > S.settings.xteNm * N.NM && Date.now() - (g.xteAlertAt || 0) > 30000) {
    g.xteAlertAt = Date.now();
    beep(2);
    toast(`Fuori rotta: XTE ${distStr(Math.abs(n.xte))} ${n.xte > 0 ? 'a dx' : 'a sx'}`, { kind: 'err', ms: 8000 });
  }
}

async function startGoto(wp) {
  S.goto = {
    wpId: wp.id, name: wp.name, lat: wp.lat, lon: wp.lon,
    start: S.fix ? { lat: S.fix.lat, lon: S.fix.lon } : null, // se manca la posizione, si prende la prima utile
    arrived: false, xteAlertAt: 0,
  };
  await db.kvSet('goto', { wpId: wp.id, start: S.goto.start });
  S.mode = 'dest'; // default quando c'e' un "Vai a"
  S.orientSuspended = false;
  S.follow = true;
  filter.reset(seaMap.bearing);
  renderGotoUi();
  seaMap.setWaypoints(S.waypoints, wp.id);
  if (S.fix) {
    updateNav(S.fix);
    updateCamera(S.fix);
  } else {
    seaMap.setGoto({ boat: null, start: null, dest: wp });
    toast('Nessuna posizione GPS ancora: la rotta partira\' dal primo fix.', { kind: 'warn' });
  }
  setTab('map');
  closeAllSheets();
  toast(`Vai a: ${wp.name}`);
}

async function stopGoto() {
  S.goto = null;
  S.lastNav = null;
  await db.kvSet('goto', null);
  seaMap.setGoto(null);
  seaMap.setWaypoints(S.waypoints, null);
  clearAlert();
  renderGotoUi();
  refreshButtons();
}

function renderGotoUi() {
  const g = S.goto;
  $('#hud-goto').hidden = !g;
  $('#g-name').textContent = g ? g.name : '';
  $('#nv-name').textContent = g ? `→ ${g.name}` : 'Nessuna destinazione';
  $('#nv-stop').hidden = !g;
  if (!g) {
    for (const id of ['n-brg', 'n-dst', 'n-xte', 'n-vmg', 'n-sog']) $('#' + id).textContent = '--';
    $('#n-eta').textContent = '--:--';
    ['n-etaclk', 'n-xtes', 'n-cog'].forEach((id) => ($('#' + id).textContent = ''));
    $('#nv-hint').textContent = 'Seleziona un waypoint e premi "Vai a".';
  }
  refreshButtons();
}

// ---------- camera / orientamento ----------
function updateCamera(fix) {
  if (!seaMap.map) return;
  const eff = effectiveMode(S.mode, !!S.goto);
  let bearing = null;
  if (!S.orientSuspended) {
    const target = targetBearing(S.mode, {
      pos: fix,
      cog: fix.cog ?? gps.lastGoodCog,
      sog: fix.sog,
      dest: S.goto ? { lat: S.goto.lat, lon: S.goto.lon } : null,
      routeStart: S.goto?.start || null,
    });
    bearing = filter.update(target);
  }
  const h = $('#map').clientHeight;
  const padTop = eff === 'north' ? 0 : Math.max(0, h * (1 - 2 * S.settings.boatFromBottom));
  if (S.follow) {
    const first = S.firstFix;
    S.firstFix = false;
    seaMap.aim({ center: [fix.lon, fix.lat], bearing, padTop, duration: first ? 0 : 900, zoom: first ? 13 : undefined });
  } else if (bearing != null) {
    seaMap.aim({ bearing, duration: 600 });
  }
}

const MODE_LABEL = { north: 'N', course: 'COG', dest: 'WP', route: 'RTA' };
const MODE_NAME = {
  north: 'Nord in alto',
  course: 'Prua/COG in alto',
  dest: 'Waypoint davanti (BRG in alto)',
  route: 'Rotta in alto',
};

function cycleMode() {
  if (S.orientSuspended) {
    S.orientSuspended = false; // il primo tocco riprende solo l'auto-orientamento
    filter.reset(seaMap.bearing);
    refreshButtons();
    if (S.fix) updateCamera(S.fix);
    toast('Auto-orientamento ripreso: ' + MODE_NAME[S.mode]);
    return;
  }
  S.mode = MODES[(MODES.indexOf(S.mode) + 1) % MODES.length];
  filter.reset(seaMap.bearing);
  if ((S.mode === 'dest' || S.mode === 'route') && !S.goto) toast('Nessun waypoint attivo: uso Prua/COG in alto', { kind: 'warn' });
  else toast(MODE_NAME[S.mode]);
  refreshButtons();
  if (S.mode === 'north') seaMap.aim({ bearing: 0, duration: 400 });
  if (S.fix) updateCamera(S.fix);
}

function refreshButtons() {
  const eff = effectiveMode(S.mode, !!S.goto);
  $('#orient-label').textContent = (S.orientSuspended ? '⏸ ' : '') + MODE_LABEL[eff];
  $('#btn-orient').title = MODE_NAME[eff];
  $('#fab-follow').classList.toggle('on', S.follow);
  $('#fab-rec').classList.toggle('recon', recorder?.recording);
  $('#fab-measure').classList.toggle('on', !!S.measure);
}

// ---------- tocchi sulla mappa ----------
function onMapTap(ll) {
  if (S.pick) {
    const p = S.pick;
    setPick(null);
    if (p.type === 'add') openWaypointEditor({ lat: ll.lat, lon: ll.lng });
    else if (p.type === 'move') {
      const w = S.waypoints.find((x) => x.id === p.id);
      if (w) {
        w.lat = ll.lat;
        w.lon = ll.lng;
        saveWp(w).then(() => openWaypointEditor(w));
      }
    }
    return;
  }
  if (S.measure) {
    if (S.measure.length >= 2) S.measure = [];
    S.measure.push({ lat: ll.lat, lon: ll.lng });
    updateMeasure();
  }
}

function setPick(p) {
  S.pick = p;
  $('#crosshair').hidden = !p;
  $('#pickbar').hidden = !p;
  if (p) {
    $('#pick-text').textContent = p.type === 'add' ? 'Tocca la mappa per piazzare il waypoint' : 'Tocca la nuova posizione del waypoint';
    S.follow = false; // niente auto-pan mentre si sceglie il punto
    refreshButtons();
  }
}

function toggleMeasure(on) {
  S.measure = on ? [] : null;
  $('#measurebar').hidden = !on;
  seaMap.setMeasure([]);
  $('#measure-text').textContent = 'Tocca due punti sulla mappa';
  refreshButtons();
}

function updateMeasure() {
  const pts = S.measure;
  seaMap.setMeasure(pts);
  if (pts.length === 2) {
    const d = N.distance(pts[0], pts[1]);
    $('#measure-text').textContent = `${distStr(d)} · rilevamento ${deg(N.rhumbBearing(pts[0], pts[1]))}°`;
  } else $('#measure-text').textContent = pts.length === 1 ? 'Tocca il secondo punto' : 'Tocca due punti sulla mappa';
}

// ---------- waypoint ----------
async function saveWp(w) {
  await db.saveWaypoint(w);
  if (!S.waypoints.some((x) => x.id === w.id)) S.waypoints.push(w);
  seaMap.setWaypoints(S.waypoints, S.goto?.wpId ?? null);
  if (S.goto && S.goto.wpId === w.id) {
    S.goto.lat = w.lat;
    S.goto.lon = w.lon;
    S.goto.name = w.name;
    renderGotoUi();
  }
}

async function removeWp(w) {
  await db.deleteWaypoint(w.id);
  S.waypoints = S.waypoints.filter((x) => x.id !== w.id);
  if (S.goto?.wpId === w.id) await stopGoto();
  seaMap.setWaypoints(S.waypoints, S.goto?.wpId ?? null);
  toast(`Eliminato "${w.name}"`, {
    ms: 9000,
    action: { label: 'ANNULLA', run: async () => { await saveWp(w); } },
  });
}

function openWaypointEditor(src) {
  if (!src) return;
  const isNew = !src.id;
  const w = isNew
    ? { id: db.uid(), name: `WP ${S.waypoints.length + 1}`, lat: src.lat, lon: src.lon, note: '', icon: 'generic', created: Date.now() }
    : { ...src };
  openSheet(isNew ? 'Nuovo waypoint' : 'Waypoint', (body, api) => {
    const name = h('input', { value: w.name, maxlength: 60 });
    const fmt = S.settings.coordFmt;
    const lat = h('input', { value: N.formatCoords(w.lat, w.lon, fmt).lat, inputmode: 'text', autocapitalize: 'characters' });
    const lon = h('input', { value: N.formatCoords(w.lat, w.lon, fmt).lon, inputmode: 'text', autocapitalize: 'characters' });
    const note = h('textarea', { rows: 2 }, w.note);
    const err = h('div', { class: 'small', style: { color: '#ff8787' } });
    let icon = w.icon;
    const picker = h('div', { class: 'picker' });
    const drawPicker = () => {
      picker.replaceChildren(
        ...Object.entries(WP_ICONS).filter(([k]) => k !== 'mob' || icon === 'mob').map(([k, ic]) =>
          h('button', { class: k === icon ? 'sel' : '', style: { background: ic.color }, title: ic.label, onclick: () => { icon = k; drawPicker(); } }, ic.glyph))
      );
    };
    drawPicker();
    const readCoords = () => {
      const la = N.parseCoord(lat.value);
      const lo = N.parseCoord(lon.value);
      if (la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) {
        err.textContent = 'Coordinate non valide (es. 43 30.500 N, 009 15.000 E oppure 43.5083, 9.25)';
        return null;
      }
      return { la, lo };
    };
    const commit = async () => {
      const c = readCoords();
      if (!c) return false;
      Object.assign(w, { name: name.value.trim() || w.name, lat: c.la, lon: c.lo, note: note.value, icon });
      await saveWp(w);
      return true;
    };
    body.append(
      h('label', { class: 'f' }, 'Nome'), name,
      h('label', { class: 'f' }, 'Latitudine'), lat,
      h('label', { class: 'f' }, 'Longitudine'), lon,
      err,
      h('label', { class: 'f' }, 'Icona'), picker,
      h('label', { class: 'f' }, 'Nota'), note,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', onclick: async () => { if (await commit()) { api.close(); toast('Waypoint salvato'); } } }, 'Salva'),
        h('button', { class: 'btn grow', onclick: async () => { if (await commit()) startGoto(w); } }, 'Vai a ▶')),
      h('div', { class: 'row' },
        isNew && S.fix ? h('button', { class: 'btn grow', onclick: () => { lat.value = N.formatCoords(S.fix.lat, S.fix.lon, fmt).lat; lon.value = N.formatCoords(S.fix.lat, S.fix.lon, fmt).lon; } }, 'Usa posizione attuale') : null,
        !isNew ? h('button', { class: 'btn grow', onclick: async () => { if (await commit()) { api.close(); setPick({ type: 'move', id: w.id }); } } }, 'Sposta sulla mappa') : null,
        !isNew ? h('button', { class: 'btn grow', onclick: () => { api.close(); seaMap.aim({ center: [w.lon, w.lat], bearing: 0, duration: 500, padTop: 0 }); S.follow = false; refreshButtons(); setTab('map'); } }, 'Mostra') : null),
      !isNew ? h('div', { class: 'row' }, h('button', { class: 'btn danger grow', onclick: () => { api.close(); removeWp(w); } }, 'Elimina')) : null
    );
  });
}

function waypointsSheet() {
  openSheet('Waypoint', (body) => {
    const q = h('input', { placeholder: 'Cerca...', type: 'search' });
    const list = h('div');
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      let items = S.waypoints.filter((w) => !term || w.name.toLowerCase().includes(term) || (w.note || '').toLowerCase().includes(term));
      const f = S.fix;
      if (f) items = items.map((w) => ({ w, d: N.distance(f, w), b: N.rhumbBearing(f, w) })).sort((a, b) => a.d - b.d);
      else items = items.map((w) => ({ w })).sort((a, b) => b.w.created - a.w.created);
      list.replaceChildren(
        ...(items.length ? [] : [h('p', { class: 'muted' }, 'Nessun waypoint. Tocca "＋" sulla mappa, oppure tieni premuto un punto della mappa.')]),
        ...items.map(({ w, d, b }) =>
          h('div', { class: 'item' },
            h('div', { class: 't' }, `${WP_ICONS[w.icon]?.glyph || '●'}  ${w.name}`),
            h('div', { class: 's' }, coordsStr(w.lat, w.lon)),
            d != null ? h('div', { class: 's' }, `${distStr(d)} · BRG ${deg(b)}°`) : null,
            w.note ? h('div', { class: 's' }, w.note) : null,
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', onclick: () => startGoto(w) }, 'Vai a ▶'),
              h('button', { class: 'btn', onclick: () => { closeAllSheets(); seaMap.aim({ center: [w.lon, w.lat], bearing: 0, duration: 500, padTop: 0, zoom: 14 }); S.follow = false; refreshButtons(); setTab('map'); } }, 'Mostra'),
              h('button', { class: 'btn', onclick: () => { closeAllSheets(); openWaypointEditor(w); } }, 'Modifica'))))
      );
    };
    q.addEventListener('input', draw);
    draw();
    body.append(
      q, list,
      h('div', { class: 'row' },
        h('button', { class: 'btn grow', onclick: () => exportWaypointsGpx() }, 'Esporta GPX'),
        h('button', { class: 'btn grow', onclick: () => importGpx() }, 'Importa GPX')),
      h('p', { class: 'small muted' }, 'I waypoint sono salvati su questo dispositivo. Esporta un GPX per portarli in un\'altra sessione o su un altro dispositivo.')
    );
  });
}

async function doMob() {
  if (!S.fix) {
    toast('MOB: nessuna posizione GPS disponibile!', { kind: 'err', ms: 8000 });
    return;
  }
  const t = new Date();
  const w = { id: db.uid(), name: `MOB ${t.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`, lat: S.fix.lat, lon: S.fix.lon, note: 'Uomo a mare', icon: 'mob', created: Date.now() };
  await saveWp(w);
  beep(2);
  await startGoto(w);
  toast(`MOB salvato e navigazione avviata`, {
    kind: 'err', ms: 10000,
    action: { label: 'ANNULLA', run: async () => { await removeWp(w); await stopGoto(); } },
  });
}

// ---------- GPX / backup ----------
async function saveOrShare(name, text, mime) {
  if (canShareFiles()) {
    const ok = await shareFile(name, text, mime);
    if (ok) return;
  }
  downloadFile(name, text, mime);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

async function exportWaypointsGpx() {
  if (!S.waypoints.length) return toast('Nessun waypoint da esportare');
  await saveOrShare(`seanav-waypoint-${stamp()}.gpx`, buildGpx({ waypoints: S.waypoints }), 'application/gpx+xml');
  markBackup();
}

async function exportTrackGpx(tr) {
  const pts = await db.getTrackPoints(tr.id);
  await saveOrShare(`${tr.name.replace(/[^\w\-]+/g, '_')}.gpx`, buildGpx({ tracks: [{ name: tr.name, points: pts }] }), 'application/gpx+xml');
  markBackup();
}

async function importGpx() {
  const f = await pickFile('.gpx,application/gpx+xml,text/xml');
  if (!f) return;
  try {
    const { waypoints, tracks } = parseGpx(f.text);
    const key = (w) => `${w.name}|${w.lat.toFixed(6)}|${w.lon.toFixed(6)}`;
    const have = new Set(S.waypoints.map(key));
    let nw = 0;
    for (const w of waypoints) {
      if (have.has(key(w))) continue;
      await saveWp({ ...w, id: db.uid() });
      have.add(key(w));
      nw++;
    }
    let nt = 0;
    for (const t of tracks) {
      const id = db.uid();
      await db.saveTrackWithPoints({ id, name: t.name, start: t.points[0].t ?? Date.now(), end: t.points.at(-1).t ?? null, active: false, imported: true }, t.points);
      nt++;
    }
    toast(`Importati ${nw} waypoint (${waypoints.length - nw} duplicati saltati) e ${nt} tracce`, { ms: 7000 });
    closeAllSheets();
  } catch (e) {
    toast('Importazione fallita: ' + e.message, { kind: 'err' });
  }
}

async function exportBackup() {
  const tracks = await db.getTracks();
  const full = [];
  for (const t of tracks) full.push({ ...t, points: await db.getTrackPoints(t.id) });
  const data = { app: 'seanav', version: 1, exported: new Date().toISOString(), settings: S.settings, waypoints: S.waypoints, tracks: full };
  await saveOrShare(`seanav-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
  markBackup();
}

async function importBackup() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  try {
    const d = JSON.parse(f.text);
    if (d.app !== 'seanav') throw new Error('non e\' un backup SeaNav');
    const have = new Set(S.waypoints.map((w) => w.id));
    let nw = 0, nt = 0;
    for (const w of d.waypoints || []) if (!have.has(w.id)) { await saveWp(w); nw++; }
    const haveT = new Set((await db.getTracks()).map((t) => t.id));
    for (const t of d.tracks || []) {
      if (haveT.has(t.id)) continue;
      const { points, ...rec } = t;
      await db.saveTrackWithPoints({ ...rec, active: false }, points || []);
      nt++;
    }
    toast(`Backup ripristinato: ${nw} waypoint e ${nt} tracce aggiunti (gli esistenti non sono stati toccati)`, { ms: 8000 });
    closeAllSheets();
  } catch (e) {
    toast('Backup non valido: ' + e.message, { kind: 'err' });
  }
}

async function markBackup() {
  S.settings.lastBackup = Date.now();
  await saveSettings();
}

async function backupReminder() {
  const tracks = await db.getTracks();
  if (!S.waypoints.length && !tracks.length) return;
  const days = (Date.now() - (S.settings.lastBackup || 0)) / 86400000;
  if (days >= 7) {
    toast(S.settings.lastBackup ? `Ultimo backup ${Math.floor(days)} giorni fa` : 'Non hai ancora fatto un backup dei tuoi dati', {
      kind: 'warn', ms: 12000, action: { label: 'Esporta', run: exportBackup },
    });
  }
}

// ---------- tracce ----------
function updateRecUi(st) {
  $('#rec-ind').hidden = !st.recording;
  $('#v-rec').textContent = dist(st.dist).v + ' ' + dist(st.dist).u;
  refreshButtons();
}

async function toggleRec() {
  if (recorder.recording) {
    const ok = await confirmDialog('Fermare la registrazione?', 'La traccia verra\' salvata.', 'Ferma');
    if (!ok) return;
    const t = await recorder.stop();
    S.recSegs = [];
    seaMap.setRecordingLine(null);
    toast(`Traccia salvata: ${t.name}`, { ms: 9000, action: { label: 'Esporta GPX', run: () => exportTrackGpx(t) } });
  } else {
    S.recSegs = [];
    S.recSegsSeg = -1;
    await recorder.start();
    setWakeLock(true);
    toast('Registrazione avviata. Tieni lo schermo acceso e il dispositivo in carica: il browser non registra con lo schermo spento.', { kind: 'warn', ms: 9000 });
    if (S.fix) recorder.onFix(S.fix);
  }
  refreshButtons();
}

async function checkOpenTrack() {
  const open = (await db.getTracks()).find((t) => t.active);
  if (!open) return;
  const ok = await confirmDialog('Traccia rimasta aperta', `"${open.name}" non e' stata chiusa (chiusura accidentale?). Vuoi riprendere la registrazione? Nella traccia ci sara' un buco tra la chiusura e la ripresa.`, 'Riprendi');
  if (ok) {
    await recorder.resume(open);
    const pts = await db.getTrackPoints(open.id);
    S.recSegs = segmentsOf(pts);
    S.recSegsSeg = pts.at(-1)?.seg ?? 0;
    seaMap.setRecordingLine(S.recSegs);
    updateRecUi(recorder.snapshot());
  } else {
    open.active = false;
    open.end = Date.now();
    await db.saveTrack(open);
  }
}

function segmentsOf(points) {
  const segs = [];
  let cur = null, last = null;
  for (const p of points) {
    if (cur === null || p.seg !== last) {
      cur = [];
      segs.push(cur);
      last = p.seg;
    }
    cur.push([p.lon, p.lat]);
  }
  return segs;
}

async function refreshShownTracks() {
  const all = [];
  for (const id of S.shownTracks) all.push(segmentsOf(await db.getTrackPoints(id)));
  seaMap.setShownTracks(all);
}

async function tracksSheet() {
  const tracks = (await db.getTracks()).sort((a, b) => b.start - a.start);
  openSheet('Tracce', (body, api) => {
    const rec = h('div', { class: 'row' },
      h('button', { class: 'btn grow ' + (recorder.recording ? 'danger' : 'primary'), onclick: () => { api.close(); toggleRec(); } }, recorder.recording ? '■ Ferma registrazione' : '● Avvia registrazione'));
    body.append(rec);
    if (!tracks.length) body.append(h('p', { class: 'muted' }, 'Nessuna traccia registrata.'));
    for (const t of tracks) {
      const card = h('div', { class: 'item' });
      body.append(card);
      db.getTrackPoints(t.id).then((pts) => {
        const st = trackStats(pts);
        const shown = S.shownTracks.has(t.id);
        card.replaceChildren(
          h('div', { class: 't' }, (t.active ? '● ' : '') + t.name),
          h('div', { class: 's' }, `${distStr(st.dist)} · ${N.formatDuration(st.duration)} · media ${sp(st.avgSog)} ${spUnit()} · max ${sp(st.maxSog)} ${spUnit()} · ${st.n} punti`),
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: async () => {
              if (shown) S.shownTracks.delete(t.id); else S.shownTracks.add(t.id);
              await refreshShownTracks();
              if (!shown) { api.close(); S.follow = false; refreshButtons(); seaMap.fitPoints(pts); setTab('map'); } else { api.close(); tracksSheet(); }
            } }, shown ? 'Nascondi' : 'Mostra'),
            h('button', { class: 'btn', onclick: () => exportTrackGpx(t) }, 'Esporta GPX'),
            h('button', { class: 'btn', onclick: async () => {
              const n = prompt('Nuovo nome', t.name);
              if (n && n.trim()) { t.name = n.trim(); await db.saveTrack(t); api.close(); tracksSheet(); }
            } }, 'Rinomina'),
            t.id !== recorder.track?.id ? h('button', { class: 'btn danger', onclick: async () => {
              if (await confirmDialog('Eliminare la traccia?', `"${t.name}" verra' cancellata definitivamente. Esportala prima se ti serve.`, 'Elimina', true)) {
                await db.deleteTrack(t.id);
                S.shownTracks.delete(t.id);
                refreshShownTracks();
                api.close();
                tracksSheet();
              }
            } }, 'Elimina') : null)
        );
      });
    }
    body.append(h('div', { class: 'row' }, h('button', { class: 'btn grow', onclick: importGpx }, 'Importa GPX')));
  });
}

// ---------- simulazione ----------
function simSheet() {
  openSheet('Simulazione GPS', (body, api) => {
    const speed = h('select', {}, [1, 2, 5, 10, 30, 60].map((v) => h('option', { value: v, selected: v === sim.speed }, `${v}x`)));
    speed.addEventListener('change', () => sim.setSpeed(Number(speed.value)));
    const center = () => {
      const c = seaMap.map.getCenter();
      return { lat: c.lat, lon: c.lng };
    };
    const ensureDest = async () => {
      if (S.goto) return { lat: S.goto.lat, lon: S.goto.lon };
      const c = center();
      const w = { id: db.uid(), name: 'DEMO', lat: c.lat, lon: c.lon, note: 'Waypoint di prova (simulazione)', icon: 'generic', created: Date.now() };
      await saveWp(w);
      await startGoto(w);
      return c;
    };
    const run = (pts, name) => {
      sim.setSpeed(Number(speed.value));
      sim.load(pts, name);
      try { sim.start(); } catch (e) { toast(e.message, { kind: 'err' }); }
    };
    body.append(
      h('p', { class: 'small muted' }, 'Riproduce un percorso come se fosse il GPS: serve per provare navigazione e orientamento mappa da scrivania.'),
      h('label', { class: 'f' }, 'Velocita\' di riproduzione'), speed,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', onclick: async () => { const d = await ensureDest(); api.close(); run(orbitPath(d, 700, 90), 'Giro attorno al waypoint'); } }, 'Demo: giro attorno al waypoint (test 359°→0°)')),
      h('div', { class: 'row' },
        h('button', { class: 'btn grow', onclick: async () => { const d = await ensureDest(); api.close(); run(approachPath(d, 200, 3000), 'Avvicinamento'); } }, 'Demo: avvicinamento in linea retta')),
      h('div', { class: 'row' },
        h('button', { class: 'btn grow', onclick: async () => {
          const f = await pickFile('.gpx,application/gpx+xml,text/xml');
          if (!f) return;
          try {
            const g = parseGpx(f.text);
            const pts = g.tracks.flatMap((t) => t.points).length ? g.tracks.flatMap((t) => t.points) : g.waypoints;
            if (pts.length < 2) throw new Error('il GPX non contiene un percorso');
            api.close();
            run(pts, f.name);
          } catch (e) { toast('GPX non valido: ' + e.message, { kind: 'err' }); }
        } }, 'Carica GPX e riproduci...')),
      sim.running ? h('div', { class: 'row' }, h('button', { class: 'btn danger grow', onclick: () => { sim.stop(); api.close(); } }, '■ Ferma simulazione e torna al GPS reale')) : null
    );
  });
}

// ---------- impostazioni ----------
function settingsSheet() {
  openSheet('Impostazioni', (body) => {
    const st = S.settings;
    const sel = (label, key, opts, after) => {
      const s = h('select', {}, opts.map(([v, t]) => h('option', { value: v, selected: String(st[key]) === String(v) }, t)));
      s.addEventListener('change', async () => {
        const raw = s.value;
        st[key] = typeof DEFAULTS[key] === 'number' ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
        await saveSettings();
        after?.();
        if (S.fix) onFix(S.fix);
      });
      body.append(h('label', { class: 'f' }, label), s);
    };
    const num = (label, key, step = 'any') => {
      const i = h('input', { type: 'number', step, value: st[key], inputmode: 'decimal' });
      i.addEventListener('change', async () => {
        const v = Number(i.value);
        if (Number.isFinite(v) && v >= 0) { st[key] = v; await saveSettings(); }
      });
      body.append(h('label', { class: 'f' }, label), i);
    };
    const chk = (label, key, after) => {
      const c = h('input', { type: 'checkbox', checked: st[key] });
      c.addEventListener('change', async () => { st[key] = c.checked; await saveSettings(); after?.(); });
      body.append(h('label', { class: 'chk' }, c, label));
    };
    body.append(h('h3', {}, 'Unita\' e formato'));
    sel('Velocita\'', 'speedUnit', [['kn', 'nodi'], ['kmh', 'km/h']]);
    sel('Distanze', 'distUnit', [['nm', 'miglia nautiche'], ['km', 'chilometri']]);
    sel('Formato coordinate', 'coordFmt', [['DM', 'Gradi e minuti decimali (DM)'], ['DD', 'Gradi decimali (DD)'], ['DMS', 'Gradi, minuti, secondi (DMS)']]);
    sel('Orario', 'utc', [[false, 'Locale'], [true, 'UTC']]);
    body.append(h('h3', {}, 'Navigazione e allarmi'));
    num('Raggio allarme di arrivo (mn)', 'arrivalNm', '0.01');
    chk('Allarme di scostamento dalla rotta (XTE)', 'xteAlarm');
    num('Soglia XTE (mn)', 'xteNm', '0.01');
    sel('Posizione della barca sullo schermo (modalita\' ruotate)', 'boatFromBottom', [[0.5, 'Centro'], [0.33, '1/3 dal basso'], [0.25, '1/4 dal basso']]);
    chk('Blocca orientamento (niente rotazione con due dita)', 'lockOrient', () => seaMap.setLockOrientation(st.lockOrient));
    sel('Tipo di barca', 'boat', [['sail', 'Vela'], ['motor', 'Motore']]);
    body.append(h('h3', {}, 'Registrazione traccia'));
    num('Campiona ogni (secondi)', 'trackSeconds');
    num('...oppure ogni (metri)', 'trackMeters');
    num('Scarta fix con precisione peggiore di (m)', 'maxAccuracy');
    num('Buco nella traccia se nessun fix per (secondi)', 'gapSeconds');
    chk('Tieni lo schermo acceso (Wake Lock)', 'wake', () => setWakeLock(st.wake));
    body.append(h('p', { class: 'small muted' }, wakeLockSupported() ? 'Wake Lock supportato da questo browser.' : 'Wake Lock NON supportato: lo schermo potrebbe spegnersi.'));
    body.append(h('h3', {}, 'Carte'));
    chk('Segnali nautici OpenSeaMap', 'seamark', () => seaMap.setSeamark(st.seamark, st.seamarkOpacity));
    sel('Opacita\' segnali nautici', 'seamarkOpacity', [[1, '100%'], [0.75, '75%'], [0.5, '50%']], () => seaMap.setSeamark(st.seamark, st.seamarkOpacity));
    const style = h('input', { value: st.baseStyle });
    style.addEventListener('change', async () => {
      st.baseStyle = style.value.trim() || DEFAULTS.baseStyle;
      await saveSettings();
      seaMap.setBaseStyle(st.baseStyle);
    });
    body.append(h('label', { class: 'f' }, 'Stile mappa base (URL style.json MapLibre; sostituibile)'), style);
    body.append(h('p', { class: 'small muted' }, 'Le carte gratuite non sono carte ufficiali. Servizi contattati: OpenFreeMap (base), OpenSeaMap (segnali).'));
    body.append(
      h('h3', {}, 'Dati'),
      h('div', { class: 'row' },
        h('button', { class: 'btn grow', onclick: exportBackup }, 'Esporta backup completo'),
        h('button', { class: 'btn grow', onclick: importBackup }, 'Importa backup')),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger grow', onclick: async () => {
          if (await confirmDialog('Cancellare tutti i dati?', 'Waypoint, tracce e impostazioni su questo dispositivo verranno eliminati definitivamente. Esporta prima un backup.', 'Cancella tutto', true)) {
            await db.clearAll();
            location.reload();
          }
        } }, 'Cancella tutti i dati')),
      h('p', { class: 'small muted' }, st.lastBackup ? 'Ultimo backup: ' + new Date(st.lastBackup).toLocaleString('it-IT') : 'Nessun backup eseguito.')
    );
  });
}

function menuSheet() {
  openSheet('Menu', (body, api) => {
    const item = (label, fn) => body.append(h('button', { class: 'btn menu-btn', onclick: () => { api.close(); fn(); } }, label));
    item('📍  Waypoint', waypointsSheet);
    item('〰  Tracce', tracksSheet);
    item('🧭  Simulazione GPS', simSheet);
    item('⚙  Impostazioni', settingsSheet);
    item('💾  Esporta backup', exportBackup);
    item('⚠  Avvertenze e informazioni', infoSheet);
  });
}

function infoSheet() {
  openSheet('Avvertenze', (body) => {
    body.append(
      h('div', { class: 'warnbox' }, 'SeaNav e\' un ausilio: non sostituisce carte ufficiali, strumenti di bordo, bollettini ufficiali ne\' il giudizio del comandante. La rotta "Vai a" e\' una linea diretta che NON evita terra o secche.'),
      h('p', {}, 'Angoli in gradi VERI. Il GPS del browser non funziona in modo affidabile con lo schermo spento.'),
      h('p', {}, 'Dati salvati solo su questo dispositivo. Servizi esterni: OpenFreeMap e OpenSeaMap (tile).')
    );
  });
}

// ---------- schermo scuro ----------
function updateDim(fix) {
  if ($('#dimscreen').hidden) return;
  $('#d-sog').textContent = sp(fix.sog);
  const n = S.lastNav;
  $('#d-info').textContent = n ? `${S.goto.name}  BRG ${deg(n.brg)}°  ${distStr(n.dst)}` : `COG ${deg(fix.cog)}°`;
  $('#d-rec').textContent = recorder.recording ? '● REC ' + distStr(recorder.snapshot().dist) : '';
}

// ---------- tab e collegamenti UI ----------
function setTab(t) {
  S.tab = t;
  $('#navview').hidden = t !== 'nav';
  $('#app').classList.toggle('nav-open', t === 'nav');
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === (t === 'menu' ? S.tab : t)));
}

function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  if (recorder?.recording && recorder.lastAccepted && Date.now() - recorder.lastAccepted.t > 20000 && !gps.simulated) {
    toast('Attenzione: la registrazione e\' stata interrotta mentre l\'app era in background (buco nella traccia).', { kind: 'warn', ms: 10000 });
  }
}

function wireUi() {
  $('#rose').addEventListener('click', () => {
    S.mode = 'north';
    S.orientSuspended = false;
    filter.reset(0);
    seaMap.aim({ bearing: 0, duration: 400, padTop: 0 });
    refreshButtons();
  });
  $('#btn-orient').addEventListener('click', cycleMode);
  $('#fab-follow').addEventListener('click', () => {
    S.follow = !S.follow;
    if (S.follow && S.fix) updateCamera(S.fix);
    refreshButtons();
  });
  $('#fab-wp').addEventListener('click', () => setPick({ type: 'add' }));
  $('#pick-cancel').addEventListener('click', () => setPick(null));
  $('#fab-rec').addEventListener('click', toggleRec);
  $('#fab-measure').addEventListener('click', () => toggleMeasure(!S.measure));
  $('#measure-off').addEventListener('click', () => toggleMeasure(false));
  $('#mob').addEventListener('click', doMob);
  $('#nv-stop').addEventListener('click', stopGoto);
  $('#fab-dim').addEventListener('click', () => {
    $('#dimscreen').hidden = false;
    if (S.fix) updateDim(S.fix);
  });
  $('#dimscreen').addEventListener('click', () => ($('#dimscreen').hidden = true));
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.tab === 'menu') menuSheet();
      else setTab(b.dataset.tab);
    })
  );
}

init().catch((e) => {
  console.error(e);
  toast('Errore di avvio: ' + e.message, { kind: 'err', ms: 0 });
});
