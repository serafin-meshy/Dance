import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { Scene } from './viewer/Scene.js';
import { buildMannequin } from './viewer/Mannequin.js';
import { AudioAnalyzer } from './audio/AudioAnalyzer.js';
import { buildBoneMap, SLOTS } from './rig/BoneMap.js';
import { Dancer, MOVES, DANCE_MOVES } from './rig/Dancer.js';
import * as meshy from './meshyClient.js';
import { analyzeOffline } from './audio/offline.js';
import { bakeDance, exportGlb } from './rig/Baker.js';

const $ = (id) => document.getElementById(id);

const scene = new Scene($('view'));
const analyzer = new AudioAnalyzer();
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
loader.setDRACOLoader(draco);

/** @type {Dancer|null} */ let dancer = null;
let model = null;
let clips = [];
let lastRigTaskId = null;

// ---------------------------------------------------------------- model loading

function installModel(object, animations = []) {
  model = scene.setModel(object);
  const map = buildBoneMap(object);
  dancer = new Dancer(object, map);
  applyDanceParams();
  renderBoneMap(map);
  clips = [];
  $('clipSel').innerHTML = '<option value="">none (procedural only)</option>';
  addClips(animations);
  scene.showSkeleton($('showSkel').checked);
  if (map.coverage < 1) toast(`Bone map incomplete (${Math.round(map.coverage * 100)}% of essential bones). Open "Bone map" to see which slots are missing.`);
}

function addClips(animations) {
  for (const clip of animations) {
    if (clips.find(c => c.name === clip.name)) clip.name = `${clip.name} (${clips.length})`;
    clips.push(clip);
    const o = document.createElement('option'); o.value = clip.name; o.textContent = `${clip.name} (${clip.duration.toFixed(1)}s)`;
    $('clipSel').appendChild(o);
  }
  $('clipBox').classList.toggle('hidden', clips.length === 0);
}

async function loadGltf(src) {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  try {
    return await new Promise((res, rej) => loader.load(url, res, undefined, rej));
  } finally { if (typeof src !== 'string') URL.revokeObjectURL(url); }
}

async function loadModelFile(file) {
  try {
    toast(`Loading ${file.name || 'model'}…`);
    const gltf = await loadGltf(file);
    installModel(gltf.scene, gltf.animations || []);
    modelName = typeof file === 'string' ? file.split('/').pop() : file.name;
    toast(`Loaded ${modelName} · ${clips.length} clip(s)`);
  } catch (e) { console.error(e); toast(`Failed to load model: ${e.message || e}`); }
}

async function loadClipFile(file) {
  if (!dancer) return toast('Load a model first.');
  try {
    const gltf = await loadGltf(file);
    if (!gltf.animations?.length) return toast('No animation clips in that file.');
    addClips(gltf.animations);
    toast(`Added ${gltf.animations.length} clip(s)`);
  } catch (e) { toast(`Failed: ${e.message || e}`); }
}

