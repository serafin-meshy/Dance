import { FFT, blackman } from './fft.js';
import { FeaturePipeline } from './pipeline.js';

/**
 * Offline analysis of a whole track: STFT (matching AnalyserNode's byte-spectrum scaling) ->
 * FeaturePipeline -> a timeline of feature snapshots at `hopHz`. Used for baking dances to
 * animation clips without real-time playback. Pure JS, runs in Node too.
 *
 * @param {Float32Array} pcm mono samples
 * @param {number} sampleRate
 * @returns {{ frames: TimelineFrame[], hopHz: number, duration: number, bpm: number, lockedFraction: number }}
 *
 * @typedef {object} TimelineFrame
 * @property {number} t
 * @property {number} rms
 * @property {{low:number,mid:number,high:number}} bands
 * @property {{low:boolean,mid:boolean,high:boolean,any:boolean}} onsets
 * @property {{low:number,mid:number,high:number}} strength
 * @property {number} bpm
 * @property {number} phase
 * @property {boolean} beat
 * @property {number} beatIndex
 * @property {number} confidence
 * @property {boolean} locked
 */
export function analyzeOffline(pcm, sampleRate, { fftSize = 2048, hopHz = 100, minDb = -100, maxDb = -30, onProgress } = {}) {
  const hop = Math.max(1, Math.round(sampleRate / hopHz));
  const fft = new FFT(fftSize);
  const win = blackman(fftSize);
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
  const bins = fftSize / 2;
  const pipeline = new FeaturePipeline({ sampleRate, fftSize, historyFrames: Math.round(hopHz * 1.2) });
  const frames = [];
  const dbScale = 255 / (maxDb - minDb);
  const total = Math.floor(pcm.length / hop);
  for (let k = 0; k < total; k++) {
    const start = k * hop;  // frame ends at `start` (causal, like the analyser's latest block)
    const from = start - fftSize;
    let sum = 0;
    for (let i = 0; i < fftSize; i++) {
      const s = from + i >= 0 && from + i < pcm.length ? pcm[from + i] : 0;
      re[i] = s * win[i]; im[i] = 0; sum += s * s;
    }
    fft.transform(re, im);
    const spec = new Uint8Array(bins);
    for (let i = 0; i < bins; i++) {
      const mag = Math.hypot(re[i], im[i]) / fftSize;
      const db = 20 * Math.log10(mag + 1e-12);
      spec[i] = Math.max(0, Math.min(255, Math.round((db - minDb) * dbScale)));
    }
    const rms = Math.sqrt(sum / fftSize);
    const t = start / sampleRate;
    const f = pipeline.push(spec, rms, t);
    const ev = pipeline.consume({});
    frames.push({
      t, rms: f.rms, bands: { ...f.bands },
      onsets: ev.onsets, strength: ev.strength, beat: ev.beat,
      bpm: f.bpm, phase: f.phase, beatIndex: f.beatIndex, confidence: f.confidence, locked: f.locked,
    });
    if (onProgress && (k & 255) === 0) onProgress(k / total);
  }
  backfillLock(frames);
  const locked = frames.filter(f => f.locked).length / Math.max(1, frames.length);
  const bpm = medianBpm(frames);
  return { frames, hopHz, duration: pcm.length / sampleRate, bpm, lockedFraction: locked };
}

/**
 * The tracker needs a few seconds before it locks. For baking we know the future, so extend the
 * first locked clock backwards to t=0 (constant tempo assumption for those first seconds).
 */
export function backfillLock(frames) {
  const i0 = frames.findIndex(f => f.locked && f.bpm > 0);
  if (i0 <= 0) return;
  const ref = frames[i0];
  const P = 60 / ref.bpm;
  let prevIdx = null;
  for (let i = 0; i < i0; i++) {
    const f = frames[i];
    const beatsBack = (ref.t - f.t) / P;
    let x = ref.beatIndex + ref.phase - beatsBack;
    const idx = Math.floor(x);
    f.bpm = ref.bpm; f.locked = true; f.confidence = ref.confidence;
    f.beatIndex = idx; f.phase = x - idx;
    f.beat = prevIdx !== null && idx !== prevIdx;
    prevIdx = idx;
  }
}

function medianBpm(frames) {
  const v = frames.filter(f => f.locked && f.bpm > 0).map(f => f.bpm).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

/**
 * Iterate the timeline at a fixed frame rate, merging events between frames.
 * @param {ReturnType<typeof analyzeOffline>} analysis
 * @param {number} fps
 * @param {(features: import('./pipeline.js').emptyFeatures extends () => infer R ? R : never, t: number, dt: number) => void} cb
 */
export function replayTimeline(analysis, fps, cb, { start = 0, end = Infinity } = {}) {
  const { frames } = analysis;
  const dt = 1 / fps;
  const duration = Math.min(end, analysis.duration);
  let j = 0;
  while (j < frames.length && frames[j].t < start) j++;
  for (let t = start; t <= duration; t += dt) {
    const onsets = { low: false, mid: false, high: false, any: false }, strength = { low: 0, mid: 0, high: 0 };
    let beat = false, last = frames[Math.max(0, j - 1)];
    while (j < frames.length && frames[j].t <= t) {
      const f = frames[j];
      for (const b of ['low', 'mid', 'high']) { if (f.onsets[b]) { onsets[b] = true; onsets.any = true; strength[b] = Math.max(strength[b], f.strength[b]); } }
      if (f.beat) beat = true;
      last = f; j++;
    }
    if (!last) continue;
    cb({ time: t, dt, rms: last.rms, bands: last.bands, flux: { low: 0, mid: 0, high: 0 }, onsets, strength, beat, bpm: last.bpm, phase: last.phase, beatIndex: last.beatIndex, confidence: last.confidence, locked: last.locked, spectrum: new Uint8Array(0) }, t, dt);
  }
}
