import { OnsetDetector, BeatTracker, EnvelopeFollower } from './dsp.js';

/**
 * Web Audio front-end. Owns the AudioContext, an AnalyserNode and whatever source is
 * currently playing (file, mic, or the built-in demo drum machine), and turns the
 * spectrum into a per-frame `AudioFeatures` object the dancer consumes.
 *
 * @typedef {object} AudioFeatures
 * @property {number} time            audio-clock seconds
 * @property {number} dt
 * @property {number} rms             overall loudness 0..1 (smoothed)
 * @property {{low:number, mid:number, high:number}} bands   smoothed band energy 0..1
 * @property {{low:number, mid:number, high:number}} flux    raw per-band spectral flux
 * @property {{low:boolean, mid:boolean, high:boolean, any:boolean}} onsets  transient this frame
 * @property {{low:number, mid:number, high:number}} strength  0..1 salience of each onset
 * @property {number} bpm
 * @property {number} phase           beat phase 0..1
 * @property {boolean} beat           true on the frame a beat boundary is crossed
 * @property {number} beatIndex
 * @property {number} confidence      0..1 how many recent predicted beats were confirmed
 * @property {boolean} locked
 * @property {Uint8Array} spectrum
 */
export class AudioAnalyzer {
  constructor({ fftSize = 2048 } = {}) {
    this.fftSize = fftSize;
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.source = null;
    this.sourceKind = 'none';
    this.mediaEl = null;
    this.demo = null;
    this.onset = null;
    this.beat = new BeatTracker();
    this.rmsEnv = new EnvelopeFollower(0.02, 0.25);
    this.bandEnv = {
      low: new EnvelopeFollower(0.015, 0.18),
      mid: new EnvelopeFollower(0.015, 0.18),
      high: new EnvelopeFollower(0.01, 0.12),
    };
    this.freq = null;
    this.wave = null;
    this.lastTime = 0;
    this.manualBpm = 0; // >0 => override tracker tempo (phase still nudged by onsets)
    this.tempoScale = 1; // 0.5 / 1 / 2: user correction for octave-ambiguous tempos
    /** @type {AudioFeatures} */
    this.features = AudioAnalyzer.emptyFeatures();
    // Analysis runs on its own high-rate timer (independent of the render loop) so onset timing
    // stays accurate even when rendering drops to a low frame rate. Events are accumulated here
    // and handed out on the next `update()` call.
    this.acc = { onsets: { low: false, mid: false, high: false, any: false }, strength: { low: 0, mid: 0, high: 0 }, beat: false };
    this.analysisHz = 120;
    this._timer = null;
    this._lastBeatIndex = -1;
  }

  static emptyFeatures() {
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

  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = 0.0; // we do our own smoothing; raw spectra give sharper onsets
      this.gain = this.ctx.createGain();
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.wave = new Float32Array(this.analyser.fftSize);
      this.onset = new OnsetDetector({ sampleRate: this.ctx.sampleRate, fftSize: this.fftSize });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this._timer) this._timer = setInterval(() => this.analyze(), Math.round(1000 / this.analysisHz));
    return this.ctx;
  }

  _disconnectSource() {
    if (this.source) { try { this.source.disconnect(); } catch {} }
    if (this.demo) { this.demo.stop(); this.demo = null; }
    if (this.mediaEl) { this.mediaEl.pause(); this.mediaEl = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.source = null;
    this.sourceKind = 'none';
    this.beat.reset();
  }

  /** Play an audio File / Blob / URL through the analyser. Returns the <audio> element. */
  async playFile(fileOrUrl) {
    await this.ensureContext();
    this._disconnectSource();
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.loop = true;
    el.src = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
    this.mediaEl = el;
    this.source = this.ctx.createMediaElementSource(el);
    this.source.connect(this.gain);
    this.gain.gain.value = 1;
    this.sourceKind = 'file';
    await el.play();
    return el;
  }

  /** Use the microphone / line-in. Monitoring is muted to avoid feedback. */
  async useMicrophone() {
    await this.ensureContext();
    this._disconnectSource();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    // analyse but don't monitor: route through a muted gain into the analyser only
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.source.connect(this.analyser);
    this.analyser.disconnect();
    this.analyser.connect(mute); mute.connect(this.ctx.destination);
    this.sourceKind = 'mic';
  }

  /** Built-in drum machine so the app can be tried without any audio file. */
  async playDemo(bpm = 124) {
    await this.ensureContext();
    this._disconnectSource();
    this.analyser.disconnect(); this.analyser.connect(this.ctx.destination);
    this.demo = new DemoBeat(this.ctx, this.gain, bpm);
    this.demo.start();
    this.sourceKind = 'demo';
  }

  stop() { this._disconnectSource(); }

  get isPlaying() {
    if (this.sourceKind === 'file') return this.mediaEl && !this.mediaEl.paused;
    return this.sourceKind !== 'none';
  }

  /** Runs on the analysis timer: pull a spectrum, detect transients, advance the beat clock. */
  analyze() {
    if (!this.ctx || !this.analyser) return;
    const now = this.ctx.currentTime;
    const dt = this.lastTime ? Math.min(0.1, now - this.lastTime) : 1 / this.analysisHz;
    if (dt <= 0) return; // audio clock hasn't advanced (suspended / same render quantum)
    this.lastTime = now;

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);

    let sum = 0;
    for (let i = 0; i < this.wave.length; i++) sum += this.wave[i] * this.wave[i];
    const rms = Math.sqrt(sum / this.wave.length);

    const o = this.onset.process(this.freq, now);
    this.beat.addNovelty(now, o.flux.low * 1.0 + o.flux.mid * 0.7 + o.flux.high * 0.35);
    for (const band of ['low', 'mid', 'high']) {
      if (o.onsets[band]) {
        this.beat.addOnset(now, o.strength[band] * (band === 'low' ? 1.0 : band === 'mid' ? 0.8 : 0.35));
        this.acc.onsets[band] = true; this.acc.onsets.any = true;
        this.acc.strength[band] = Math.max(this.acc.strength[band], o.strength[band]);
      }
    }
    if (this.manualBpm > 0) { this.beat.period = 60 / this.manualBpm; this.beat.bpm = this.manualBpm; }
    const b = scaleBeat(this.beat.update(now), this.tempoScale);
    // beat edge on the (possibly rescaled) clock
    if (b.period > 0 && b.beatIndex !== this._lastBeatIndex) { this.acc.beat = true; }
    this._lastBeatIndex = b.beatIndex;

    const f = this.features;
    f.time = now; f.dt = dt;
    f.rms = this.rmsEnv.process(Math.min(1, rms * 2.5), dt);
    f.bands.low = this.bandEnv.low.process(o.energy.low, dt);
    f.bands.mid = this.bandEnv.mid.process(o.energy.mid, dt);
    f.bands.high = this.bandEnv.high.process(o.energy.high, dt);
    f.flux = o.flux;
    f.bpm = b.bpm; f.phase = b.phase; f.beatIndex = b.beatIndex;
    f.confidence = b.confidence; f.locked = b.locked;
    f.spectrum = this.freq;
  }

  /**
   * Call once per animation frame. Returns the latest continuous features plus every transient /
   * beat event that happened since the previous call.
   */
  update() {
    if (!this.ctx || !this.analyser) return this.features;
    const f = this.features, a = this.acc;
    f.onsets = { low: a.onsets.low, mid: a.onsets.mid, high: a.onsets.high, any: a.onsets.any };
    f.strength = { low: a.strength.low, mid: a.strength.mid, high: a.strength.high };
    f.beat = a.beat;
    a.onsets.low = a.onsets.mid = a.onsets.high = a.onsets.any = false;
    a.strength.low = a.strength.mid = a.strength.high = 0;
    a.beat = false;
    return f;
  }
}

