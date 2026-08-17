import * as THREE from './three.module.js';
import { CONFIG } from './config.js';
import { OnePole, distanceToSegment, pitchPosition, frequencyFor, levelFor, snapFrequency, describeFrequency, clamp01 } from './mapping.js';
import { createHandTracking } from './hands.js';
import { createTheremin, createAudioPrompt } from './thereminModel.js';
import { createThereminAudio } from './thereminAudio.js';

/**
 * Aether — a WebXR theremin for Snapchat Spectacles.
 *
 * immersive-ar + hand tracking + raw Web Audio. Right hand near the rod = pitch,
 * left hand away from the loop = volume, exactly like the real instrument.
 *
 * Session notes specific to Spectacles:
 *  - hit-testing is only emulated, so there is no floor/plane placement here;
 *    the instrument anchors relative to your head a moment after entry, and
 *    you can re-anchor at any time by pinching with both hands.
 *  - the experience pauses when the user opens the palm menu, which fires
 *    'visibilitychange' on the session — we mute there so nothing drones on.
 *  - field of view is narrow (~46°), so hands leave tracking constantly. Both
 *    axes hold their last value briefly instead of cutting out.
 */

// ---------------------------------------------------------------- DOM handles
const enterButton = document.getElementById('enter');
const testButton = document.getElementById('test');
const statusLine = document.getElementById('status');

function setStatus(message, isError = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle('error', isError);
}

// ------------------------------------------------------------------ app state
let renderer, scene, camera;
let session = null;
let hands = null;
let theremin = null;
let audio = null;
let testAudio = null;
let audioPrompt = null;
let audioStarting = false;
let floorReferenceSpace = true;

let anchored = false;
let sessionStartTime = 0;
let lastFrameTime = 0;
let paused = false;
let volumeHandSeen = false;

let bothPinchMs = 0;
let hudKnobTouching = false;
let debugClock = 0;
let healthClock = 0;
let frameError = null;
let silenceReason = 'init';
let lastContextState = 'unknown';

const pitchSmoother = new OnePole(CONFIG.pitch.smoothingTau, 0);
const levelSmoother = new OnePole(CONFIG.volume.smoothingTau, 0);

let lastPitchDistance = CONFIG.pitch.farDistance;
let lastVolumeDistance = CONFIG.volume.nearDistance;

// Scratch vectors — the render loop allocates nothing.
const axisA = new THREE.Vector3();
const axisB = new THREE.Vector3();
const volumeCentre = new THREE.Vector3();
const hudKnobPos = new THREE.Vector3();
const instrumentCentre = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const headPos = new THREE.Vector3();
const headDir = new THREE.Vector3();

// ------------------------------------------------------------------- boot
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
  ]);
}

async function boot() {
  // Tell the watchdog in index.html that the module is alive.
  if (window.__aether) window.__aether.ready = true;

  setStatus('Building the audio engine…');

  // Build the context and graph now. Creating nodes needs no gesture; only
  // starting the context does. This mirrors the reference app, which builds its
  // whole audio graph at page load and starts the sources in the click.
  try {
    audio = createThereminAudio(CONFIG);
    audio.build();
    console.log('[aether] audio graph built:', audio.contextState, '@', audio.sampleRate, 'Hz');
  } catch (error) {
    setStatus(`Audio setup failed: ${error.message}`, true);
    return;
  }

  setStatus('Checking WebXR…');
  if (!navigator.xr) {
    setStatus('No WebXR here. Open this page in the Spectacles Browser Lens.', true);
    return;
  }

  // Some runtimes never settle this promise, which would leave the page
  // apparently frozen, so treat a stall as "unknown" rather than waiting.
  let supported = null;
  try {
    supported = await withTimeout(navigator.xr.isSessionSupported('immersive-ar'), 4000);
  } catch (_) {
    supported = null;
  }

  if (supported === false) {
    setStatus('This device cannot start an AR session.', true);
    return;
  }

  enterButton.disabled = false;
  if (testButton) {
    testButton.disabled = false;
    testButton.addEventListener('click', playTestTone);
  }
  enterButton.addEventListener('click', enter, { once: true });

  setStatus(supported === null
    ? 'Could not confirm AR support — try Start playing anyway.'
    : 'Ready. Give yourself about a metre of space.');
}

/**
 * Plays 440 Hz for a second and a half in the flat browser page, with no XR
 * involved. This is the fastest way to tell "the audio stack is silent" apart
 * from "the hand mapping is asking for silence".
 */
