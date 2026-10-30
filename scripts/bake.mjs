#!/usr/bin/env node
/**
 * Bake a dance for a rigged GLB + a song into a new GLB (textures untouched), from the command line.
 *
 *   node scripts/bake.mjs --model rigged.glb --audio song.mp3 [--out out.glb]
 *          [--fps 30] [--max 300] [--intensity 1] [--hit 1] [--seed 1234] [--name Dance] [--move groove]
 *
 * Audio: .wav (16-bit PCM or 32-bit float) is read directly; anything else is decoded with ffmpeg.
 * The clip is injected into the original file with gltf-transform, so materials and textures are
 * byte-for-byte preserved. In your engine, play the clip and the song from t=0 together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Document, NodeIO, Accessor } from '@gltf-transform/core';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { analyzeOffline } from '../src/audio/offline.js';
import { buildBoneMap } from '../src/rig/BoneMap.js';
import { Dancer } from '../src/rig/Dancer.js';
import { bakeDance } from '../src/rig/Baker.js';

export function parseArgs(argv) {
  const a = { fps: 30, max: 300, intensity: 1, hit: 1, seed: 1234, name: 'Dance', move: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    const num = () => { i++; return parseFloat(v); };
    switch (k) {
      case '--model': a.model = v; i++; break;
      case '--audio': a.audio = v; i++; break;
      case '--out': a.out = v; i++; break;
      case '--name': a.name = v; i++; break;
      case '--move': a.move = v; i++; break;
      case '--fps': a.fps = num(); break;
      case '--max': a.max = num(); break;
      case '--intensity': a.intensity = num(); break;
      case '--hit': a.hit = num(); break;
      case '--seed': a.seed = num(); break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

/** Decode an audio file to mono Float32 PCM. */
export function decodeAudio(file, sampleRate = 44100) {
  const buf = fs.readFileSync(file);
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return parseWav(buf);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(sampleRate), '-'], { maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg failed to decode ${file} (${r.error?.message || r.stderr?.toString().slice(0, 200)}). Install ffmpeg or supply a .wav`);
  const out = r.stdout;
  return { pcm: new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4), sampleRate };
}

export function parseWav(buf) {
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('invalid WAV');
  const ch = fmt.channels, frames = data.length / (ch * fmt.bits / 8);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const idx = (i * ch + c);
      if (fmt.bits === 16) s += data.readInt16LE(idx * 2) / 32768;
      else if (fmt.bits === 32 && fmt.format === 3) s += data.readFloatLE(idx * 4);
      else if (fmt.bits === 32) s += data.readInt32LE(idx * 4) / 2147483648;
      else if (fmt.bits === 24) s += ((data[idx * 3] | (data[idx * 3 + 1] << 8) | (data[idx * 3 + 2] << 16)) << 8 >> 8) / 8388608;
      else throw new Error(`unsupported WAV bit depth ${fmt.bits}`);
    }
    pcm[i] = s / ch;
  }
  return { pcm, sampleRate: fmt.sampleRate };
}

/** Load a GLB with three.js in Node (textures skipped; we only need the skeleton). */
export function loadGlbSkeleton(buf) {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'skip-textures', loadTexture: () => Promise.resolve(null) }));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

const sanitize = (n) => String(n ?? '').replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');

/**
 * Inject a THREE.AnimationClip (uuid-named tracks) into the original GLB bytes via gltf-transform.
 * @param {Buffer} glbBuf original file
 * @param {object} gltf  three.js parse result (for parser.associations -> node indices)
 * @param {import('three').AnimationClip} clip
 */
export async function injectClip(glbBuf, gltf, clip, { extras } = {}) {
  const io = new NodeIO();
  const doc = await io.readBinary(new Uint8Array(glbBuf.buffer, glbBuf.byteOffset, glbBuf.byteLength));
  const root = doc.getRoot();
  const nodes = root.listNodes();
  const buffer = root.listBuffers()[0] || doc.createBuffer();

  // three object -> glTF node index (GLTFLoader records this in parser.associations)
  const byUuid = new Map();
  gltf.scene.traverse(o => { const a = gltf.parser.associations.get(o); if (a && a.nodes !== undefined) byUuid.set(o.uuid, { index: a.nodes, name: o.name }); });

  const anim = doc.createAnimation(clip.name);
  let input = null;
  const used = new Set();
  for (const track of clip.tracks) {
    const [uuid, prop] = track.name.split('.');
    const ref = byUuid.get(uuid);
    if (!ref) continue;
    let node = nodes[ref.index];
    if (!node || (node.getName() && sanitize(node.getName()) !== sanitize(ref.name))) node = nodes.find(n => sanitize(n.getName()) === sanitize(ref.name)) || node;
    if (!node) continue;
    if (!input) input = doc.createAccessor(`${clip.name}_time`).setType(Accessor.Type.SCALAR).setArray(new Float32Array(track.times)).setBuffer(buffer);
    const path = prop === 'quaternion' ? 'rotation' : prop === 'position' ? 'translation' : prop === 'scale' ? 'scale' : null;
    if (!path) continue;
    const output = doc.createAccessor().setType(path === 'rotation' ? Accessor.Type.VEC4 : Accessor.Type.VEC3).setArray(new Float32Array(track.values)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    const channel = doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler);
    anim.addSampler(sampler).addChannel(channel);
    used.add(node);
  }
  if (!used.size) throw new Error('No animation channels could be mapped onto the GLB nodes');
  if (extras) {
    const scene = root.listScenes()[0];
    if (scene) scene.setExtras({ ...(scene.getExtras() || {}), meshyDance: extras });
  }
  const out = await io.writeBinary(doc);
  return { bytes: out, channels: anim.listChannels().length, nodes: used.size };
}

export async function bake(a, log = (m) => process.stderr.write(m + '\n')) {
  if (!a.model || !a.audio) throw new Error('--model and --audio are required');
  const glbBuf = fs.readFileSync(a.model);
  const { pcm, sampleRate } = decodeAudio(a.audio);
  log(`audio: ${(pcm.length / sampleRate).toFixed(1)}s @ ${sampleRate} Hz`);
  const analysis = analyzeOffline(pcm, sampleRate);
  log(`tempo: ${analysis.bpm.toFixed(1)} BPM, beat lock on ${(analysis.lockedFraction * 100).toFixed(0)}% of the track`);
  const gltf = await loadGlbSkeleton(glbBuf);
  const map = buildBoneMap(gltf.scene);
  const missing = map.report.filter(r => !r.bone).map(r => r.slot);
  log(`bones: ${map.report.length - missing.length}/${map.report.length} humanoid slots mapped${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  if (map.coverage < 0.5) throw new Error('Could not find a humanoid skeleton in the model');
  const dancer = new Dancer(gltf.scene, map);
  dancer.params.intensity = a.intensity; dancer.params.hitGain = a.hit;
  if (a.move) { dancer.params.autoMoves = false; dancer.params.move = a.move; }
  dancer.seed(a.seed);
  const clip = bakeDance(dancer, analysis, { fps: a.fps, end: Math.min(a.max, analysis.duration), name: a.name });
  log(`baked: ${clip.duration.toFixed(1)}s, ${clip.tracks.length} tracks @ ${a.fps} fps`);
  const { bytes, channels, nodes } = await injectClip(glbBuf, gltf, clip, {
    extras: { tool: 'meshy-dance', audio: path.basename(a.audio), bpm: +analysis.bpm.toFixed(2), fps: a.fps, duration: +clip.duration.toFixed(3), lockedFraction: +analysis.lockedFraction.toFixed(2), seed: a.seed },
  });
  const out = a.out || path.join(path.dirname(a.model), `${path.basename(a.model, path.extname(a.model))}__dance__${path.basename(a.audio, path.extname(a.audio))}.glb`);
  fs.writeFileSync(out, bytes);
  log(`wrote ${out} (${(bytes.byteLength / 1e6).toFixed(2)} MB, ${channels} channels on ${nodes} nodes)`);
  return { out, clip, analysis, channels, nodes };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0]); process.exit(0); }
  bake(a).then(r => console.log(JSON.stringify({ out: r.out, bpm: +r.analysis.bpm.toFixed(1), duration: +r.clip.duration.toFixed(2), channels: r.channels }))).catch(e => { console.error(e.message || e); process.exit(1); });
}
