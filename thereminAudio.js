/**
 * thereminAudio.js — the voice, in raw Web Audio.
 *
 * Tone.js was removed from this path deliberately. Constructing its graph
 * (Freeverb, Limiter, Panner3D, the standardized-audio-context shim) froze the
 * main thread for seconds on Spectacles and the context kept being suspended
 * afterwards. What's left is eight native nodes:
 *
 *   osc(sine) ─> gain ─┐
 *                      ├─> lowpass ─> amp ─> destination
 *   osc(tri)  ─> gain ─┘
 *   lfo ─> lfoDepth ─> detune of both        (vibrato)
 *
 * The lifecycle copies the reference app that works on this hardware:
 *   1. create the context and graph at page load
 *   2. start the oscillators in the 2D click, before requestSession
 *   3. never stop them; never let the gain reach true zero
 *   4. don't touch context state from the render loop — it has no user
 *      activation, so resume() there is rejected
 *
 * Parameter changes use setTargetAtTime: a one-pole approach in the audio
 * thread. No scheduling, no cancellation, no zipper noise, and it cannot throw.
 */

export function createThereminAudio(config) {
  const cfg = config.audio;

  let ctx = null;
  let nodes = null;
  let built = false;
  let started = false;
  let muted = false;
  let resumeError = null;
  let keepAlive = null;
  let lastState = 'none';

  /** Create the context and graph. No user gesture needed for this part. */
  function build() {
    if (built) return;

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio is not available in this browser.');

    ctx = new Ctor({ latencyHint: 'interactive' });
    lastState = ctx.state;

    // The one place the platform tells us the truth about suspension.
    ctx.onstatechange = () => {
      console.log('[aether] audiocontext state:', lastState, '->', ctx.state);
      lastState = ctx.state;
    };

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.value = 220;

    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.value = 220;

    const sineGain = ctx.createGain();
    sineGain.gain.value = 1 - cfg.harmonicMix;

    const triGain = ctx.createGain();
    triGain.gain.value = cfg.harmonicMix;

    // Vibrato: an LFO into both detune params, in cents.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = cfg.vibratoRate;

    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = cfg.vibratoDepthCents;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.max(cfg.filterMin, 220 * cfg.filterKeyFollow);
    filter.Q.value = cfg.filterQ;

    // Idles at an inaudible floor rather than zero, so the graph always
    // produces a stream. A silent graph is what gets suspended.
    const amp = ctx.createGain();
    amp.gain.value = cfg.idleGain;

    sine.connect(sineGain);
    tri.connect(triGain);
    sineGain.connect(filter);
    triGain.connect(filter);
    lfo.connect(lfoDepth);
    lfoDepth.connect(sine.detune);
    lfoDepth.connect(tri.detune);
    filter.connect(amp);
    amp.connect(ctx.destination);

    nodes = { sine, tri, sineGain, triGain, lfo, lfoDepth, filter, amp };
    built = true;
  }

  /**
   * Start the context and the oscillators. Must be called from a user gesture
   * (the 2D launch click) and before requestSession.
   */
  async function unlock() {
    if (!built) build();

    try {
      if (ctx.state !== 'running') await ctx.resume();
      resumeError = null;
    } catch (error) {
      resumeError = error && error.message ? error.message : String(error);
      console.warn('[aether] resume failed:', resumeError);
    }

    if (!started) {
      const t = ctx.currentTime;
      nodes.sine.start(t);
      nodes.tri.start(t);
      nodes.lfo.start(t);
      started = true;

      // Only snap to the idle floor on this first activation. Doing this on
      // every unlock() call (e.g. one triggered by a stray XR 'select' event
      // mid-play) yanks the live playing level down to near-silence over
      // 10ms while the per-frame setLevel() is simultaneously trying to hold
      // it at the real level — audible as a click.
      nodes.amp.gain.setTargetAtTime(cfg.idleGain, ctx.currentTime, 0.01);
    }

    return ctx.state;
  }

  /** Only for the in-XR fallback prompt, where a gesture is available. */
  async function resume() {
    if (!built) return 'none';
    try {
      if (ctx.state !== 'running') await ctx.resume();
      resumeError = null;
    } catch (error) {
      resumeError = error && error.message ? error.message : String(error);
      console.warn('[aether] resume failed:', resumeError);
    }
    return ctx.state;
  }

  /** Silent looping media element: extra insurance for audio focus. */
  function startKeepAlive() {
    if (!cfg.keepAlive) return;
    try {
      if (keepAlive) { keepAlive.play().catch(() => {}); return; }
      keepAlive = document.createElement('audio');
      keepAlive.loop = true;
      keepAlive.volume = 0.001;
      keepAlive.setAttribute('playsinline', '');
      keepAlive.src = 'data:audio/wav;base64,UklGRsQPAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAPAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
      document.body.appendChild(keepAlive);
      keepAlive.play().catch((error) => {
        console.warn('[aether] keepalive blocked:', error && error.message);
      });
    } catch (error) {
      console.warn('[aether] keepalive failed:', error);
    }
  }

  function setPitch(freq) {
    if (!started || !(freq > 0)) return;
    const t = ctx.currentTime;
    const glide = Math.max(0.005, config.pitch.portamento);
    nodes.sine.frequency.setTargetAtTime(freq, t, glide);
    nodes.tri.frequency.setTargetAtTime(freq, t, glide);
    nodes.filter.frequency.setTargetAtTime(
      Math.min(16000, Math.max(cfg.filterMin, freq * cfg.filterKeyFollow)), t, 0.03
    );
  }

  function setLevel(level) {
    if (!started) return;
    const wanted = muted ? cfg.idleGain : Math.max(cfg.idleGain, level);
    nodes.amp.gain.setTargetAtTime(wanted, ctx.currentTime, cfg.fadeSec);
  }

  function setMuted(value) {
    muted = !!value;
    if (started && muted) nodes.amp.gain.setTargetAtTime(cfg.idleGain, ctx.currentTime, 0.05);
  }

  /** Confirmation tone on its own path, immune to the per-frame level changes. */
  function blip(freq = 660) {
    if (!started) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);

      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(cfg.confirmationVolume, t + 0.03);
      gain.gain.linearRampToValueAtTime(0, t + 0.45);
      osc.start(t);
      osc.stop(t + 0.5);
      osc.onended = () => {
        try { osc.disconnect(); gain.disconnect(); } catch (_) { /* gone */ }
      };
    } catch (_) { /* non-fatal */ }
  }

  // Spatialisation is not part of this build: a PannerNode's gain depends on
  // listener/source geometry, which is one more way to arrive at silence.
  function setSourcePosition() { /* no-op */ }
  function updateListener() { /* no-op */ }

  function dispose() {
    built = false;
    started = false;
    if (nodes) {
      try {
        nodes.sine.stop(); nodes.tri.stop(); nodes.lfo.stop();
        Object.values(nodes).forEach((node) => node && node.disconnect && node.disconnect());
      } catch (_) { /* ignore teardown noise */ }
      nodes = null;
    }
    if (keepAlive) {
      try { keepAlive.pause(); keepAlive.remove(); } catch (_) {}
      keepAlive = null;
    }
    if (ctx && ctx.close) {
      try { ctx.close(); } catch (_) {}
    }
    ctx = null;
  }

  return {
    build,
    unlock,
    resume,
    startKeepAlive,
    setPitch,
    setLevel,
    setMuted,
    setSourcePosition,
    updateListener,
    blip,
    dispose,
    get isBuilt() { return built; },
    get isReady() { return built && started; },
    get contextState() { return ctx ? ctx.state : 'none'; },
    get rawState() { return ctx ? ctx.state : 'none'; },
    get sampleRate() { return ctx ? ctx.sampleRate : 0; },
    get ampValue() {
      try { return nodes ? nodes.amp.gain.value : -1; } catch (_) { return -1; }
    },
    get resumeError() { return resumeError; }
  };
}