async function playTestTone() {
  testButton.disabled = true;
  try {
    if (!testAudio) {
      testAudio = createThereminAudio(CONFIG);
      testAudio.build();
    }
    testAudio.startKeepAlive();
    const state = await testAudio.unlock();
    setStatus(`Audio context: ${state}. Playing 440 Hz…`);

    testAudio.setPitch(440);
    testAudio.setLevel(0.35);

    setTimeout(() => {
      testAudio.setLevel(0);
      testButton.disabled = false;
      setStatus(
        testAudio.contextState === 'running'
          ? 'Context running. If you heard nothing, check the device volume.'
          : `Context is ${testAudio.contextState} — the gesture unlock did not take.`,
        testAudio.contextState !== 'running'
      );
    }, 1500);
  } catch (error) {
    setStatus(`Audio failed: ${error.message}`, true);
    testButton.disabled = false;
  }
}

// --------------------------------------------------------------- enter AR
async function enter() {
  enterButton.disabled = true;
  if (testButton) testButton.disabled = true;
  setStatus('Starting audio…');

  // A test voice would keep its own oscillators running alongside the real one.
  if (testAudio) { testAudio.dispose(); testAudio = null; }

  // Start the context and the oscillators HERE, inside the click and before
  // requestSession. This is the order the working reference app uses: sources
  // begin playing at an inaudible level in the 2D page and never stop, so
  // nothing has to be resumed once we're immersive.
  try {
    audio.startKeepAlive();
    const state = await audio.unlock();
    console.log('[aether] audio unlocked in click ->', state);
    if (state !== 'running') {
      setStatus(`Audio context is ${state}. Tap Test tone first, then Start.`, true);
    }
  } catch (error) {
    setStatus(`Audio failed: ${error.message}`, true);
    enterButton.disabled = false;
    enterButton.addEventListener('click', enter, { once: true });
    return;
  }

  setStatus('Starting AR…');

  // The reference app requests local-floor as REQUIRED and it works on
  // Spectacles, so try that first and fall back if this device refuses.
  try {
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking']
      });
      floorReferenceSpace = true;
    } catch (floorError) {
      console.warn('[aether] local-floor refused, falling back to local:', floorError && floorError.message);
      session = await navigator.xr.requestSession('immersive-ar', {
        optionalFeatures: ['hand-tracking', 'local-floor']
      });
      floorReferenceSpace = false;
    }
  } catch (error) {
    setStatus(`Could not start AR: ${error.message}`, true);
    audio.dispose();
    audio = null;
    enterButton.disabled = false;
    enterButton.addEventListener('click', enter, { once: true });
    return;
  }

  buildScene();

  // three.js defaults to local-floor, which is what the reference app relies on.
  renderer.xr.setReferenceSpaceType(floorReferenceSpace ? 'local-floor' : 'local');
  await renderer.xr.setSession(session);

  // Taking over the display can suspend or reroute audio on some runtimes.
  console.log('[aether] session started; audio waits for a pinch');

  hands = createHandTracking(renderer, scene, CONFIG);

  theremin = createTheremin(CONFIG);
  theremin.group.visible = false;
  scene.add(theremin.group);

  audioPrompt = createAudioPrompt(CONFIG);
  scene.add(audioPrompt.group);
  // Only asks for a gesture if the click-time unlock didn't take.
  if (!audio.isReady || audio.contextState !== 'running') audioPrompt.show();

  session.addEventListener('end', onSessionEnd);
  session.addEventListener('visibilitychange', onVisibilityChange);

  // These events carry user activation; a render-loop call does not.
  session.addEventListener('select', startAudioFromGesture);
  session.addEventListener('selectstart', startAudioFromGesture);
  session.addEventListener('squeeze', startAudioFromGesture);

  hidePageForXR();
  sessionStartTime = performance.now();
  lastFrameTime = 0;
  anchored = false;
  paused = false;
  volumeHandSeen = false;
  frameError = null;
  silenceReason = 'init';
  pitchSmoother.reset(0);
  levelSmoother.reset(0);
  lastPitchDistance = CONFIG.pitch.farDistance;
  lastVolumeDistance = CONFIG.volume.nearDistance;

  renderer.setAnimationLoop(onFrame);
}

/**
 * Builds (or revives) the audio graph from a genuine user gesture inside the
 * session. Called from XR select/squeeze events, which are activation-triggering
 * — unlike anything the render loop can do.
 */
