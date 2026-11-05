/**
 * drone.js — the harmonic bed that replaced the mp3 backing track.
 *
 * Same plumbing as the loop it replaced: it feeds the very same trackGain
 * node, so the fades, the toggle, the knob and its indicator in
 * thereminModel.js are all untouched. Created in build(), started once in
 * unlock(), never stopped — on/off is purely a gain ramp.
 *
 * TWO CHARACTERS, same public API:
 *
 *   'tanpura' (default) — a static drone in the Indian manner. Four strings
 *      tuned Pa–Sa–Sa–Sa', plucked in rotation, each swelling and decaying
 *      over several seconds so the cycle overlaps itself. No chord changes at
 *      all: a tanpura never moves, and that is precisely what makes it
 *      meditative rather than merely ambient. The movement is in the plucking
 *      and in the shimmer, not in the harmony.
 *
 *   'pad' — the earlier behaviour: three voices, a slow quartal progression
 *      with nearest-tone voice leading, no plucking.
 *
 * THE SHIMMER. A tanpura's signature is jivari: the strings run over a curved
 * bridge that keeps clipping them into a bright, breathing buzz. Here each
 * voice adds a sawtooth through a resonant bandpass sitting high above the
 * fundamental, with one slow shared LFO sweeping all of them. That sweep is
 * the shimmer, and it is also why the bed reads as a different instrument
 * from the theremin rather than as a second, lower theremin.
 *
 * Envelopes are computed in JS and written once per frame, not scheduled.
 * Same reasoning as the rest of this build: no scheduling, no cancellation,
 * nothing that can throw or strand a param mid-ramp.
 */

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Nearest-tone voice leading, for 'pad' character only. Each voice moves to
 * the closest free tone of the new chord instead of the stack jumping as a
 * block, which is what makes a chord change read as drift.
 */
function voiceLead(previous, offsets, rootMidi) {
  const taken = [];
  const usedMidi = [];
  return previous.map((prev, voiceIndex) => {
    let best = -1;
    let bestKey = -1;
    let bestCost = Infinity;

    for (let k = 0; k < offsets.length; k++) {
      if (taken.indexOf(k) !== -1) continue;
      const base = rootMidi + offsets[k];
      for (let octave = -1; octave <= 2; octave++) {
        const candidate = base + 12 * octave;
        if (candidate < rootMidi - 7 || candidate > rootMidi + 26) continue;
        // Two voices on the SAME note is the failure mode: they sit a few
        // cents apart by design, so a unison pair beats hard and reads as one
        // loud wobbling tone. Reserve the pitch, not just the chord tone.
        if (usedMidi.indexOf(candidate) !== -1) continue;
        const cost = Math.abs(candidate - prev) + (k === voiceIndex ? 0 : 0.6);
        if (cost < bestCost) { bestCost = cost; best = candidate; bestKey = k; }
      }
    }

    if (best < 0) best = usedMidi.indexOf(prev) !== -1 ? prev + 12 : prev;
    if (bestKey >= 0) taken.push(bestKey);
    usedMidi.push(best);
    return best;
  });
}

/**
 * @param {AudioContext} ctx
 * @param {AudioNode} destination  the gain node that owns on/off (trackGain)
 * @param {object} config          the whole CONFIG object (reads config.drone)
 */
