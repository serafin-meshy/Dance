import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMannequin } from '../src/viewer/Mannequin.js';
import { exportGlb } from '../src/rig/Baker.js';
import { parseArgs, parseWav, bake, loadGlbSkeleton } from '../scripts/bake.mjs';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class { readAsArrayBuffer(blob) { blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend && this.onloadend(); this.onload && this.onload(); }); } };
}

function writeWav(file, pcm, sampleRate) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

test('parseArgs reads options', () => {
  const a = parseArgs(['--model', 'm.glb', '--audio', 's.mp3', '--fps', '24', '--max', '10', '--seed', '9']);
  assert.equal(a.model, 'm.glb'); assert.equal(a.fps, 24); assert.equal(a.max, 10); assert.equal(a.seed, 9);
  assert.throws(() => parseArgs(['--nope']));
});

test('bake CLI: GLB in, GLB with Dance clip out, materials untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-'));
  const sr = 22050, seconds = 6, pcm = new Float32Array(sr * seconds);
  for (let i = 0; i < pcm.length; i++) { const t = i / sr, tb = t % 0.5; pcm[i] = 0.8 * Math.exp(-tb / 0.08) * Math.sin(2 * Math.PI * 60 * tb); }
  const wav = path.join(dir, 'click.wav'); writeWav(wav, pcm, sr);
  assert.ok(Math.abs(parseWav(fs.readFileSync(wav)).pcm[0] - pcm[0]) < 1e-3);

  const m = buildMannequin();
  const glb = Buffer.from(await exportGlb(m, []));
  const model = path.join(dir, 'mannequin.glb'); fs.writeFileSync(model, glb);
  const inMaterials = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString()).materials;

  const logs = [];
  const r = await bake({ model, audio: wav, fps: 30, max: 5, intensity: 1, hit: 1, seed: 3, name: 'Dance', move: '' }, (l) => logs.push(l));
  assert.ok(fs.existsSync(r.out));
  const out = fs.readFileSync(r.out);
  const json = JSON.parse(out.subarray(20, 20 + out.readUInt32LE(12)).toString());
  const anim = json.animations.find(a => a.name === 'Dance');
  assert.ok(anim, 'Dance animation present');
  assert.ok(anim.channels.length >= 20, `channels ${anim.channels.length}`);
  assert.ok(anim.channels.some(c => c.target.path === 'translation'), 'hips translation channel');
  assert.deepEqual(json.materials, inMaterials, 'materials preserved');
  assert.equal(json.scenes[0].extras.meshyDance.tool, 'meshy-dance');
  assert.ok(Math.abs(r.clip.duration - 5) < 0.1, `duration ${r.clip.duration}`);
  // re-load with three and check the clip binds to bones by name
  const gltf = await loadGlbSkeleton(out);
  assert.ok(gltf.animations.length === 1 && gltf.animations[0].tracks.length >= 20);
  const trackNodes = new Set(gltf.animations[0].tracks.map(t => t.name.split('.')[0]));
  assert.ok(trackNodes.has('Hips') && trackNodes.has('LeftArm'), `tracks target bones: ${[...trackNodes].slice(0, 5)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
