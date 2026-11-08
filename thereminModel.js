import * as THREE from './three.module.js';
import { clamp01, octaveRadii } from './mapping.js';

/**
 * thereminModel.js — the instrument you see.
 *
 * Modelled on the RCA Theremin (1929), the production version of Léon
 * Theremin's thereminvox: a slant-top lectern cabinet on four tall tapered
 * legs, a nickel pitch rod rising from the back-right corner, and a
 * keyhole-shaped volume loop jutting out of the left side.
 *
 * It is drawn like an old silver-gelatin print, adapted to an additive
 * see-through display. On Spectacles black is transparent, so dark lacquered
 * wood can't be dark: it becomes a dim sepia glow, and the plated metal
 * becomes the bright highlights, the way those 1920s photographs read anyway.
 * Every material goes through one shared shader patch (photoMat) that adds:
 *   - a fixed studio key light, so the cabinet has form without scene lights
 *   - procedural wood figure on the cabinet
 *   - fine film grain, a slow exposure flicker and a soft vignette
 *   - a fade at the foot of the legs, like the soft edge of an old print
 * The cabinet writes depth, so its far edges and the back doors are hidden
 * behind it instead of showing through as wireframe.
 */

// Print palette. Brightness is visibility on an additive display.
const SEPIA_SHADOW = 0x765234;   // lacquered wood (overridden by CONFIG.visuals.photo.woodColor)
const SEPIA_MID = 0x9c7650;      // mouldings, panel lines
const SEPIA_LIGHT = 0xd9b98a;    // lit edges of the woodwork
const NICKEL = 0xf1e3c6;         // plated metal: rod, loop, knobs
const NICKEL_HOT = 0xfff6e2;
const LAMP_GLOW = 0xffd9a0;       // warm filament glow of a lit pilot lamp
// Names the readout, prompt and feedback elements already use.
const AMBER = SEPIA_LIGHT;
const AMBER_HOT = NICKEL_HOT;
const CYAN = 0xe9dfca;           // volume side: a paler, cooler tone of the same print

// Cabinet, in metres. +Z faces the player, +X is the player's right.
// The slanted lid (the music desk) is low at the front and rises to a flat
// strip at the back, where the antenna stands.
const BODY = { w: 0.40, d: 0.26, bottom: -0.36, frontTop: -0.035, slopeBack: -0.075, backTop: 0.065 };
const CAP = 0.008;                               // thickness of the lid and back strip
const PLINTH = { h: 0.035, overhang: 0.012 };    // apron band where the legs join
const LEG = { top: 0.02, bottom: 0.011, inset: 0.032, defaultLength: 0.6, min: 0.3, max: 1.2 };
const ANT = { x: 0.165, z: -0.105, len: 0.50, r: 0.005 };
const LOOP = { x: -0.325, y: -0.005, z: 0.0, r: 0.09, tube: 0.0055, neck: 0.018 };
const METER_SEGMENTS = 9;

// ---- the old-photograph shader patch --------------------------------------
const PHOTO_UNIFORMS = {
  uPhotoTime: { value: 0 },
  uPhotoFlicker: { value: 1 },
  uPhotoGrain: { value: 0.16 },
  uPhotoVignette: { value: 0.55 },
  uPhotoCentre: { value: new THREE.Vector3() }
};

const PHOTO_VERT_PARS = /* glsl */`
varying vec3 vPhotoObj;
varying vec3 vPhotoWorld;
#ifdef PHOTO_LIT
  varying vec3 vPhotoN;
  varying vec3 vPhotoV;
#endif
`;

const PHOTO_VERT = /* glsl */`
vPhotoObj = transformed;
vPhotoWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#ifdef PHOTO_LIT
  vPhotoN = normalize( normalMatrix * normal );
  vPhotoV = -mvPosition.xyz;
#endif
`;

