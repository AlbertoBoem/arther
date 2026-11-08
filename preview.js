import * as THREE from './three.module.js';
import { CONFIG } from './config.js';
import { clamp01, frequencyFor, describeFrequency } from './mapping.js';
import { createTheremin } from './thereminModel.js';

/**
 * preview.js — a flat-screen look at the model, no headset needed.
 *
 * The background is black because black is what Spectacles show as
 * see-through, so this is roughly what floats in the room. The hands are
 * faked with slow sweeps so the bead and level meter move. Drag to turn,
 * scroll to zoom, H toggles the readout, T the drone lamp, Esc closes.
 *
 * Purely visual: it creates no audio and touches none of main.js's state.
 */
let preview = null;

export function startPreview() {
  if (preview) return;
  const stage = document.getElementById('stage');
  const ui = document.getElementById('preview-ui');
  if (stage) stage.style.display = 'none';
  if (ui) ui.hidden = false;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.classList.add('preview-canvas');
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.02, 20);
  const target = new THREE.Vector3(0, -0.14, 0);
  let distance = 2.75;
  let pitchAngle = 0.3;

  const model = createTheremin(CONFIG);
  if (model.setFloor) model.setFloor(-0.95);
  model.group.rotation.y = 0.5;
  scene.add(model.group);
  scene.add(camera);

  const hudWasOn = CONFIG.debug.hud;
  let droneLamp = true;

  function placeCamera() {
    camera.position.set(0, target.y + Math.sin(pitchAngle) * distance, Math.cos(pitchAngle) * distance);
    camera.lookAt(target);
  }
  placeCamera();

  let dragging = false, lastX = 0, lastY = 0;
  const onDown = (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    model.group.rotation.y += (e.clientX - lastX) * 0.01;
    pitchAngle = Math.min(1.2, Math.max(-0.3, pitchAngle + (e.clientY - lastY) * 0.005));
    lastX = e.clientX; lastY = e.clientY;
    placeCamera();
  };
  const onUp = () => { dragging = false; };
  const onWheel = (e) => {
    e.preventDefault();
    distance = Math.min(4, Math.max(0.6, distance * (1 + e.deltaY * 0.001)));
    placeCamera();
  };
  const onKey = (e) => {
    if (e.key === 'h' || e.key === 'H') CONFIG.debug.hud = !CONFIG.debug.hud;
    if (e.key === 't' || e.key === 'T') droneLamp = !droneLamp;
    if (e.key === 'Escape') stopPreview();
  };
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  const closeButton = document.getElementById('preview-close');
  if (closeButton) closeButton.addEventListener('click', stopPreview, { once: true });

  let t = 0, last = 0;
  renderer.setAnimationLoop((now) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    t += dt;

    const p = clamp01(0.5 + 0.4 * Math.sin(t * 0.55) + 0.06 * Math.sin(t * 2.1));
    const freq = frequencyFor(p, CONFIG.pitch);
    const note = describeFrequency(freq);
    const dist = CONFIG.pitch.farDistance - p * (CONFIG.pitch.farDistance - CONFIG.pitch.nearDistance);
    model.setPitchState(p, freq, note.name, note.cents, dist, true, false);
    model.setVolumeState(clamp01(0.5 + 0.45 * Math.sin(t * 0.9 + 1)), 0.2, true);
    model.setDiagnostics({ reason: 'preview', ctx: 'preview', raw: '-' });
    if (model.setTrackPlaying) model.setTrackPlaying(droneLamp);
    if (model.setHudActive) model.setHudActive(!!CONFIG.debug.hud);
    model.syncMatrices();
    model.update(dt, camera);
    renderer.render(scene, camera);
  });

  preview = { renderer, model, onKey, onResize, ui, stage, hudWasOn };
}

export function stopPreview() {
  if (!preview) return;
  const { renderer, model, onKey, onResize, ui, stage, hudWasOn } = preview;
  renderer.setAnimationLoop(null);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
  model.dispose();
  renderer.dispose();
  if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  if (ui) ui.hidden = true;
  if (stage) stage.style.display = '';
  CONFIG.debug.hud = hudWasOn;
  preview = null;
}
