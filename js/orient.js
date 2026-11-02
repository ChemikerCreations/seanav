// Logica pura dell'orientamento mappa (sez. 5.1): quale bearing dare alla mappa e come stabilizzarlo.
import { angleDiff, smoothAngle, normDeg, rhumbBearing } from './nav.js';

export const MODES = ['north', 'course', 'dest', 'route'];

/** Sotto questa velocita' (nodi) il COG del GPS non e' affidabile. */
export const MIN_SOG_FOR_COG = 1;

/** Le modalita' dest/route senza waypoint attivo ricadono su 'course'. */
export function effectiveMode(mode, hasDest) {
  if ((mode === 'dest' || mode === 'route') && !hasDest) return 'course';
  return mode;
}

/**
 * Bearing "in alto" desiderato, oppure null se non va aggiornato (es. COG inaffidabile).
 * pos/dest/routeStart = {lat, lon}; cog/sog in gradi/nodi.
 */
export function targetBearing(mode, { pos, cog, sog, dest, routeStart }) {
  const m = effectiveMode(mode, !!dest);
  switch (m) {
    case 'north':
      return 0;
    case 'course':
      return cog != null && sog != null && sog >= MIN_SOG_FOR_COG ? cog : null;
    case 'dest':
      return pos && dest ? rhumbBearing(pos, dest) : null;
    case 'route':
      return dest && (routeStart || pos) ? rhumbBearing(routeStart || pos, dest) : null;
    default:
      return null;
  }
}

/** Filtro passa-basso con soglia per evitare rotazioni a scatti. */
export class OrientFilter {
  constructor({ alpha = 0.3, threshold = 3 } = {}) {
    this.alpha = alpha;
    this.threshold = threshold;
    this.value = null;
  }

  reset(value = null) {
    this.value = value == null ? null : normDeg(value);
  }

  /** Ritorna il nuovo bearing da applicare, oppure null se la variazione e' sotto soglia. */
  update(target) {
    if (target == null) return null;
    if (this.value == null) {
      this.value = normDeg(target);
      return this.value;
    }
    if (Math.abs(angleDiff(this.value, target)) < this.threshold) return null;
    this.value = smoothAngle(this.value, target, this.alpha);
    return this.value;
  }
}
