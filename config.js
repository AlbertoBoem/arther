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
    distance: 0.62,        // metres in front of the head
    heightOffset: -0.28,   // relative to head height: roughly chest height
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
    nearDistance: 0.09,    // palm on/over the loop ring -> silence (matches LOOP.r = 0.09)
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
    muteWhenHidden: false
  },

  gestures: {
    pinchThreshold: 0.026,
    // Pinch with both hands at once to re-anchor the instrument in front of you.
    reanchorHoldMs: 700
  },

  visuals: {
    readoutHz: 8,        // canvas texture updates per second (uploads are costly)
    fieldRings: true,    // concentric guides showing where the octaves sit
    dimWhenIdle: 0.35
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

