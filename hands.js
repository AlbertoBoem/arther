import * as THREE from './three.module.js';

/**
 * hands.js — WebXR hand tracking, resolved by handedness rather than index.
 *
 * renderer.xr.getHand(0) is NOT reliably the left hand. Three.js dispatches a
 * 'connected' event carrying the XRInputSource, which does tell us, so we map
 * from that and only fall back to index order if the runtime stays silent.
 *
 * The hand spaces are added to the scene with an identity transform, which
 * means joint.position is already in world (reference) space — no conversion.
 */
// Averaging these three gives a much steadier "hand position" than the wrist
// alone, and it doesn't wobble when the fingers curl.
const PALM_JOINTS = ['wrist', 'index-finger-metacarpal', 'pinky-finger-metacarpal'];

// Full joint list, kept here so you can reach for any of them later.
const HAND_JOINTS = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'
];

function makeSide(name) {
  return {
    name,
    tracked: false,
    everSeen: false,          // distinct from "lost": never arrived at all
    lostForMs: Infinity,
    palm: new THREE.Vector3(),
    indexTip: new THREE.Vector3(),
    thumbTip: new THREE.Vector3(),
    pinchDistance: Infinity,
    pinching: false,
    jointCount: 0
  };
}

export function createHandTracking(renderer, scene, config) {
  const spaces = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
  spaces.forEach(space => scene.add(space));

  const declared = [null, null];
  spaces.forEach((space, i) => {
    space.addEventListener('connected', (event) => {
      const source = event && event.data;
      declared[i] = source && source.handedness ? source.handedness : null;
    });
    space.addEventListener('disconnected', () => { declared[i] = null; });
  });

  const sides = { left: makeSide('left'), right: makeSide('right') };
  const accum = new THREE.Vector3();

  function sideFor(i) {
    const mine = declared[i];
    if (mine === 'left' || mine === 'right') return mine;
    const other = declared[1 - i];
    if (other === 'left') return 'right';
    if (other === 'right') return 'left';
    return i === 0 ? 'left' : 'right';
  }

  // Three.js sets joint.visible = false when the runtime returns no pose.
  const posed = (joint) => !!joint && joint.visible !== false;

  function update(dtMs) {
    const seen = { left: false, right: false };

    for (let i = 0; i < 2; i++) {
      const joints = spaces[i] && spaces[i].joints;
      if (!joints) continue;

      const side = sides[sideFor(i)];
      const indexTip = joints['index-finger-tip'];
      const thumbTip = joints['thumb-tip'];

      accum.set(0, 0, 0);
      let n = 0;
      for (const name of PALM_JOINTS) {
        const joint = joints[name];
        if (posed(joint)) { accum.add(joint.position); n++; }
      }

      if (n === 0 && !posed(indexTip)) continue;   // hand object exists but no poses yet

      if (n > 0) side.palm.copy(accum.divideScalar(n));
      else side.palm.copy(indexTip.position);

      if (posed(indexTip)) side.indexTip.copy(indexTip.position);
      if (posed(thumbTip)) side.thumbTip.copy(thumbTip.position);

      side.pinchDistance = (posed(indexTip) && posed(thumbTip))
        ? side.indexTip.distanceTo(side.thumbTip)
        : Infinity;
      side.pinching = side.pinchDistance < config.gestures.pinchThreshold;
      side.jointCount = n;

      seen[side.name] = true;
    }

    for (const key of ['left', 'right']) {
      const side = sides[key];
      if (seen[key]) {
        side.tracked = true;
        side.everSeen = true;
        side.lostForMs = 0;
      } else {
        side.tracked = false;
        side.pinching = false;
        side.lostForMs += dtMs;
      }
    }
  }

  /** Read any joint's world position, e.g. joint('right', 'middle-finger-tip', v) */
  function joint(sideName, jointName, target) {
    for (let i = 0; i < 2; i++) {
      if (sideFor(i) !== sideName) continue;
      const joints = spaces[i] && spaces[i].joints;
      const found = joints && joints[jointName];
      if (posed(found)) return target.copy(found.position);
    }
    return null;
  }

  return {
    update,
    joint,
    spaces,
    left: sides.left,
    right: sides.right,
    get(sideName) { return sides[sideName]; }
  };
}

