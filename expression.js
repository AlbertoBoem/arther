/**
 * expression.js — how the hand MOVES, not just where it is.
 *
 * Three signals come out of one tracker, all of them derived from data drive()
 * already has, so nothing new is read from the XR frame:
 *
 *   speed01      palm velocity      -> filter opens, more triangle in the mix
 *   stillness01  hand held steady   -> vibrato swells instead of running flat
 *   tremorCents  the player's own wobble, band-passed -> straight to detune
 *
 * The last one is the point. On a real theremin the vibrato IS the player's
 * hand tremor; a fixed 5.3Hz LFO is why a synthesised one sounds like a test
 * tone. The LFO stays as a floor and the hand rides on top of it.
 *
 * Also here: createSmallReverb. Four damped comb filters in parallel into two
 * allpasses — the cheap Schroeder arrangement. Native nodes only, no impulse
 * response to fetch, no decodeAudioData, nothing to block the main thread. The
 * convolver path is exactly what the Tone graph was doing when it froze.
 *
 * No imports: this file must stay usable with or without Three.js.
 */

/**
 * @param {object} config  the whole CONFIG object (reads config.expression)
 */
export function createExpression(config) {
  const cfg = config.expression || {};

  // Previous palm position as plain numbers, so this module never touches
  // THREE and never allocates a vector per frame.
  let px = 0, py = 0, pz = 0;
  let havePrevious = false;

  let speed = 0;          // smoothed, m/s
  let stillness = 0;      // 0..1

  // Two followers on log2(frequency): their difference is a band-pass around
  // roughly 1.5–9Hz. Measuring in octaves rather than Hz means a wobble at the
  // top of the range reads the same as the same wobble at the bottom.
  let slow = null;
  let fast = null;

  // One object, mutated in place and handed back every frame. The render loop
  // allocates nothing, and this keeps that promise.
  const out = { speed: 0, speed01: 0, stillness01: 0, tremorCents: 0 };

  function neutral(dt) {
    const step = dt > 0 ? dt : 0.016;
    speed += (0 - speed) * (1 - Math.exp(-step / (cfg.speedTau || 0.13)));
    stillness = Math.max(0, stillness - step / (cfg.stillFallSec || 0.2));
    out.speed = speed;
    out.speed01 = 0;
    out.stillness01 = stillness;
    out.tremorCents *= 0.85;    // let the detune walk back rather than jump
    havePrevious = false;
    return out;
  }

  /**
   * @param {number}  dt       seconds since the last frame
   * @param {object}  palm     pitch hand palm (anything with x/y/z)
   * @param {boolean} tracked  is that hand actually being seen right now
   * @param {number}  rawFreq  frequency BEFORE pitchSmoother — see the note in
   *                           main.js. The smoother's 45ms tau eats most of
   *                           the wobble this wants to measure.
   */
  function update(dt, palm, tracked, rawFreq) {
    if (cfg.enabled === false) return out;
    if (!tracked || !palm || !(dt > 0)) return neutral(dt);

    // ---- velocity ---------------------------------------------------------
    let instant = 0;
    if (havePrevious) {
      const dx = palm.x - px, dy = palm.y - py, dz = palm.z - pz;
      instant = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
    }
    px = palm.x; py = palm.y; pz = palm.z;
    havePrevious = true;

    const full = cfg.speedFull || 1.1;
    // A single dropped-and-recovered frame can report metres of movement.
    // Clamp BEFORE smoothing, or that spike lives on in the filter for a
    // second and the timbre lurches for no reason the player can see.
    if (instant > full * 3) instant = full * 3;

    speed += (instant - speed) * (1 - Math.exp(-dt / (cfg.speedTau || 0.13)));
    out.speed = speed;
    out.speed01 = Math.min(1, Math.max(0, speed / full));

    // ---- stillness --------------------------------------------------------
    if (speed < (cfg.stillSpeed || 0.055)) {
      stillness = Math.min(1, stillness + dt / (cfg.stillRiseSec || 0.7));
    } else {
      stillness = Math.max(0, stillness - dt / (cfg.stillFallSec || 0.2));
    }
    out.stillness01 = stillness;

    // ---- tremor -----------------------------------------------------------
    if (rawFreq > 0) {
      const octaves = Math.log2(rawFreq);
      if (slow === null) { slow = octaves; fast = octaves; }

      slow += (octaves - slow) * (1 - Math.exp(-dt / (cfg.tremorSlowTau || 0.24)));
      fast += (octaves - fast) * (1 - Math.exp(-dt / (cfg.tremorFastTau || 0.028)));

      let cents = (fast - slow) * 1200 * (cfg.tremorGain != null ? cfg.tremorGain : 2.6);
      // Only let tremor through on held notes. During a deliberate sweep the
      // "wobble" is just the sweep itself arriving at the fast follower first,
      // which would add a growl to every glissando.
      if (cfg.tremorNeedsStillness !== false) cents *= stillness;

      const ceiling = cfg.tremorMaxCents != null ? cfg.tremorMaxCents : 45;
      out.tremorCents = Math.min(ceiling, Math.max(-ceiling, cents));
    }

    return out;
  }

  /** Forget the hand: called on re-anchor, so the jump isn't read as speed. */
  function reset() {
    havePrevious = false;
    speed = 0;
    stillness = 0;
    slow = null;
    fast = null;
    out.speed = 0; out.speed01 = 0; out.stillness01 = 0; out.tremorCents = 0;
  }

  return { update, reset, state: out };
}

