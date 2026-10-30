import test from 'node:test';
import assert from 'node:assert/strict';
import { OnsetDetector, BeatTracker, EnvelopeFollower, Spring } from '../src/audio/dsp.js';

const SR = 48000, FFT = 2048, BINS = FFT / 2, BIN_HZ = SR / FFT;
const FPS = 60;

/** Synthesise a byte spectrum stream: decaying kicks (low band) on every beat, snares (mid) on 2 & 4, hats (high) on 8ths, plus noise. */
function* synthSpectra({ bpm, seconds, noise = 18, seed = 1 }) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const period = 60 / bpm;
  const spec = new Uint8Array(BINS);
  for (let f = 0; f < seconds * FPS; f++) {
    const t = f / FPS;
    const beatNo = Math.floor(t / period + 1e-9), sinceBeat = t - beatNo * period;
    const isBeat = beatNo !== Math.floor((t - 1 / FPS) / period + 1e-9);
    const since8th = t % (period / 2);
    const kick = Math.exp(-sinceBeat / 0.06);
    const snare = beatNo % 2 === 1 ? Math.exp(-sinceBeat / 0.05) : 0;
    const hat = Math.exp(-since8th / 0.025);
    for (let i = 0; i < BINS; i++) {
      const hz = i * BIN_HZ;
      let v = noise * rnd();
      if (hz < 160) v += 200 * kick;
      else if (hz < 2500) v += 120 * snare + 25 * kick;
      else v += 110 * hat * (hz < 12000 ? 1 : 0.5);
      spec[i] = Math.min(255, v | 0);
    }
    yield { t, spec, isBeat };
  }
}

function feed(bt, r, t) {
  bt.addNovelty(t, r.flux.low * 1.0 + r.flux.mid * 0.7 + r.flux.high * 0.35);
  for (const band of ['low', 'mid', 'high']) {
    if (r.onsets[band]) bt.addOnset(t, r.strength[band] * (band === 'low' ? 1 : band === 'mid' ? 0.8 : 0.35));
  }
}

/** The demo drum machine's pattern (incl. a dotted-eighth bass line) rendered as spectra at a given fps. */
function* synthGroove({ bpm, seconds, fps = 100, noise = 15, seed = 7 }) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const kick = [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,1], snare = [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0];
  const hat = [1,0,1,0, 1,0,1,1, 1,0,1,0, 1,0,1,0], bass = [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,0];
  const step = 60 / bpm / 4;
  const spec = new Uint8Array(BINS);
  const env = (arr, t, tau) => { let v = 0; for (let k = 0; k < 64; k++) { const idx = Math.floor(t / step) - k; if (idx < 0) break; if (arr[((idx % 16) + 16) % 16]) { const dt = t - idx * step; v = Math.max(v, Math.exp(-dt / tau)); } } return v; };
  for (let f = 0; f < seconds * fps; f++) {
    const t = f / fps;
    const k = env(kick, t, 0.06), sn = env(snare, t, 0.05), h = env(hat, t, 0.02), b = env(bass, t, 0.08);
    for (let i = 0; i < BINS; i++) {
      const hz = i * BIN_HZ; let v = noise * rnd();
      if (hz < 160) v += 200 * k + 110 * b;
      else if (hz < 2500) v += 120 * sn + 25 * k + 20 * b;
      else v += 110 * h;
      spec[i] = Math.min(255, v | 0);
    }
    const beatNo = Math.floor(t / (step * 4) + 1e-9);
    yield { t, spec, isBeat: beatNo !== Math.floor((t - 1 / fps) / (step * 4) + 1e-9) };
  }
}

test('EnvelopeFollower attacks fast and releases slow', () => {
  const env = new EnvelopeFollower(0.01, 0.2);
  env.process(1, 0.05);
  assert.ok(env.value > 0.95, `attack reached ${env.value}`);
  env.process(0, 0.05);
  assert.ok(env.value > 0.7 && env.value < 0.85, `release ${env.value}`);
});

test('Spring returns to rest after an impulse', () => {
  const sp = new Spring(120, 12);
  sp.impulse(2);
  let peak = 0;
  for (let i = 0; i < 120; i++) { sp.step(1 / 60); peak = Math.max(peak, sp.x); }
  assert.ok(peak > 0.05, 'moved');
  assert.ok(Math.abs(sp.x) < 0.01, `settled x=${sp.x}`);
});

