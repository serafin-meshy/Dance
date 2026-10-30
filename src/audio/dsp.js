/**
 * Pure DSP building blocks. No DOM / Web Audio here so everything is unit-testable in Node.
 *
 *  - EnvelopeFollower : asymmetric attack / release smoother
 *  - OnsetDetector    : per-band positive spectral flux + adaptive threshold -> transient events
 *  - BeatTracker      : tempo (BPM) estimation from onset intervals + phase-locked beat clock
 */

export class EnvelopeFollower {
  /**
   * @param {number} attack  seconds to reach ~63% on a rising edge
   * @param {number} release seconds to decay ~63% on a falling edge
   */
  constructor(attack = 0.01, release = 0.15) {
    this.attack = attack;
    this.release = release;
    this.value = 0;
  }
  process(x, dt) {
    const tau = x > this.value ? this.attack : this.release;
    const a = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    this.value += (x - this.value) * a;
    return this.value;
  }
}

/** Critically-damped-ish spring used for impulses (bounce, squash, arm pumps). */
export class Spring {
  constructor(stiffness = 120, damping = 12) {
    this.k = stiffness;
    this.c = damping;
    this.x = 0;
    this.v = 0;
  }
  impulse(dv) { this.v += dv; }
  set(x) { this.x = x; this.v = 0; }
  step(dt, target = 0) {
    // semi-implicit Euler, sub-stepped for stability at low frame rates
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - target) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

class RingStats {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.size = size;
    this.i = 0;
    this.n = 0;
  }
  push(v) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.size;
    if (this.n < this.size) this.n++;
  }
  meanStd() {
    if (this.n === 0) return [0, 0];
    let s = 0, s2 = 0;
    for (let k = 0; k < this.n; k++) { const v = this.buf[k]; s += v; s2 += v * v; }
    const mean = s / this.n;
    const variance = Math.max(0, s2 / this.n - mean * mean);
    return [mean, Math.sqrt(variance)];
  }
}

/** Default frequency bands (Hz). "low" catches kicks, "mid" snares/claps, "high" hats. */
export const DEFAULT_BANDS = {
  low:  { lo: 30,   hi: 160,   k: 1.6, floor: 0.04, minIOI: 0.11 },
  mid:  { lo: 160,  hi: 2500,  k: 1.8, floor: 0.05, minIOI: 0.09 },
  high: { lo: 2500, hi: 16000, k: 2.0, floor: 0.05, minIOI: 0.06 },
};

export class OnsetDetector {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate
   * @param {number} opts.fftSize       analyser fftSize (bin count = fftSize/2)
   * @param {number} [opts.historyFrames=90] frames of flux history for the adaptive threshold (~1.5s @60fps)
   * @param {object} [opts.bands]
   */
  constructor({ sampleRate, fftSize, historyFrames = 90, bands = DEFAULT_BANDS }) {
    this.sampleRate = sampleRate;
    this.binCount = fftSize / 2;
    this.binHz = sampleRate / fftSize;
    this.bands = {};
    for (const [name, b] of Object.entries(bands)) {
      const lo = Math.max(1, Math.floor(b.lo / this.binHz));
      const hi = Math.min(this.binCount - 1, Math.ceil(b.hi / this.binHz));
      this.bands[name] = {
        ...b, loBin: lo, hiBin: hi,
        stats: new RingStats(historyFrames),
        prevFlux: 0, lastOnset: -Infinity, energy: 0,
      };
    }
    this.prev = new Float32Array(this.binCount);
    this.cur = new Float32Array(this.binCount);
    this.frame = 0;
  }

  /**
   * @param {Uint8Array|Float32Array} spectrum  byte (0..255) or linear-magnitude spectrum, length binCount
   * @param {number} time seconds
   * @returns {{ flux: Record<string, number>, onsets: Record<string, boolean>, strength: Record<string, number>, energy: Record<string, number>, any: boolean }}
   */
  process(spectrum, time) {
    const isByte = spectrum instanceof Uint8Array;
    const cur = this.cur;
    for (let i = 0; i < this.binCount; i++) {
      // perceptual-ish compression so loud bins don't dominate
      const m = isByte ? spectrum[i] / 255 : spectrum[i];
      cur[i] = Math.log1p(8 * m) / Math.log1p(8);
    }

    const flux = {}, onsets = {}, strength = {}, energy = {};
    let any = false;
    for (const [name, b] of Object.entries(this.bands)) {
      let f = 0, e = 0;
      for (let i = b.loBin; i <= b.hiBin; i++) {
        const d = cur[i] - this.prev[i];
        if (d > 0) f += d;
        e += cur[i];
      }
      const width = b.hiBin - b.loBin + 1;
      f /= width;                   // normalise so bands are comparable
      e /= width;
      b.energy = e;

      const [mean, std] = b.stats.meanStd();
      const threshold = mean + b.k * std + b.floor;
      const rising = f > b.prevFlux;
      const refractoryOk = time - b.lastOnset >= b.minIOI;
      const hit = this.frame > 3 && rising && refractoryOk && f > threshold;

      if (hit) {
        b.lastOnset = time;
        any = true;
      }
      flux[name] = f;
      energy[name] = e;
      onsets[name] = hit;
      // 0..1-ish salience: how far above threshold relative to the typical deviation
      strength[name] = hit ? Math.min(1, (f - threshold) / (std * 3 + b.floor) + 0.35) : 0;

      b.stats.push(f);
      b.prevFlux = f;
    }
    this.prev.set(cur);
    this.frame++;
    return { flux, onsets, strength, energy, any };
  }
}

