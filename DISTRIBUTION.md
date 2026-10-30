# Distributing Meshy Dance to the Meshy community

The product has three faces, and each one reaches a different slice of the community:

| Face | Who it's for | Ship as |
| --- | --- | --- |
| **Web demo** (drop GLB + song → it dances, bake to GLB) | Meshy creators, non-coders | GitHub Pages URL |
| **Bake CLI** (`npm run bake`) | Indie devs with a pipeline | npm package / GitHub release |
| **Runtime library** (`meshy-dance` ESM) | three.js / web game devs | npm package |

## 0. Before posting (one afternoon)

1. **Merge to `main`** and turn on Pages: repo *Settings → Pages → Source: GitHub Actions*.
   `pages.yml` already builds, tests and deploys `dist/` on every push to `main`/`master`.
   Result: `https://serafin-meshy.github.io/Dance/`.
2. **Make a hero clip (15–30 s)**: a Meshy character you rigged with the API, dancing to a
   track you have rights to (your own, or CC0 — avoid commercial music in public posts).
   Record the browser with OBS or the macOS screen recorder. Also export one **baked GLB** and
   screen-record it playing inside Unity or Godot — "it works in my engine" is the hook.
3. **Tag a release** (`v0.1.0`) with: the hero MP4/GIF, a sample baked `.glb` of a Meshy
   character you're allowed to share, and a one-paragraph "how to use".
4. **Publish to npm** (optional but it makes the library side real):
   `npm login && npm publish --access public`. `package.json` already has `files`, `exports`,
   keywords and a `three` peer dependency. Pick the final package name first (`meshy-dance`
   is free as of writing — verify with `npm view meshy-dance`).
5. Add a `CONTRIBUTING.md` + issue templates, and label a few `good first issue`s
   (new moves, VRM spring-bone support, Babylon adapter) so people have an on-ramp.

## 1. Meshy channels

- **Meshy Discord — https://discord.gg/meshy.** The help center describes Discord as the place
  for questions, tips and feedback. Post the hero clip + Pages link; ask which channel the mods
  prefer for community tools/API projects (don't dump it in general). Offer to do a live demo.
- **Meshy web app showcase.** Meshy's community showcase lives in the web app, where users
  publish creations and can earn tips. Publish the rigged character you used (with a short
  description + link to the demo); the model is the showcase item, the dance is the hook.
- **Meshy Contributor Program.** There is an application flow (Apply button in the Discord
  channel, or DM Myko, the Meshy Community Assistant). Apply with this project — it is exactly
  the kind of end-to-end API showcase they describe wanting.
- **Meshy DevRel.** Meshy has been hiring Developer Experience roles tasked with demo apps,
  sample projects, hackathons and game jams. Send them the repo: it's a ready-made API sample
  (rigging → animation) and a good jam toolkit. Ask about a slot in the API docs' examples, a
  blog post, or the integrations page.
- **Meshy socials.** Tag @meshyai on X / YouTube Shorts / TikTok with the hero clip; Meshy
  reshares community work.

## 2. Beyond Meshy

- **three.js** — r/threejs, the three.js Discord #showcase, and Three.js Forum "Showcase"
  category (it runs on three.js and uses their sample rigs in tests).
- **Game-dev** — r/gamedev "Feedback Friday" or "Screenshot Saturday", r/godot, r/Unity3D with
  the engine-import clip; itch.io as a free *tool* page (web build + GLB samples).
- **Audio/creative coding** — r/creativecoding, Web Audio Weekly, Hacker News *Show HN*
  (lead with "beat tracking + procedural choreography on any humanoid rig, bake to GLB").
- **Asset stores** — once there's demand, wrap the baked-GLB workflow as a Unity package or
  Godot addon (`Meshy Dance Importer` that syncs the clip with the AudioSource). The baked GLBs
  themselves are engine-agnostic today.

## 3. The pitch (copy/paste)

> **Meshy Dance** — rig a Meshy character with the Rigging API, then make it dance to *any*
> song: live in the browser (beat tracking + transient-driven moves, works on Mixamo/VRM/UE
> rigs too) or **baked into a GLB animation clip** you import into Unity, Unreal, Godot or
> three.js. Free, MIT. Demo: <pages url> · Code: <repo url> · `npm i meshy-dance`

## 4. Keep it alive

- Pin a **"share your dancer"** thread; reshare community clips.
- Ship small, visible updates (new moves, a Babylon adapter, VRM spring bones) and post each
  one in the same Discord thread.
- Collect baked GLBs people share as a `samples/` gallery on the Pages site.

## Licensing notes

- Your code: MIT (see `LICENSE`).
- Meshy outputs: follow Meshy's terms for the plan that generated them before redistributing a
  rigged character in the repo or release.
- Music in demos: use tracks you own or CC0/CC-BY with attribution; the three.js test tracks
  used during development are not redistributed in this repo.
- Sample rigs used for testing (three.js Xbot/Soldier, Khronos CesiumMan/RiggedFigure) are
  downloaded on demand and not committed.