async function startAudioFromGesture() {
  if (!audio || audioStarting) return;

  // 'select'/'selectstart' fire on every pinch on hand-tracking runtimes,
  // not just when audio genuinely needs unlocking. If it's already running
  // there is nothing to do here — proceeding was causing a click plus a
  // confirmation blip() on every ordinary pinch during play.
  if (audio.contextState === 'running' && audio.isReady) return;

  audioStarting = true;

  try {
    audio.startKeepAlive();

    if (audioPrompt) audioPrompt.setMessage('STARTING AUDIO', 'one moment');
    await audio.unlock();
    const state = await audio.resume();
    console.log('[aether] audio started by gesture ->', state, audio.resumeError || '');

    if (state === 'running' && audio.isReady) {
      audio.blip();
      if (anchored) {
        theremin.getCentre(instrumentCentre);
        audio.setSourcePosition(instrumentCentre);
      }
      if (audioPrompt) audioPrompt.hide();
    } else if (audioPrompt) {
      audioPrompt.setMessage('AUDIO BLOCKED', audio.resumeError || state);
      audioPrompt.show();
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('[aether] audio start failed:', error);
    if (audioPrompt) {
      audioPrompt.setMessage('AUDIO FAILED', message.slice(0, 40));
      audioPrompt.show();
    }
  } finally {
    audioStarting = false;
  }
}

function buildScene() {
  renderer = new THREE.WebGLRenderer({
    antialias: CONFIG.renderer.antialias,
    alpha: true            // required: the real world shows through
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.renderer.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = null;   // anything opaque here would black out the world

  // No lights: every material in the instrument is unlit by design, which is
  // both cheaper and far more legible on an additive display.
  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    CONFIG.renderer.near,
    CONFIG.renderer.far
  );
  scene.add(camera);

  window.addEventListener('resize', onResize);
}

// -------------------------------------------------------------- anchoring
function anchorInstrument() {
  camera.getWorldPosition(headPos);
  camera.getWorldDirection(headDir);

  headDir.y = 0;
  if (headDir.lengthSq() < 1e-6) headDir.set(0, 0, -1);
  headDir.normalize();

  theremin.group.position.copy(headPos).addScaledVector(headDir, CONFIG.placement.distance);
  theremin.group.position.y = headPos.y + CONFIG.placement.heightOffset;

  // Turn the cabinet so its front (+Z) faces the player.
  theremin.group.rotation.set(0, Math.atan2(-headDir.x, -headDir.z), 0);
  theremin.group.visible = true;
  theremin.syncMatrices();

  theremin.getCentre(instrumentCentre);
  if (audio && audio.isReady) {
    audio.setSourcePosition(instrumentCentre);
    if (CONFIG.audio.startupBlip) audio.blip();
  }

  anchored = true;
}

// ------------------------------------------------------------- frame loop
function onFrame(time) {
  const dt = lastFrameTime ? Math.min(0.05, (time - lastFrameTime) / 1000) : 0;
  lastFrameTime = time;

  try {
    // Read this every frame rather than trusting the event: a paused flag that
    // only ever gets set in a handler can stick on permanently.
    paused = CONFIG.audio.muteWhenHidden && session
      ? session.visibilityState === 'hidden'
      : false;

    hands.update(dt * 1000);

    if (!anchored) {
      if (performance.now() - sessionStartTime >= CONFIG.placement.settleDelayMs) {
        anchorInstrument();
      }
    } else {
      handleReanchorGesture(dt);
      handleHudKnobToggle();
      drive(dt);
    }

    // Prompt: head-locked, plus a fingertip poke as an alternative to pinching.
    if (audioPrompt) {
      audioPrompt.update(dt, camera);
      if (audioPrompt.group.visible && !audioStarting) {
        if ((hands.right.tracked && audioPrompt.containsPoint(hands.right.indexTip)) ||
            (hands.left.tracked && audioPrompt.containsPoint(hands.left.indexTip))) {
          startAudioFromGesture();
        }
      }
      // If the context dies later, ask for another gesture rather than going
      // quietly silent.
      if (audio && audio.isReady && audio.contextState !== 'running' && !audioStarting) {
        audioPrompt.setMessage('PINCH TO RESUME AUDIO', audio.contextState);
        audioPrompt.show();
      }
    }

    // Always refresh the panel, even before anchoring or after a failure —
    // it's the only way to see state from inside the headset.
    if (theremin) {
      theremin.setDiagnostics({
        ctx: audio ? audio.contextState : 'none',
        paused,
        right: hands.right.jointCount,
        left: hands.left.jointCount,
        level: levelSmoother.value,
        amp: audio ? audio.ampValue : -1,
        raw: audio ? audio.rawState : '-',
        reason: audio && audio.isReady ? silenceReason : 'no-audio',
        error: frameError || (audio ? audio.resumeError : null)
      });
      theremin.update(dt, camera);
    }

    if (CONFIG.audio.spatial && audio && audio.isReady) audio.updateListener(camera);
    checkAudioHealth(dt);
    maybeLog(dt);
  } catch (error) {
    // Without this, one bad call throws every frame, anchoring never completes
    // and the whole app looks dead for no visible reason.
    if (!frameError) {
      frameError = error && error.message ? error.message : String(error);
      console.error('[aether] frame error:', error);
    }
  }

  renderer.render(scene, camera);
}

/** A context that quietly suspends mid-session is a classic cause of silence. */
function checkAudioHealth(dt) {
  healthClock += dt;
  if (healthClock < 0.5) return;
  healthClock = 0;
  if (!audio) return;

  if (!audio.isReady) return;
  const state = audio.contextState;
  if (state !== lastContextState) {
    console.warn('[aether] audio context:', lastContextState, '->', state);
    lastContextState = state;
  }
  if (state !== 'running') audio.resume();
}

function handleReanchorGesture(dt) {
  if (hands.left.pinching && hands.right.pinching) {
    bothPinchMs += dt * 1000;
    if (bothPinchMs >= CONFIG.gestures.reanchorHoldMs) {
      bothPinchMs = -1500;      // debounce so it can't retrigger immediately
      if (audio && audio.isReady) audio.setLevel(0);
      levelSmoother.reset(0);
      anchorInstrument();
    }
  } else if (bothPinchMs > 0) {
    bothPinchMs = 0;
  } else if (bothPinchMs < 0) {
    bothPinchMs = Math.min(0, bothPinchMs + dt * 1000);
  }
}

/** Tap-to-toggle: fires once on the rising edge, not every frame of contact. */
function handleHudKnobToggle() {
  theremin.getHudKnobPosition(hudKnobPos);
  const touchRadius = 0.03;
  const touching =
    (hands.right.tracked && hands.right.indexTip.distanceTo(hudKnobPos) < touchRadius) ||
    (hands.left.tracked && hands.left.indexTip.distanceTo(hudKnobPos) < touchRadius);

  if (touching && !hudKnobTouching) {
    CONFIG.debug.hud = !CONFIG.debug.hud;
  }
  hudKnobTouching = touching;
}

function drive(dt) {
  theremin.syncMatrices();
  theremin.getPitchAxis(axisA, axisB);
  theremin.getVolumeCentre(volumeCentre);

  const pitchHand = hands.get(CONFIG.pitch.hand);
  const volumeHand = hands.get(CONFIG.volume.hand);

  // ---- pitch: distance to the rod, not to a point, so raising and lowering
  // the hand alongside the antenna doesn't change the note.
  if (pitchHand.tracked) {
    lastPitchDistance = distanceToSegment(pitchHand.palm, axisA, axisB, tmpA, tmpB);
  }
  // lostForMs starts at Infinity, so a hand that never arrived counts as lost
  // immediately — which silenced the whole app the moment hand tracking wasn't
  // working. Treat "never seen" separately.
  const pitchNeverSeen = !pitchHand.everSeen;
  const pitchLost = pitchHand.everSeen
    && !pitchHand.tracked
    && pitchHand.lostForMs > CONFIG.pitch.holdWhenLostMs;
  const targetT = pitchPosition(lastPitchDistance, CONFIG.pitch);
  const smoothT = pitchSmoother.process(targetT, dt);

  let frequency = frequencyFor(smoothT, CONFIG.pitch);
  const snapped = !!(CONFIG.pitch.scale && CONFIG.pitch.scale.length && CONFIG.pitch.snapStrength > 0);
  if (snapped) frequency = snapFrequency(frequency, CONFIG.pitch);

  // ---- volume: distance from the loop. Holding the last level through a
  // tracking dropout is far more playable than cutting to silence.
  if (volumeHand.tracked) {
    lastVolumeDistance = volumeHand.palm.distanceTo(volumeCentre);
    volumeHandSeen = true;
  }
  const volumeLost = !volumeHand.tracked && volumeHand.lostForMs > CONFIG.volume.holdWhenLostMs;

  let targetLevel;
  let reason;
  if (!volumeHandSeen) {
    // The left hand has not been seen yet this session. Falling silent here is
    // indistinguishable from broken audio, so play at a usable level instead.
    targetLevel = CONFIG.volume.defaultLevel * CONFIG.volume.maxGain;
    reason = 'default';
  } else {
    targetLevel = levelFor(lastVolumeDistance, CONFIG.volume);
    reason = 'playing';
    if (volumeLost) { targetLevel = 0; reason = 'vol-lost'; }
  }
  if (pitchLost) { targetLevel = 0; reason = 'pitch-lost'; }
  if (pitchNeverSeen && !CONFIG.debug.soundWithoutHands) { targetLevel = 0; reason = 'no-hands'; }
  if (paused) { targetLevel = 0; reason = 'paused'; }

  // Debug override: bypass every gate above.
  if (CONFIG.debug.forceLevel !== null && CONFIG.debug.forceLevel !== undefined) {
    targetLevel = CONFIG.debug.forceLevel;
    reason = 'forced';
  }

  silenceReason = reason;
  const level = levelSmoother.process(targetLevel, dt);

  if (audio && audio.isReady) {
    audio.setPitch(frequency);
    audio.setLevel(level);
  }

  const note = describeFrequency(frequency);
  theremin.setPitchState(
    smoothT, frequency, note.name, note.cents,
    lastPitchDistance, pitchHand.tracked, snapped
  );
  theremin.setVolumeState(
    clamp01(level / CONFIG.volume.maxGain),
    lastVolumeDistance, volumeHand.tracked
  );
}

function maybeLog(dt) {
  if (!CONFIG.debug.logHandDataMs) return;
  debugClock += dt * 1000;
  if (debugClock < CONFIG.debug.logHandDataMs) return;
  debugClock = 0;
  console.log('[aether]', {
    ready: audio ? audio.isReady : false,
    ctx: audio ? audio.contextState : 'none',
    raw: audio ? audio.rawState : '-',
    amp: audio ? audio.ampValue.toFixed(3) : '-',
    resumeError: audio ? audio.resumeError : null,
    level: levelSmoother.value.toFixed(3),
    reason: silenceReason,     // why the gain is what it is
    hz: frequencyFor(pitchSmoother.value, CONFIG.pitch).toFixed(1),
    volumeHandSeen,
    right: { tracked: hands.right.tracked, joints: hands.right.jointCount, d: lastPitchDistance.toFixed(3) },
    left: { tracked: hands.left.tracked, joints: hands.left.jointCount, d: lastVolumeDistance.toFixed(3) }
  });
}

// ------------------------------------------------------------- lifecycle
function onVisibilityChange() {
  // Spectacles pauses the experience behind the palm menu.
  paused = CONFIG.audio.muteWhenHidden && session.visibilityState === 'hidden';
  if (audio && CONFIG.audio.muteWhenHidden) audio.setMuted(paused);
  console.log('[aether] session visibility:', session.visibilityState);
}

function onSessionEnd() {
  renderer.setAnimationLoop(null);

  if (audio) { audio.dispose(); audio = null; }
  if (theremin) { theremin.dispose(); theremin = null; }
  if (audioPrompt) { audioPrompt.dispose(); audioPrompt = null; }

  window.removeEventListener('resize', onResize);
  if (renderer) {
    renderer.dispose();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }

  renderer = scene = camera = null;
  hands = null;
  session = null;
  anchored = false;
  pitchSmoother.reset(0);
  levelSmoother.reset(0);

  showPageAfterXR();
  enterButton.disabled = false;
  if (testButton) testButton.disabled = false;
  enterButton.addEventListener('click', enter, { once: true });
  setStatus('Session ended. Start again whenever you like.');
}

/**
 * Take the 2D page out of the picture entirely.
 *
 * A class plus a stylesheet rule isn't enough on its own: the page background
 * is opaque, and anything left painted shows through as a panel behind the AR
 * content. The reference app sets display:none on each element inline, so this
 * does both — the class for the stylesheet, and inline styles that can't be
 * missed.
 */
function hidePageForXR() {
  document.documentElement.classList.add('xr');
  document.body.classList.add('xr');
  if (CONFIG.renderer.hideCanvasInXR) document.body.classList.add('hide-canvas');

  ['stage', 'enter', 'test', 'status'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.style.display = 'none';
  });

  // The opaque background is the part that actually shows through.
  document.documentElement.style.background = 'transparent';
  document.documentElement.style.backgroundColor = 'transparent';
  document.body.style.background = 'transparent';
  document.body.style.backgroundColor = 'transparent';

  if (renderer) renderer.setClearAlpha(0);
}

function showPageAfterXR() {
  document.documentElement.classList.remove('xr');
  document.body.classList.remove('xr', 'hide-canvas');

  ['stage', 'enter', 'test', 'status'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.style.display = '';   // back to the stylesheet's value
  });

  document.documentElement.style.background = '';
  document.documentElement.style.backgroundColor = '';
  document.body.style.background = '';
  document.body.style.backgroundColor = '';
}

function onResize() {
  if (!renderer || !camera) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

boot();