/** Re-express a beat-clock reading at half or double tempo. */
export function scaleBeat(b, scale) {
  if (!b.period || scale === 1) return b;
  if (scale === 2) {
    const idx = b.beatIndex * 2 + (b.phase >= 0.5 ? 1 : 0);
    const phase = (b.phase * 2) % 1;
    return { ...b, bpm: b.bpm * 2, period: b.period / 2, beatIndex: idx, phase };
  }
  if (scale === 0.5) {
    const idx = Math.floor(b.beatIndex / 2);
    const phase = (((b.beatIndex % 2) + 2) % 2 + b.phase) / 2;
    return { ...b, bpm: b.bpm / 2, period: b.period * 2, beatIndex: idx, phase };
  }
  return b;
}

/**
 * Tiny synthesised four-on-the-floor groove (kick / snare / hats / bass) with lookahead scheduling.
 */
export class DemoBeat {
  constructor(ctx, out, bpm = 124) {
    this.ctx = ctx; this.out = out; this.bpm = bpm;
    this.step = 0; this.nextTime = 0; this.timer = null;
    this.pattern = {
      kick:  [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,1],
      snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
      hat:   [1,0,1,0, 1,0,1,1, 1,0,1,0, 1,0,1,0],
      bass:  [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,0],
    };
    this.noise = this._noiseBuffer();
  }
  _noiseBuffer() {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  start() {
    this.nextTime = this.ctx.currentTime + 0.05;
    this.step = 0;
    this.timer = setInterval(() => this._schedule(), 25);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  _schedule() {
    const stepDur = 60 / this.bpm / 4;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      const s = this.step % 16, t = this.nextTime;
      if (this.pattern.kick[s]) this._kick(t);
      if (this.pattern.snare[s]) this._snare(t);
      if (this.pattern.hat[s]) this._hat(t, s % 4 === 0 ? 0.5 : 0.3);
      if (this.pattern.bass[s]) this._bass(t, stepDur * 0.9);
      this.nextTime += stepDur; this.step++;
    }
  }
  _kick(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(1.0, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(this.out); o.start(t); o.stop(t + 0.4);
  }
  _snare(t) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(f); f.connect(g); g.connect(this.out); n.start(t); n.stop(t + 0.2);
    const o = this.ctx.createOscillator(), g2 = this.ctx.createGain();
    o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.08);
    g2.gain.setValueAtTime(0.4, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g2); g2.connect(this.out); o.start(t); o.stop(t + 0.12);
  }
  _hat(t, vel) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vel * 0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f); f.connect(g); g.connect(this.out); n.start(t); n.stop(t + 0.06);
  }
  _bass(t, dur) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = 55;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    g.gain.setValueAtTime(0.25, t); g.gain.setTargetAtTime(0.0001, t + dur * 0.6, 0.03);
    o.connect(f); f.connect(g); g.connect(this.out); o.start(t); o.stop(t + dur + 0.1);
  }
}
