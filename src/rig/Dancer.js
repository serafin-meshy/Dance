import { Vector3, Quaternion, Matrix4, AnimationMixer, LoopRepeat, Box3 } from 'three';
import { Spring } from '../audio/dsp.js';
import { MOVES, DANCE_MOVES, POSE_KEYS, zeroPose, lerpPose, pickMove } from './Moves.js';

const _q = new Quaternion(), _q2 = new Quaternion(), _v = new Vector3(), _v2 = new Vector3(), _v3 = new Vector3();
const _m = new Matrix4();
const UP = new Vector3(0, 1, 0);

/**
 * Drives a humanoid skeleton from AudioFeatures.
 *
 * Layering per frame:
 *   1. base  : rest pose, or an AnimationClip (optionally time-locked to the beat clock)
 *   2. move  : the current dance move, cross-faded on switches, scaled by energy
 *   3. hits  : spring impulses from transients (kick -> bounce/knees, snare -> arm pump + nod, hats -> shoulders)
 * All rotations are applied about WORLD axes (converted into each bone's parent space) so the same
 * choreography works regardless of how a given rig orients its bone-local axes.
 */
export class Dancer {
  /**
   * @param {import('three').Object3D} root  the loaded model (scene) containing the skeleton
   * @param {ReturnType<import('./BoneMap.js').buildBoneMap>} boneMap
   */
  constructor(root, boneMap, { forward = new Vector3(0, 0, 1), relaxedArmAngle = 0.35 } = {}) {
    this.root = root;
    this.relaxedArmAngle = relaxedArmAngle;
    this.map = boneMap;
    this.bones = boneMap.bones;
    this.forward = forward.clone().normalize();
    this.side = new Vector3().crossVectors(UP, this.forward).normalize(); // character's left

    this.params = {
      intensity: 1.0,       // overall amplitude
      smoothing: 0.07,      // seconds, pose smoothing time constant
      hitGain: 1.0,         // transient response
      autoMoves: true,
      move: 'groove',
      switchEveryBeats: 8,
      proceduralWeight: 1.0,// how much procedural motion to add on top of a clip
      clipSync: true,       // lock clip playback to the beat clock
      beatsPerLoop: 2,      // clip loop length in beats when synced
      bobOnBeat: 1.0,
    };

    // rest pose
    root.updateWorldMatrix(true, true);
    this.rest = new Map();
    for (const b of new Set(Object.values(this.bones))) {
      this.rest.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
    }
    const box = new Box3().setFromObject(root);
    this.height = Math.max(0.2, box.max.y - box.min.y);

    // Rest-pose neutralisation: rigs are bound in T- or A-pose, but the moves are authored
    // relative to a relaxed stance (arms hanging ~20 deg from vertical). Measure each upper
    // arm's bind angle from straight-down and store the correction applied under every pose.
    this.neutral = { armRaiseL: 0, armRaiseR: 0 };
    for (const [side, key] of [['left', 'armRaiseL'], ['right', 'armRaiseR']]) {
      const up = this.bones[`${side}UpperArm`], lo = this.bones[`${side}LowerArm`];
      if (!up || !lo) continue;
      const dir = this.limbDir(up, lo, new Vector3(0, -1, 0), new Vector3());
      const angleFromDown = Math.acos(Math.max(-1, Math.min(1, -dir.y)));
      this.neutral[key] = Math.min(0, this.relaxedArmAngle - angleFromDown);  // never raise, only lower
    }

    // springs for transient hits
    this.springs = {
      bounce: new Spring(180, 14),
      pump: new Spring(140, 11),
      nod: new Spring(220, 14),
      shimmy: new Spring(260, 10),
      lean: new Spring(90, 10),
    };
    this.hitSide = 1;

    // move blending
    this.moveA = 'groove'; this.moveB = null; this.blend = 0;
    this.poseA = zeroPose(); this.poseB = zeroPose();
    this.target = zeroPose(); this.pose = zeroPose();
    this.lastSwitchBeat = -1;
    this.idleClock = 0;
    this.energy = 0;
    this.amp = 0;

    // animation clips
    this.mixer = null; this.action = null; this.clip = null;
    this.beatCount = 0;
    this.stats = { lastMove: 'groove', lastHit: '' };
    this.rng = Math.random;
  }