/**
 * Small room reverb — early reflections only, NO feedback loop anywhere.
 *
 * The first version of this was the textbook Schroeder arrangement: parallel
 * feedback combs into allpasses. That is wrong for this instrument and it
 * howled. A comb with feedback 0.9 is a resonator with a peak every ~30Hz and
 * ~8x gain at each peak; a theremin plays sustained tones and glides, so a
 * held note parks on a peak and builds, and a sweep drags the resonance along
 * with the hand. Textbook reverbs get away with it because they are fed
 * drums and voices, which are transient.
 *
 * So: no loop. A bank of fixed taps at irregular times with decaying,
 * alternating-sign gains. The impulse response is finite and short by
 * construction, every tap is heard exactly once, and there is no value of any
 * parameter that can make it ring, build or run away. It reads as a small
 * room rather than a hall, which is what the instrument wanted anyway.
 *
 * Returns { input, output } for a parallel send: the caller's dry path is
 * untouched, so this can never attenuate or interrupt the played note.
 */
export function createSmallReverb(ctx, config) {
  const cfg = config.reverb || {};

  const input = ctx.createGain();
  const output = ctx.createGain();
  output.gain.value = cfg.wet != null ? cfg.wet : 0.22;

  const preDelay = ctx.createDelay(0.25);
  preDelay.delayTime.value = cfg.preDelaySec != null ? cfg.preDelaySec : 0.012;
  input.connect(preDelay);

  // Damping before the taps rather than inside a loop: one filter instead of
  // one per tap, and the high end of the whole reflection set dies together.
  const damping = ctx.createBiquadFilter();
  damping.type = 'lowpass';
  damping.frequency.value = cfg.dampingHz != null ? cfg.dampingHz : 3200;
  preDelay.connect(damping);

  // Reflection times in seconds. Deliberately irregular — evenly spaced taps
  // are a comb filter by another name and would colour the tone. Spread from
  // 11ms to 127ms, which is a room a few metres across.
  const taps = [
    0.0113, 0.0197, 0.0273, 0.0359, 0.0441, 0.0557,
    0.0661, 0.0783, 0.0899, 0.1013, 0.1151, 0.1270
  ];

  const spread = cfg.sizeSec != null ? cfg.sizeSec / 0.127 : 1;   // scale the room
  const decay = cfg.decaySec != null ? cfg.decaySec : 1.9;

  const merge = ctx.createGain();
  const nodes = [];
  let total = 0;

  taps.forEach((time, i) => {
    const t = time * spread;
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = t;

    const gain = ctx.createGain();
    // Exponential decay across the tap set, and alternating polarity so the
    // taps don't sum coherently into a resonance at any one frequency.
    const magnitude = Math.pow(10, (-3 * t) / Math.max(0.2, decay));
    gain.gain.value = magnitude * (i % 2 ? -1 : 1);
    total += magnitude;

    damping.connect(delay);
    delay.connect(gain);
    gain.connect(merge);
    nodes.push({ delay, gain });
  });

  // Normalise so `wet` means what it says regardless of tap count or decay.
  merge.gain.value = 1 / Math.max(1, total);
  merge.connect(output);

  /** Live wet control — setWet(0) is the one-line test for "is this the CPU?" */
  function setWet(value) {
    output.gain.setTargetAtTime(Math.max(0, value), ctx.currentTime, 0.1);
  }

  function dispose() {
    try {
      nodes.forEach((n) => { n.delay.disconnect(); n.gain.disconnect(); });
      input.disconnect();
      preDelay.disconnect();
      damping.disconnect();
      merge.disconnect();
      output.disconnect();
    } catch (_) { /* teardown noise */ }
  }

  return { input, output, setWet, dispose };
}