/**
 * Tempo + beat phase estimation.
 *
 * Tempo: autocorrelation of a continuous "novelty" curve (band-weighted spectral flux sampled at
 * 100 Hz over the last ~8 s) with harmonic support (lag P, 2P, 3P, 4P) and a weak log-tempo prior.
 * This is far more robust to syncopation (dotted-eighth bass lines, off-beat hats) than scoring
 * discrete inter-onset intervals.
 * Phase: a free-running clock nudged toward onsets that land near predicted beats (PLL-style),
 * re-phased periodically to the strength-weighted maximum.
 */
export class BeatTracker {
  constructor({
    minBpm = 70, maxBpm = 180, window = 8.0, reestimateEvery = 0.5,
    priorBpm = 115, priorWidth = 0.9, hysteresis = 1.12, phaseGain = 0.35, novHz = 100, switchVotes = 3, continuity = 0.8, minOnsets = 6,
  } = {}) {
    this.minBpm = minBpm; this.maxBpm = maxBpm;
    this.window = window;
    this.reestimateEvery = reestimateEvery;
    this.priorBpm = priorBpm; this.priorWidth = priorWidth;
    this.hysteresis = hysteresis;
    this.phaseGain = phaseGain;
    this.switchVotes = switchVotes;
    this.continuity = continuity;
    this.minOnsets = minOnsets;
    this._pending = null;
    this._stable = 0;      // consecutive estimates that agreed with the current tempo

    /** @type {{t:number, s:number}[]} */
    this.onsets = [];
    this.bpm = 0;
    this.period = 0;
    this.score = 0;
    this.anchor = 0;        // time of a beat (phase reference)
    this.confidence = 0;
    this.beatIndex = -1;
    this.lastEstimate = -Infinity;
    this.hits = [];         // recent predicted beats: 1 if an onset confirmed it
    this._locked = false;

    // novelty ring buffer
    this.novHz = novHz;
    this.novLen = Math.round(window * novHz);
    this.nov = new Float32Array(this.novLen);
    this.lastBin = -1; this.firstBin = -1;
    this._lin = new Float32Array(this.novLen);
    this._ac = new Float32Array(this.novLen);

    // candidate periods, 0.5 BPM resolution
    this.candidates = [];
    for (let b = minBpm; b <= maxBpm; b += 0.5) this.candidates.push(60 / b);
  }

  /** Feed the continuous onset-strength ("novelty") value for the current analysis frame. */
  addNovelty(time, value) {
    const bin = Math.floor(time * this.novHz);
    if (this.firstBin < 0) { this.firstBin = bin; this.lastBin = bin - 1; }
    if (bin > this.lastBin) {
      // zero-fill skipped bins, then start the new one
      const gap = Math.min(this.novLen, bin - this.lastBin);
      for (let k = 1; k <= gap; k++) this.nov[(this.lastBin + k) % this.novLen] = 0;
      this.lastBin = bin;
    }
    const i = ((bin % this.novLen) + this.novLen) % this.novLen;
    if (value > this.nov[i]) this.nov[i] = value;
  }

  addOnset(time, strength = 1) {
    this.onsets.push({ t: time, s: strength });
    const cutoff = time - this.window;
    while (this.onsets.length && this.onsets[0].t < cutoff) this.onsets.shift();

    // phase lock: nudge anchor if this onset is close to a predicted beat
    if (this.period > 0) {
      const k = Math.round((time - this.anchor) / this.period);
      const predicted = this.anchor + k * this.period;
      const err = time - predicted;             // >0 => onset late vs clock
      const tol = this.period * 0.22;
      if (Math.abs(err) < tol) {
        this.anchor += err * this.phaseGain * Math.min(1, strength + 0.3);
        this._recordHit(k, 1);
      }
    }
  }

  _recordHit(k, v) {
    this.hits.push(v);
    if (this.hits.length > 16) this.hits.shift();
  }

  _prior(P) {
    const lb = Math.log2((60 / P) / this.priorBpm);
    return Math.exp(-(lb * lb) / (2 * this.priorWidth * this.priorWidth));
  }

