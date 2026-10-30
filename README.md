# Meshy Dance

Make any **Meshy humanoid** dance to music — live in the browser, or **baked into a GLB animation
clip** you drop into Unity, Unreal, Godot, three.js or Babylon.

```
music ──▶ onsets (kick / snare / hats) + beat tracker (BPM, phase)
                       │
rigged GLB ──▶ humanoid bone map ──▶ Dancer: beat-phase moves + transient springs
                       │
          live three.js viewer  ─or─  bake → .glb with a "Dance" AnimationClip
```

**Live demo:** enable GitHub Pages on this repo and the `pages.yml` workflow publishes `dist/`
(see [DISTRIBUTION.md](DISTRIBUTION.md)).

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173
```

The app opens with a procedural mannequin. Press **Demo beat**, or drop a rigged `.glb` and a
song onto the page. `?model=/x.glb&audio=/song.mp3` loads files from `public/`.

## 1. Rig a Meshy model

| | |
| --- | --- |
| **In the app** | Copy `.env.example` → `.env`, set `MESHY_API_KEY`, `npm run dev`. In **Rig with Meshy**, paste a public `.glb` URL or a Meshy task id and press **Rig & load**. The dev server proxies `/api/meshy/*` to `api.meshy.ai` and injects the key, so it never reaches the browser. Walking/running clips come along; **Add Meshy animation** applies a library `action_id`. |
| **CLI** | `npm run rig -- --model ./char.glb` (local file → data URI), `--model-url https://…/char.glb`, or `--task-id <meshy_task_id>`; add `--animate 5,12` for library actions, `--dry-run` to print the request. Output: `output/<rig_task_id>/rigged.glb` + animations + `task.json`. |

| **Generate one** | `node scripts/meshy-generate.mjs --prompt "stylized humanoid dancer, hoodie and sneakers"` runs Text-to-3D preview → refine with `pose_mode: a-pose` and downloads `output/<refine_id>/model.glb`; then `npm run rig -- --task-id <refine_id>`. |

Meshy auto-rigging wants a textured bipedal humanoid in a clear A/T-pose with distinct limbs,
facing +Z. Behind a corporate proxy, run the Node scripts (and `npm run dev`) with
`NODE_USE_ENV_PROXY=1` so `fetch` honours `HTTPS_PROXY`.
Any other humanoid rig works too (Mixamo, VRM, Unreal mannequin, Rigify, Character Creator…).

## 2. Dance live

Load the rigged GLB and a song (or microphone, or the demo beat). Controls: intensity, hit
response, smoothing, auto/pinned moves, tempo override, ½×/2× for octave-ambiguous tempos. If
the GLB has clips, pick one; with *Lock to beat* the clip's time is driven straight from the beat
clock (`beats/loop`), and *Procedural on top* layers the transient hits over it.

## 3. Bake for your game

**In the app:** load the model and a song file, press **Bake dance → GLB**. The whole track is
analysed offline, the rig is danced through it deterministically and a `.glb` downloads with a
`Dance_<song>` clip (plus the loaded clips, optionally). Materials and textures are kept.

**CLI (batch, no browser):**
```bash
npm run bake -- --model output/<id>/rigged.glb --audio song.mp3 --out dancer.glb \
    [--fps 30] [--max 300] [--intensity 1.2] [--hit 1] [--seed 7] [--move bounce]
```
`.wav` is read directly; other formats are decoded with ffmpeg. The clip is injected into the
original GLB bytes with gltf-transform, so nothing else in the file changes.

**In the engine:** import the GLB, play clip `Dance` and start the song at the same moment.
The clip is 30 fps linear keyframes on the humanoid bones (rotation, plus hips translation), so it
retargets like any other humanoid animation. The scene `extras.meshyDance` block records the
song name, BPM, fps and seed.

| Engine | Notes |
| --- | --- |
| Unity | Import GLB with [glTFast](https://github.com/atteneder/glTFast) or UnityGLTF; the clip appears as an AnimationClip. Humanoid rigs can retarget it via Avatar. Start `AudioSource.Play()` and `Animator.Play("Dance")` in the same frame. |
| Unreal | glTF import (built-in plugin) → Skeletal Mesh + Animation Sequence. Play with an Anim Montage / Sequence Player alongside the sound cue. |
| Godot 4 | Drag the GLB in; the `AnimationPlayer` gets `Dance`. Play it with the `AudioStreamPlayer`. |
| three.js / Babylon / PlayCanvas | Load the GLB, `mixer.clipAction(clips.find(c => c.name === 'Dance')).play()` as the audio starts. |

For music that changes at runtime (player-chosen tracks), use the live runtime instead (below).

## 4. Use the runtime in a three.js game

```bash
npm run build:lib        # dist-lib/meshy-dance.js (ESM, three.js as peer dependency)
```
```js
import { AudioAnalyzer, buildBoneMap, Dancer } from 'meshy-dance';

const analyzer = new AudioAnalyzer();
await analyzer.playFile('/music/track.mp3');          // or useMicrophone(), or your own <audio>
const dancer = new Dancer(gltf.scene, buildBoneMap(gltf.scene));
dancer.params.intensity = 1.2;

function frame(dt) {
  dancer.update(analyzer.update(), dt);               // after your mixer.update(dt), if any
}
```
`Dancer` only touches the bones it mapped and applies rotations about world axes, so it layers on
top of your own locomotion clips (`setClip`, `proceduralWeight`). `AudioFeatures` (rms, bands,
onsets, bpm, phase, beat…) are also handy for lights and VFX.

## How it works

- **OnsetDetector** – per-band positive spectral flux (kick 30–160 Hz, snare/clap mid, hats high)
  against an adaptive mean + k·σ threshold with per-band refractory periods.
- **BeatTracker** – autocorrelation of a 100 Hz novelty curve over the last 8 s with harmonic
  support (P, 2P, 3P, 4P), a subharmonic penalty, a weak log-tempo prior, continuity + vote-based
  switching so a syncopated bar can't flip the tempo, and a minimum-onset guard so ambient
  material reports *no beat* instead of noise. Phase is a PLL nudged by onsets near predicted
  beats, re-phased to the strength-weighted maximum.
- Live analysis runs on a 120 Hz timer independent of rendering; offline analysis uses the same
  `FeaturePipeline` on our own STFT, so live and baked dances see identical features.
- **BoneMap** – 22 humanoid slots from names (Mixamo, Meshy/Unity, VRM, Unreal, Rigify, CC…) with
  a topology + world-position fallback (CesiumMan's `arm_joint_L_2`-style rigs resolve 20/22).
- **Moves** – pure functions of the beat clock and energy writing a numeric pose, cross-faded on
  switches, chosen by energy. **Dancer** layers rest/clip → move → springs (kick: hips drop +
  knee squash; snare: arm pump + nod; hats: shoulder shimmy) in world axes.

Verified in this repo on three.js' Mixamo-rigged *Xbot* and *Soldier*, Khronos' *CesiumMan*
and *RiggedFigure*, and the *Bad Cat* / *j_s_song* tracks from the three.js examples (real
music: steady 140 BPM lock on 86% of a 4-minute track; the ambient track correctly yields no
beat and falls back to transient-only motion).

## Tests
```bash
npm test
```
DSP on synthetic spectra (several tempos, a syncopated groove), bone-name classification across
conventions, structural fallback, dancer behaviour on a real skeleton, clip beat-sync, offline
analysis + backfill, deterministic baking, GLB export, CLI request builder and the bake CLI
end to end.

## Layout
```
index.html, src/main.js, src/style.css      demo app & UI
src/lib.js                                  library entry (npm run build:lib)
src/audio/dsp.js                            EnvelopeFollower, Spring, OnsetDetector, BeatTracker
src/audio/pipeline.js, offline.js, fft.js   FeaturePipeline, offline STFT analysis, timeline replay
src/audio/AudioAnalyzer.js                  Web Audio front-end + DemoBeat drum machine
src/rig/BoneMap.js, Moves.js, Dancer.js     humanoid slots, choreography, skeleton driver
src/rig/Baker.js                            DanceRecorder, bakeDance, exportGlb
src/viewer/Scene.js, Mannequin.js           three.js scene, procedural fallback humanoid
src/meshyClient.js, vite.config.js          Meshy API client + key-injecting dev proxy
scripts/meshy-rig.mjs, scripts/bake.mjs     Meshy rigging CLI, bake CLI
.github/workflows                           CI (tests + builds) and GitHub Pages deploy
```

MIT © Serafin Sanchez. Sample models/music used for testing are not redistributed here.
