// Export/import GPX 1.1 per waypoint (<wpt>) e tracce (<trk><trkseg><trkpt>).
// I buchi nella registrazione diventano <trkseg> separati (punto.seg).

const esc = (s) =>
  String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

const iso = (ms) => new Date(ms).toISOString();

/**
 * waypoints: [{name, lat, lon, note, icon, created}]
 * tracks: [{name, points:[{lat, lon, t, seg, sog, cog, acc}]}]
 */
export function buildGpx({ waypoints = [], tracks = [] }) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<gpx version="1.1" creator="SeaNav" xmlns="http://www.topografix.com/GPX/1/1" xmlns:sn="https://seanav.local/gpx">'
  );
  for (const w of waypoints) {
    out.push(`<wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">`);
    if (w.created) out.push(`<time>${iso(w.created)}</time>`);
    out.push(`<name>${esc(w.name)}</name>`);
    if (w.note) out.push(`<desc>${esc(w.note)}</desc>`);
    if (w.icon) out.push(`<sym>${esc(w.icon)}</sym>`);
    out.push('</wpt>');
  }
  for (const t of tracks) {
    out.push('<trk>');
    out.push(`<name>${esc(t.name)}</name>`);
    let seg = null;
    for (const p of t.points) {
      const s = p.seg ?? 0;
      if (s !== seg) {
        if (seg !== null) out.push('</trkseg>');
        out.push('<trkseg>');
        seg = s;
      }
      let line = `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`;
      if (p.t != null) line += `<time>${iso(p.t)}</time>`;
      const ext = [];
      if (p.sog != null) ext.push(`<sn:sog>${p.sog.toFixed(2)}</sn:sog>`);
      if (p.cog != null) ext.push(`<sn:cog>${Math.round(p.cog)}</sn:cog>`);
      if (p.acc != null) ext.push(`<sn:acc>${Math.round(p.acc)}</sn:acc>`);
      if (ext.length) line += `<extensions>${ext.join('')}</extensions>`;
      line += '</trkpt>';
      out.push(line);
    }
    if (seg !== null) out.push('</trkseg>');
    out.push('</trk>');
  }
  out.push('</gpx>');
  return out.join('\n');
}

const childText = (el, name) => {
  for (const c of el.children) if (c.localName === name) return c.textContent;
  return null;
};

function findExt(el, name) {
  const ext = [...el.children].find((c) => c.localName === 'extensions');
  if (!ext) return null;
  const n = [...ext.children].find((c) => c.localName === name);
  return n ? Number(n.textContent) : null;
}

/** Ritorna {waypoints, tracks}. Lancia Error se il file non e' un GPX valido. */
export function parseGpx(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx') {
    throw new Error('File GPX non valido');
  }
  const all = (name) => [...doc.getElementsByTagNameNS('*', name)];
  const num = (v) => (v == null ? NaN : Number(v));

  const waypoints = [];
  for (const w of all('wpt')) {
    const lat = num(w.getAttribute('lat'));
    const lon = num(w.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const time = childText(w, 'time');
    waypoints.push({
      name: childText(w, 'name') || 'Waypoint',
      lat,
      lon,
      note: childText(w, 'desc') || '',
      icon: childText(w, 'sym') || 'generic',
      created: time ? Date.parse(time) || Date.now() : Date.now(),
    });
  }

  const tracks = [];
  for (const trk of all('trk')) {
    const points = [];
    let seg = 0;
    for (const s of [...trk.children].filter((c) => c.localName === 'trkseg')) {
      for (const p of [...s.children].filter((c) => c.localName === 'trkpt')) {
        const lat = num(p.getAttribute('lat'));
        const lon = num(p.getAttribute('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const time = childText(p, 'time');
        const pt = { lat, lon, t: time ? Date.parse(time) : null, seg };
        const sog = findExt(p, 'sog');
        const cog = findExt(p, 'cog');
        const acc = findExt(p, 'acc');
        if (sog != null) pt.sog = sog;
        if (cog != null) pt.cog = cog;
        if (acc != null) pt.acc = acc;
        points.push(pt);
      }
      seg++;
    }
    if (points.length) tracks.push({ name: childText(trk, 'name') || 'Traccia', points });
  }
  // rotte (<rte>) importate come waypoint numerati
  for (const rte of all('rte')) {
    const rname = childText(rte, 'name') || 'Rotta';
    [...rte.children]
      .filter((c) => c.localName === 'rtept')
      .forEach((p, i) => {
        const lat = num(p.getAttribute('lat'));
        const lon = num(p.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          waypoints.push({ name: childText(p, 'name') || `${rname} ${i + 1}`, lat, lon, note: '', icon: 'generic', created: Date.now() });
        }
      });
  }
  return { waypoints, tracks };
}
