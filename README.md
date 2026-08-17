# ARTHER: a WebXR theremin for Spectacles

A hand-tracked theremin built with WebXR + Three.js, designed for Snapchat
Spectacles. Right hand controls pitch, left hand controls volume.

## Running it

This is a static site with no build step, but it must be served over HTTP(S)
— opening `index.html` via `file://` will not work because the app uses ES
module imports.

- **Locally:** `npx serve .` (or any static file server) from this folder.
- **On the web:** enable GitHub Pages for this repo (Settings → Pages →
  Deploy from branch → `main` / `/ (root)`). Pages serves over HTTPS, which
  WebXR requires.

## File layout

- `index.html` — markup, styles, and a small inline diagnostics script
- `config.js` — every tunable number (distances, thresholds, timings)
- `mapping.js` — pure functions turning hand distance into pitch/volume
- `hands.js` — WebXR hand tracking, resolved by handedness
- `thereminModel.js` — the visible instrument (Three.js scene objects)
- `thereminAudio.js` — the audio graph (raw Web Audio, no Tone.js)
- `main.js` — session lifecycle, render loop, gesture handling, `boot()`
- `three.module.js` — Three.js, vendored locally (imported by relative path,
  no import map needed)
