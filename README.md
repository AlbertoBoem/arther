# ARTHER: a WebXR theremin for Spectacles

A WebXR Augmented Reality (AR) theremin, designed especially for [Snapchat Spectacles]([https://developers.snap.com/spectacles/about-spectacles-features/webxr](https://developers.snap.com/spectacles/about-spectacles-features/webxr)). 

Right hand controls pitch, left hand controls volume.

Try it on you Spectacles web browser or any WebXR-compatible device (should be compatible with hand tracking).

**[ARTher: a WebXR theremin for Spectacles](https://albertoboem.github.io/arther/)**

The so-called Theremin is one of the earliest electronic instruments, developed around 1920 by Lev Sergeyevich Termen in USSR. What makes this instrument it unique is that you play it without touching it, two antennas sense the position of your hands in the air: one controls the frequency of the note (how high or low the note is), the other controls amplitude of the note. Moving your hand closer to the pitch antenna raises the note; moving it away from the volume antenna raises the loudness. 

For me, the Theremin embodies and prefigures all the possibilities of interactive music systems we will see booming after WWII. 

If you want to know more about Termen and his invention(s) check the following book:

```bash
   Andrey Smirnov. Sound in Z – Experiments In Sound And Electronic Music in Early 20th Century Russia. König Books Ltd / Sound And Music, ISBN-13: 978-3865607065, 96 pages, 2013, English.
```

ARTHER reimagines the theremin as a WebXR app for Snapchat Spectacles. A virtual theremin is placed in front of you in your room, and real hand tracking replaces the antennas: your right hand's distance from the pitch rod controls the note, your left hand's distance from the volume loop controls the loudness. No physical instrument, no controllers, just your hands and the room around you.

## Built with

- Three.js
- WebXR Device API
- Web Audio API

## Test locally

1. **Serve the folder.** From the project root:
```bash
   cd arther
   python3 -m http.server 8000
```

   This serves the app at `http://localhost:8000`, but that's HTTP only —
   fine for a desktop browser, not for a WebXR session on Spectacles.
 
2. **Tunnel it over HTTPS with [ngrok](https://ngrok.com/).** In a second
   terminal:
```bash
   ngrok http 8000
```
 
   ngrok prints a public `https://...ngrok-free.app` URL that forwards to
   your local server. That's the link to open on the headset.
 
3. **Shorten it for easy sharing with [hmd.link](https://hmd.link/).**
   Paste the ngrok URL in to get a short link that's easier to type or
   share for a quick test.
   
Note that ngrok free-tier URL changes every time you restart the tunnel,
and the tunnel only stays up while your local server and `ngrok` are both
running — it's meant for quick tests, not a permanent link. 

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
