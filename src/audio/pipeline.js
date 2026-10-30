import { OnsetDetector, BeatTracker, EnvelopeFollower } from './dsp.js';

/**
 * Turns a stream of (byte spectrum, rms, time) frames into AudioFeatures. Shared by the real-time
 * AudioAnalyzer (frames from an AnalyserNode) and the offline analyzer (frames from our own STFT),
 * so a baked dance and a live dance see exactly the same features.
 */
export class FeaturePipeline {
  constructor({ sampleRate, fftSize, historyFrames = 120 }) {
    this.onset = new OnsetDetector({ sampleRate, fftSize, historyFrames });
    this.beat = new BeatTracker();
    this.rmsEnv = new EnvelopeFollower(0.02, 0.25);
    this.bandEnv = { low: new EnvelopeFollower(0.015, 0.18), mid: new EnvelopeFollower(0.015, 0.18), high: new EnvelopeFollower(0.01, 0.12) };
    this.manualBpm = 0;
    this.tempoScale = 1;
    this.lastTime = 0;
    this._lastBeatIndex = -1;
    this.features = emptyFeatures();
    this.acc = { onsets: { low: false, mid: false, high: false, any: false }, strength: { low: 0, mid: 0, high: 0 }, beat: false };
  }

  /** @param {Uint8Array} spectrum  @param {number} rms  @param {number} time seconds */
  push(spectrum, rms, time) {
    const dt = this.lastTime ? Math.min(0.1, time - this.lastTime) : 0.01;
    if (dt <= 0) return this.features;
    this.lastTime = time;
    const o = this.onset.process(spectrum, time);
    this.beat.addNovelty(time, o.flux.low * 1.0 + o.flux.mid * 0.7 + o.flux.high * 0.35);
    for (const band of ['low', 'mid', 'high']) {
      if (o.onsets[band]) {
        this.beat.addOnset(time, o.strength[band] * (band === 'low' ? 1.0 : band === 'mid' ? 0.8 : 0.35));
        this.acc.onsets[band] = true; this.acc.onsets.any = true;
        this.acc.strength[band] = Math.max(this.acc.strength[band], o.strength[band]);
      }
    }
    if (this.manualBpm > 0) { this.beat.period = 60 / this.manualBpm; this.beat.bpm = this.manualBpm; }
    const b = scaleBeat(this.beat.update(time), this.tempoScale);
    if (b.period > 0 && b.beatIndex !== this._lastBeatIndex) this.acc.beat = true;
    this._lastBeatIndex = b.beatIndex;

    const f = this.features;
    f.time = time; f.dt = dt;
    f.rms = this.rmsEnv.process(Math.min(1, rms * 2.5), dt);
    f.bands.low = this.bandEnv.low.process(o.energy.low, dt);
    f.bands.mid = this.bandEnv.mid.process(o.energy.mid, dt);
    f.bands.high = this.bandEnv.high.process(o.energy.high, dt);
    f.flux = o.flux;
    f.bpm = b.bpm; f.phase = b.phase; f.beatIndex = b.beatIndex;
    f.confidence = b.confidence; f.locked = b.locked;
    f.spectrum = spectrum;
    return f;
  }

  /** Hand out the latest features plus every event since the previous consume(); resets events. */
  consume(out = this.features) {
    const a = this.acc;
    if (out !== this.features) Object.assign(out, this.features, { bands: { ...this.features.bands }, flux: { ...this.features.flux } });
    out.onsets = { low: a.onsets.low, mid: a.onsets.mid, high: a.onsets.high, any: a.onsets.any };
    out.strength = { low: a.strength.low, mid: a.strength.mid, high: a.strength.high };
    out.beat = a.beat;
    a.onsets.low = a.onsets.mid = a.onsets.high = a.onsets.any = false;
    a.strength.low = a.strength.mid = a.strength.high = 0;
    a.beat = false;
    return out;
  }

  reset() { this.beat.reset(); this.lastTime = 0; this._lastBeatIndex = -1; }
}

/** Re-express a beat-clock reading at half or double tempo. */
export function scaleBeat(b, scale) {
  if (!b.period || scale === 1) return b;
  if (scale === 2) {
    const idx = b.beatIndex * 2 + (b.phase >= 0.5 ? 1 : 0);
    return { ...b, bpm: b.bpm * 2, period: b.period / 2, beatIndex: idx, phase: (b.phase * 2) % 1 };
  }
  if (scale === 0.5) {
    const idx = Math.floor(b.beatIndex / 2);
    const phase = (((b.beatIndex % 2) + 2) % 2 + b.phase) / 2;
    return { ...b, bpm: b.bpm / 2, period: b.period * 2, beatIndex: idx, phase };
  }
  return b;
}

export function emptyFeatures() {
  return {
    time: 0, dt: 0, rms: 0,
    bands: { low: 0, mid: 0, high: 0 },
    flux: { low: 0, mid: 0, high: 0 },
    onsets: { low: false, mid: false, high: false, any: false },
    strength: { low: 0, mid: 0, high: 0 },
    bpm: 0, phase: 0, beat: false, beatIndex: -1, confidence: 0, locked: false,
    spectrum: new Uint8Array(0),
  };
}
