// Modalita' simulazione (sez. 11): riproduce un percorso come se fosse il GPS.
import { distance, initialBearing, destinationPoint, msToKn, knToMs, normDeg } from './nav.js';

const DEFAULT_KN = 6;

export class Simulator {
  /** gps: istanza di Gps; onState(state) per aggiornare la UI. */
  constructor(gps, onState = () => {}) {
    this.gps = gps;
    this.onState = onState;
    this.pts = [];
    this.cum = []; // tempo cumulativo simulato (s) per ogni punto
    this.speed = 1; // moltiplicatore tempo
    this.simT = 0; // tempo simulato trascorso (s)
    this.timer = null;
    this.loop = true;
    this.name = '';
  }

  get running() {
    return this.timer != null;
  }

  /** pts: [{lat, lon, t?}] — se tutti hanno t si usa il tempo reale registrato, altrimenti 6 nodi costanti. */
  load(pts, name = 'Percorso') {
    this.pts = pts;
    this.name = name;
    const useTime = pts.length > 1 && pts.every((p) => p.t != null) && pts[pts.length - 1].t > pts[0].t;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dt = useTime
        ? Math.max(0.001, (pts[i].t - pts[i - 1].t) / 1000)
        : Math.max(0.001, distance(pts[i - 1], pts[i]) / knToMs(DEFAULT_KN));
      this.cum.push(this.cum[i - 1] + dt);
    }
    this.simT = 0;
  }

  setSpeed(mult) {
    this.speed = mult;
  }

  start() {
    if (this.pts.length < 2) throw new Error('Percorso troppo corto');
    this.gps.setSimulated(true);
    if (this.timer) clearInterval(this.timer);
    this._tick(0);
    this.timer = setInterval(() => this._tick(this.speed), 1000);
    this.onState({ running: true, name: this.name });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.gps.setSimulated(false);
    this.onState({ running: false });
  }

  _tick(advance) {
    this.simT += advance;
    const total = this.cum[this.cum.length - 1];
    if (this.simT >= total) {
      if (this.loop) this.simT %= total;
      else return this.stop();
    }
    // segmento corrente
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < this.simT) i++;
    const a = this.pts[i - 1];
    const b = this.pts[i];
    const span = this.cum[i] - this.cum[i - 1];
    const f = Math.min(1, Math.max(0, (this.simT - this.cum[i - 1]) / span));
    const lat = a.lat + (b.lat - a.lat) * f;
    let dLon = b.lon - a.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let lon = a.lon + dLon * f;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const segD = distance(a, b);
    this.gps.injectSim({
      lat,
      lon,
      acc: 5,
      sog: msToKn(segD / span),
      cog: segD < 0.5 ? null : initialBearing(a, b),
      t: Date.now(),
    });
  }
}

/** Percorso circolare di raggio r (m) attorno a centro: prova di rotazione 359->0 della modalita' "waypoint davanti". */
export function orbitPath(center, r = 700, steps = 90, startBrg = 180) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    // la barca gira in senso orario attorno al centro
    pts.push(destinationPoint(center, normDeg(startBrg + (i * 360) / steps), r));
  }
  return pts;
}

/** Avvicinamento in linea retta al centro da una certa distanza e rilevamento. */
export function approachPath(center, fromBrg = 200, dist = 3000, steps = 30) {
  const start = destinationPoint(center, fromBrg, dist);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    pts.push({ lat: start.lat + ((center.lat - start.lat) * i) / steps, lon: start.lon + ((center.lon - start.lon) * i) / steps });
  }
  return pts;
}