export function createDrone(ctx, destination, config) {
  const cfg = config.drone || {};
  const tanpura = (cfg.character || 'tanpura') === 'tanpura';

  const rootMidi = cfg.rootMidi != null ? cfg.rootMidi : 55;      // G3 = Sa
  // Pa, Sa, Sa, Sa' as semitone offsets from Sa. The real fourth string is an
  // octave BELOW Sa; at 98Hz that is under what open-ear speakers reproduce,
  // so it goes up instead. On headphones, -12 is the authentic one.
  const tuning = cfg.tuning && cfg.tuning.length ? cfg.tuning : [-5, 0, 0, 12];
  const progression = cfg.progression && cfg.progression.length
    ? cfg.progression
    : [[0, 7, 14], [-2, 5, 12], [-5, 2, 9], [0, 7, 12]];

  const voiceCount = tanpura
    ? Math.max(1, Math.min(5, tuning.length))
    : Math.max(1, Math.min(4, cfg.voices || 3));

  const pluckSec = cfg.pluckSec != null ? cfg.pluckSec : 1.35;
  const attackSec = cfg.pluckAttackSec != null ? cfg.pluckAttackSec : 0.12;
  const decaySec = cfg.pluckDecaySec != null ? cfg.pluckDecaySec : 2.8;
  const sustain = cfg.pluckSustain != null ? cfg.pluckSustain : 0.32;

  const voices = [];
  let chordIndex = 0;
  let clock = 0;
  let pluckClock = 0;
  let nextVoice = 0;
  let playTime = 0;
  let started = false;
  let active = false;

  // ---- shared output filter ------------------------------------------------
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cfg.filterHz != null ? cfg.filterHz : 2600;
  filter.Q.value = cfg.filterQ != null ? cfg.filterQ : 0.4;
  filter.connect(destination);

  // ---- the shimmer LFO -----------------------------------------------------
  // One slow oscillator moving every voice's bandpass together. Slower than
  // anything the ear tracks as modulation — it reads as the sound breathing.
  const shimmer = ctx.createOscillator();
  shimmer.type = 'sine';
  shimmer.frequency.value = cfg.buzzRateHz != null ? cfg.buzzRateHz : 0.07;

  const shimmerDepth = ctx.createGain();
  shimmerDepth.gain.value = cfg.buzzSweepHz != null ? cfg.buzzSweepHz : 420;
  shimmer.connect(shimmerDepth);

  for (let i = 0; i < voiceCount; i++) {
    const midi = tanpura ? rootMidi + tuning[i] : rootMidi;
    const freq = midiToFreq(midi);

    // Fundamental.
    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.value = freq;

    // Buzz source. A sawtooth has the dense harmonic series the bridge needs
    // to work with; a sine has nothing up there to filter.
    const buzz = ctx.createOscillator();
    buzz.type = tanpura ? 'sawtooth' : 'triangle';
    buzz.frequency.value = freq;
    buzz.detune.value = (cfg.detuneSpread != null ? cfg.detuneSpread : 7) * (i % 2 ? -1 : 1);

    const voiceGain = ctx.createGain();
    // In tanpura mode this is the pluck envelope and starts near silence; in
    // pad mode it is a fixed balance.
    const balance = (1 / voiceCount) * (i === 0 ? 1 : 0.75);
    voiceGain.gain.value = tanpura ? balance * sustain : balance;

    sine.connect(voiceGain);

    let bandpass = null;
    const buzzGain = ctx.createGain();

    if (tanpura) {
      // Resonant bandpass well above the fundamental: this is the jivari.
      // Each voice sits at a slightly different multiple so the four strings
      // shimmer against each other rather than in lockstep.
      bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = freq * ((cfg.buzzRatio != null ? cfg.buzzRatio : 7) + i * 1.5);
      bandpass.Q.value = cfg.buzzQ != null ? cfg.buzzQ : 6;
      shimmerDepth.connect(bandpass.frequency);

      buzzGain.gain.value = cfg.buzzMix != null ? cfg.buzzMix : 0.5;
      buzz.connect(bandpass);
      bandpass.connect(buzzGain);
    } else {
      buzzGain.gain.value = cfg.triangleMix != null ? cfg.triangleMix : 0.45;
      buzz.connect(buzzGain);
    }

    buzzGain.connect(voiceGain);
    voiceGain.connect(filter);

    voices.push({
      sine, buzz, bandpass, buzzGain, voiceGain,
      midi, balance,
      env: tanpura ? sustain : 1,   // JS-side envelope value
      target: sustain,
      rising: false
    });
  }

  function applyChord(offsets, glideSec) {
    const next = voiceLead(voices.map((v) => v.midi), offsets, rootMidi);
    const now = ctx.currentTime;
    const tau = Math.max(0.005, glideSec / 3);

    next.forEach((midi, i) => {
      const voice = voices[i];
      voice.midi = midi;
      const freq = midiToFreq(midi);
      voice.sine.frequency.setTargetAtTime(freq, now, tau);
      voice.buzz.frequency.setTargetAtTime(freq, now, tau);
    });
  }

  /** Start the oscillators. Called once, from unlock(), like the voice does. */
  function start() {
    if (started) return;
    if (!tanpura) applyChord(progression[0], 0.001);

    const now = ctx.currentTime;
    voices.forEach((v) => { v.sine.start(now); v.buzz.start(now); });
    shimmer.start(now);
    started = true;

    // Pluck the first string immediately so switching on has an attack rather
    // than fading up out of nothing.
    if (tanpura) pluck(0);
  }

  /** One string sounded: swell to full, then decay back toward the sustain. */
  function pluck(index) {
    const v = voices[index];
    if (!v) return;
    v.target = 1;
    v.rising = true;
  }

  function advance() {
    chordIndex = (chordIndex + 1) % progression.length;
    applyChord(progression[chordIndex], cfg.glideSec != null ? cfg.glideSec : 2.4);
  }

  /**
   * Per-frame tick. Does nothing while the bed is switched off, so a tanpura
   * freezes where it was rather than plucking away into silence.
   *
   * @param {number} dt      seconds
   * @param {number} level01 the player's current level, 0..1
   */
  function update(dt, level01) {
    if (!started || !active || !(dt > 0)) return;
    const now = ctx.currentTime;
    const playing = level01 > (cfg.playingLevel != null ? cfg.playingLevel : 0.04);

    if (tanpura) {
      // ---- the plucking cycle ---------------------------------------------
      pluckClock += dt;
      if (pluckClock >= pluckSec) {
        pluckClock -= pluckSec;
        nextVoice = (nextVoice + 1) % voices.length;
        pluck(nextVoice);
      }

      // Envelopes, computed here and written once each. A swell and a long
      // decay per string, overlapping three strings deep at the default rate.
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        const tau = v.rising ? attackSec / 3 : decaySec / 3;
        v.env += (v.target - v.env) * (1 - Math.exp(-dt / tau));
        if (v.rising && v.env > 0.9) { v.rising = false; v.target = sustain; }
        v.voiceGain.gain.setTargetAtTime(v.env * v.balance, now, 0.03);
      }
    } else {
      // ---- the pad's chord clock ------------------------------------------
      clock += dt * (playing ? 1 : (cfg.idleRate != null ? cfg.idleRate : 0.3));
      if (clock >= (cfg.chordHoldSec != null ? cfg.chordHoldSec : 13)) {
        clock = 0;
        advance();
      }
    }

    // Sustained playing opens the bed very slowly, in both characters. A
    // minute in is a noticeably brighter room, and nobody can point at when
    // it changed.
    playTime = Math.min(90, Math.max(0, playTime + (playing ? dt : -dt * 0.4)));
    const base = cfg.filterHz != null ? cfg.filterHz : 2600;
    const lift = cfg.brightenWithPlay != null ? cfg.brightenWithPlay : 600;
    filter.frequency.setTargetAtTime(base + lift * (playTime / 90), now, 2.0);
  }

  /** Called by setBackingTrackPlaying(): the knob's on/off. */
  function setActive(value) {
    active = !!value;
  }

  /** Pitch classes the bed is sounding, 0..11. Unused while pitch.scale is
   *  null; here because chord-following snap would need exactly this. */
  function chordTones() {
    if (!started) return null;
    return voices.map((v) => ((v.midi % 12) + 12) % 12);
  }

  function dispose() {
    try {
      voices.forEach((v) => {
        if (started) { v.sine.stop(); v.buzz.stop(); }
        v.sine.disconnect(); v.buzz.disconnect();
        if (v.bandpass) v.bandpass.disconnect();
        v.buzzGain.disconnect(); v.voiceGain.disconnect();
      });
      if (started) shimmer.stop();
      shimmer.disconnect();
      shimmerDepth.disconnect();
      filter.disconnect();
    } catch (_) { /* teardown noise */ }
    started = false;
    active = false;
  }

  return {
    start,
    update,
    setActive,
    chordTones,
    dispose,
    get isStarted() { return started; },
    get isActive() { return active; }
  };
}
