import * as THREE from './three.module.js';
import { clamp01, octaveRadii } from './mapping.js';

/**
 * thereminModel.js — the instrument you see.
 *
 * Built for an additive see-through display: on Spectacles, black is
 * transparent, so a realistic lacquered cabinet would simply be invisible.
 * Everything here is unlit, additively blended, and mostly made of bright
 * lines. Warm amber = pitch side, cool cyan = volume side, consistently.
 */
const AMBER = 0xffc978;
const AMBER_HOT = 0xfff4d6;
const CYAN = 0x7fe6ff;

const CAB = { w: 0.34, h: 0.11, d: 0.17 };
const ANT = { x: 0.155, len: 0.50, r: 0.006 };
const LOOP = { x: -0.205, r: 0.09, tube: 0.006 };
const METER_SEGMENTS = 9;

function additive(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color, opacity,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
}

function lineMat(color, opacity) {
  return new THREE.LineBasicMaterial({
    color, opacity,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
}

/** Circle in the XZ plane, as a LineLoop. */
function ringGeometry(radius, segments = 56) {
  const points = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

export function createTheremin(config) {
  const group = new THREE.Group();

  // ---- cabinet -----------------------------------------------------------
  const cabGeo = new THREE.BoxGeometry(CAB.w, CAB.h, CAB.d);
  group.add(new THREE.Mesh(cabGeo, additive(AMBER, 0.6)));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(cabGeo), lineMat(AMBER, 0.9)));

  // two control knobs on the top panel, front edge. The one nearer the pitch
  // antenna (player's right) doubles as a HUD toggle: tap it to show/hide
  // the entire readout panel (note, frequency, level bar, diagnostics).
  const decorKnob = new THREE.Mesh(new THREE.RingGeometry(0.011, 0.015, 20), additive(AMBER, 0.85));
  decorKnob.rotation.x = -Math.PI / 2;
  decorKnob.position.set(-0.055, CAB.h / 2 + 0.001, 0.035);
  group.add(decorKnob);

  const hudKnob = new THREE.Mesh(new THREE.RingGeometry(0.011, 0.015, 20), additive(AMBER, 0.85));
  hudKnob.rotation.x = -Math.PI / 2;
  hudKnob.position.set(0.015, CAB.h / 2 + 0.001, 0.035);
  group.add(hudKnob);

  // ---- pitch antenna (player's right) ------------------------------------
  const antennaBaseY = CAB.h / 2;
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(ANT.r, ANT.r, ANT.len, 8),
    additive(AMBER_HOT, 0.95)
  );
  antenna.position.set(ANT.x, antennaBaseY + ANT.len / 2, 0);
  group.add(antenna);

  const halo = new THREE.Mesh(
    new THREE.CylinderGeometry(ANT.r * 5, ANT.r * 5, ANT.len, 8),
    additive(AMBER, 0.1)
  );
  halo.position.copy(antenna.position);
  group.add(halo);

  // the bead rides up the rod with the note — the main pitch feedback
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0115, 12, 10), additive(AMBER_HOT, 0.4));
  bead.position.set(ANT.x, antennaBaseY, 0);
  group.add(bead);

  // ---- volume loop (player's left) ---------------------------------------
  const loop = new THREE.Mesh(
    new THREE.TorusGeometry(LOOP.r, LOOP.tube, 6, 36),
    additive(CYAN, 0.95)
  );
  loop.rotation.x = -Math.PI / 2;
  loop.position.set(LOOP.x, CAB.h / 2, 0);
  group.add(loop);

  const stemLength = (LOOP.x + LOOP.r) - (-CAB.w / 2);
  if (stemLength > 0.005) {
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(LOOP.tube, LOOP.tube, stemLength, 6),
      additive(CYAN, 0.8)
    );
    stem.rotation.z = Math.PI / 2;
    stem.position.set(-CAB.w / 2 - stemLength / 2 + 0.001, CAB.h / 2, 0);
    group.add(stem);
  }

  // ---- dead-zone bubble: the silent region around the loop centre ----------
  // Volume is the palm's distance to the loop CENTRE, so the silence threshold
  // (nearDistance + deadZone) is a sphere. Drawing it makes the "where does it
  // go quiet" boundary visible; it brightens when a hand is inside it (muted).
  const deadRadius = config.volume.nearDistance + (config.volume.deadZone || 0);
  const deadFill = new THREE.Mesh(
    new THREE.SphereGeometry(deadRadius, 24, 16),
    additive(CYAN, 0.12)
  );
  deadFill.position.set(LOOP.x, CAB.h / 2, 0);
  group.add(deadFill);

  const deadWire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(deadRadius, 12, 8)),
    lineMat(CYAN, 0.30)
  );
  deadWire.position.set(LOOP.x, CAB.h / 2, 0);
  group.add(deadWire);

  const deadZone = { fill: deadFill, wire: deadWire, radius: deadRadius };

  // level ladder above the loop: lit rungs = current amplitude
  const meter = [];
  for (let i = 0; i < METER_SEGMENTS; i++) {
    const rung = new THREE.Mesh(
      new THREE.BoxGeometry(0.034 + i * 0.001, 0.0028, 0.0028),
      additive(CYAN, 0.12)
    );
    rung.position.set(LOOP.x, CAB.h / 2 + 0.035 + i * 0.0165, 0);
    group.add(rung);
    meter.push(rung);
  }

  // ---- field rings -------------------------------------------------------
  // Pitch side only — the volume-distance guide rings have been removed.
  const pitchRings = [];

  if (config.visuals.fieldRings) {
    const pitchCentre = new THREE.Vector3(ANT.x, antennaBaseY + ANT.len * 0.45, 0);
    for (const radius of octaveRadii(config.pitch)) {
      const ring = new THREE.LineLoop(ringGeometry(radius), lineMat(AMBER, 0.16));
      ring.position.copy(pitchCentre);
      ring.userData.radius = radius;
      group.add(ring);
      pitchRings.push(ring);
    }
  }

  // ---- readout -----------------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 210;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const readout = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.144),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  readout.position.set(0, CAB.h / 2 + 0.30, 0);
  group.add(readout);

  const info = {
    note: '—', cents: 0, freq: 0, level: 0,
    pitchHand: false, volumeHand: false, snapped: false
  };
  const diag = { ctx: '?', raw: '?', paused: false, right: 0, left: 0, level: 0, amp: -1, reason: 'init', error: null };
  let readoutClock = 0;
  const readoutPeriod = 1 / Math.max(1, config.visuals.readoutHz);

  function setDiagnostics(next) {
    Object.assign(diag, next);
  }

  function drawReadout() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Single master toggle for the whole panel. Off means genuinely blank —
    // no note, no frequency, no level bar, no diagnostics — not just the
    // debug lines at the bottom.
    if (!config.debug.hud) { texture.needsUpdate = true; return; }

    // note name
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = '600 56px Helvetica, Arial, sans-serif';
    ctx.fillStyle = info.pitchHand ? '#fff4d6' : '#8a6a3c';
    ctx.fillText(info.note, 16, 58);
    const noteWidth = ctx.measureText(info.note).width;

    // cents offset, tucked in beside it
    ctx.font = '400 20px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#e0b169';
    const sign = info.cents > 0 ? '+' : '';
    ctx.fillText(`${sign}${info.cents}c`, 24 + noteWidth, 58);

    // frequency
    ctx.textAlign = 'right';
    ctx.font = '400 22px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#e0b169';
    ctx.fillText(`${info.freq.toFixed(1)} Hz`, w - 16, 34);

    if (info.snapped) {
      ctx.font = '400 15px Helvetica, Arial, sans-serif';
      ctx.fillStyle = '#7fe6ff';
      ctx.fillText('SCALE', w - 16, 58);
    }

    // hairline
    ctx.fillStyle = 'rgba(224,177,105,0.45)';
    ctx.fillRect(16, 74, w - 32, 1);

    // level bar
    ctx.fillStyle = 'rgba(127,230,255,0.22)';
    ctx.fillRect(16, 92, w - 32, 10);
    ctx.fillStyle = info.volumeHand ? '#7fe6ff' : '#3f6f80';
    ctx.fillRect(16, 92, (w - 32) * clamp01(info.level), 10);

    // hand status, only when something is missing
    ctx.textAlign = 'left';
    ctx.font = '400 16px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#ff9a7a';
    if (!info.pitchHand && !info.volumeHand) ctx.fillText('both hands out of view', 16, 132);
    else if (!info.pitchHand) ctx.fillText(`${config.pitch.hand} hand out of view`, 16, 132);
    else if (!info.volumeHand) ctx.fillText(`${config.volume.hand} hand out of view`, 16, 132);

    // diagnostics: there is no console on your face
    ctx.font = '400 14px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#8fbfa0';
    ctx.fillText(
      `${diag.ctx}/${diag.raw} · R${diag.right}/L${diag.left} · ${diag.reason}`,
      16, 162
    );
    // asked-for gain vs the value the AudioParam actually holds
    ctx.fillText(
      `want ${diag.level.toFixed(2)} · amp ${diag.amp < 0 ? '-' : diag.amp.toFixed(2)}${diag.paused ? ' · PAUSED' : ''}`,
      16, 180
    );
    if (diag.error) {
      ctx.fillStyle = '#ff9a7a';
      ctx.fillText(String(diag.error).slice(0, 44), 16, 198);
    }

    texture.needsUpdate = true;
  }

  drawReadout();

  // ---- world-space accessors --------------------------------------------
  const localPitchA = new THREE.Vector3(ANT.x, antennaBaseY, 0);
  const localPitchB = new THREE.Vector3(ANT.x, antennaBaseY + ANT.len, 0);
  const localVolume = new THREE.Vector3(LOOP.x, CAB.h / 2, 0);
  const localHudKnob = hudKnob.position.clone();
  const _camPos = new THREE.Vector3();
  const _selfPos = new THREE.Vector3();

  function syncMatrices() { group.updateMatrixWorld(true); }
  function getPitchAxis(a, b) {
    a.copy(localPitchA).applyMatrix4(group.matrixWorld);
    b.copy(localPitchB).applyMatrix4(group.matrixWorld);
  }
  function getVolumeCentre(target) {
    target.copy(localVolume).applyMatrix4(group.matrixWorld);
  }
  function getHudKnobPosition(target) {
    target.copy(localHudKnob).applyMatrix4(group.matrixWorld);
  }
  function getCentre(target) {
    return target.setFromMatrixPosition(group.matrixWorld);
  }

  // ---- per-frame state --------------------------------------------------
  function setPitchState(t, freq, note, cents, distance, tracked, snapped) {
    bead.position.y = antennaBaseY + clamp01(t) * ANT.len;
    bead.material.opacity = tracked ? 0.65 : 0.35;
    halo.material.opacity = tracked ? 0.1 + clamp01(t) * 0.18 : 0.05;
    antenna.material.opacity = tracked ? 0.95 : config.visuals.dimWhenIdle;

    for (const ring of pitchRings) {
      const near = Math.abs(distance - ring.userData.radius);
      ring.material.opacity = tracked ? (near < 0.035 ? 0.65 : 0.16) : 0.08;
    }

    info.note = note;
    info.cents = cents;
    info.freq = freq;
    info.pitchHand = tracked;
    info.snapped = snapped;
  }

  function setVolumeState(level01, distance, tracked) {
    const lit = Math.round(clamp01(level01) * METER_SEGMENTS);
    for (let i = 0; i < METER_SEGMENTS; i++) {
      meter[i].material.opacity = i < lit ? 0.9 : 0.12;
    }
    loop.material.opacity = tracked ? 0.95 : config.visuals.dimWhenIdle;

    // Dead-zone bubble: brighten while the hand is inside it (i.e. muted).
    const insideDead = tracked && distance <= deadZone.radius;
    deadZone.fill.material.opacity = 0; //insideDead ? 0.30 : 0.12;
    deadZone.wire.material.opacity = 0 //;insideDead ? 0.70 : 0.30;

    info.level = clamp01(level01);
    info.volumeHand = tracked;
  }

  /** Billboard the readout (yaw only, so it never tips) and refresh the canvas. */
  function update(dt, camera) {
    readoutClock += dt;
    if (readoutClock >= readoutPeriod) {
      readoutClock = 0;
      drawReadout();
    }

    camera.getWorldPosition(_camPos);
    readout.getWorldPosition(_selfPos);
    const yaw = Math.atan2(_camPos.x - _selfPos.x, _camPos.z - _selfPos.z);
    readout.rotation.set(0, yaw - group.rotation.y, 0);

    // Lit when the HUD is on, dim when off — the knob is its own on/off
    // indicator.
    hudKnob.material.color.setHex(config.debug.hud ? AMBER_HOT : AMBER);
    hudKnob.material.opacity = config.debug.hud ? 1 : 0.85;
  }

  function dispose() {
    group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        if (object.material.map) object.material.map.dispose();
        object.material.dispose();
      }
    });
  }

  return {
    group,
    syncMatrices,
    getPitchAxis,
    getVolumeCentre,
    getHudKnobPosition,
    getCentre,
    setPitchState,
    setVolumeState,
    setDiagnostics,
    update,
    dispose
  };
}