function renderBoneMap(map) {
  const t = $('boneMapTable'); t.innerHTML = '';
  let hit = 0;
  for (const r of map.report) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.slot}</td><td class="${r.bone ? '' : 'miss'}">${r.bone || 'missing'}</td><td class="via">${r.via || ''}</td>`;
    t.appendChild(tr); if (r.bone) hit++;
  }
  const pill = $('boneMapSummary');
  pill.textContent = `${hit}/${SLOTS.length}`;
  pill.classList.toggle('ok', map.coverage === 1);
}

// ---------------------------------------------------------------- UI wiring

function applyDanceParams() {
  if (!dancer) return;
  const P = dancer.params;
  P.intensity = +$('intensity').value;
  P.hitGain = +$('hitGain').value;
  P.smoothing = +$('smoothing').value;
  P.autoMoves = $('autoMoves').checked;
  P.move = $('moveSel').value || 'groove';
  P.switchEveryBeats = Math.max(1, +$('switchBeats').value | 0);
  P.clipSync = $('clipSync').checked;
  P.beatsPerLoop = +$('beatsPerLoop').value || 2;
  P.proceduralWeight = +$('procWeight').value;
  if (!P.autoMoves) dancer.setMove(P.move);
}

for (const k of DANCE_MOVES) { const o = document.createElement('option'); o.value = k; o.textContent = MOVES[k].label; $('moveSel').appendChild(o); }
for (const id of ['intensity', 'hitGain', 'smoothing', 'autoMoves', 'moveSel', 'switchBeats', 'clipSync', 'beatsPerLoop', 'procWeight']) {
  $(id).addEventListener('input', () => {
    const el = $(id); const out = el.parentElement.querySelector('output');
    if (out) out.textContent = (+el.value).toFixed(2);
    applyDanceParams();
  });
}
$('moveSel').addEventListener('change', () => { $('autoMoves').checked = false; applyDanceParams(); });
$('clipSel').addEventListener('change', () => {
  if (!dancer) return;
  const clip = clips.find(c => c.name === $('clipSel').value) || null;
  dancer.setClip(clip);
});
$('showSkel').addEventListener('change', () => scene.showSkeleton($('showSkel').checked));
$('glbFile').addEventListener('change', (e) => e.target.files[0] && loadModelFile(e.target.files[0]));
$('clipFile').addEventListener('change', (e) => e.target.files[0] && loadClipFile(e.target.files[0]));
$('mannequinBtn').addEventListener('click', () => { installModel(buildMannequin()); modelName = 'mannequin'; toast('Mannequin loaded'); });

$('audioFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await analyzer.playFile(f); toast(`Playing ${f.name}`); } catch (err) { toast(`Audio error: ${err.message}`); }
});
$('micBtn').addEventListener('click', async () => {
  try { await analyzer.useMicrophone(); toast('Listening to microphone (not monitored)'); } catch (err) { toast(`Mic error: ${err.message}`); }
});
$('demoBtn').addEventListener('click', async () => {
  await analyzer.playDemo(+$('demoBpm').value || 124); toast(`Demo beat @ ${$('demoBpm').value} BPM`);
});
$('demoBpm').addEventListener('change', () => { if (analyzer.demo) analyzer.demo.bpm = +$('demoBpm').value || 124; });
$('stopBtn').addEventListener('click', () => analyzer.stop());
$('manualBpm').addEventListener('change', () => { analyzer.manualBpm = Math.max(0, +$('manualBpm').value || 0); });
function setTempoScale(s) {
  analyzer.tempoScale = analyzer.tempoScale === s ? 1 : s;
  $('halfBtn').classList.toggle('on', analyzer.tempoScale === 0.5);
  $('dblBtn').classList.toggle('on', analyzer.tempoScale === 2);
}
$('halfBtn').addEventListener('click', () => setTempoScale(0.5));
$('dblBtn').addEventListener('click', () => setTempoScale(2));

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').classList.add('hidden');
  for (const f of e.dataTransfer.files) {
    if (/\.(glb|gltf)$/i.test(f.name)) await loadModelFile(f);
    else if (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name)) { try { await analyzer.playFile(f); toast(`Playing ${f.name}`); } catch (err) { toast(err.message); } }
  }
});

// ---------------------------------------------------------------- Meshy panel

$('meshyRigBtn').addEventListener('click', async () => {
  const v = $('meshyInput').value.trim();
  if (!v) return toast('Enter a public .glb URL or a Meshy task id.');
  const status = (s) => { $('meshyStatus').textContent = s; };
  $('meshyRigBtn').disabled = true;
  try {
    const isUrl = /^https?:\/\//i.test(v) || v.startsWith('data:');
    status('Creating rigging task…');
    const id = await meshy.createRiggingTask({ modelUrl: isUrl ? v : undefined, inputTaskId: isUrl ? undefined : v, heightMeters: +$('meshyHeight').value || 1.7 });
    const task = await meshy.waitForTask(meshy.getRiggingTask, id, { onProgress: (t) => status(`Rigging ${id}: ${t.status} ${t.progress ?? 0}%`) });
    lastRigTaskId = id;
    const urls = meshy.collectGlbUrls(task.result || {});
    const main = urls.find(u => /rigged_character|rigged/.test(u.key)) || urls[0];
    if (!main) throw new Error('No GLB url in result: ' + JSON.stringify(task.result).slice(0, 200));
    status(`Downloading ${main.key}…`);
    const gltf = await loadGltf(meshy.proxiedAssetUrl(main.url));
    installModel(gltf.scene, gltf.animations || []);
    modelName = `meshy_${id}`;
    // pull in basic animations (walking / running) as clips
    for (const u of urls.filter(u => u !== main)) {
      try { const g = await loadGltf(meshy.proxiedAssetUrl(u.url)); g.animations.forEach(c => { c.name = u.key.split('.').pop().replace(/_glb_url$/, ''); }); addClips(g.animations); } catch (e) { console.warn('clip load failed', u, e); }
    }
    $('meshyAnimBtn').disabled = false;
    status(`Rigged ✓ task ${id} · ${clips.length} clip(s). Rigged GLB: ${main.url}`);
  } catch (e) { console.error(e); status(`Error: ${e.message}`); }
  finally { $('meshyRigBtn').disabled = false; }
});

$('meshyAnimBtn').addEventListener('click', async () => {
  const actionId = +$('meshyActionId').value;
  if (!lastRigTaskId) return toast('Rig a model first.');
  if (!Number.isFinite(actionId)) return toast('Enter an action id from the Meshy animation library.');
  const status = (s) => { $('meshyStatus').textContent = s; };
  try {
    const id = await meshy.createAnimationTask({ rigTaskId: lastRigTaskId, actionId });
    const task = await meshy.waitForTask(meshy.getAnimationTask, id, { onProgress: (t) => status(`Animation ${id}: ${t.status} ${t.progress ?? 0}%`) });
    const url = meshy.collectGlbUrls(task.result || {})[0];
    if (!url) throw new Error('No GLB in animation result');
    const g = await loadGltf(meshy.proxiedAssetUrl(url.url));
    g.animations.forEach(c => { c.name = `meshy action ${actionId}`; });
    addClips(g.animations);
    status(`Animation ${actionId} added as a clip ✓`);
  } catch (e) { status(`Error: ${e.message}`); }
});

// ---------------------------------------------------------------- bake / export

function downloadBlob(buf, name) {
  const blob = new Blob([buf], { type: 'model/gltf-binary' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const baseName = (s) => (s || 'model').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
let modelName = 'mannequin';

$('bakeBtn').addEventListener('click', async () => {
  const status = (m) => { $('bakeStatus').textContent = m; };
  if (!dancer) return status('Load a model first.');
  if (analyzer.sourceKind !== 'file') return status('Load a song file first (baking needs the whole track).');
  $('bakeBtn').disabled = true;
  const wasPlaying = analyzer.mediaEl && !analyzer.mediaEl.paused;
  try {
    status('Decoding audio…');
    const { pcm, sampleRate, duration } = await analyzer.decodeCurrentFile();
    status('Analysing beats…');
    await new Promise(r => setTimeout(r, 20));
    const analysis = analyzeOffline(pcm, sampleRate);
    const fps = +$('bakeFps').value || 30;
    const end = Math.min(duration, +$('bakeMax').value || duration);
    status(`Tempo ${analysis.bpm.toFixed(1)} BPM, locked ${Math.round(analysis.lockedFraction * 100)}% of the track. Baking ${end.toFixed(0)}s @ ${fps} fps…`);
    await new Promise(r => setTimeout(r, 20));
    if (analyzer.mediaEl) analyzer.mediaEl.pause();
    const liveClip = dancer.clip; dancer.setClip(null);
    dancer.seed(1234); dancer.resetState();
    const clip = bakeDance(dancer, analysis, { fps, end, name: `Dance_${baseName(analyzer.lastFileName)}` });
    dancer.resetState(); dancer.rng = Math.random; if (liveClip) dancer.setClip(liveClip);
    status(`Exporting ${clip.duration.toFixed(1)}s clip (${clip.tracks.length} tracks)…`);
    await new Promise(r => setTimeout(r, 20));
    const extra = $('bakeIncludeClips').checked ? clips : [];
    const buf = await exportGlb(model, [clip, ...extra], { embedMetadata: { tool: 'meshy-dance', audio: analyzer.lastFileName, bpm: +analysis.bpm.toFixed(2), fps, duration: +clip.duration.toFixed(3), lockedFraction: +analysis.lockedFraction.toFixed(2) } });
    const name = `${baseName(modelName)}__dance__${baseName(analyzer.lastFileName)}.glb`;
    downloadBlob(buf, name);
    status(`Saved ${name} (${(buf.byteLength / 1e6).toFixed(1)} MB). In your engine: import the GLB, play clip "${clip.name}" and the song from t=0.`);
  } catch (e) { console.error(e); status(`Bake failed: ${e.message || e}`); }
  finally { $('bakeBtn').disabled = false; if (wasPlaying && analyzer.mediaEl) analyzer.mediaEl.play().catch(() => {}); }
});

$('exportRestBtn').addEventListener('click', async () => {
  if (!model) return;
  try {
    const buf = await exportGlb(model, $('bakeIncludeClips').checked ? clips : [], { embedMetadata: { tool: 'meshy-dance' } });
    downloadBlob(buf, `${baseName(modelName)}.glb`);
  } catch (e) { toast(`Export failed: ${e.message}`); }
});

// ---------------------------------------------------------------- loop

let toastTimer = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
}

const clock = new THREE.Clock();
let frames = 0, fpsT = 0;
const hitEls = { low: $('hitLow'), mid: $('hitMid'), high: $('hitHigh') };
function flash(el) { el.classList.add('hit'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('hit'))); }

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, clock.getDelta());
  const f = analyzer.update();
  if (dancer) dancer.update(f, dt);
  scene.render(f, dt);

  // meters (cheap DOM updates)
  $('bpmVal').textContent = f.bpm ? f.bpm.toFixed(1) : '—';
  $('bpmVal').style.opacity = f.locked ? '1' : '0.45';
  const lock = $('lockPill'); lock.textContent = f.locked ? `locked ${Math.round(f.confidence * 100)}%` : (f.bpm ? 'tracking' : 'unlocked'); lock.classList.toggle('ok', f.locked);
  $('phaseBar').style.width = `${(1 - f.phase) * 100}%`;
  $('bandLow').style.height = `${Math.min(100, f.bands.low * 130)}%`;
  $('bandMid').style.height = `${Math.min(100, f.bands.mid * 160)}%`;
  $('bandHigh').style.height = `${Math.min(100, f.bands.high * 220)}%`;
  $('bandRms').style.height = `${Math.min(100, f.rms * 120)}%`;
  if (f.onsets.low) flash(hitEls.low);
  if (f.onsets.mid) flash(hitEls.mid);
  if (f.onsets.high) flash(hitEls.high);
  if (dancer) $('moveStatus').textContent = `move: ${MOVES[dancer.stats.lastMove]?.label || dancer.stats.lastMove}${dancer.moveB ? ' → ' + MOVES[dancer.moveB].label : ''} · energy ${dancer.energy.toFixed(2)}${dancer.stats.lastHit ? ' · last hit: ' + dancer.stats.lastHit : ''}`;

  frames++; fpsT += dt;
  if (fpsT > 0.5) { $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
}

// boot: mannequin so there's something on screen immediately; load ?model= if given
installModel(buildMannequin());
const params = new URLSearchParams(location.search);
if (params.get('model')) loadModelFile(params.get('model'));
if (params.get('audio')) analyzer.playFile(params.get('audio')).catch(() => {});
tick();

// expose for debugging / automation
window.__dance = { scene, analyzer, get dancer() { return dancer; }, installModel, buildMannequin, meshy };