  /** Use a deterministic move sequence (for reproducible bakes). */
  seed(seed = 1) {
    let a = (seed >>> 0) || 1;
    this.rng = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /** Reset dynamic state (springs, smoothing, move blend) so a bake starts from a clean pose. */
  resetState(move = 'groove') {
    for (const sp of Object.values(this.springs)) sp.set(0);
    this.moveA = move; this.moveB = null; this.blend = 0;
    for (const k of POSE_KEYS) { this.pose[k] = 0; this.target[k] = 0; }
    this.lastSwitchBeat = -1; this.idleClock = 0; this.energy = 0; this.hitSide = 1;
    for (const [b, r] of this.rest) { b.quaternion.copy(r.q); b.position.copy(r.p); }
  }

  /** Replace the rest pose with the skeleton's current pose (e.g. after posing in another tool). */
  captureRest() {
    for (const b of this.rest.keys()) this.rest.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
    this.root.updateWorldMatrix(true, true);
    for (const [side, key] of [['left', 'armRaiseL'], ['right', 'armRaiseR']]) {
      const up = this.bones[`${side}UpperArm`], lo = this.bones[`${side}LowerArm`];
      if (!up || !lo) continue;
      const dir = this.limbDir(up, lo, new Vector3(0, -1, 0), new Vector3());
      this.neutral[key] = Math.min(0, this.relaxedArmAngle - Math.acos(Math.max(-1, Math.min(1, -dir.y))));
    }
  }

  setClip(clip) {
    if (this.action) { this.action.stop(); }
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root); }
    this.mixer = null; this.action = null; this.clip = null;
    // restore rest so leftover clip pose doesn't persist
    for (const [b, r] of this.rest) { b.quaternion.copy(r.q); b.position.copy(r.p); }
    if (!clip) return;
    this.mixer = new AnimationMixer(this.root);
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(LoopRepeat, Infinity);
    this.action.play();
    this.clip = clip;
  }

  setMove(name) {
    if (!MOVES[name]) return;
    if (name === this.moveA && !this.moveB) return;
    this.moveB = name; this.blend = 0;
  }

  // ----- world-axis rotation helpers --------------------------------------------------------

  /** Rotate `bone` by `angle` about a WORLD-space axis. */
  rotateWorld(bone, axisWorld, angle) {
    if (!bone || !bone.parent || Math.abs(angle) < 1e-6) return;
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(_q).invert();
    _v.copy(axisWorld).applyQuaternion(_q).normalize();
    _q2.setFromAxisAngle(_v, angle);
    bone.quaternion.premultiply(_q2);
  }

  /** Current world-space direction from `bone` toward `child` (or a fallback direction). */
  limbDir(bone, child, fallback, out) {
    bone.updateWorldMatrix(true, false);
    if (child) {
      _v2.setFromMatrixPosition(bone.matrixWorld);
      _v3.copy(child.position).applyMatrix4(bone.matrixWorld);
      out.subVectors(_v3, _v2);
      if (out.lengthSq() > 1e-10) return out.normalize();
    }
    return out.copy(fallback);
  }

  /** Swing a limb so its tip moves toward `towardWorld` by `angle` radians. */
  swing(bone, child, fallbackDir, towardWorld, angle) {
    if (!bone || Math.abs(angle) < 1e-6) return;
    const dir = this.limbDir(bone, child, fallbackDir, _v);
    const axis = _v2.crossVectors(dir, towardWorld);
    if (axis.lengthSq() < 1e-6) {
      axis.crossVectors(dir, Math.abs(dir.dot(UP)) < 0.9 ? UP : this.forward);
    }
    axis.normalize();
    this.rotateWorld(bone, axis, angle);
  }

  /** Translate `bone` by a world-space offset (expressed in parent space). */
  translateWorld(bone, offsetWorld) {
    if (!bone || !bone.parent) return;
    bone.parent.updateWorldMatrix(true, false);
    _m.copy(bone.parent.matrixWorld).invert();
    // transform as a direction: strip translation
    _v.copy(offsetWorld).transformDirection(_m);
    // transformDirection normalises; rescale by inverse parent world scale
    bone.parent.getWorldScale(_v2);
    const len = offsetWorld.length();
    _v.multiplyScalar(len).divide(_v2);
    bone.position.add(_v);
  }

  // ----- main update ------------------------------------------------------------------------

  /**
   * @param {import('../audio/AudioAnalyzer.js').AudioFeatures} f
   * @param {number} dt seconds (wall clock)
   */
  update(f, dt) {
    const P = this.params;
    dt = Math.min(0.1, Math.max(0, dt));

    // --- energy & amplitude
    const target = Math.min(1, f.rms * 1.1 + f.bands.low * 0.25);
    this.energy += (target - this.energy) * Math.min(1, dt / 0.4);
    const musicOn = f.locked || (f.bpm > 0 && f.rms > 0.02);
    this.amp = P.intensity * (musicOn ? 0.35 + 0.65 * this.energy : 0.25);

    // --- beat clock (fallback internal clock when not locked so the body never freezes)
    let b;
    if (f.locked) {
      b = f.beatIndex + f.phase;
      this.beatCount = b;
      this.idleClock = b;
    } else {
      const fallbackBpm = f.bpm > 0 ? f.bpm : 96;
      this.idleClock += dt * fallbackBpm / 60;
      b = this.idleClock;
    }
    const phase = b - Math.floor(b);
    const ctx = {
      b, phase, e: this.energy, bands: f.bands,
      s2: Math.sin(Math.PI * b), s4: Math.sin(Math.PI * b / 2), s8: Math.sin(Math.PI * b / 4),
    };

    // --- move selection
    if (!musicOn && !f.locked && f.rms < 0.02) {
      if (this.moveA !== 'idle' && this.moveB !== 'idle') this.setMove('idle');
    } else if (this.moveA === 'idle' && !this.moveB) {
      this.setMove(P.autoMoves ? pickMove(this.energy, 'idle', this.rng) : P.move);
    } else if (P.autoMoves && f.locked && f.beat && f.beatIndex % P.switchEveryBeats === 0 && f.beatIndex !== this.lastSwitchBeat && !this.moveB) {
      this.lastSwitchBeat = f.beatIndex;
      const next = pickMove(this.energy, this.moveA, this.rng);
      if (next !== this.moveA) this.setMove(next);
    } else if (!P.autoMoves && P.move !== this.moveA && !this.moveB && musicOn) {
      this.setMove(P.move);
    }

    // --- evaluate + crossfade moves
    MOVES[this.moveA].fn(ctx, resetPose(this.poseA));
    if (this.moveB) {
      MOVES[this.moveB].fn(ctx, resetPose(this.poseB));
      this.blend = Math.min(1, this.blend + dt / 0.45);
      lerpPose(this.poseA, this.poseB, smoothstep(this.blend), this.target);
      if (this.blend >= 1) { this.moveA = this.moveB; this.moveB = null; this.blend = 0; }
    } else {
      for (const k of POSE_KEYS) this.target[k] = this.poseA[k];
    }
    this.stats.lastMove = this.moveA;
    const moveAmp = this.moveA === 'idle' ? P.intensity : this.amp;
    for (const k of POSE_KEYS) this.target[k] *= moveAmp;

    // --- transient hits -> springs
    const S = this.springs, hg = P.hitGain * (0.5 + 0.5 * P.intensity);
    if (f.onsets.low) { S.bounce.impulse(-2.2 * f.strength.low * hg); S.lean.impulse(0.6 * f.strength.low * hg); this.stats.lastHit = 'kick'; }
    if (f.onsets.mid) { this.hitSide = -this.hitSide; S.pump.impulse(2.0 * f.strength.mid * hg); S.nod.impulse(1.6 * f.strength.mid * hg); this.stats.lastHit = 'snare'; }
    if (f.onsets.high) { S.shimmy.impulse(1.4 * f.strength.high * hg * (f.beatIndex % 2 ? 1 : -1)); this.stats.lastHit = 'hat'; }
    const bounce = S.bounce.step(dt), pump = S.pump.step(dt), nod = S.nod.step(dt), sh = S.shimmy.step(dt), lean = S.lean.step(dt);

    const t = this.target;
    t.hipsY += 0.05 * bounce;                       // drop on the kick
    t.kneeL += -0.9 * bounce; t.kneeR += -0.9 * bounce;
    t.legFwdL += -0.35 * bounce; t.legFwdR += -0.35 * bounce;
    t.spinePitch += 0.12 * lean; t.chestPitch += 0.08 * lean;
    t.armRaiseL += 0.45 * pump * (this.hitSide > 0 ? 1 : 0.4);
    t.armRaiseR += 0.45 * pump * (this.hitSide < 0 ? 1 : 0.4);
    t.elbowL += 0.35 * pump; t.elbowR += 0.35 * pump;
    t.headPitch += 0.3 * nod;
    t.shoulderL += 0.12 * sh; t.shoulderR -= 0.12 * sh;
    t.headRoll += 0.06 * sh;
    t.chestYaw += 0.08 * sh;

    // --- smooth toward target
    const a = P.smoothing <= 0 ? 1 : 1 - Math.exp(-dt / P.smoothing);
    for (const k of POSE_KEYS) this.pose[k] += (t[k] - this.pose[k]) * a;

    // --- base layer
    if (this.mixer && this.action && this.clip) {
      if (P.clipSync && f.locked) {
        const loopBeats = Math.max(0.25, P.beatsPerLoop);
        const frac = ((b % loopBeats) + loopBeats) % loopBeats / loopBeats;
        this.action.paused = true;
        this.action.time = frac * this.clip.duration;
        this.mixer.update(0);
      } else {
        this.action.paused = false;
        this.mixer.update(dt);
      }
    } else {
      for (const [bone, r] of this.rest) { bone.quaternion.copy(r.q); bone.position.copy(r.p); }
    }

    // --- apply procedural pose
    const w = this.mixer ? P.proceduralWeight : 1;
    if (w > 0) this.applyPose(this.pose, w);
  }

  applyPose(p, w) {
    const B = this.bones, H = this.height, F = this.forward, SD = this.side;
    const back = _vBack.copy(F).negate();
    const right = _vRight.copy(SD).negate();

    // hips translation + rotation
    if (B.hips) {
      _vOff.set(0, 0, 0)
        .addScaledVector(SD, p.hipsX * H * w)
        .addScaledVector(UP, p.hipsY * H * w)
        .addScaledVector(F, p.hipsZ * H * w);
      this.translateWorld(B.hips, _vOff);
      this.rotateWorld(B.hips, F, p.hipsRoll * w);
      this.rotateWorld(B.hips, UP, p.hipsYaw * w);
      this.rotateWorld(B.hips, SD, p.hipsPitch * w);
    }
    // torso chain (pitch about side axis: positive = lean forward)
    const torso = [[B.spine, p.spinePitch, p.spineYaw, p.spineRoll], [B.chest, p.chestPitch, p.chestYaw, p.chestRoll]];
    if (!B.chest && B.upperChest) torso[1][0] = B.upperChest;
    for (const [bone, pitch, yaw, roll] of torso) {
      if (!bone) continue;
      this.rotateWorld(bone, SD, -pitch * w);
      this.rotateWorld(bone, UP, yaw * w);
      this.rotateWorld(bone, F, roll * w);
    }
    if (B.neck) this.rotateWorld(B.neck, SD, -p.neckPitch * w);
    if (B.head) {
      this.rotateWorld(B.head, SD, -p.headPitch * w);
      this.rotateWorld(B.head, UP, p.headYaw * w);
      this.rotateWorld(B.head, F, p.headRoll * w);
    }
    // shoulders: raise toward up
    if (B.leftShoulder) this.swing(B.leftShoulder, B.leftUpperArm, SD, UP, p.shoulderL * w);
    if (B.rightShoulder) this.swing(B.rightShoulder, B.rightUpperArm, right, UP, p.shoulderR * w);
    // arms (neutral correction lowers T/A-pose arms to a relaxed hang; it is part of the base pose,
    // so it is applied at full weight even when layering over a clip only lightly)
    const nL = this.neutral.armRaiseL * (this.mixer ? w : 1), nR = this.neutral.armRaiseR * (this.mixer ? w : 1);
    this.swing(B.leftUpperArm, B.leftLowerArm, _vDownL.copy(SD).multiplyScalar(0.3).addScaledVector(UP, -1).normalize(), UP, nL + p.armRaiseL * w);
    this.swing(B.leftUpperArm, B.leftLowerArm, _vDownL, F, p.armFwdL * w);
    this.swing(B.rightUpperArm, B.rightLowerArm, _vDownR.copy(right).multiplyScalar(0.3).addScaledVector(UP, -1).normalize(), UP, nR + p.armRaiseR * w);
    this.swing(B.rightUpperArm, B.rightLowerArm, _vDownR, F, p.armFwdR * w);
    // elbows bend toward forward+up
    _vBend.copy(F).add(UP).normalize();
    this.swing(B.leftLowerArm, B.leftHand, _vDownL, _vBend, p.elbowL * w);
    this.swing(B.rightLowerArm, B.rightHand, _vDownR, _vBend, p.elbowR * w);
    // legs
    const down = _vDown.set(0, -1, 0);
    this.swing(B.leftUpperLeg, B.leftLowerLeg, down, F, p.legFwdL * w);
    this.swing(B.leftUpperLeg, B.leftLowerLeg, down, SD, p.legOutL * w);
    this.swing(B.rightUpperLeg, B.rightLowerLeg, down, F, p.legFwdR * w);
    this.swing(B.rightUpperLeg, B.rightLowerLeg, down, right, p.legOutR * w);
    this.swing(B.leftLowerLeg, B.leftFoot, down, back, p.kneeL * w);
    this.swing(B.rightLowerLeg, B.rightFoot, down, back, p.kneeR * w);
    // feet: pitch toes down about side axis
    if (B.leftFoot) this.rotateWorld(B.leftFoot, SD, p.footL * w);
    if (B.rightFoot) this.rotateWorld(B.rightFoot, SD, p.footR * w);
  }
}

const _vOff = new Vector3(), _vBack = new Vector3(), _vRight = new Vector3(), _vDownL = new Vector3(), _vDownR = new Vector3(), _vBend = new Vector3(), _vDown = new Vector3();

function resetPose(p) { for (const k of POSE_KEYS) p[k] = 0; return p; }
function smoothstep(x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }

export { MOVES, DANCE_MOVES };
