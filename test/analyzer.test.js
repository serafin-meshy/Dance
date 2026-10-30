import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleBeat } from '../src/audio/AudioAnalyzer.js';

test('scaleBeat doubles and halves the beat clock consistently', () => {
  const b = { bpm: 100, period: 0.6, beatIndex: 5, phase: 0.75, beat: false, confidence: 1, locked: true };
  const d = scaleBeat(b, 2);
  assert.equal(d.bpm, 200); assert.equal(d.beatIndex, 11); assert.ok(Math.abs(d.phase - 0.5) < 1e-9);
  const h = scaleBeat(b, 0.5);
  assert.equal(h.bpm, 50); assert.equal(h.beatIndex, 2); assert.ok(Math.abs(h.phase - 0.875) < 1e-9);
  assert.equal(scaleBeat(b, 1), b);
  assert.equal(scaleBeat({ ...b, period: 0 }, 2).bpm, 100);
});
