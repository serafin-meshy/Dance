# Contributing

Thanks for helping make Meshy characters dance.

## Dev loop
```bash
npm install
npm run dev        # app at http://localhost:5173 (press "Demo beat" to see motion without assets)
npm test           # node --test: DSP, bone map, dancer, baker, CLIs
npm run build      # demo -> dist/        npm run build:lib -> dist-lib/meshy-dance.js
```
Sample rigs for manual testing (not committed): three.js `Xbot.glb` / `Soldier.glb` (Mixamo
names), Khronos `CesiumMan.glb` / `RiggedFigure.glb` (generic names → structural mapping). Put
them in `public/samples/` and open `?model=/samples/Xbot.glb&audio=/samples/song.mp3`.

## Good first contributions
- **New moves** – add an entry to `src/rig/Moves.js` (pure function of the beat clock → pose),
  give it an energy range, done. Run `npm test` (every move must stay finite).
- **Bone-name aliases** – extend `classifyName` in `src/rig/BoneMap.js` and add a case to
  `test/bonemap.test.js`.
- **Engine adapters** – a Babylon.js / PlayCanvas `Dancer` port only needs the world-axis rotate
  and swing helpers; the audio side is engine-agnostic.
- **VRM** – spring bones and the VRM humanoid map (`J_Bip_*` already resolves).
- **Importer scripts** – a Unity/Godot helper that starts the `Dance` clip and the AudioSource
  together from `extras.meshyDance`.

## Rules of thumb
- Keep `src/audio/dsp.js`, `pipeline.js`, `offline.js`, `BoneMap.js`, `Moves.js` free of DOM /
  Web Audio so they stay testable in Node and usable from the bake CLI.
- Anything that moves a bone goes through `Dancer.rotateWorld` / `swing` so it stays
  rig-orientation independent.
- Add a test for every bug you fix; the headless browser checks in the PR description are
  appreciated but not required.
