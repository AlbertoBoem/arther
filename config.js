/**
 * config.js — every number worth tuning lives here.
 * Distances are metres, times are seconds unless the name says Ms.
 */
export const CONFIG = {

  renderer: {
    // Spectacles jitter badly above 1.0. Leave this alone unless you profile.
    pixelRatio: 1.0,
    // Also remove the canvas from page layout while presenting. The XR
    // compositor owns the framebuffer, so this is usually safe — try it if the
    // browser page is still visible behind the AR content.
    hideCanvasInXR: false,
    antialias: true,
    near: 0.02,
    far: 20
  },

  placement: {
    // No hit-testing on Spectacles (it's emulated), so the instrument is
    // anchored to wherever your head was pointing a moment after entry.
    // The RCA-style cabinet is deeper and its rod stands at the back corner,
    // so it sits a little closer than the old box did to keep the rod in reach.
    distance: 0.55,        // metres in front of the head
    // Sized against the RCA Victor cabinet and period photos of players:
    // antenna tip at eye level, top of the cabinet at chest height (~1.16m
    // for a 1.60m eye height; the RCA's is 1.18m). The model is drawn at
    // roughly RCA proportions, then scaled down a little so it fits the
    // Spectacles' narrow field of view without looking like a toy: at 0.85
    // the cabinet is 34cm wide against the RCA's 48cm.
    scale: 0.85,           // uniform size of the whole instrument
    heightOffset: -0.50,   // group origin (≈ loop height) relative to the eyes
    settleDelayMs: 1400    // let the tracker stabilise before anchoring
  },

  pitch: {
    hand: 'right',
    nearDistance: 0.06,    // palm this close to the rod -> highest note
    farDistance: 0.58,     // palm this far -> lowest note
    minFreq: 98.0,         // G2
    maxFreq: 1567.98,      // G6  (4 octaves)
    smoothingTau: 0.045,   // bigger = smoother, laggier
    portamento: 0.02,      // audio-rate glide applied on top of smoothing
    holdWhenLostMs: 2500,  // keep the last note this long if the hand vanishes

    // Set scale to null for a true continuous theremin.
    // Otherwise: semitone offsets from the root, e.g. major = [0,2,4,5,7,9,11]
    scale: null,
    scaleRootMidi: 55,     // G3
    snapStrength: 0.85     // 0 = no snap, 1 = hard quantise
  },

  volume: {
    hand: 'left',
    nearDistance: 0.077,   // palm on/over the loop ring -> silence. Matches the
                           // drawn ring: LOOP.r 0.09 x placement.scale 0.85
    farDistance: 0.18,//0.30,     // palm this far from the loop centre -> full level
    // Outer edge of the field. Past this distance from the loop centre the
    // volume fades back to silence (and is hard zero beyond it), like a real
    // theremin field that no longer reaches the hand. null = off (volume just
    // holds at full past farDistance). MUST be larger than farDistance.
    maxDistance: 0.40,     // e.g. 0.20, paired with a smaller farDistance (~0.14)
    curve: 1.15,           // near-linear = even, responsive throughout (1.0 = fully linear)
    // Buffer / dead zone around the loop. The palm centroid sits behind the
    // fingertips, so touching the ring reads a little past LOOP.r; this pads the
    // silence out by ~1cm so a touch reliably kills the sound and small tremor
    // near the ring stays at a clean zero instead of wavering.
    deadZone: 0.012,       // metres of hard-silence beyond nearDistance (~1cm+)
    // Level the instant you leave the dead zone. A small floor makes the edge feel
    // like a crisp on/off (sound "drops to zero suddenly") instead of a long fade
    // through inaudible values. Set 0 for a smooth fade-in; raise for a harder gate.
    onsetLevel: 0.06,      // 0..1 fraction of maxGain, applied just outside the buffer
    maxGain: 0.85,
    smoothingTau: 0.035,
    // Holding the last level when the hand leaves the (narrow) field of view
    // is far more playable than cutting out. It still fades eventually.
    holdWhenLostMs: 3000,
    // Level used until the volume hand is seen for the first time. Without
    // this, the instrument is silent until your left hand shows up — which
    // looks exactly like broken audio. Set to 0 for strict theremin behaviour.
    defaultLevel: 0.4
  },

  audio: {
    harmonicMix: 0.26,        // triangle blended under the sine
    vibratoRate: 5.3,
    vibratoDepthCents: 11,
    filterKeyFollow: 3.4,     // cutoff = freq * this
    filterMin: 650,
    filterQ: 0.6,
    // No reverb and no 3D panner in this build: both were in the Tone graph
    // that froze the main thread, and a panner's gain depends on listener/source
    // geometry, which is one more route to silence.
    spatial: false,
    fadeSec: 0.03,            // param ramp time; below ~0.02 you get zipper noise
    startupBlip: true,        // short tone when the instrument anchors, proving
                              // the audio chain works before you touch anything
    confirmationVolume: 0,    // peak gain of that blip (both the anchor one and
                              // the one on gesture-recovered audio). 0 = silent;
                              // it still fires, just muted. Was 0.2.
    // The graph idles here instead of at true zero. A continuously streaming
    // graph keeps audio focus through the immersive transition; one that goes
    // properly silent can be suspended, and it cannot be resumed from the
    // render loop. Roughly -66 dB: inaudible.
    idleGain: 0.0005,
    keepAlive: true,          // also hold focus with a silent looping <audio>
    // The reference app has no visibility handling at all and works. Muting on
    // a 'hidden' report was silencing this app permanently, so it's off.
    muteWhenHidden: false,

    // Soft clipper on the master bus. The destination clips hard at 1.0 and
    // nothing else in this graph limits: the voice reaches maxGain 0.85 and
    // the bed peaks near 0.6, so together they were asking for 1.45 and
    // getting square edges. A WaveShaper is a lookup table — stateless, no
    // feedback, nothing that can ring or run away.
    //
    // enabled:false makes outputBus = ctx.destination, i.e. exactly the graph
    // this build had before. That's the A/B test if anything sounds off.
    limiter: {
      enabled: true,
      inputGain: 0.7,   // pulls the sum into range before the curve
      drive: 1.2        // knee. inputGain x drive/tanh(drive) = 1.008, so
                        // quiet signals pass through at unity and only loud
                        // ones bend. Raise drive for more squash and more
                        // harmonics; lower it toward 0.5 for nearly linear
    }
  },

  gestures: {
    pinchThreshold: 0.026,
    // Pinch with both hands at once to re-anchor the instrument in front of you.
    reanchorHoldMs: 700
  },

  // Generative harmonic bed under the instrument. Took over the backing
  // track's slot: same knob, same gain node, same on/off, but synthesised, so
  // there's no file to fetch and nothing to repeat.
  drone: {
    // 'tanpura' — a static Indian-style drone: four strings plucked in
    //             rotation over a shimmering bridge, no chord changes at all.
    // 'pad'     — the earlier behaviour: a slow quartal progression.
    character: 'tanpura',

    // Kept from the old backingTrack block because applyTrackGain() still
    // reads exactly these two.
    //
    // Headroom matters: nothing in this graph limits. The bed's voices sum to
    // ~0.95 before this gain and the played note reaches maxGain 0.85 on top,
    // so the total has to stay under 1.0 or the destination clips — and
    // clipped sustained tones sound like something is broken.
    //
    // THIS IS THE DRONE'S VOLUME KNOB. The tanpura spends most of its time at
    // the sustain floor rather than held open like the pad did, so it needs a
    // higher number here to land at the same perceived level.
    volume: 0.6,            // gain while playing (0..1, independent of maxGain)
    fadeSec: 0.6,           // fade on toggle. A bed should arrive, not switch on

    rootMidi: 55,           // Sa. G3 — an octave above where this started,
                            // because open-ear speakers cannot move air at
                            // 98Hz. Drop to 43 for headphones or desktop.

    // ---- tanpura ---------------------------------------------------------
    // Semitone offsets from Sa: Pa, Sa, Sa, Sa'. The real fourth string is an
    // octave BELOW Sa (-12); at 98Hz that is inaudible on the glasses, so it
    // goes up instead. Use [-5, 0, 0, -12] on headphones.
    tuning: [-5, 0, 0, 12],

    pluckSec: 1.35,         // seconds between strings. The classic cycle is
                            // slow — under ~0.8 it starts to sound busy
    pluckAttackSec: 0.12,
    pluckDecaySec: 2.8,     // long enough that three strings overlap
    pluckSustain: 0.45,     // level a string falls back to, never to silence.
                            // Also the single biggest influence on how loud
                            // the bed FEELS, since it is where the strings sit
                            // between plucks. Near 1.0 the plucking disappears
                            // into a steady pad

    // Jivari: the bright buzz of the bridge. A sawtooth through a resonant
    // bandpass high above the fundamental, swept by one very slow LFO.
    buzzMix: 0.5,           // how much buzz against the plain fundamental.
                            // Makeup gain for the bandpass is applied inside
                            // drone.js, so 0.5 really is half-and-half now
    buzzRatio: 7,           // bandpass centre, as a multiple of the string
    buzzQ: 6,               // resonance. Past ~10 it whistles
    buzzSweepHz: 420,       // how far the shimmer moves that centre
    buzzRateHz: 0.07,       // ~14s per cycle: breathing, not modulation

    // ---- pad (character: 'pad' only) -------------------------------------
    voices: 3,
    progression: [
      [0, 7, 14],           // fourths, fifths and ninths, NO thirds — the
      [-2, 5, 12],          // pitch field is continuous, so a defined third
      [-5, 2, 9],           // would make half the glide sound wrong
      [0, 7, 12]
    ],
    chordHoldSec: 13,
    idleRate: 0.3,
    glideSec: 2.4,
    triangleMix: 0.45,

    // ---- both ------------------------------------------------------------
    playingLevel: 0.04,     // player level above which "playing" counts
    detuneSpread: 7,        // cents between a voice's two oscillators
    filterHz: 2600,         // brighter than a pad wants: the buzz lives up here
    filterQ: 0.4,
    brightenWithPlay: 600   // Hz the filter opens by over a long session
  },

  // Hand MOVEMENT -> timbre. See expression.js.
  expression: {
    enabled: true,
    speedFull: 1.1,         // palm speed counted as full tilt, m/s
    speedTau: 0.13,         // smoothing on velocity; frame deltas are noisy

    stillSpeed: 0.055,      // m/s below which the hand counts as held
    stillRiseSec: 0.7,      // how long stillness takes to bloom
    stillFallSec: 0.2,      // and how fast movement cancels it

    brightness: 2.2,        // filter cutoff multiplier at full speed
    growl: 0.30,            // extra triangle in the mix at full speed
    vibratoFloor: 0.25,     // LFO depth when moving, as a fraction of
                            // audio.vibratoDepthCents (1.0 = no stillness effect)

    // Tremor -> detune: the difference between a slow and a fast follower of
    // the pitch, which is a band-pass around 1.5-9Hz. Slower than that is the
    // melody; faster is tracking noise.
    tremorSlowTau: 0.24,
    tremorFastTau: 0.028,
    tremorGain: 2.6,        // how much of the natural wobble reaches detune
    tremorMaxCents: 45,     // ceiling, or a tracking glitch becomes a siren
    tremorNeedsStillness: true
  },

  // Parallel send off the voice's amp. Four combs and two allpasses — no
  // impulse response, no decodeAudioData, nothing that can block the thread.
  reverb: {
    enabled: true,
    wet: 0.22,              // small room. Past ~0.35 the theremin loses its edge
    decaySec: 1.9,
    preDelaySec: 0.012,
    dampingHz: 3200         // the high end dies first, as in a real room
  },

  visuals: {
    readoutHz: 8,        // canvas texture updates per second (uploads are costly)
    fieldRings: false,    // concentric guides showing where the octaves sit
    dimWhenIdle: 0.35,
    // The "old photograph" look of the RCA-style cabinet (thereminModel.js).
    photo: {
      grain: 0.16,          // film grain amplitude (0 = clean)
      flicker: 0.06,        // slow exposure flicker (0 = steady)
      vignette: 0.8,        // brightness at the instrument's extremities (1 = none)
      // On an additive display brightness IS solidity: dark reads as see-through.
      woodColor: 0xa47650,  // lacquered wood: brighter = more solid on Spectacles
      woodOpacity: 1.0,
      legsToFloor: true     // stretch the legs down to the floor when it is known
    }
  },

  debug: {
    logHandDataMs: 1000,     // >0 logs audio state + joint counts + distances
    // Master on/off for the whole readout panel — note, cents, frequency,
    // level bar, hand status, and diagnostics all go dark together. There is
    // no console on your face, so this is how you see what's happening.
    // Starts off; tap the knob beside the pitch antenna (player's right) to
    // toggle it at runtime.
    hud: false,
    // Keeps a tone going when no hand has ever been tracked, so you can tell
    // "hand tracking is dead" apart from "audio is dead". Turn off to play
    // properly: silence with no hands is the correct behaviour.
    soundWithoutHands: true,
    // Set to a number 0..1 to bypass ALL hand mapping and hold that gain.
    // The decisive test: if this still gives silence, the problem is the audio
    // context or graph. If you hear it, the problem is tracking or mapping.
    forceLevel: null
  }
};