test('OnsetDetector fires low-band onsets on kicks and not in between', () => {
  const det = new OnsetDetector({ sampleRate: SR, fftSize: FFT });
  let hitsOnBeat = 0, hitsOffBeat = 0, beats = 0;
  let lastBeatT = -1;
  for (const { t, spec, isBeat } of synthSpectra({ bpm: 120, seconds: 8 })) {
    if (isBeat) { beats++; lastBeatT = t; }
    const r = det.process(spec, t);
    if (r.onsets.low) {
      if (t - lastBeatT <= 2.5 / FPS) hitsOnBeat++; else hitsOffBeat++;
    }
  }
  assert.ok(beats >= 15, `beats ${beats}`);
  assert.ok(hitsOnBeat >= beats - 3, `on-beat hits ${hitsOnBeat} / ${beats}`);
  assert.ok(hitsOffBeat <= 2, `off-beat false positives ${hitsOffBeat}`);
});

for (const bpm of [92, 120, 140, 172]) {
  test(`BeatTracker converges to ${bpm} BPM and locks phase`, () => {
    const det = new OnsetDetector({ sampleRate: SR, fftSize: FFT });
    const bt = new BeatTracker();
    let final = null, phaseErrs = [];
    for (const { t, spec, isBeat } of synthSpectra({ bpm, seconds: 12, seed: bpm })) {
      const r = det.process(spec, t);
      feed(bt, r, t);
      final = bt.update(t);
      if (t > 8 && isBeat) {
        // tracker phase at a true beat should be near 0 (or 1)
        const p = final.phase; phaseErrs.push(Math.min(p, 1 - p));
      }
    }
    const err = Math.abs(final.bpm - bpm);
    assert.ok(err < 2.5, `bpm ${final.bpm.toFixed(1)} vs ${bpm}`);
    const meanPhaseErr = phaseErrs.reduce((a, b) => a + b, 0) / phaseErrs.length;
    assert.ok(meanPhaseErr < 0.12, `phase error ${meanPhaseErr.toFixed(3)}`);
    assert.ok(final.confidence > 0.6, `confidence ${final.confidence}`);
    assert.ok(final.locked, 'locked');
  });
}

test('BeatTracker reports no tempo on silence', () => {
  const bt = new BeatTracker();
  const r = bt.update(5);
  assert.equal(r.bpm, 0); assert.equal(r.locked, false);
});

for (const bpm of [92, 124, 160]) {
  test(`BeatTracker resists the dotted-eighth bass line at ${bpm} BPM`, () => {
    const det = new OnsetDetector({ sampleRate: SR, fftSize: FFT, historyFrames: 150 });
    const bt = new BeatTracker();
    let final = null, phaseErrs = [];
    for (const { t, spec, isBeat } of synthGroove({ bpm, seconds: 14 })) {
      const r = det.process(spec, t);
      feed(bt, r, t);
      final = bt.update(t);
      if (t > 9 && isBeat) { const p = final.phase; phaseErrs.push(Math.min(p, 1 - p)); }
    }
    // Half-time is acceptable for strongly backbeat-driven grooves (octave ambiguity); any other
    // ratio (e.g. the dotted-eighth 4:3 grid) is a real error.
    const ratio = final.bpm / bpm;
    const octave = [1, 0.5, 2].find(r => Math.abs(ratio - r) / r < 0.02);
    assert.ok(octave, `bpm ${final.bpm.toFixed(1)} vs ${bpm} (ratio ${ratio.toFixed(3)})`);
    // at true beats the tracked phase must sit on the tracked grid: near 0 (or 0.5 when half-time)
    const errs = phaseErrs.map(e => octave === 0.5 ? Math.min(e, Math.abs(e - 0.5)) : e);
    const meanPhaseErr = errs.reduce((a, b) => a + b, 0) / errs.length;
    assert.ok(meanPhaseErr < 0.15, `phase error ${meanPhaseErr.toFixed(3)}`);
    assert.ok(final.locked, `locked (confidence ${final.confidence.toFixed(2)})`);
  });
}
