// Registrazione traccia con salvataggio incrementale in IndexedDB (sopravvive a chiusure accidentali).
import * as db from './db.js';
import { distance, msToKn } from './nav.js';

export class TrackRecorder {
  /**
   * settings: {trackSeconds, trackMeters, maxAccuracy, gapSeconds}
   * onChange(state) per aggiornare indicatore REC/statistiche.
   */
  constructor(getSettings, onChange = () => {}) {
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.track = null; // record in tabella tracks
    this.lastAccepted = null;
    this.seg = 0;
    this.stats = this._emptyStats();
    this.gaps = 0;
    this.rejected = 0;
  }

  _emptyStats() {
    return { dist: 0, n: 0, maxSog: 0, start: null, last: null };
  }

  get recording() {
    return !!this.track;
  }

  async start(name) {
    const now = Date.now();
    this.track = { id: db.uid(), name: name || 'Traccia ' + new Date(now).toLocaleString('it-IT'), start: now, active: true };
    this.lastAccepted = null;
    this.seg = 0;
    this.gaps = 0;
    this.rejected = 0;
    this.stats = this._emptyStats();
    await db.saveTrack(this.track);
    this.onChange(this.snapshot());
  }

  /** Riprende una traccia rimasta "attiva" dopo chiusura accidentale: nuovo segmento. */
  async resume(track) {
    const pts = await db.getTrackPoints(track.id);
    this.track = track;
    this.stats = this._emptyStats();
    this.seg = 0;
    let prev = null;
    for (const p of pts) {
      this._account(p, prev);
      prev = p;
      this.seg = Math.max(this.seg, p.seg ?? 0);
    }
    this.seg += 1; // buco tra chiusura e ripresa
    this.lastAccepted = null;
    this.onChange(this.snapshot());
  }

  async stop() {
    if (!this.track) return null;
    const t = this.track;
    t.active = false;
    t.end = Date.now();
    await db.saveTrack(t);
    this.track = null;
    this.lastAccepted = null;
    this.onChange(this.snapshot());
    return t;
  }

  _account(p, prev) {
    const s = this.stats;
    s.n++;
    if (s.start == null) s.start = p.t;
    s.last = p.t;
    if (prev && (prev.seg ?? 0) === (p.seg ?? 0)) s.dist += distance(prev, p);
    if (p.sog != null && p.sog > s.maxSog) s.maxSog = p.sog;
  }

  /** Da chiamare a ogni fix. Ritorna true se il punto e' stato registrato. */
  async onFix(fix) {
    if (!this.track) return false;
    const cfg = this.getSettings();
    if (fix.acc != null && fix.acc > cfg.maxAccuracy) {
      this.rejected++;
      return false;
    }
    const prev = this.lastAccepted;
    if (prev) {
      const dt = (fix.t - prev.t) / 1000;
      const d = distance(prev, fix);
      if (dt <= 0) return false;
      // salto impossibile (> 80 nodi): scartato
      if (d / dt > 41.2 && d > 100) {
        this.rejected++;
        return false;
      }
      if (dt > cfg.gapSeconds) {
        this.seg++; // buco nella traccia -> nuovo <trkseg>
        this.gaps++;
      } else if (dt < cfg.trackSeconds && d < cfg.trackMeters) {
        return false; // campionamento: "X secondi e/o Y metri, qualunque avvenga prima"
      }
    }
    const p = { lat: fix.lat, lon: fix.lon, t: fix.t, seg: this.seg };
    if (fix.sog != null) p.sog = fix.sog;
    if (fix.cog != null) p.cog = fix.cog;
    if (fix.acc != null) p.acc = fix.acc;
    await db.addPoint(this.track.id, p);
    this._account(p, this.seg === (prev?.seg ?? this.seg) ? prev : null);
    this.lastAccepted = p;
    this.onChange(this.snapshot(p));
    return true;
  }

  snapshot(point) {
    const s = this.stats;
    const dur = s.start && s.last ? (s.last - s.start) / 1000 : 0;
    return {
      recording: this.recording,
      name: this.track?.name,
      id: this.track?.id,
      dist: s.dist,
      n: s.n,
      duration: dur,
      avgSog: dur > 0 ? msToKn(s.dist / dur) : 0,
      maxSog: s.maxSog,
      gaps: this.gaps,
      rejected: this.rejected,
      point,
    };
  }
}

/** Statistiche di una traccia salvata. */
export function trackStats(points) {
  let dist = 0;
  let maxSog = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.sog != null && p.sog > maxSog) maxSog = p.sog;
    const prev = points[i - 1];
    if (prev && (prev.seg ?? 0) === (p.seg ?? 0)) dist += distance(prev, p);
  }
  const t0 = points[0]?.t;
  const t1 = points[points.length - 1]?.t;
  const dur = t0 != null && t1 != null ? (t1 - t0) / 1000 : 0;
  return { dist, duration: dur, avgSog: dur > 0 ? msToKn(dist / dur) : 0, maxSog, n: points.length };
}