const PHOTO_FRAG_PARS = /* glsl */`
uniform float uPhotoTime;
uniform float uPhotoFlicker;
uniform float uPhotoGrain;
uniform float uPhotoVignette;
uniform vec3 uPhotoCentre;
varying vec3 vPhotoObj;
varying vec3 vPhotoWorld;
#ifdef PHOTO_LIT
  varying vec3 vPhotoN;
  varying vec3 vPhotoV;
#endif
float photoHash( vec2 p ) {
  p = fract( p * vec2( 0.1031, 0.1030 ) );
  p += dot( p, p.yx + 33.33 );
  return fract( ( p.x + p.y ) * p.x );
}
`;

const PHOTO_FRAG = /* glsl */`
{
  float photoK = 1.0;
  #ifdef PHOTO_LIT
    vec3 pn = normalize( vPhotoN );
    vec3 pv = normalize( vPhotoV );
    // Key light from upper left, on the camera side, like a studio flash.
    vec3 pl = normalize( vec3( -0.45, 0.75, 0.5 ) );
    float lam = max( dot( pn, pl ), 0.0 );
    float ndv = clamp( dot( pn, pv ), 0.0, 1.0 );
    #ifdef PHOTO_METAL
      float spec = pow( max( dot( reflect( -pv, pn ), pl ), 0.0 ), 14.0 );
      photoK = 0.38 + 0.45 * lam + 1.6 * spec;
    #else
      photoK = 0.42 + 0.7 * lam + 0.35 * pow( 1.0 - ndv, 3.0 );   // lacquer sheen at grazing angles
    #endif
  #endif
  #ifdef PHOTO_WOOD
    // Vertical figure: changes quickly across a panel, slowly up it.
    vec3 wp = vPhotoObj * 38.0;
    float fig = sin( wp.x * 1.3 + wp.z * 1.3 + sin( wp.y * 0.35 + wp.x * 0.2 ) * 2.4 );
    float fine = sin( wp.x * 7.0 + wp.z * 6.0 + wp.y * 0.25 );
    photoK *= 0.74 + 0.18 * fig + 0.08 * fine;
  #endif
  #ifdef PHOTO_FADE
    photoK *= smoothstep( PHOTO_FADE_LO, PHOTO_FADE_HI, vPhotoObj.y );
  #endif
  // Print vignette: the instrument's extremities fall off a little.
  float pd = length( vPhotoWorld - uPhotoCentre );
  photoK *= mix( 1.0, uPhotoVignette, smoothstep( 0.25, 0.85, pd ) );
  // Film grain, re-rolled every frame.
  float grain = photoHash( floor( gl_FragCoord.xy * 0.75 ) + fract( uPhotoTime * 7.31 ) * 311.0 );
  photoK *= 1.0 + ( grain - 0.5 ) * 2.0 * uPhotoGrain;
  photoK *= uPhotoFlicker;
  // Collapse to luminance and re-tint toward print sepia.
  float lum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
  outgoingLight = mix( outgoingLight, lum * vec3( 1.18, 0.98, 0.74 ), 0.6 ) * photoK;
}
`;

/**
 * Unlit additive material with the photo patch.
 * opts: line, lit (shaded by the key light), metal, wood, fade: [lo, hi]
 * in geometry-local y, solid (writes depth, drawn front-to-back before the rest).
 */