/**
 * createAudioPrompt — a head-locked panel that asks for the gesture Web Audio
 * needs. Browsers only allow an AudioContext to start from a user activation,
 * and a call from the render loop doesn't count. WebXR `select` events do, so
 * the whole audio graph waits for a pinch and is built inside that handler.
 */
export function createAudioPrompt(config) {
  const group = new THREE.Group();
  group.visible = false;

  const W = 0.26;
  const H = 0.085;

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 168;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  group.add(panel);

  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-W / 2, -H / 2, 0), new THREE.Vector3(W / 2, -H / 2, 0),
      new THREE.Vector3(W / 2, H / 2, 0), new THREE.Vector3(-W / 2, H / 2, 0)
    ]),
    lineMat(AMBER, 0.9)
  );
  group.add(border);

  let title = 'PINCH TO START AUDIO';
  let detail = 'pinch anywhere \u2014 thumb to index';

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';

    ctx.font = '600 44px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#fff4d6';
    ctx.fillText(title, canvas.width / 2, 74);

    ctx.font = '400 24px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#e0b169';
    ctx.fillText(detail, canvas.width / 2, 120);

    texture.needsUpdate = true;
  }
  draw();

  function setMessage(nextTitle, nextDetail) {
    title = nextTitle;
    detail = nextDetail || '';
    draw();
  }

  function show() { group.visible = true; }
  function hide() { group.visible = false; }

  const _camPos = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _inv = new THREE.Matrix4();
  const _local = new THREE.Vector3();
  let pulse = 0;

  /** Head-locked so it's always findable, lerped so it isn't nailed to the face. */
  function update(dt, camera) {
    if (!group.visible) return;

    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camDir);
    _target.copy(_camPos).addScaledVector(_camDir, 0.55);

    group.position.lerp(_target, Math.min(1, dt * 6));
    group.lookAt(_camPos);

    pulse += dt * 2.4;
    border.material.opacity = 0.55 + Math.sin(pulse) * 0.35;
  }

  /** Fingertip hit test, for poking the panel instead of pinching. */
  function containsPoint(point) {
    if (!group.visible) return false;
    _inv.copy(group.matrixWorld).invert();
    _local.copy(point).applyMatrix4(_inv);
    return Math.abs(_local.x) < W / 2 && Math.abs(_local.y) < H / 2 && Math.abs(_local.z) < 0.04;
  }

  function dispose() {
    group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        if (object.material.map) object.material.map.dispose();
        object.material.dispose();
      }
    });
  }

  return { group, show, hide, setMessage, update, containsPoint, dispose };
}

