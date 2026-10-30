/**
 * Dance moves are pure functions of the beat clock + audio energy that write a numeric
 * pose. Everything is a plain number so moves can be cross-faded by linear blending.
 *
 * Units: angles in radians, hips offsets as a fraction of character height.
 * Sign conventions (see Dancer.js): "raise" swings a limb toward world up, "fwd" toward
 * the character's forward, "out" toward its own side, "knee" bends backward.
 */

export const POSE_KEYS = [
  'hipsX', 'hipsY', 'hipsZ', 'hipsRoll', 'hipsYaw', 'hipsPitch',
  'spinePitch', 'spineYaw', 'spineRoll', 'chestPitch', 'chestYaw', 'chestRoll',
  'neckPitch', 'headPitch', 'headYaw', 'headRoll',
  'shoulderL', 'shoulderR',
  'armRaiseL', 'armRaiseR', 'armFwdL', 'armFwdR', 'elbowL', 'elbowR',
  'legFwdL', 'legFwdR', 'legOutL', 'legOutR', 'kneeL', 'kneeR', 'footL', 'footR',
];

export function zeroPose() {
  const p = {};
  for (const k of POSE_KEYS) p[k] = 0;
  return p;
}

export function lerpPose(a, b, t, out = zeroPose()) {
  for (const k of POSE_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

const TAU = Math.PI * 2;
const dip = (phase) => 0.5 - 0.5 * Math.cos(TAU * phase); // 0 on the beat, 1 half-way

/**
 * @typedef {object} MoveCtx
 * @property {number} b      continuous beat count (beatIndex + phase)
 * @property {number} phase  0..1 within the beat
 * @property {number} e      overall energy 0..1
 * @property {{low:number,mid:number,high:number}} bands
 * @property {number} s2     sin(pi*b): +1/-1 alternating every beat (weight shift)
 * @property {number} s4     sin(pi*b/2): alternating every 2 beats
 * @property {number} s8     sin(pi*b/4)
 */

/** @type {Record<string, {label:string, energy:[number,number], fn:(c:MoveCtx, p:object)=>void}>} */
export const MOVES = {
  groove: {
    label: 'Groove (weight shift)', energy: [0, 0.7],
    fn(c, p) {
      p.hipsX = 0.03 * c.s2;
      p.hipsY = -0.012 * dip(c.phase);
      p.hipsRoll = -0.07 * c.s2;
      p.hipsYaw = 0.08 * c.s2;
      p.spineRoll = 0.05 * c.s2;
      p.chestYaw = -0.12 * c.s2;
      p.chestPitch = 0.03 * dip(c.phase);
      p.armFwdL = 0.28 * c.s2; p.armFwdR = -0.28 * c.s2;
      p.armRaiseL = 0.12; p.armRaiseR = 0.12;
      p.elbowL = 0.55 + 0.15 * Math.max(0, c.s2); p.elbowR = 0.55 + 0.15 * Math.max(0, -c.s2);
      p.headPitch = 0.05 * Math.cos(TAU * c.phase); p.headYaw = 0.06 * c.s4;
      p.kneeL = 0.12 + 0.1 * dip(c.phase) + 0.08 * Math.max(0, -c.s2);
      p.kneeR = 0.12 + 0.1 * dip(c.phase) + 0.08 * Math.max(0, c.s2);
      p.legFwdL = 0.06; p.legFwdR = 0.06;
      p.legOutL = 0.05 + 0.04 * c.s2; p.legOutR = 0.05 - 0.04 * c.s2;
    },
  },
  bounce: {
    label: 'Bounce (arm pump)', energy: [0.35, 1],
    fn(c, p) {
      const d = dip(c.phase);
      p.hipsY = -0.045 * d;
      p.hipsX = 0.015 * c.s2;
      p.kneeL = 0.15 + 0.45 * d; p.kneeR = 0.15 + 0.45 * d;
      p.legFwdL = 0.08 + 0.18 * d; p.legFwdR = 0.08 + 0.18 * d;
      p.footL = 0.1 * d; p.footR = 0.1 * d;
      p.chestPitch = 0.1 + 0.05 * d;
      p.spinePitch = 0.05;
      const pump = 0.5 - 0.5 * Math.cos(TAU * c.phase + Math.PI); // high on the beat
      p.armRaiseL = 0.35 + 0.35 * pump; p.armRaiseR = 0.35 + 0.35 * pump;
      p.armFwdL = 0.55; p.armFwdR = 0.55;
      p.elbowL = 1.3 + 0.3 * pump; p.elbowR = 1.3 + 0.3 * pump;
      p.headPitch = 0.12 * Math.cos(TAU * c.phase);
      p.chestYaw = 0.06 * c.s2;
    },
  },
  stepTouch: {
    label: 'Step-touch', energy: [0.25, 0.9],
    fn(c, p) {
      const w = c.s4;                       // which side we're stepping to (2-beat cycle)
      p.hipsX = 0.07 * w;
      p.hipsY = -0.012 * dip(c.phase);
      p.hipsRoll = -0.1 * w;
      p.hipsYaw = -0.12 * w;
      p.chestYaw = 0.25 * w;
      p.spineRoll = 0.04 * w;
      p.legOutL = 0.1 + 0.18 * Math.max(0, w); p.legOutR = 0.1 + 0.18 * Math.max(0, -w);
      p.kneeL = 0.1 + 0.15 * dip(c.phase) + 0.15 * Math.max(0, -w);
      p.kneeR = 0.1 + 0.15 * dip(c.phase) + 0.15 * Math.max(0, w);
      p.legFwdL = 0.05 + 0.12 * Math.max(0, -w); p.legFwdR = 0.05 + 0.12 * Math.max(0, w);
      p.armFwdL = 0.5 + 0.35 * c.s2; p.armFwdR = 0.5 - 0.35 * c.s2;
      p.armRaiseL = 0.25 + 0.15 * Math.max(0, -w); p.armRaiseR = 0.25 + 0.15 * Math.max(0, w);
      p.elbowL = 0.9 + 0.3 * c.s2; p.elbowR = 0.9 - 0.3 * c.s2;
      p.headYaw = 0.15 * w; p.headPitch = 0.05 * Math.cos(TAU * c.phase);
    },
  },
  armsUp: {
    label: 'Arms up & wave', energy: [0.5, 1],
    fn(c, p) {
      p.hipsX = 0.04 * c.s2;
      p.hipsY = -0.02 * dip(c.phase);
      p.hipsRoll = -0.06 * c.s2;
      p.spineRoll = 0.12 * c.s4;
      p.chestRoll = 0.1 * c.s4;
      p.armRaiseL = 2.4 + 0.15 * c.s4; p.armRaiseR = 2.4 - 0.15 * c.s4;
      p.armFwdL = 0.25 + 0.35 * c.s4; p.armFwdR = 0.25 + 0.35 * c.s4;
      p.elbowL = 0.45 + 0.3 * dip(c.phase); p.elbowR = 0.45 + 0.3 * dip(c.phase);
      p.headRoll = 0.12 * c.s4; p.headPitch = -0.08 + 0.06 * Math.cos(TAU * c.phase);
      p.kneeL = 0.1 + 0.2 * dip(c.phase); p.kneeR = 0.1 + 0.2 * dip(c.phase);
      p.legFwdL = 0.08 * dip(c.phase); p.legFwdR = 0.08 * dip(c.phase);
      p.legOutL = 0.12; p.legOutR = 0.12;
    },
  },
  shimmy: {
    label: 'Shoulder shimmy', energy: [0, 0.6],
    fn(c, p) {
      const fast = Math.sin(TAU * c.b);       // 8th-note shoulder alternation
      p.shoulderL = 0.14 * fast; p.shoulderR = -0.14 * fast;
      p.chestYaw = 0.12 * fast;
      p.chestPitch = 0.08;
      p.hipsX = 0.015 * c.s2;
      p.hipsYaw = -0.05 * c.s2;
      p.hipsY = -0.008 * dip(c.phase);
      p.armRaiseL = 0.45; p.armRaiseR = 0.45;
      p.armFwdL = 0.3; p.armFwdR = 0.3;
      p.elbowL = 1.1 + 0.1 * fast; p.elbowR = 1.1 - 0.1 * fast;
      p.headYaw = -0.1 * c.s4; p.headRoll = 0.06 * fast;
      p.kneeL = 0.12 + 0.06 * dip(c.phase); p.kneeR = 0.12 + 0.06 * dip(c.phase);
      p.legOutL = 0.08; p.legOutR = 0.08;
    },
  },
  twist: {
    label: 'Twist', energy: [0.3, 1],
    fn(c, p) {
      const tw = Math.sin(TAU * c.b);  // twist every 8th
      p.hipsYaw = 0.35 * tw;
      p.chestYaw = -0.3 * tw;
      p.hipsY = -0.03 * dip(c.phase);
      p.kneeL = 0.3 + 0.2 * dip(c.phase); p.kneeR = 0.3 + 0.2 * dip(c.phase);
      p.legFwdL = 0.15; p.legFwdR = 0.15;
      p.footL = 0.1 * tw; p.footR = 0.1 * tw;
      p.armRaiseL = 0.6; p.armRaiseR = 0.6;
      p.armFwdL = 0.5 + 0.2 * tw; p.armFwdR = 0.5 - 0.2 * tw;
      p.elbowL = 1.4; p.elbowR = 1.4;
      p.headYaw = 0.1 * tw; p.headPitch = 0.08 * Math.cos(TAU * c.phase);
    },
  },
  idle: {
    label: 'Idle (breathing)', energy: [0, 0],
    fn(c, p) {
      // c.b here is driven by a slow internal clock
      p.chestPitch = 0.02 + 0.015 * Math.sin(TAU * c.b / 4);
      p.hipsX = 0.006 * Math.sin(TAU * c.b / 8);
      p.headYaw = 0.03 * Math.sin(TAU * c.b / 6);
      p.armRaiseL = 0.08; p.armRaiseR = 0.08;
      p.elbowL = 0.3; p.elbowR = 0.3;
      p.kneeL = 0.03; p.kneeR = 0.03;
    },
  },
};

export const DANCE_MOVES = Object.keys(MOVES).filter(k => k !== 'idle');

/** Choose the next move for a given energy level, avoiding the current one. */
export function pickMove(energy, current, rnd = Math.random) {
  const pool = DANCE_MOVES.filter(k => k !== current && energy >= MOVES[k].energy[0] - 0.1 && energy <= MOVES[k].energy[1] + 0.1);
  const list = pool.length ? pool : DANCE_MOVES.filter(k => k !== current);
  return list[Math.floor(rnd() * list.length)];
}