function photoMat(color, opacity, opts = {}) {
  // Solids go in the opaque pass: three sorts that front-to-back, so with
  // depth writes a near panel hides what's behind it. They still blend
  // additively (three only switches blending off for NormalBlending).
  const params = {
    color, opacity,
    transparent: !opts.solid,
    blending: THREE.AdditiveBlending,
    depthWrite: !!opts.solid
  };
  const material = opts.line
    ? new THREE.LineBasicMaterial(params)
    : new THREE.MeshBasicMaterial(params);
  if (opts.solid) {
    // Push faces back a hair so their own edge lines don't z-fight (shimmer).
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
  }

  const defines = {};
  if (!opts.line && (opts.lit || opts.metal || opts.wood)) defines.PHOTO_LIT = '';
  if (opts.metal) defines.PHOTO_METAL = '';
  if (opts.wood) defines.PHOTO_WOOD = '';
  if (opts.fade) {
    defines.PHOTO_FADE = '';
    defines.PHOTO_FADE_LO = opts.fade[0].toFixed(4);
    defines.PHOTO_FADE_HI = opts.fade[1].toFixed(4);
  }
  material.defines = defines;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, PHOTO_UNIFORMS);   // shared objects, one update drives all
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PHOTO_VERT_PARS)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + PHOTO_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PHOTO_FRAG_PARS)
      .replace('#include <opaque_fragment>', PHOTO_FRAG + '\n#include <opaque_fragment>');
  };
  const key = 'photo:' + (opts.line ? 'L' : 'M') + Object.keys(defines).map(k => k + defines[k]).join('|');
  material.customProgramCacheKey = () => key;
  return material;
}

// Plain additive helpers, still used by the audio prompt.
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

/** Rectangle outline in the XY plane, for panel mouldings and door edges. */
function rectGeometry(w, h) {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-w / 2, -h / 2, 0), new THREE.Vector3(w / 2, -h / 2, 0),
    new THREE.Vector3(w / 2, h / 2, 0), new THREE.Vector3(-w / 2, h / 2, 0)
  ]);
}

/** The cabinet as one prism: the side profile (Z, Y) extruded across X. */
function cabinetGeometry() {
  const zf = BODY.d / 2, zb = -BODY.d / 2;
  const shape = new THREE.Shape();
  // Shape x is -Z, because rotateY(+90°) below maps shape x to -Z.
  shape.moveTo(-zf, BODY.bottom);
  shape.lineTo(-zf, BODY.frontTop);
  shape.lineTo(-BODY.slopeBack, BODY.backTop);
  shape.lineTo(-zb, BODY.backTop);
  shape.lineTo(-zb, BODY.bottom);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: BODY.w, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);          // extrusion axis -> +X
  geometry.translate(-BODY.w / 2, 0, 0);
  return geometry;
}

/**
 * The volume loop as on the RCA: a round loop on a narrow neck, both rods
 * entering the side wall. Points are relative to the loop centre, in XZ.
 */
