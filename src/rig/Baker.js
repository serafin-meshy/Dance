import { AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack, InterpolateLinear } from 'three';
import { replayTimeline } from '../audio/offline.js';

/**
 * Records the mapped bones of a Dancer each time `capture(t)` is called and turns the result
 * into a THREE.AnimationClip. Track names use bone UUIDs so GLTFExporter / PropertyBinding resolve
 * them unambiguously even for names with namespaces (mixamorig:Hips) or duplicates.
 */
export class DanceRecorder {
  constructor(dancer, { fps = 30, name = 'Dance' } = {}) {
    this.dancer = dancer; this.fps = fps; this.name = name;
    this.bones = [...dancer.rest.keys()];
    this.times = [];
    this.quat = new Map(this.bones.map(b => [b, []]));
    this.pos = new Map(this.bones.map(b => [b, []]));
    this.lastT = -Infinity;
    this.recording = false;
    this.t0 = 0;
  }
  start(t0 = 0) { this.recording = true; this.t0 = t0; this.times.length = 0; for (const b of this.bones) { this.quat.get(b).length = 0; this.pos.get(b).length = 0; } this.lastT = -Infinity; }
  stop() { this.recording = false; }

  /** Sample the current skeleton pose at time t (seconds since start). Rate-limited to fps. */
  capture(t) {
    if (!this.recording) return;
    const rel = t - this.t0;
    if (rel - this.lastT < 1 / this.fps - 1e-6) return;
    this.lastT = rel;
    this.times.push(rel);
    for (const b of this.bones) {
      const q = b.quaternion, p = b.position;
      this.quat.get(b).push(q.x, q.y, q.z, q.w);
      this.pos.get(b).push(p.x, p.y, p.z);
    }
  }

  get duration() { return this.times.length ? this.times[this.times.length - 1] : 0; }

  /** Build the clip. Position tracks are only emitted for bones that actually translate (hips). */
  toClip(name = this.name) {
    const times = new Float32Array(this.times);
    const tracks = [];
    for (const b of this.bones) {
      tracks.push(new QuaternionKeyframeTrack(`${b.uuid}.quaternion`, times, new Float32Array(this.quat.get(b)), InterpolateLinear));
      const p = this.pos.get(b);
      let moves = false;
      for (let i = 3; i < p.length && !moves; i += 3) if (Math.abs(p[i] - p[0]) + Math.abs(p[i + 1] - p[1]) + Math.abs(p[i + 2] - p[2]) > 1e-6) moves = true;
      if (moves) tracks.push(new VectorKeyframeTrack(`${b.uuid}.position`, times, new Float32Array(p), InterpolateLinear));
    }
    const clip = new AnimationClip(name, -1, tracks);
    clip.resetDuration();
    return clip;
  }
}

/**
 * Bake a dance for a whole track offline: replay an `analyzeOffline` timeline through the dancer at
 * `fps`, recording every frame. Deterministic and fast (no real-time playback).
 *
 * @param {import('./Dancer.js').Dancer} dancer
 * @param {ReturnType<import('../audio/offline.js').analyzeOffline>} analysis
 * @param {{fps?:number, name?:string, start?:number, end?:number, seed?:number, onProgress?:(p:number)=>void}} [opts]
 */
export function bakeDance(dancer, analysis, { fps = 30, name = 'Dance', start = 0, end = Infinity, onProgress } = {}) {
  const rec = new DanceRecorder(dancer, { fps, name });
  dancer.resetState();   // clean springs / blends so the clip starts from the rest pose
  rec.start(start);
  const total = Math.min(end, analysis.duration) - start;
  let frames = 0;
  replayTimeline(analysis, fps, (features, t, dt) => {
    dancer.update(features, dt);
    dancer.root.updateMatrixWorld(true);
    rec.capture(t);
    if (onProgress && (frames++ & 63) === 0) onProgress(Math.min(1, (t - start) / total));
  }, { start, end });
  rec.stop();
  return rec.toClip(name);
}

/**
 * Export a model (with its skeleton) plus clips to a binary glTF. Browser + Node (textures need DOM).
 * Resolves lazily so Node tests that don't export don't need GLTFExporter.
 */
export async function exportGlb(root, clips, { embedMetadata = {} } = {}) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const prevUserData = root.userData;
  root.userData = { ...prevUserData, meshyDance: embedMetadata };
  try {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(root, { binary: true, animations: clips, onlyVisible: false, includeCustomExtensions: false });
    return result; // ArrayBuffer
  } finally { root.userData = prevUserData; }
}
