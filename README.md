# Meshy Dance

Rig a Meshy humanoid with the **Meshy Rigging API**, then make it dance in the browser to the
**transients and beat** of any music: a song file, the microphone, or a built-in demo groove.

```
music ──▶ Web Audio ──▶ spectral-flux onsets (kick / snare / hats)
                    └─▶ novelty autocorrelation ──▶ BPM + beat phase (PLL)
                                                        │
rigged GLB ──▶ bone map (Mixamo / Meshy / VRM / UE / Rigify names, structural fallback)
                                                        ▼
                                     Dancer: move library (beat-phase driven) + spring hits
                                     applied as world-axis rotations on top of rest pose / clip
```

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

The app opens with a procedural mannequin. Click **Demo beat** to see it dance, or:

- **Load rigged GLB** – a Meshy rigged character (`rigged_character_glb_url`) or any humanoid rig.
- **Load song** / **Microphone** – any audio file, or live input (mic is analysed, not monitored).
- Drag & drop `.glb` and audio files anywhere on the page.
- `?model=/path.glb&audio=/song.mp3` query params load files from `public/`.

## Rigging a Meshy model

### Option A – in the app
Copy `.env.example` to `.env`, set `MESHY_API_KEY`, run `npm run dev`. In the **Rig with Meshy**
panel paste a public `.glb` URL or a Meshy task id (Text-to-3D / Image-to-3D output), press
**Rig & load**. The dev server proxies `/api/meshy/*` to `https://api.meshy.ai` and injects the key,
so the key never reaches the browser. Basic animations (walking / running) are pulled in as clips, and
**Add Meshy animation** applies an `action_id` from Meshy's animation library to the same rig.

### Option B – CLI
```bash
npm run rig -- --model ./character.glb --height 1.7           # local file (sent as data URI)
npm run rig -- --task-id <meshy_task_id> --animate 5,12        # rig a Meshy task + library actions
npm run rig -- --model-url https://.../character.glb --dry-run # print the request only
```
Output lands in `output/<rig_task_id>/` (`rigged.glb`, basic animations, `action_<id>.glb`, `task.json`).
Copy a GLB into `public/` and open `http://localhost:5173/?model=/rigged.glb`.

Meshy auto-rigging expects a textured, bipedal humanoid in a clear A/T-pose with distinct limbs.

## How the dancing works

**Audio** (`src/audio/`)
- `OnsetDetector` – per-band positive spectral flux (low 30–160 Hz = kick, mid = snare/clap,
  high = hats) against an adaptive mean + k·σ threshold with per-band refractory periods.
- `BeatTracker` – a 100 Hz novelty curve is autocorrelated over the last 8 s; candidate periods are
  scored with harmonic support (P, 2P, 3P, 4P), a subharmonic penalty and a weak log-tempo prior.
  Phase is a free-running clock nudged by onsets near predicted beats, re-phased to the
  strength-weighted maximum so hats on the off-beat can't capture it.
- Analysis runs on its own 120 Hz timer, independent of the render loop, so transient timing stays
  accurate when rendering is slow. Events are accumulated and consumed once per frame.
- `AudioFeatures` is the contract the dancer consumes: `rms`, `bands`, `onsets`, `strength`,
  `bpm`, `phase`, `beat`, `beatIndex`, `confidence`, `locked`.

**Rig** (`src/rig/`)
- `BoneMap` resolves 22 canonical humanoid slots from bone names (Mixamo `mixamorig:LeftForeArm`,
  Meshy / Unity `LeftLowerArm`, VRM `J_Bip_L_UpperArm`, Unreal `lowerarm_l`, Rigify `DEF-forearm.L`,
  Character Creator…), with a topology + world-position fallback for unnamed skeletons. Open
  **Bone map** in the UI to see what resolved and how.
- `Moves` are pure functions of the beat clock (`b`, `phase`, 2- and 4-beat oscillators) and
  energy that write a numeric pose, so they cross-fade by linear blending. Moves switch every
  N beats (default 8), picked by energy level.
- `Dancer` layers: base (rest pose, or an animation clip time-locked to the beat clock) → move →
  transient springs (kick → hips drop & knee squash, snare → arm pump & head nod, hats → shoulder
  shimmy). All rotations are applied about **world axes** converted into each bone's parent space,
  and limb swings are computed from the limb's current direction, so the same choreography works
  regardless of how a rig orients its local bone axes.

**Clips.** If the GLB (or an added animation GLB) has clips, pick one under **Dance → Clip**.
With *Lock to beat* on, clip time is driven directly from the beat clock (`beats/loop` sets how many
beats one loop spans), and *Procedural on top* blends the transient hits over it.

## Controls

| Control | Effect |
| --- | --- |
| Intensity | Overall amplitude of moves |
| Hit response | Strength of transient impulses |
| Smoothing | Pose smoothing time constant (lower = snappier) |
| Auto moves / move | Energy-driven move switching, or pin one move |
| Tempo override | Force a BPM (phase still locks to onsets) |
| ½× / 2× | Correct octave-ambiguous tempos (half-time / double-time) |

## Tests

```bash
npm test
```
Node tests cover the DSP (synthetic spectra at several tempos, including a syncopated groove),
bone-name classification across conventions, structural fallback, the dancer (kick drops hips,
"raise" moves a forearm up in world space on a real skeleton, return to idle), clip beat-sync,
and the CLI request builder.

## Layout
```
index.html, src/main.js, src/style.css     app shell & UI wiring
src/audio/dsp.js                           EnvelopeFollower, Spring, OnsetDetector, BeatTracker
src/audio/AudioAnalyzer.js                 Web Audio front-end + DemoBeat drum machine
src/rig/BoneMap.js                         humanoid slot resolution
src/rig/Moves.js, src/rig/Dancer.js        choreography + skeleton driver
src/viewer/Scene.js, Mannequin.js          Three.js scene, procedural fallback humanoid
src/meshyClient.js, vite.config.js         Meshy API client + key-injecting dev proxy
scripts/meshy-rig.mjs                      Meshy Rigging / Animation CLI
test/                                      node --test suites
```