function loopCurve() {
  const r = LOOP.r, h = LOOP.neck;
  const wallX = (-BODY.w / 2 + 0.006) - LOOP.x;     // a little inside the wall
  const th = Math.asin(h / r);
  const neckX = r * Math.cos(th);
  const points = [
    new THREE.Vector3(wallX, 0, h),
    new THREE.Vector3((wallX + neckX) / 2, 0, h)
  ];
  const N = 30;
  for (let i = 0; i <= N; i++) {
    const a = th + (i / N) * (Math.PI * 2 - 2 * th);
    points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  points.push(new THREE.Vector3((wallX + neckX) / 2, 0, -h));
  points.push(new THREE.Vector3(wallX, 0, -h));
  return new THREE.CatmullRomCurve3(points, false, 'centripetal');
}

export function createTheremin(config) {
  const group = new THREE.Group();
  // Uniform size of the instrument. Everything below is modelled in
  // unscaled metres; the hand mapping reads positions through matrixWorld,
  // so the rod, loop and knobs scale with it automatically. Values that are
  // defined in world metres (config distances) are divided by this before
  // they're used as geometry inside the group.
  const modelScale = (config.placement && config.placement.scale) || 1;
  group.scale.setScalar(modelScale);
  const photo = config.visuals.photo || {};
  const woodColor = photo.woodColor !== undefined ? photo.woodColor : SEPIA_SHADOW;
  const woodOpacity = photo.woodOpacity !== undefined ? photo.woodOpacity : 0.9;

  PHOTO_UNIFORMS.uPhotoGrain.value = photo.grain !== undefined ? photo.grain : 0.16;
  PHOTO_UNIFORMS.uPhotoVignette.value = photo.vignette !== undefined ? photo.vignette : 0.55;

  const woodMat = photoMat(woodColor, woodOpacity, { wood: true, solid: true });
  const edgeMat = photoMat(SEPIA_LIGHT, 0.7, { line: true });
  const mouldMat = photoMat(SEPIA_MID, 0.55, { line: true });
  const metalMat = () => photoMat(NICKEL, 0.95, { metal: true });

  function addSolid(geometry, material, edges = true) {
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    if (edges) {
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), edgeMat);
      mesh.add(lines);
    }
    return mesh;
  }

  // ---- cabinet body ------------------------------------------------------
  // Drawn first and writing depth: it hides what's behind it.
  addSolid(cabinetGeometry(), woodMat);

  // slanted lid / music desk, overhanging the sides a touch
  const slopeDZ = BODY.slopeBack - BODY.d / 2;               // negative
  const slopeDY = BODY.backTop - BODY.frontTop;
  const slopeLen = Math.hypot(slopeDZ, slopeDY);
  const slopeAngle = Math.atan2(slopeDY, -slopeDZ);
  const lid = addSolid(new THREE.BoxGeometry(BODY.w + 0.012, CAP, slopeLen + 0.008), woodMat);
  lid.rotation.x = slopeAngle;
  lid.position.set(
    0,
    (BODY.frontTop + BODY.backTop) / 2 + Math.cos(slopeAngle) * CAP / 2,
    (BODY.d / 2 + BODY.slopeBack) / 2 + Math.sin(slopeAngle) * CAP / 2
  );

  // flat strip at the back of the lid, where the antenna stands
  const stripDepth = BODY.d / 2 + BODY.slopeBack + 0.006;
  const strip = addSolid(new THREE.BoxGeometry(BODY.w + 0.012, CAP, stripDepth), woodMat);
  strip.position.set(0, BODY.backTop + CAP / 2, -BODY.d / 2 + stripDepth / 2 - 0.003);

  // the music-rest lip across the bottom of the desk
  const ledge = addSolid(new THREE.BoxGeometry(BODY.w + 0.01, 0.016, 0.014), woodMat);
  ledge.position.set(0, BODY.frontTop + 0.016, BODY.d / 2 - 0.012);

  // apron band at the foot of the cabinet
  const plinth = addSolid(new THREE.BoxGeometry(
    BODY.w + PLINTH.overhang * 2, PLINTH.h, BODY.d + PLINTH.overhang * 2
  ), woodMat);
  plinth.position.y = BODY.bottom - PLINTH.h / 2;

  // ---- legs: tall, square, tapered; they fade out toward the floor -------
  const legGeo = new THREE.CylinderGeometry(LEG.top, LEG.bottom, 1, 4, 1);
  legGeo.rotateY(Math.PI / 4);
  legGeo.translate(0, -0.5, 0);                  // top at 0, foot at -1
  const legEdgesGeo = new THREE.EdgesGeometry(legGeo, 20);
  const legFade = [-1.0, -0.62];
  const legMat = photoMat(woodColor, woodOpacity, { wood: true, fade: legFade, solid: true });
  const legLineMat = photoMat(SEPIA_LIGHT, 0.6, { line: true, fade: legFade });
  const legs = [];
  const legX = BODY.w / 2 + PLINTH.overhang - LEG.inset;
  const legZ = BODY.d / 2 + PLINTH.overhang - LEG.inset;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.add(new THREE.LineSegments(legEdgesGeo, legLineMat));
    leg.position.set(sx * legX, BODY.bottom - PLINTH.h, sz * legZ);
    leg.scale.y = LEG.defaultLength;
    group.add(leg);
    legs.push(leg);
  }

  // ---- panel mouldings ---------------------------------------------------
  const lift = 0.0015;
  const frontH = BODY.frontTop - BODY.bottom;
  const frontPanel = new THREE.LineLoop(rectGeometry(BODY.w - 0.05, frontH - 0.05), mouldMat);
  frontPanel.position.set(0, BODY.bottom + frontH / 2, BODY.d / 2 + lift);
  group.add(frontPanel);

  // the back has a pair of doors, as on the RCA cabinets
  const backH = BODY.backTop - BODY.bottom;
  const doorW = (BODY.w - 0.06) / 2;
  for (const sx of [-1, 1]) {
    const door = new THREE.LineLoop(rectGeometry(doorW, backH - 0.06), mouldMat);
    door.position.set(sx * (doorW / 2 + 0.005), BODY.bottom + backH / 2, -BODY.d / 2 - lift);
    group.add(door);
    const pull = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), metalMat());
    pull.position.set(sx * 0.014, BODY.bottom + backH * 0.55, -BODY.d / 2 - 0.004);
    group.add(pull);
  }

  // side panels: inset frames below the slope
  const sideH = BODY.frontTop - BODY.bottom - 0.05;
  for (const sx of [-1, 1]) {
    const side = new THREE.LineLoop(rectGeometry(BODY.d - 0.05, sideH), mouldMat);
    side.rotation.y = Math.PI / 2;
    side.position.set(sx * (BODY.w / 2 + lift), BODY.bottom + 0.025 + sideH / 2, 0);
    group.add(side);
  }

  // ---- control plate on the front, with two knobs ------------------------
  // Left knob toggles the drone (the old backing-track slot), right knob
  // (nearer the pitch antenna) toggles the readout panel. They sit 8cm apart:
  // with the 3cm touch radius in main.js, one fingertip can't reach both.
  // Each has a small pilot lamp beside it, the on/off indicator: on a sepia
  // print a colour change wouldn't read, a lit lamp does.
  const plateY = BODY.frontTop - 0.07;
  const plateZ = BODY.d / 2 + 0.002;
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.04, 0.004), photoMat(0x2a1e14, 0.6, { lit: true }));
  plate.position.set(0, plateY, plateZ);
  group.add(plate);
  const plateRim = new THREE.LineLoop(rectGeometry(0.15, 0.04), photoMat(NICKEL, 0.8, { line: true }));
  plateRim.position.set(0, plateY, plateZ + 0.0025);
  group.add(plateRim);

  const knobGeo = new THREE.CylinderGeometry(0.0085, 0.0095, 0.012, 18);
  knobGeo.rotateX(Math.PI / 2);
  const trackKnob = new THREE.Mesh(knobGeo, metalMat());
  trackKnob.position.set(-0.04, plateY, plateZ + 0.008);
  group.add(trackKnob);
  const hudKnob = new THREE.Mesh(knobGeo, metalMat());
  hudKnob.position.set(0.04, plateY, plateZ + 0.008);
  group.add(hudKnob);

  // pilot lamps, inboard of each knob
  const lampGeo = new THREE.SphereGeometry(0.0045, 10, 8);
  const lampGlowGeo = new THREE.CircleGeometry(0.011, 20);
  function makeLamp(x) {
    const lamp = new THREE.Mesh(lampGeo, photoMat(NICKEL_HOT, 0.25));
    lamp.position.set(x, plateY, plateZ + 0.004);
    const glow = new THREE.Mesh(lampGlowGeo, photoMat(LAMP_GLOW, 0));
    glow.position.set(0, 0, 0.001);
    lamp.add(glow);
    group.add(lamp);
    return { lamp, glow };
  }
  const trackLamp = makeLamp(-0.014);
  const hudLamp = makeLamp(0.014);
  function setLamp(l, knob, on) {
    l.lamp.material.opacity = on ? 1 : 0.25;
    l.glow.material.opacity = on ? 0.85 : 0;
    knob.material.color.setHex(on ? NICKEL_HOT : NICKEL);
    knob.material.opacity = on ? 1 : 0.75;
  }

  // two small brass screws at the front right, as on the original
  for (const y of [plateY + 0.005, BODY.bottom + 0.06]) {
    const screw = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 8, 6), metalMat());
    screw.position.set(BODY.w / 2 - 0.018, y, BODY.d / 2 + 0.002);
    group.add(screw);
  }

  // ---- pitch antenna (back right corner) ---------------------------------
  const antennaBaseY = BODY.backTop + CAP;

  const insulator = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.013, 0.026, 14),
    photoMat(SEPIA_MID, 0.8, { lit: true })
  );
  insulator.position.set(ANT.x, antennaBaseY + 0.013, ANT.z);
  group.add(insulator);

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(ANT.r, ANT.r, ANT.len, 12),
    metalMat()
  );
  antenna.position.set(ANT.x, antennaBaseY + ANT.len / 2, ANT.z);
  group.add(antenna);

  const tip = new THREE.Mesh(new THREE.SphereGeometry(ANT.r * 1.5, 10, 8), metalMat());
  tip.position.set(ANT.x, antennaBaseY + ANT.len, ANT.z);
  group.add(tip);

  const halo = new THREE.Mesh(
    new THREE.CylinderGeometry(ANT.r * 5, ANT.r * 5, ANT.len, 10, 1, true),
    photoMat(AMBER, 0.03)
  );
  halo.position.copy(antenna.position);
  group.add(halo);

  // the bead rides up the rod with the note — the main pitch feedback
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0115, 14, 10), photoMat(NICKEL_HOT, 0.4, { metal: true }));
  bead.position.set(ANT.x, antennaBaseY, ANT.z);
  group.add(bead);

  // ---- volume loop (left side) -------------------------------------------
  const loop = new THREE.Mesh(
    new THREE.TubeGeometry(loopCurve(), 140, LOOP.tube, 7, false),
    photoMat(CYAN, 0.95, { metal: true })
  );
  loop.position.set(LOOP.x, LOOP.y, LOOP.z);
  group.add(loop);

  // bushings where the loop rods enter the cabinet
  const bushGeo = new THREE.CylinderGeometry(0.0085, 0.0085, 0.012, 12);
  bushGeo.rotateZ(Math.PI / 2);
  for (const sz of [-1, 1]) {
    const bush = new THREE.Mesh(bushGeo, photoMat(SEPIA_MID, 0.8, { lit: true }));
    bush.position.set(-BODY.w / 2 - 0.005, LOOP.y, LOOP.z + sz * LOOP.neck);
    group.add(bush);
  }

  // ---- dead-zone bubble: the silent region around the loop centre ----------
  // Volume is the palm's distance to the loop CENTRE, so the silence threshold
  // (nearDistance + deadZone) is a sphere. Kept for debugging; hidden in play.
  const deadRadius = (config.volume.nearDistance + (config.volume.deadZone || 0)) / modelScale;
  const deadFill = new THREE.Mesh(
    new THREE.SphereGeometry(deadRadius, 24, 16),
    additive(CYAN, 0.12)
  );
  deadFill.position.set(LOOP.x, LOOP.y, LOOP.z);
  group.add(deadFill);

  const deadWire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(deadRadius, 12, 8)),
    lineMat(CYAN, 0.30)
  );
  deadWire.position.set(LOOP.x, LOOP.y, LOOP.z);
  group.add(deadWire);

  const deadZone = { fill: deadFill, wire: deadWire, radius: deadRadius };

  // level ladder above the loop: lit rungs = current amplitude
  const meter = [];
  for (let i = 0; i < METER_SEGMENTS; i++) {
    const rung = new THREE.Mesh(
      new THREE.BoxGeometry(0.034 + i * 0.001, 0.0028, 0.0028),
      photoMat(CYAN, 0.12)
    );
    rung.position.set(LOOP.x, LOOP.y + 0.035 + i * 0.0165, LOOP.z);
    group.add(rung);
    meter.push(rung);
  }

  // ---- field rings -------------------------------------------------------
  // Pitch side only — the volume-distance guide rings have been removed.
  const pitchRings = [];

  if (config.visuals.fieldRings) {
    const pitchCentre = new THREE.Vector3(ANT.x, antennaBaseY + ANT.len * 0.45, ANT.z);
    for (const radius of octaveRadii(config.pitch)) {
      const ring = new THREE.LineLoop(ringGeometry(radius / modelScale), photoMat(AMBER, 0.16, { line: true }));
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
  readout.position.set(0, antennaBaseY + 0.33, -0.02);
  group.add(readout);

  const info = {
    note: '—', cents: 0, freq: 0, level: 0,
    pitchHand: false, volumeHand: false, snapped: false
  };
  const diag = { ctx: '?', raw: '?', paused: false, right: 0, left: 0, level: 0, amp: -1, reason: 'init', error: null };
  let readoutClock = 0;
  const readoutPeriod = 1 / Math.max(1, config.visuals.readoutHz);
  const SERIF = 'Georgia, "Times New Roman", serif';

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
    ctx.font = `italic 600 56px ${SERIF}`;
    ctx.fillStyle = info.pitchHand ? '#fff6e2' : '#8a6a4a';
    ctx.fillText(info.note, 16, 58);
    const noteWidth = ctx.measureText(info.note).width;

    // cents offset, tucked in beside it
    ctx.font = `400 20px ${SERIF}`;
    ctx.fillStyle = '#d9b98a';
    const sign = info.cents > 0 ? '+' : '';
    ctx.fillText(`${sign}${info.cents}c`, 24 + noteWidth, 58);

    // frequency
    ctx.textAlign = 'right';
    ctx.font = `400 22px ${SERIF}`;
    ctx.fillStyle = '#d9b98a';
    ctx.fillText(`${info.freq.toFixed(1)} Hz`, w - 16, 34);

    if (info.snapped) {
      ctx.font = `400 15px ${SERIF}`;
      ctx.fillStyle = '#e9dfca';
      ctx.fillText('SCALE', w - 16, 58);
    }

    // hairline
    ctx.fillStyle = 'rgba(217,185,138,0.45)';
    ctx.fillRect(16, 74, w - 32, 1);

    // level bar
    ctx.fillStyle = 'rgba(233,223,202,0.18)';
    ctx.fillRect(16, 92, w - 32, 10);
    ctx.fillStyle = info.volumeHand ? '#e9dfca' : '#6f6250';
    ctx.fillRect(16, 92, (w - 32) * clamp01(info.level), 10);

    // hand status, only when something is missing
    ctx.textAlign = 'left';
    ctx.font = `italic 400 16px ${SERIF}`;
    ctx.fillStyle = '#e8a77c';
    if (!info.pitchHand && !info.volumeHand) ctx.fillText('both hands out of view', 16, 132);
    else if (!info.pitchHand) ctx.fillText(`${config.pitch.hand} hand out of view`, 16, 132);
    else if (!info.volumeHand) ctx.fillText(`${config.volume.hand} hand out of view`, 16, 132);

    // diagnostics: there is no console on your face
    ctx.font = '400 14px "Courier New", Courier, monospace';
    ctx.fillStyle = '#bfae8e';
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
      ctx.fillStyle = '#e8a77c';
      ctx.fillText(String(diag.error).slice(0, 44), 16, 198);
    }

    texture.needsUpdate = true;
  }

  drawReadout();

  // ---- world-space accessors --------------------------------------------
  const localPitchA = new THREE.Vector3(ANT.x, antennaBaseY, ANT.z);
  const localPitchB = new THREE.Vector3(ANT.x, antennaBaseY + ANT.len, ANT.z);
  const localVolume = new THREE.Vector3(LOOP.x, LOOP.y, LOOP.z);
  const localHudKnob = hudKnob.position.clone();
  const localTrackKnob = trackKnob.position.clone();
  const localPhotoCentre = new THREE.Vector3(0, -0.12, 0);
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
  function getTrackKnobPosition(target) {
    target.copy(localTrackKnob).applyMatrix4(group.matrixWorld);
  }
  function getCentre(target) {
    return target.setFromMatrixPosition(group.matrixWorld);
  }

  /**
   * Stretch the legs down to the floor. floorY is the floor's height relative
   * to the group origin, in world metres (null when the floor is unknown,
   * which keeps the default length).
   */
  function setFloor(floorY) {
    let length = LEG.defaultLength;
    if (photo.legsToFloor !== false && typeof floorY === 'number' && isFinite(floorY)) {
      const wanted = (BODY.bottom - PLINTH.h) - floorY / modelScale;
      length = Math.min(LEG.max, Math.max(LEG.min, wanted));
    }
    for (const leg of legs) leg.scale.y = length;
  }

  // ---- per-frame state --------------------------------------------------
  function setPitchState(t, freq, note, cents, distance, tracked, snapped) {
    bead.position.y = antennaBaseY + clamp01(t) * ANT.len;
    bead.material.opacity = tracked ? 0.75 : 0.4;
    halo.material.opacity = tracked ? 0.02 + clamp01(t) * 0.07 : 0.01;
    antenna.material.opacity = tracked ? 0.95 : Math.max(0.6, config.visuals.dimWhenIdle);

    for (const ring of pitchRings) {
      const near = Math.abs(distance - ring.userData.radius);
      ring.material.opacity = tracked ? (near < 0.035 ? 0.6 : 0.12) : 0.06;
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
      meter[i].material.opacity = i < lit ? 0.85 : 0.1;
    }
    loop.material.opacity = tracked ? 0.95 : Math.max(0.6, config.visuals.dimWhenIdle);

    // Dead-zone bubble stays hidden in play.
    deadZone.fill.material.opacity = 0;
    deadZone.wire.material.opacity = 0;

    info.level = clamp01(level01);
    info.volumeHand = tracked;
  }

  /** Drone on/off, called every frame by main.js. */
  function setTrackPlaying(playing) { setLamp(trackLamp, trackKnob, !!playing); }

  /** Readout panel on/off, called every frame by main.js. */
  function setHudActive(active) { setLamp(hudLamp, hudKnob, !!active); }

  // ---- film flicker ------------------------------------------------------
  let photoClock = 0;
  let dip = 0;
  function updatePhoto(dt) {
    photoClock += dt;
    const amount = photo.flicker !== undefined ? photo.flicker : 0.06;
    const wobble = 0.5 + 0.5 * Math.sin(photoClock * 7.7) * Math.sin(photoClock * 2.3 + 1.1);
    // an occasional quick dip, like a frame that came out a little dark
    if (Math.random() < dt * 0.5) dip = amount * 1.6;
    dip = Math.max(0, dip - dt * 4);
    PHOTO_UNIFORMS.uPhotoTime.value = photoClock;
    PHOTO_UNIFORMS.uPhotoFlicker.value = 1 - amount * wobble - dip;
    PHOTO_UNIFORMS.uPhotoCentre.value.copy(localPhotoCentre).applyMatrix4(group.matrixWorld);
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

    updatePhoto(dt);
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
    getTrackKnobPosition,
    getCentre,
    setFloor,
    setPitchState,
    setVolumeState,
    setTrackPlaying,
    setHudActive,
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

    ctx.font = '600 42px Georgia, "Times New Roman", serif';
    ctx.fillStyle = '#fff6e2';
    ctx.fillText(title, canvas.width / 2, 74);

    ctx.font = 'italic 400 24px Georgia, "Times New Roman", serif';
    ctx.fillStyle = '#d9b98a';
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