  _estimateTempo(now) {
    const have = this.lastBin - this.firstBin + 1;
    if (this.firstBin < 0 || have < 2.5 * this.novHz) return;
    // Too few transients in the window (sparse / ambient material): there is no beat to find,
    // so keep whatever we have rather than chasing noise in the autocorrelation.
    if (this.onsets.length < this.minOnsets) return;
    const N = Math.min(this.novLen, have);
    // linearise ring: oldest -> newest ending at lastBin
    const lin = this._lin;
    let mean = 0;
    for (let i = 0; i < N; i++) {
      const bin = this.lastBin - (N - 1) + i;
      const v = this.nov[((bin % this.novLen) + this.novLen) % this.novLen];
      lin[i] = v; mean += v;
    }
    mean /= N;
    let energy = 0;
    for (let i = 0; i < N; i++) { lin[i] -= mean; energy += lin[i] * lin[i]; }
    if (energy < 1e-9) return;

    // autocorrelation for lags up to 4 * longest period (or half the window)
    const maxLag = Math.min(N - 2, Math.ceil(4 * (60 / this.minBpm) * this.novHz));
    const ac = this._ac;
    for (let lag = 1; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < N; i++) s += lin[i] * lin[i + lag];
      ac[lag] = s / (N - lag);
    }
    const acAt = (lagF) => {
      if (lagF < 1 || lagF > maxLag) return 0;
      const i = Math.floor(lagF), t = lagF - i;
      return ac[i] * (1 - t) + (i + 1 <= maxLag ? ac[i + 1] : ac[i]) * t;
    };
    const scoreFor = (P) => {
      const L = P * this.novHz;
      let sc = acAt(L) + 0.5 * acAt(2 * L) + 0.33 * acAt(3 * L) + 0.25 * acAt(4 * L);
      // Octave disambiguation: if the half period is itself a strong pulse, the true tempo is
      // more likely twice this candidate (kick on every beat vs. snare every 2 beats).
      sc -= 0.5 * Math.max(0, acAt(L / 2));
      return Math.max(0, sc) * this._prior(P);
    };

    // Continuity: once we have a tempo, favour candidates near it or at an octave of it, so a
    // few bars of syncopation can't flip the clock to a 3:4 / 4:3 relative.
    // Only trust continuity once the tempo has been confirmed by a few consecutive estimates;
    // a first guess made 2-3 s into the track must stay easy to overturn.
    const trust = Math.min(1, this._stable / 4);
    const cont = (P) => {
      if (!(this.period > 0) || trust <= 0) return 1;
      const r = Math.log2(P / this.period);
      const d = Math.min(Math.abs(r), Math.abs(r - 1), Math.abs(r + 1));
      return 1 + this.continuity * trust * Math.exp(-(d * d) / (2 * 0.06 * 0.06));
    };
    let best = null, rawBest = null;
    for (const P of this.candidates) {
      const raw = scoreFor(P);
      const sc = raw * cont(P);
      if (!best || sc > best.score) best = { P, score: sc };
      if (!rawBest || raw > rawBest.score) rawBest = { P, score: raw };
    }
    if (!best || best.score <= 0) return;
    // Trust bookkeeping: if the *unboosted* evidence keeps preferring a different tempo, the
    // current lock is probably wrong (e.g. a 3:4 relative picked in the first seconds). Let the
    // continuity trust decay so the switch can happen after ~2 s instead of never.
    if (this.period > 0) {
      const rawCurrent = scoreFor(this.period);
      const rawNear = Math.abs(rawBest.P - this.period) / this.period < 0.04;
      if (!rawNear && rawBest.score > rawCurrent * this.hysteresis) this._stable = Math.max(0, this._stable - 2);
      else this._stable = Math.min(8, this._stable + 1);
    }
    // refine with a finer local search (0.1 BPM)
    const bpm0 = 60 / best.P;
    for (let b = bpm0 - 0.5; b <= bpm0 + 0.5; b += 0.1) {
      const P = 60 / b; const sc = scoreFor(P) * cont(P);
      if (sc > best.score) best = { P, score: sc };
    }

