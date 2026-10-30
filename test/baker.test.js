import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOffline, replayTimeline } from '../src/audio/offline.js';
import { buildMannequin } from '../src/viewer/Mannequin.js';
import { buildBoneMap } from '../src/rig/BoneMap.js';
import { Dancer } from '../src/rig/Dancer.js';
import { bakeDance, exportGlb, DanceRecorder } from '../src/rig/Baker.js';

// three's GLTFExporter reads its binary result through FileReader, which Node lacks.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend && this.onloadend(); this.onload && this.onload(); }); }
    readAsDataURL(blob) { blob.arrayBuffer().then(buf => { this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`; this.onloadend && this.onloadend(); this.onload && this.onload(); }); }
  };
}

/** Synthesise PCM: kick (sine sweep) on every beat, hat noise on 8ths, at `bpm`. */
function synthPcm({ bpm, seconds, sampleRate = 22050 }) {
  const n = Math.floor(seconds * sampleRate), pcm = new Float32Array(n);
  const period = 60 / bpm;
  let seed = 3; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const tb = t % period, t8 = t % (period / 2);
    const kick = Math.exp(-tb / 0.08) * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb / 0.03)) * tb);
    const hat = Math.exp(-t8 / 0.02) * rnd() * 0.5;
    pcm[i] = 0.8 * kick + hat;
  }
  return pcm;
}

test('analyzeOffline finds the tempo of a synthetic click track and backfills the lock to t=0', () => {
  const sr = 22050, pcm = synthPcm({ bpm: 128, seconds: 16, sampleRate: sr });
  const a = analyzeOffline(pcm, sr);
  assert.ok(Math.abs(a.bpm - 128) < 2 || Math.abs(a.bpm - 64) < 1, `bpm ${a.bpm}`);
  assert.ok(a.lockedFraction > 0.95, `locked fraction ${a.lockedFraction}`);
  assert.ok(a.frames[0].locked, 'first frame locked after backfill');
  assert.ok(a.frames.length > 1500, `frames ${a.frames.length}`);
  // beats are evenly spaced at the detected tempo
  const beats = a.frames.filter(f => f.beat).map(f => f.t);
  const gaps = beats.slice(1).map((t, i) => t - beats[i]);
  const mean = gaps.reduce((x, y) => x + y, 0) / gaps.length;
  assert.ok(Math.abs(mean - 60 / a.bpm) < 0.03, `mean beat gap ${mean} vs ${60 / a.bpm}`);
});

test('replayTimeline merges events between frames and never drops a beat', () => {
  const sr = 22050, a = analyzeOffline(synthPcm({ bpm: 120, seconds: 10, sampleRate: sr }), sr);
  let beats = 0, frames = 0, onsets = 0;
  replayTimeline(a, 30, (f) => { frames++; if (f.beat) beats++; if (f.onsets.low) onsets++; });
  assert.ok(frames >= 299 && frames <= 301, `frames ${frames}`);
  const timelineBeats = a.frames.filter(f => f.beat).length;
  assert.equal(beats, timelineBeats);
  assert.ok(onsets >= 15, `low onsets ${onsets}`);
});

test('bakeDance produces a clip for every mapped bone and exportGlb writes a valid GLB', async () => {
  const sr = 22050, a = analyzeOffline(synthPcm({ bpm: 120, seconds: 8, sampleRate: sr }), sr);
  const m = buildMannequin();
  const d = new Dancer(m, buildBoneMap(m));
  d.seed(7);
  const clip = bakeDance(d, a, { fps: 30, name: 'Dance_test' });
  assert.ok(Math.abs(clip.duration - 8) < 0.1, `duration ${clip.duration}`);
  const quatTracks = clip.tracks.filter(t => t.name.endsWith('.quaternion'));
  assert.equal(quatTracks.length, d.rest.size);
  assert.ok(clip.tracks.some(t => t.name.endsWith('.position')), 'hips position track present');
  for (const t of clip.tracks) for (const v of t.values) assert.ok(Number.isFinite(v));
  // motion actually happened
  const head = quatTracks.find(t => t.name.startsWith(d.bones.head.uuid));
  let maxDev = 0; for (let i = 4; i < head.values.length; i += 4) maxDev = Math.max(maxDev, Math.abs(head.values[i] - head.values[0]) + Math.abs(head.values[i + 1] - head.values[1]));
  assert.ok(maxDev > 0.01, `head moved ${maxDev}`);
  // deterministic with the same seed
  const m2 = buildMannequin();
  const d2 = new Dancer(m2, buildBoneMap(m2)); d2.seed(7);
  const clip2 = bakeDance(d2, a, { fps: 30 });
  const h2 = clip2.tracks.find(t => t.name.startsWith(d2.bones.head.uuid) && t.name.endsWith('.quaternion'));
  assert.ok(h2 && h2.values.every((v, i) => Math.abs(v - head.values[i]) < 1e-6), 'same seed => same clip');

  const glb = await exportGlb(m, [clip], { embedMetadata: { tool: 'meshy-dance', bpm: a.bpm } });
  const u8 = new Uint8Array(glb);
  assert.equal(String.fromCharCode(...u8.subarray(0, 4)), 'glTF');
  const jsonLen = new DataView(glb).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen)));
  assert.equal(json.animations.length, 1);
  assert.equal(json.animations[0].name, 'Dance_test');
  assert.ok(json.animations[0].channels.length >= d.rest.size, 'a channel per bone');
  assert.ok(json.nodes.some(n => n.extras && n.extras.meshyDance), 'metadata embedded');
});
