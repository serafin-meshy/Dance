import { FeaturePipeline, emptyFeatures, scaleBeat } from './pipeline.js';

export { scaleBeat };

/**
 * Web Audio front-end. Owns the AudioContext, an AnalyserNode and whatever source is
 * currently playing (file, mic, or the built-in demo drum machine). Spectra are pushed into a
 * FeaturePipeline on a high-rate timer (independent of the render loop) and the resulting
 * `AudioFeatures` are consumed once per frame via `update()`.
 *
 * @typedef {object} AudioFeatures
 * @property {number} time            audio-clock seconds
 * @property {number} dt
 * @property {number} rms             overall loudness 0..1 (smoothed)
 * @property {{low:number, mid:number, high:number}} bands   smoothed band energy 0..1
 * @property {{low:number, mid:number, high:number}} flux    raw per-band spectral flux
 * @property {{low:boolean, mid:boolean, high:boolean, any:boolean}} onsets  transient since last frame
 * @property {{low:number, mid:number, high:number}} strength  0..1 salience of each onset
 * @property {number} bpm
 * @property {number} phase           beat phase 0..1
 * @property {boolean} beat           true if a beat boundary was crossed since last frame
 * @property {number} beatIndex
 * @property {number} confidence      0..1 how many recent predicted beats were confirmed
 * @property {boolean} locked
 * @property {Uint8Array} spectrum
 */
export class AudioAnalyzer {
  constructor({ fftSize = 2048, analysisHz = 120 } = {}) {
    this.fftSize = fftSize;
    this.analysisHz = analysisHz;
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.source = null;
    this.sourceKind = 'none';
    this.mediaEl = null;
    this.demo = null;
    this.stream = null;
    this.pipeline = null;
    this.freq = null;
    this.wave = null;
    this._timer = null;
    this._manualBpm = 0;
    this._tempoScale = 1;
    /** @type {AudioFeatures} */
    this.features = emptyFeatures();
    /** The decoded buffer of the last file played (for offline baking). */
    this.lastBuffer = null;
    this.lastFileName = '';
  }

  static emptyFeatures() { return emptyFeatures(); }

  get manualBpm() { return this._manualBpm; }
  set manualBpm(v) { this._manualBpm = v; if (this.pipeline) this.pipeline.manualBpm = v; }
  get tempoScale() { return this._tempoScale; }
  set tempoScale(v) { this._tempoScale = v; if (this.pipeline) this.pipeline.tempoScale = v; }
  get beat() { return this.pipeline?.beat; }

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
      this.pipeline = new FeaturePipeline({ sampleRate: this.ctx.sampleRate, fftSize: this.fftSize, historyFrames: Math.round(this.analysisHz * 1.2) });
      this.pipeline.manualBpm = this._manualBpm; this.pipeline.tempoScale = this._tempoScale;
      this.features = this.pipeline.features;
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
    if (this.pipeline) this.pipeline.reset();
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
    this.lastFile = fileOrUrl;
    this.lastFileName = typeof fileOrUrl === 'string' ? fileOrUrl.split('/').pop() : fileOrUrl.name;
    this.source = this.ctx.createMediaElementSource(el);
    this.source.connect(this.gain);
    this.gain.gain.value = 1;
    this.sourceKind = 'file';
    await el.play();
    return el;
  }

  /** Decode the current file fully (mono Float32) for offline analysis / baking. */
  async decodeCurrentFile() {
    if (!this.lastFile) throw new Error('No audio file loaded');
    await this.ensureContext();
    const ab = typeof this.lastFile === 'string' ? await (await fetch(this.lastFile)).arrayBuffer() : await this.lastFile.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab.slice(0));
    const n = buf.length, ch = buf.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    this.lastBuffer = { pcm: mono, sampleRate: buf.sampleRate, duration: buf.duration };
    return this.lastBuffer;
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

  /** Runs on the analysis timer: pull a spectrum and push it through the pipeline. */
  analyze() {
    if (!this.ctx || !this.analyser) return;
    const now = this.ctx.currentTime;
    if (now <= this.pipeline.lastTime) return; // audio clock hasn't advanced
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (let i = 0; i < this.wave.length; i++) sum += this.wave[i] * this.wave[i];
    this.pipeline.push(this.freq, Math.sqrt(sum / this.wave.length), now);
  }

  /** Call once per animation frame: latest features + all events since the previous call. */
  update() {
    if (!this.pipeline) return this.features;
    return this.pipeline.consume();
  }
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
