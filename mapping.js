/**
 * mapping.js — the "how does a hand become a note" layer.
 * Pure functions plus one smoother, so it's easy to retune or unit-test.
 */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One-pole low-pass. Hand tracking is noisy and the ear is unforgiving about
 * it, so nothing reaches the synth without passing through one of these.
 * The tau is a real time constant, so behaviour doesn't change with framerate.
 */
export class OnePole {
  constructor(tau, initial = 0) {
    this.tau = tau;
    this.value = initial;
  }
  reset(value) { this.value = value; return value; }
  process(target, dt) {
    if (!(dt > 0)) return this.value;
    const alpha = 1 - Math.exp(-dt / this.tau);
    this.value += (target - this.value) * alpha;
    return this.value;
  }
}

/** Shortest distance from a point to a line segment (the antenna rod). */
export function distanceToSegment(point, a, b, tmpAB, tmpAP) {
  tmpAB.subVectors(b, a);
  tmpAP.subVectors(point, a);
  const denom = tmpAB.lengthSq();
  const t = denom > 1e-9 ? clamp01(tmpAP.dot(tmpAB) / denom) : 0;
  tmpAB.multiplyScalar(t).add(a);
  return point.distanceTo(tmpAB);
}

/**
 * Distance -> pitch. Returns a normalised 0..1 position as well, because
 * smoothing in that domain (perceptually linear) beats smoothing in Hz.
 * t = 1 means "hand at the rod" = highest note.
 */
export function pitchPosition(distance, cfg) {
  const span = Math.max(1e-4, cfg.farDistance - cfg.nearDistance);
  return clamp01(1 - (distance - cfg.nearDistance) / span);
}

export function frequencyFor(t, cfg) {
  return cfg.minFreq * Math.pow(cfg.maxFreq / cfg.minFreq, clamp01(t));
}

/** Distance -> amplitude. Away from the loop is louder, as on the real thing.
 *  A dead zone of `deadZone` metres past nearDistance holds a hard zero, so the
 *  region around the loop is decisively silent; `onsetLevel` sets the small floor
 *  just outside it, which makes crossing the edge feel like a crisp on/off. */
export function levelFor(distance, cfg) {
  const dead = cfg.nearDistance + (cfg.deadZone || 0);
  if (distance <= dead) return 0;                       // inside the buffer: silent

  const onset = cfg.onsetLevel || 0;

  // Outer edge (optional): past maxDistance the field no longer reaches the
  // hand, so the volume tapers from full back to silence and is hard zero
  // beyond it. Peak volume sits at farDistance, so farDistance < maxDistance.
  if (cfg.maxDistance && distance > cfg.farDistance) {
    if (distance >= cfg.maxDistance) return 0;
    const fallSpan = Math.max(1e-4, cfg.maxDistance - cfg.farDistance);
    const uf = clamp01((distance - cfg.farDistance) / fallSpan);  // 0 at far -> 1 at max
    const taper = 0.5 + 0.5 * Math.cos(Math.PI * uf);             // 1 -> 0, smooth
    return taper * cfg.maxGain;
  }

  const span = Math.max(1e-4, cfg.farDistance - dead);
  const u = clamp01((distance - dead) / span);          // 0 at the buffer edge, 1 at far
  const shaped = Math.pow(u, cfg.curve);
  return (onset + (1 - onset) * shaped) * cfg.maxGain;
}

const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Optional scale snapping. strength 0 leaves the glide untouched, 1 locks to
 * the scale; anything between gives you a magnet, which is the fun setting.
 */
export function snapFrequency(freq, cfg) {
  if (!cfg.scale || !cfg.scale.length || cfg.snapStrength <= 0) return freq;

  const midi = freqToMidi(freq);
  const root = cfg.scaleRootMidi;
  let best = midi;
  let bestDelta = Infinity;

  // Search a few octaves either side of the note we're near.
  const baseOctave = Math.floor((midi - root) / 12);
  for (let oct = baseOctave - 1; oct <= baseOctave + 1; oct++) {
    for (const degree of cfg.scale) {
      const candidate = root + oct * 12 + degree;
      const delta = Math.abs(candidate - midi);
      if (delta < bestDelta) { bestDelta = delta; best = candidate; }
    }
  }
  return midiToFreq(midi + (best - midi) * clamp01(cfg.snapStrength));
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function describeFrequency(freq) {
  const midi = freqToMidi(freq);
  const nearest = Math.round(midi);
  return {
    midi,
    name: NOTE_NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1),
    cents: Math.round((midi - nearest) * 100)
  };
}

/** Ring radii that mark each octave boundary in the pitch field. */
export function octaveRadii(cfg) {
  const octaves = Math.log2(cfg.maxFreq / cfg.minFreq);
  const span = cfg.farDistance - cfg.nearDistance;
  const radii = [];
  for (let k = 1; k <= Math.floor(octaves); k++) {
    const t = k / octaves;                    // t of the octave boundary
    radii.push(cfg.nearDistance + (1 - t) * span);
  }
  return radii;
}

