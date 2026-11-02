// Calcoli nautici: funzioni pure, nessuna dipendenza dal DOM.
// Tutti gli angoli sono gradi VERI (non magnetici). Distanze in metri salvo diversa indicazione.
//
// Scelta: distanze con haversine (ortodromia); rilevamento da seguire con lossodromia (rhumb line,
// rotta a prua costante). Per tratte brevi (< ~50 mn) la differenza e' trascurabile.

export const R_EARTH = 6371008.8; // raggio medio terrestre (m)
export const NM = 1852; // metri per miglio nautico
export const MS_TO_KN = 1.943844;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Normalizza in [0, 360). */
export function normDeg(a) {
  return ((a % 360) + 360) % 360;
}

/** Differenza angolare con segno b - a, normalizzata in [-180, 180]. */
export function angleDiff(a, b) {
  let d = normDeg(b - a);
  if (d > 180) d -= 360;
  return d;
}

/** Interpola da prev verso target sul percorso piu' breve. Risultato in [0, 360). */
export function smoothAngle(prev, target, alpha) {
  return normDeg(prev + alpha * angleDiff(prev, target));
}

export const msToKn = (ms) => ms * MS_TO_KN;
export const knToMs = (kn) => kn / MS_TO_KN;
export const mToNm = (m) => m / NM;
export const nmToM = (nm) => nm * NM;

/** Distanza ortodromica (haversine). a, b = {lat, lon}. */
export function distance(a, b) {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dp = p2 - p1;
  const dl = toRad(b.lon - a.lon);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rilevamento iniziale ortodromico a -> b, [0, 360). Usato per XTE. */
export function initialBearing(a, b) {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normDeg(toDeg(Math.atan2(y, x)));
}

/** Rilevamento lossodromico (rotta a prua costante) a -> b, [0, 360). Gestisce l'antimeridiano. */
export function rhumbBearing(a, b) {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  let dl = toRad(b.lon - a.lon);
  if (dl > Math.PI) dl -= 2 * Math.PI;
  if (dl < -Math.PI) dl += 2 * Math.PI;
  const dpsi = Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  // vicino ai poli dpsi puo' essere non finito: in quel caso la rotta e' N/S
  if (!Number.isFinite(dpsi)) return p2 > p1 ? 0 : 180;
  return normDeg(toDeg(Math.atan2(dl, dpsi)));
}

/** Distanza lossodromica (m). */
export function rhumbDistance(a, b) {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dp = p2 - p1;
  let dl = Math.abs(toRad(b.lon - a.lon));
  if (dl > Math.PI) dl = 2 * Math.PI - dl;
  const dpsi = Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  const q = Math.abs(dpsi) > 1e-12 && Number.isFinite(dpsi) ? dp / dpsi : Math.cos(p1);
  return Math.sqrt(dp * dp + q * q * dl * dl) * R_EARTH;
}

/** Punto a distanza d (m) e rilevamento brg (gradi) da a, lungo l'ortodromia. */
export function destinationPoint(a, brg, d) {
  const dr = d / R_EARTH;
  const th = toRad(brg);
  const p1 = toRad(a.lat);
  const l1 = toRad(a.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(th));
  const l2 =
    l1 + Math.atan2(Math.sin(th) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
  let lon = toDeg(l2);
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: toDeg(p2), lon };
}

/**
 * XTE: scostamento laterale (m) di pos dalla linea start -> dest.
 * Positivo = a DESTRA della rotta, negativo = a sinistra.
 */
export function crossTrack(start, dest, pos) {
  if (distance(start, dest) < 1) return 0;
  const d13 = distance(start, pos) / R_EARTH;
  const t13 = toRad(initialBearing(start, pos));
  const t12 = toRad(initialBearing(start, dest));
  return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * R_EARTH;
}

/** VMG (stessa unita' di sog) verso il waypoint: sog * cos(COG - BRG). */
export function vmg(sog, cog, brg) {
  if (sog == null || cog == null || brg == null) return null;
  return sog * Math.cos(toRad(angleDiff(cog, brg)));
}

/**
 * ETA in secondi, oppure null se non calcolabile (VMG <= soglia).
 * dist in metri, vmgKn in nodi.
 */
export function etaSeconds(dist, vmgKn, minKn = 0.2) {
  if (vmgKn == null || !(vmgKn > minKn)) return null;
  return dist / knToMs(vmgKn);
}

// ---- formati coordinate ----

function splitDeg(abs) {
  let deg = Math.floor(abs);
  let min = (abs - deg) * 60;
  return { deg, min };
}

function fmtOne(value, isLat, fmt) {
  const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  const abs = Math.abs(value);
  const degW = isLat ? 2 : 3;
  const pad = (n, w) => String(n).padStart(w, '0');
  if (fmt === 'DD') return `${abs.toFixed(5).padStart(degW + 6, '0')}° ${hemi}`;
  if (fmt === 'DMS') {
    let { deg, min } = splitDeg(abs);
    let m = Math.floor(min);
    let s = (min - m) * 60;
    if (s >= 59.995) {
      s = 0;
      m += 1;
    }
    if (m >= 60) {
      m = 0;
      deg += 1;
    }
    return `${pad(deg, degW)}° ${pad(m, 2)}' ${s.toFixed(2).padStart(5, '0')}" ${hemi}`;
  }
  // DM (default): gradi e minuti decimali
  let { deg, min } = splitDeg(abs);
  if (min >= 59.9995) {
    min = 0;
    deg += 1;
  }
  return `${pad(deg, degW)}° ${min.toFixed(3).padStart(6, '0')}' ${hemi}`;
}

/** Formatta {lat, lon} come stringhe. fmt: 'DD' | 'DM' | 'DMS'. */
export function formatCoords(lat, lon, fmt = 'DM') {
  return { lat: fmtOne(lat, true, fmt), lon: fmtOne(lon, false, fmt) };
}

/**
 * Interpreta una coordinata scritta dall'utente: "43.5", "43 30.5 N", "43°30'30\" S", "-9.2".
 * Ritorna un numero (gradi decimali) o null.
 */
export function parseCoord(text) {
  if (text == null) return null;
  const s = String(text).trim().toUpperCase().replace(',', '.');
  if (!s) return null;
  const hemiMatch = s.match(/[NSEW]/);
  const sign = hemiMatch && (hemiMatch[0] === 'S' || hemiMatch[0] === 'W') ? -1 : 1;
  const nums = s.replace(/[NSEW]/g, ' ').match(/-?\d+(\.\d+)?/g);
  if (!nums || nums.length > 3) return null;
  const parts = nums.map(Number);
  let val = Math.abs(parts[0]) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
  if (parts[1] != null && (parts[1] < 0 || parts[1] >= 60)) return null;
  if (parts[2] != null && (parts[2] < 0 || parts[2] >= 60)) return null;
  if (parts[0] < 0 || Object.is(parts[0], -0)) val = -val;
  return val * sign;
}

/** Durata in secondi -> "2h 05m" oppure "16m 02s". */
export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h >= 100) return `${Math.floor(h / 24)}g ${h % 24}h`;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(r).padStart(2, '0')}s`;
}
