import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { buildMannequin } from '../src/viewer/Mannequin.js';
import { buildBoneMap } from '../src/rig/BoneMap.js';
import { Dancer } from '../src/rig/Dancer.js';
import { AudioAnalyzer } from '../src/audio/AudioAnalyzer.js';
import { MOVES, zeroPose } from '../src/rig/Moves.js';

function features(over = {}) {
  const f = AudioAnalyzer.emptyFeatures();
  return Object.assign(f, over);
}

test('mannequin maps 100% by name', () => {
  const m = buildMannequin();
  const map = buildBoneMap(m);
  assert.equal(map.coverage, 1);
  assert.equal(map.report.filter(r => !r.bone).length, 0, 'all slots resolved');
});

test('every move produces finite pose values', () => {
  for (const [name, mv] of Object.entries(MOVES)) {
    for (let b = 0; b < 8; b += 0.37) {
      const p = zeroPose();
      mv.fn({ b, phase: b % 1, e: 0.5, bands: { low: .3, mid: .3, high: .3 }, s2: Math.sin(Math.PI * b), s4: Math.sin(Math.PI * b / 2), s8: Math.sin(Math.PI * b / 4) }, p);
      for (const [k, v] of Object.entries(p)) assert.ok(Number.isFinite(v), `${name}.${k} = ${v}`);
    }
  }
});

test('dancer moves bones on a kick, raises arms toward up, and returns to rest in silence', () => {
  const m = buildMannequin();
  const map = buildBoneMap(m);
  const d = new Dancer(m, map);
  const hips = map.bones.hips, head = map.bones.head, lArm = map.bones.leftUpperArm, lFore = map.bones.leftLowerArm;
  const restHipsY = hips.position.y;
  const restHeadQ = head.quaternion.clone();

  // locked beat, a kick + snare on frame 0
  let minHipsY = Infinity;
  for (let i = 0; i < 40; i++) {
    const f = features({
      rms: 0.5, bands: { low: 0.5, mid: 0.3, high: 0.3 }, bpm: 120, locked: true, confidence: 0.9,
      beatIndex: Math.floor(i / 30), phase: (i % 30) / 30, beat: i % 30 === 0,
      onsets: { low: i === 0, mid: i === 0, high: false, any: i === 0 },
      strength: { low: i === 0 ? 1 : 0, mid: i === 0 ? 1 : 0, high: 0 },
    });
    d.update(f, 1 / 60);
    minHipsY = Math.min(minHipsY, hips.position.y);
    m.traverse(o => { if (o.isBone) { assert.ok(Number.isFinite(o.quaternion.x) && Number.isFinite(o.position.y), `finite ${o.name}`); } });
  }
  assert.ok(minHipsY < restHipsY - 0.005, `hips dropped on kick: ${minHipsY} < ${restHipsY}`);
  assert.ok(head.quaternion.angleTo(restHeadQ) > 0.01, 'head nodded');

  // arm "raise" must move the forearm upward in world space, whichever way the rig's axes point
  d.setClip(null);
  d.params.autoMoves = false;
  const before = lFore.getWorldPosition(new Vector3());
  // force a pure raise by applying the pose directly
  for (const [b, r] of d.rest) { b.quaternion.copy(r.q); b.position.copy(r.p); }
  const p = zeroPose(); p.armRaiseL = 1.0;
  d.applyPose(p, 1);
  m.updateWorldMatrix(true, true);
  const after = lFore.getWorldPosition(new Vector3());
  assert.ok(after.y > before.y + 0.05, `left forearm went up: ${before.y.toFixed(3)} -> ${after.y.toFixed(3)}`);

  // elbow bend moves the hand forward (+Z) relative to the forearm
  for (const [b, r] of d.rest) { b.quaternion.copy(r.q); b.position.copy(r.p); }
  const hand = map.bones.leftHand;
  const h0 = hand.getWorldPosition(new Vector3());
  const p2 = zeroPose(); p2.elbowL = 1.0; d.applyPose(p2, 1); m.updateWorldMatrix(true, true);
  const h1 = hand.getWorldPosition(new Vector3());
  assert.ok(h1.z > h0.z + 0.05, `hand moved forward: ${h0.z.toFixed(3)} -> ${h1.z.toFixed(3)}`);

  // silence: pose decays toward idle breathing, hips come back near rest height
  for (let i = 0; i < 240; i++) d.update(features({ rms: 0, bpm: 0, locked: false }), 1 / 60);
  assert.ok(Math.abs(hips.position.y - restHipsY) < 0.02, `hips near rest: ${hips.position.y} vs ${restHipsY}`);
  assert.equal(d.stats.lastMove, 'idle');
});

test('clip sync drives action time from the beat clock', async () => {
  const { AnimationClip, QuaternionKeyframeTrack } = await import('three');
  const m = buildMannequin();
  const map = buildBoneMap(m);
  const d = new Dancer(m, map);
  const head = map.bones.head;
  const track = new QuaternionKeyframeTrack(`${head.name}.quaternion`, [0, 1, 2], [0,0,0,1, 0,0.7071,0,0.7071, 0,0,0,1]);
  const clip = new AnimationClip('spin', 2, [track]);
  d.setClip(clip);
  d.params.beatsPerLoop = 2; d.params.proceduralWeight = 0;
  d.update(features({ rms: 0.4, bpm: 120, locked: true, beatIndex: 4, phase: 0.5 }), 1 / 60); // b = 4.5 -> frac 0.25 -> t = 0.5
  assert.ok(Math.abs(d.action.time - 0.5) < 1e-6, `action.time ${d.action.time}`);
  d.update(features({ rms: 0.4, bpm: 120, locked: true, beatIndex: 5, phase: 0.0 }), 1 / 60); // b = 5 -> frac 0.5 -> t = 1.0
  assert.ok(Math.abs(d.action.time - 1.0) < 1e-6, `action.time ${d.action.time}`);
});

test('T-pose rigs get their arms lowered to a relaxed hang before choreography', () => {
  const m = buildMannequin({ armDroopDeg: 0 });   // T-pose
  const map = buildBoneMap(m);
  const d = new Dancer(m, map);
  assert.ok(d.neutral.armRaiseL < -1.0 && d.neutral.armRaiseR < -1.0, `neutral ${JSON.stringify(d.neutral)}`);
  // apply the zero pose: forearm should now hang well below the shoulder
  d.applyPose(zeroPose(), 1); m.updateWorldMatrix(true, true);
  const sh = map.bones.leftUpperArm.getWorldPosition(new Vector3()), fa = map.bones.leftLowerArm.getWorldPosition(new Vector3());
  assert.ok(fa.y < sh.y - 0.15, `forearm below shoulder: ${fa.y.toFixed(2)} vs ${sh.y.toFixed(2)}`);
  // A-pose (arms 65 deg from vertical) needs less correction than T-pose; a rig already hanging
  // at ~20 deg needs none, and arms are never raised by the correction
  const m2 = buildMannequin({ armDroopDeg: 25 });
  const d2 = new Dancer(m2, buildBoneMap(m2));
  assert.ok(d2.neutral.armRaiseL < 0 && d2.neutral.armRaiseL > d.neutral.armRaiseL, `A-pose neutral ${d2.neutral.armRaiseL}`);
  const m3 = buildMannequin({ armDroopDeg: 70 });
  const d3 = new Dancer(m3, buildBoneMap(m3));
  assert.ok(Math.abs(d3.neutral.armRaiseL) < 0.05, `relaxed neutral ${d3.neutral.armRaiseL}`);
});
