// Wrapper MapLibre: stile base, overlay OpenSeaMap, barca, waypoint, rotta, tracce. Richiede il global `maplibregl`.
import { destinationPoint } from './nav.js';

const SEAMARK_URL = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';
const EMPTY = { type: 'FeatureCollection', features: [] };

export const WP_ICONS = {
  generic: { glyph: '●', color: '#e8590c', label: 'Generico' },
  anchor: { glyph: '⚓', color: '#1971c2', label: 'Ancora' },
  port: { glyph: 'P', color: '#2f9e44', label: 'Porto' },
  danger: { glyph: '!', color: '#e03131', label: 'Pericolo' },
  fishing: { glyph: 'F', color: '#7048e8', label: 'Pesca' },
  mob: { glyph: 'M', color: '#d6336c', label: 'MOB' },
};

function circlePolygon(center, radiusM, n = 48) {
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const p = destinationPoint(center, (i * 360) / n, radiusM);
    ring.push([p.lon, p.lat]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

export class SeaMap {
  /**
   * handlers: { onTap(lngLat), onLongPress(lngLat), onWaypointClick(id), onUserPan(), onUserRotate(), onRotate(bearing), onError(msg) }
   */
  constructor(container, settings, handlers) {
    this.h = handlers;
    this.settings = settings;
    this.cache = { acc: EMPTY, goto: EMPTY, tracks: EMPTY, rec: EMPTY, measure: EMPTY };
    this.wpMarkers = new Map();
    this.suppressClick = false;

    if (!window.maplibregl || (maplibregl.supported && !maplibregl.supported())) {
      handlers.onError?.('WebGL non disponibile: la mappa non puo\' essere mostrata. Waypoint e tracce restano utilizzabili.');
      this.map = null;
      return;
    }

    const map = (this.map = new maplibregl.Map({
      container,
      style: settings.baseStyle,
      center: [10.0, 43.5],
      zoom: 7,
      maxPitch: 0,
      attributionControl: { compact: true },
      dragRotate: !settings.lockOrient,
      fadeDuration: 0,
    }));
    map.touchZoomRotate.enable({ around: 'center' });
    if (settings.lockOrient) map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical', maxWidth: 90 }), 'bottom-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 90 }), 'bottom-left');

    map.on('style.load', () => this._install());
    map.on('rotate', () => this.h.onRotate?.(map.getBearing()));
    map.on('error', (e) => {
      const m = e?.error?.message || '';
      if (/Failed to fetch|NetworkError|AJAXError|Load failed/i.test(m)) this.h.onError?.('Rete assente: carte non aggiornate (le tile gia\' viste possono mancare).', true);
    });

    // gesti manuali sospendono l'auto-orientamento / auto-pan
    map.on('dragstart', (e) => e.originalEvent && this.h.onUserPan?.());
    map.on('rotatestart', (e) => e.originalEvent && this.h.onUserRotate?.());

    // marker barca (frecciа ruotata in coordinate mappa: mostra l'errore di rotta rispetto al "su" dello schermo)
    const el = document.createElement('div');
    el.className = 'boat';
    el.innerHTML =
      '<svg viewBox="-20 -28 40 56" width="40" height="56"><path class="boat-arrow" d="M0 -24 L14 20 L0 11 L-14 20 Z"/><circle class="boat-dot" r="8"/></svg>';
    this.boatEl = el;
    this.boat = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });

    this._setupTaps();
  }

  _setupTaps() {
    const map = this.map;
    let timer = null;
    let startPt = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    const begin = (e) => {
      if (e.originalEvent?.touches && e.originalEvent.touches.length !== 1) return cancel();
      if (e.originalEvent?.button > 0) return;
      startPt = e.point;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 500);
        navigator.vibrate?.(30);
        this.h.onLongPress?.(e.lngLat);
      }, 650);
    };
    const move = (e) => {
      if (timer && startPt && Math.hypot(e.point.x - startPt.x, e.point.y - startPt.y) > 10) cancel();
    };
    map.on('touchstart', begin);
    map.on('mousedown', begin);
    map.on('touchmove', move);
    map.on('mousemove', move);
    for (const ev of ['touchend', 'touchcancel', 'mouseup', 'dragstart', 'zoomstart', 'rotatestart']) map.on(ev, cancel);
    map.on('click', (e) => {
      if (this.suppressClick) return;
      this.h.onTap?.(e.lngLat);
    });
    map.on('contextmenu', (e) => {
      // click destro su desktop
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 300);
      this.h.onLongPress?.(e.lngLat);
    });
  }

  _install() {
    const map = this.map;
    const s = this.settings;
    if (!map.getSource('seamark')) {
      map.addSource('seamark', { type: 'raster', tiles: [SEAMARK_URL], tileSize: 256, maxzoom: 18, attribution: 'Segnali: © <a href="https://www.openseamap.org">OpenSeaMap</a> contributors' });
    }
    map.addLayer({
      id: 'seamark',
      type: 'raster',
      source: 'seamark',
      paint: { 'raster-opacity': s.seamarkOpacity },
      layout: { visibility: s.seamark ? 'visible' : 'none' },
    });
    const geo = (id, data) => map.addSource(id, { type: 'geojson', data });
    geo('acc', this.cache.acc);
    geo('tracks', this.cache.tracks);
    geo('rec', this.cache.rec);
    geo('goto', this.cache.goto);
    geo('measure', this.cache.measure);
    map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#1c7ed6', 'fill-opacity': 0.15 } });
    map.addLayer({ id: 'tracks-line', type: 'line', source: 'tracks', paint: { 'line-color': '#1c7ed6', 'line-width': 3, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'rec-line', type: 'line', source: 'rec', paint: { 'line-color': '#e03131', 'line-width': 4 } });
    map.addLayer({
      id: 'goto-line',
      type: 'line',
      source: 'goto',
      paint: { 'line-color': '#d6336c', 'line-width': 3, 'line-dasharray': [2, 1.5] },
    });
    map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', paint: { 'line-color': '#f59f00', 'line-width': 3 } });
    map.addLayer({ id: 'measure-pts', type: 'circle', source: 'measure', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#f59f00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  }

  _set(id, data) {
    this.cache[id] = data;
    const src = this.map?.getSource(id);
    if (src) src.setData(data);
  }

  setSeamark(on, opacity) {
    this.settings.seamark = on;
    this.settings.seamarkOpacity = opacity;
    if (!this.map?.getLayer('seamark')) return;
    this.map.setLayoutProperty('seamark', 'visibility', on ? 'visible' : 'none');
    this.map.setPaintProperty('seamark', 'raster-opacity', opacity);
  }

  setBaseStyle(url) {
    this.settings.baseStyle = url;
    this.map?.setStyle(url);
  }

  setLockOrientation(lock) {
    if (!this.map) return;
    if (lock) {
      this.map.dragRotate.disable();
      this.map.touchZoomRotate.disableRotation();
    } else {
      this.map.dragRotate.enable();
      this.map.touchZoomRotate.enableRotation();
    }
  }

  // ---- barca ----
  setBoat(fix, cog, showArrow) {
    if (!this.map) return;
    this.boat.setLngLat([fix.lon, fix.lat]);
    if (!this.boat._added) {
      this.boat.addTo(this.map);
      this.boat._added = true;
    }
    this.boatEl.classList.toggle('no-course', !showArrow);
    if (showArrow && cog != null) this.boat.setRotation(cog);
    const r = Math.max(3, fix.acc ?? 0);
    this._set('acc', { type: 'FeatureCollection', features: [circlePolygon(fix, r)] });
  }

  // ---- waypoint ----
  setWaypoints(list, activeId) {
    if (!this.map) return;
    const seen = new Set();
    for (const w of list) {
      seen.add(w.id);
      let m = this.wpMarkers.get(w.id);
      const ic = WP_ICONS[w.icon] || WP_ICONS.generic;
      if (!m) {
        const el = document.createElement('div');
        el.className = 'wp';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.h.onWaypointClick?.(w.id);
        });
        m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([w.lon, w.lat]).addTo(this.map);
        this.wpMarkers.set(w.id, m);
      }
      m.setLngLat([w.lon, w.lat]);
      const el = m.getElement();
      el.classList.toggle('active', w.id === activeId);
      el.innerHTML = `<div class="wp-pin" style="background:${ic.color}">${ic.glyph}</div><div class="wp-name"></div>`;
      el.querySelector('.wp-name').textContent = w.name;
      // il click sul marker ricrea innerHTML: il listener e' sul contenitore, quindi resta valido
      el.onclick = (ev) => {
        ev.stopPropagation();
        this.h.onWaypointClick?.(w.id);
      };
    }
    for (const [id, m] of this.wpMarkers) {
      if (!seen.has(id)) {
        m.remove();
        this.wpMarkers.delete(id);
      }
    }
  }

  // ---- linee ----
  /** goto: {boat:{lat,lon}|null, start:{lat,lon}|null, dest:{lat,lon}}|null */
  setGoto(g) {
    const feats = [];
    if (g) {
      if (g.start) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[g.start.lon, g.start.lat], [g.dest.lon, g.dest.lat]] } });
      if (g.boat) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[g.boat.lon, g.boat.lat], [g.dest.lon, g.dest.lat]] } });
    }
    this._set('goto', { type: 'FeatureCollection', features: feats });
  }

  _lines(segLists) {
    return {
      type: 'FeatureCollection',
      features: segLists.map((coords) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: coords } })),
    };
  }

  /** tracks: array di array-di-segmenti, ciascun segmento = [[lon,lat],...] */
  setShownTracks(tracks) {
    this._set('tracks', this._lines(tracks));
  }

  setRecordingLine(segments) {
    this._set('rec', this._lines(segments ? [segments] : []));
  }

  setMeasure(pts) {
    const feats = pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }));
    if (pts.length === 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) } });
    this._set('measure', { type: 'FeatureCollection', features: feats });
  }

  // ---- camera ----
  get bearing() {
    return this.map ? this.map.getBearing() : 0;
  }

  /** padTop in px: sposta il punto di fuoco in basso (barca a 1/3 dal basso). */
  aim({ center, bearing, padTop, duration = 900, zoom }) {
    if (!this.map) return;
    const opts = { duration, easing: (t) => t, essential: true };
    if (center) opts.center = center;
    if (bearing != null) opts.bearing = bearing;
    if (zoom != null) opts.zoom = zoom;
    if (padTop != null) opts.padding = { top: padTop, bottom: 0, left: 0, right: 0 };
    this.map.easeTo(opts);
  }

  fitPoints(pts) {
    if (!this.map || !pts.length) return;
    const b = new maplibregl.LngLatBounds();
    pts.forEach((p) => b.extend([p.lon, p.lat]));
    this.map.fitBounds(b, { padding: 60, duration: 600, bearing: 0, maxZoom: 15 });
  }

  resize() {
    this.map?.resize();
  }
}
