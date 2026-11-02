// Sorgente di posizione: GPS reale (Geolocation API) oppure simulato (sim.js). Una sola uscita: onFix.
import { distance, initialBearing, msToKn, knToMs } from './nav.js';

/** @typedef {{lat:number, lon:number, acc:number|null, sog:number|null, cog:number|null, t:number, sim?:boolean}} Fix */

export class Gps {
  constructor() {
    this.listeners = new Set();
    this.errListeners = new Set();
    this.watchId = null;
    this.simulated = false;
    this.last = null; // ultimo fix
    this.ref = null; // punto di riferimento per SOG/COG derivati
    this.lastGoodCog = null;
  }

  onFix(cb) {
    this.listeners.add(cb);
  }
  onError(cb) {
    this.errListeners.add(cb);
  }

  get supported() {
    return 'geolocation' in navigator;
  }

  start() {
    if (this.simulated || this.watchId != null) return;
    if (!this.supported) {
      this.errListeners.forEach((cb) => cb({ code: 0, message: 'Geolocalizzazione non disponibile' }));
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._real(pos),
      (err) => this.errListeners.forEach((cb) => cb(err)),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  /** Attiva/disattiva la sorgente simulata: il GPS reale viene ignorato mentre e' attiva. */
  setSimulated(on) {
    this.simulated = on;
    this.ref = null;
    if (on) this.stop();
    else this.start();
  }

  _real(pos) {
    if (this.simulated) return;
    const c = pos.coords;
    const fix = {
      lat: c.latitude,
      lon: c.longitude,
      acc: c.accuracy ?? null,
      sog: c.speed != null && Number.isFinite(c.speed) ? msToKn(c.speed) : null,
      cog: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
      t: pos.timestamp || Date.now(),
    };
    this._derive(fix);
    this._emit(fix);
  }

  /** Fix da simulazione (sog/cog gia' calcolati). */
  injectSim(fix) {
    this._emit({ ...fix, sim: true });
  }

  // SOG/COG di ripiego calcolati dai fix successivi quando speed/heading sono null (sez. 3 punto 3).
  _derive(fix) {
    if (fix.sog != null && fix.cog != null) {
      this.ref = fix;
      return;
    }
    if (!this.ref) {
      this.ref = fix;
      return;
    }
    const d = distance(this.ref, fix);
    const dt = (fix.t - this.ref.t) / 1000;
    const minMove = Math.max(3, (fix.acc ?? 0) * 0.3);
    if (dt <= 0 || d < minMove) {
      if (fix.sog == null && dt > 10) fix.sog = 0; // fermo
      return;
    }
    if (fix.sog == null) fix.sog = msToKn(d / dt);
    if (fix.cog == null) fix.cog = initialBearing(this.ref, fix);
    this.ref = fix;
  }

  _emit(fix) {
    // COG affidabile solo in movimento: altrimenti ripete l'ultimo valido
    if (fix.cog != null && (fix.sog ?? 0) >= 0.5) this.lastGoodCog = fix.cog;
    this.last = fix;
    this.listeners.forEach((cb) => cb(fix));
  }
}

// ---- Wake Lock (schermo acceso) ----
let wakeSentinel = null;
let wantWake = false;

async function requestWake() {
  if (!wantWake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return false;
  try {
    wakeSentinel = await navigator.wakeLock.request('screen');
    wakeSentinel.addEventListener('release', () => {
      wakeSentinel = null;
    });
    return true;
  } catch {
    return false; // negato o non supportato: l'app resta usabile
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWake && !wakeSentinel) requestWake();
});

export async function setWakeLock(on) {
  wantWake = on;
  if (on) return requestWake();
  try {
    await wakeSentinel?.release();
  } catch {
    /* ignora */
  }
  wakeSentinel = null;
  return true;
}

export const wakeLockSupported = () => 'wakeLock' in navigator;
export { knToMs };