    const currentScore = this.period > 0 ? scoreFor(this.period) * cont(this.period) : 0;
    const isNear = this.period > 0 && Math.abs(best.P - this.period) / this.period < 0.04;
    // a tempo change must win `switchVotes` consecutive estimates before we take it
    if (!isNear && this.period > 0 && best.score > currentScore * this.hysteresis) {
      const same = this._pending && Math.abs(this._pending.P - best.P) / best.P < 0.03;
      this._pending = { P: best.P, votes: same ? this._pending.votes + 1 : 1 };
      const needed = trust >= 1 ? this.switchVotes : 1;
      if (this._pending.votes < needed) { this.lastEstimate = now; this._estimatePhase(now); return; }
      this._pending = null;
      this._stable = 0;
    } else {
      this._pending = null;
    }
    if (this.period === 0 || isNear || best.score > currentScore * this.hysteresis) {
      const on = this.onsets;
      if (this.period === 0) {
        this.anchor = on.length ? on[on.length - 1].t : now;
        this.beatIndex = -1;
      } else if (!isNear) {
        this.anchor = on.length ? on[on.length - 1].t : now;
        this.hits.length = 0;
      }
      this.period = isNear ? this.period * 0.7 + best.P * 0.3 : best.P;
      this.bpm = 60 / this.period;
      this.score = best.score;
    }
    this._estimatePhase(now);
    this.lastEstimate = now;
  }

  /**
   * Pick the beat phase that best explains the strongest recent onsets. Hats on off-beats
   * can otherwise capture the clock half a beat off; weighting by onset strength (kicks are
   * fed in with the highest weight) resolves this. Only re-phase with hysteresis so the
   * clock doesn't jitter.
   */
  _estimatePhase(now) {
    const P = this.period;
    if (!(P > 0) || this.onsets.length < 3) return;
    const sigma = 0.08; // in beats
    const scoreFor = (anchor) => {
      let sc = 0;
      for (const { t, s } of this.onsets) {
        const x = (t - anchor) / P;
        const d = x - Math.round(x);
        // recency weighting: last 4s count most
        const age = Math.max(0, now - t);
        sc += s * Math.exp(-(d * d) / (2 * sigma * sigma)) * Math.exp(-age / 4);
      }
      return sc;
    };
    const K = 24;
    let best = { off: 0, sc: -1 };
    for (let k = 0; k < K; k++) {
      const off = (k / K) * P;
      const sc = scoreFor(this.anchor + off);
      if (sc > best.sc) best = { off, sc };
    }
    // refine around the winner
    for (let k = -3; k <= 3; k++) {
      const off = best.off + (k / (K * 4)) * P;
      const sc = scoreFor(this.anchor + off);
      if (sc > best.sc) best = { off, sc };
    }
    const current = scoreFor(this.anchor);
    // offset wrapped into (-P/2, P/2]
    let off = best.off % P; if (off > P / 2) off -= P;
    const far = Math.abs(off) > 0.15 * P;
    if (far && best.sc > current * 1.25) {
      this.anchor += off;
      this.hits.length = 0;           // confidence restarts after a re-phase
      this.beatIndex = Math.floor((now - this.anchor) / P);
    } else if (!far) {
      this.anchor += off * 0.5;        // gentle correction toward the maximum
    }
  }

  /**
   * Advance the clock. Returns beat phase in [0,1) and whether a beat boundary was crossed.
   * @param {number} now seconds
   */
  update(now) {
    if (now - this.lastEstimate >= this.reestimateEvery) this._estimateTempo(now);
    if (this.period <= 0) {
      return { bpm: 0, period: 0, phase: 0, beat: false, beatIndex: -1, confidence: 0, locked: false };
    }
    const x = (now - this.anchor) / this.period;
    const idx = Math.floor(x);
    const phase = x - idx;
    const beat = idx !== this.beatIndex;
    if (beat) {
      // a beat passed with no confirming onset -> count as a miss (unless already counted)
      if (this.beatIndex >= 0 && idx === this.beatIndex + 1) {
        const lastOn = this.onsets[this.onsets.length - 1];
        const confirmed = lastOn && Math.abs(lastOn.t - (this.anchor + this.beatIndex * this.period)) < this.period * 0.22;
        if (!confirmed) this._recordHit(this.beatIndex, 0);
      }
      this.beatIndex = idx;
    }
    const hits = this.hits.length ? this.hits.reduce((a, b) => a + b, 0) / this.hits.length : 0;
    this.confidence = hits;
    // decay tempo if the music stops
    const lastOn = this.onsets[this.onsets.length - 1];
    const silentFor = lastOn ? now - lastOn.t : Infinity;
    // lock once a few beats have been confirmed; keep it while the music keeps producing onsets
    if (this.hits.length >= 3 && hits > 0.4 && silentFor < 2.5) this._locked = true;
    if (silentFor > 4 || (this.hits.length >= 8 && hits < 0.2)) this._locked = false;
    const locked = this._locked;
    return { bpm: this.bpm, period: this.period, phase, beat, beatIndex: idx, confidence: hits, locked };
  }

  reset() {
    this._locked = false; this._pending = null; this._stable = 0;
    this.nov.fill(0); this.lastBin = -1; this.firstBin = -1;
    this.onsets.length = 0; this.hits.length = 0;
    this.bpm = 0; this.period = 0; this.score = 0; this.anchor = 0; this.beatIndex = -1;
    this.lastEstimate = -Infinity;
  }
}
