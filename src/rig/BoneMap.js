import { Vector3 } from 'three';

/**
 * Canonical humanoid slots (a subset of the VRM / Unity humanoid layout).
 * Everything the dancer drives is addressed through these names, so the same
 * choreography runs on Meshy, Mixamo, VRM, Unreal-mannequin or Rigify skeletons.
 */
export const SLOTS = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
];

const JUNK_TOKENS = new Set([
  'mixamorig', 'mixamo', 'def', 'mch', 'org', 'ctrl', 'cc', 'base', 'bip', 'bip01', 'bip001', 'b', 'j',
  'jnt', 'joint', 'bone', 'rig', 'armature', 'skeleton', 'character', 'char', 'body', 'humanoid', 'avatar',
  'root', 'c', 'center', 'ctr', 'mid', 'ue4', 'ue5', 'meshy', 'sk', 'bn', 'skel', 'deform', 'dyn', 'std',
]);
const SKIP_IF_CONTAINS = [
  'thumb', 'index', 'middle', 'ring', 'pinky', 'little', 'finger', 'eye', 'jaw', 'tongue', 'teeth',
  'twist', 'roll', 'ik', 'pole', 'target', 'end', 'top', 'breast', 'hair', 'tail', 'cloth', 'skirt',
  'weapon', 'prop', 'attach', 'socket', 'helper', 'nub',
];

/** Lower-case tokens of a bone name, splitting camelCase and separators. */
export function tokenize(name) {
  const base = name.includes(':') ? name.split(':').pop() : name;      // strip namespaces (mixamorig:Hips)
  return base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Classify one bone name.
 * @returns {{slot:string|null, side:'left'|'right'|null, core:string, spineIndex?:number}}
 */
export function classifyName(name) {
  let tokens = tokenize(name);
  let side = null;
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'left' || t === 'l' || t === 'lft') { side = 'left'; continue; }
    if (t === 'right' || t === 'r' || t === 'rgt') { side = 'right'; continue; }
    if (JUNK_TOKENS.has(t)) continue;
    rest.push(t);
  }
  // Numbers: keep for spine/neck indexing, drop otherwise
  const nums = rest.filter(t => /^\d+$/.test(t)).map(Number);
  const words = rest.filter(t => !/^\d+$/.test(t));
  const core = words.join('');
  if (!core) return { slot: null, side, core };
  for (const bad of SKIP_IF_CONTAINS) {
    if (words.includes(bad) || (bad.length > 3 && core.includes(bad))) {
      // "upperarm" contains "arm" fine; but "lowerarm_twist" must be skipped
      return { slot: null, side, core };
    }
  }

  const n = nums.length ? nums[nums.length - 1] : 0;
  let slot = null;
  const S = (base) => (side ? side + base : null);

  switch (core) {
    case 'hips': case 'hip': case 'pelvis': case 'cog': case 'waist':
      slot = 'hips'; break;
    case 'spine': case 'spine0': case 'abdomen': case 'torso': case 'lowerback':
      slot = 'spine'; break;
    case 'chest': case 'ribcage': case 'upperbody':
      slot = 'chest'; break;
    case 'upperchest': case 'chestupper': case 'sternum':
      slot = 'upperChest'; break;
    case 'neck': slot = 'neck'; break;
    case 'head': slot = 'head'; break;
    case 'shoulder': case 'clavicle': case 'collar': case 'collarbone': case 'scapula':
      slot = S('Shoulder'); break;
    case 'upperarm': case 'arm': case 'uparm': case 'humerus': case 'bicep': case 'armupper':
      slot = S('UpperArm'); break;
    case 'lowerarm': case 'forearm': case 'lowarm': case 'elbow': case 'armlower': case 'ulna':
      slot = S('LowerArm'); break;
    case 'hand': case 'wrist': slot = S('Hand'); break;
    case 'upperleg': case 'upleg': case 'thigh': case 'legupper': case 'femur': case 'hipjoint':
      slot = S('UpperLeg'); break;
    case 'lowerleg': case 'leg': case 'calf': case 'shin': case 'knee': case 'leglower': case 'tibia': case 'lowleg':
      slot = S('LowerLeg'); break;
    case 'foot': case 'ankle': slot = S('Foot'); break;
    case 'toebase': case 'toe': case 'toes': case 'ball': slot = S('Toes'); break;
    default: break;
  }
  const out = { slot, side, core };
  if (slot === 'spine' || core === 'spine') { out.spineIndex = n; out.slot = 'spine'; }
  if (slot === 'neck') out.neckIndex = n;
  return out;
}

/** Collect all THREE.Bone objects under root (falls back to all Object3Ds named like bones). */
export function collectBones(root) {
  const bones = [];
  root.traverse(o => { if (o.isBone) bones.push(o); });
  if (bones.length) return bones;
  root.traverse(o => { if (o.isObject3D && !o.isMesh && o.parent && o.name) bones.push(o); });
  return bones;
}

/**
 * Resolve canonical slots -> bones. Name matching first, structural fallback second.
 * @param {import('three').Object3D} root
 * @param {Record<string,string>} [overrides] slot -> exact bone name
 * @returns {{ bones: Record<string, import('three').Bone>, report: {slot:string, bone:string|null, via:string}[], coverage:number }}
 */
export function buildBoneMap(root, overrides = {}) {
  const all = collectBones(root);
  const byName = new Map(all.map(b => [b.name, b]));
  const bones = {};
  const via = {};

  // 1. explicit overrides
  for (const [slot, name] of Object.entries(overrides)) {
    if (byName.has(name)) { bones[slot] = byName.get(name); via[slot] = 'override'; }
  }

  // 2. names
  const spineCandidates = [];
  const neckCandidates = [];
  for (const b of all) {
    const c = classifyName(b.name);
    if (!c.slot) continue;
    if (c.slot === 'spine') { spineCandidates.push({ bone: b, idx: c.spineIndex ?? 0, depth: depthOf(b) }); continue; }
    if (c.slot === 'neck') { neckCandidates.push({ bone: b, idx: c.neckIndex ?? 0, depth: depthOf(b) }); continue; }
    if (!bones[c.slot]) { bones[c.slot] = b; via[c.slot] = 'name'; }
  }
  // Spine chain: ordered by hierarchy depth, lowest = spine, highest = upperChest, middle = chest
  if (spineCandidates.length) {
    spineCandidates.sort((a, b) => a.depth - b.depth || a.idx - b.idx);
    const order = spineCandidates.map(s => s.bone);
    const assign = (slot, bone) => { if (!bones[slot]) { bones[slot] = bone; via[slot] = 'name'; } };
    if (order.length === 1) assign('spine', order[0]);
    else if (order.length === 2) { assign('spine', order[0]); assign('chest', order[1]); }
    else {
      assign('spine', order[0]);
      assign('chest', order[Math.floor((order.length - 1) / 2)]);
      assign('upperChest', order[order.length - 1]);
    }
  }
  if (neckCandidates.length) {
    neckCandidates.sort((a, b) => a.depth - b.depth);
    if (!bones.neck) { bones.neck = neckCandidates[0].bone; via.neck = 'name'; }
  }

  // 3. structural fallback for anything still missing, and for conflicts: generic names such as
  //    "torso_joint_1" / "leg_joint_L_1" can land two slots on one bone, in which case topology wins.
  const missing = SLOTS.filter(s => !bones[s]);
  const dupSlots = () => { const seen = new Map(); const out = new Set(); for (const [slot, b] of Object.entries(bones)) { if (seen.has(b)) { out.add(slot); out.add(seen.get(b)); } else seen.set(b, slot); } return [...out]; };
  if ((missing.length || dupSlots().length) && all.length >= 10) {
    try {
      const known = {};
      for (const [slot, b] of Object.entries(bones)) if (via[slot] === 'override') known[slot] = b;
      if (!known.hips && bones.hips && !dupSlots().includes('hips')) known.hips = bones.hips;
      const guess = structuralGuess(root, all, known);
      // a name-based slot holding a bone that topology assigns to a different slot yields to topology
      for (const slot of SLOTS) {
        const g = guess[slot]; if (!g) continue;
        for (const other of SLOTS) {
          if (other === slot || via[other] !== 'name' || bones[other] !== g) continue;
          if (guess[other] !== g) { delete bones[other]; delete via[other]; }
        }
      }
      const used = new Set(Object.values(bones));
      for (const slot of SLOTS) {
        if (bones[slot] || !guess[slot] || used.has(guess[slot])) continue;
        bones[slot] = guess[slot]; via[slot] = 'structure'; used.add(guess[slot]);
      }
      // last resort: never leave one bone on two slots
      const seen = new Set();
      for (const slot of SLOTS) { const b = bones[slot]; if (!b) continue; if (seen.has(b)) { delete bones[slot]; delete via[slot]; } else seen.add(b); }
    } catch (e) { /* best effort */ }
  }

  const report = SLOTS.map(slot => ({ slot, bone: bones[slot] ? bones[slot].name : null, via: via[slot] || null }));
  const essential = ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg'];
  const coverage = essential.filter(s => bones[s]).length / essential.length;
  return { bones, report, coverage, all };
}

function depthOf(o) { let d = 0; while (o.parent) { d++; o = o.parent; } return d; }

/**
 * Guess slots from topology + world positions. Assumes a roughly upright bind pose.
 */
function structuralGuess(root, all, known) {
  root.updateWorldMatrix(true, true);
  const pos = new Map(all.map(b => [b, b.getWorldPosition(new Vector3())]));
  const boneChildren = (b) => b.children.filter(c => all.includes(c));
  const out = {};

  // hips: known, or the shallowest bone with >= 3 bone children; else the shallowest bone with any bone children
  let hips = known.hips;
  if (!hips) {
    const sorted = [...all].sort((a, b) => depthOf(a) - depthOf(b));
    hips = sorted.find(b => boneChildren(b).length >= 3) || sorted.find(b => boneChildren(b).length >= 1);
  }
  if (!hips) return out;
  out.hips = hips;
  const hp = pos.get(hips);

  const kids = boneChildren(hips);
  const legs = kids.filter(k => pos.get(k).y < hp.y - 1e-6 || (kids.length >= 3 && pos.get(k).y <= hp.y));
  const spineStart = kids.filter(k => !legs.includes(k)).sort((a, b) => pos.get(b).y - pos.get(a).y)[0];

  const chain = (start, max) => { const c = []; let b = start; while (b && c.length < max) { c.push(b); const ch = boneChildren(b); b = ch.length === 1 ? ch[0] : (ch.length > 1 ? longestChild(ch, boneChildren) : null); } return c; };

  // legs by x sign (character faces +Z: left is +X)
  for (const leg of legs) {
    const side = pos.get(leg).x >= hp.x ? 'left' : 'right';
    const c = chain(leg, 4);
    const names = ['UpperLeg', 'LowerLeg', 'Foot', 'Toes'];
    c.forEach((b, i) => { if (names[i]) out[side + names[i]] = b; });
  }

  if (spineStart) {
    // walk up until a branch with >=2 children (neck + arms)
    const spineBones = []; let b = spineStart;
    while (b) {
      const ch = boneChildren(b);
      spineBones.push(b);
      if (ch.length >= 2) break;
      b = ch[0];
    }
    const top = spineBones[spineBones.length - 1];
    if (spineBones.length === 1) out.spine = spineBones[0];
    else if (spineBones.length === 2) { out.spine = spineBones[0]; out.chest = spineBones[1]; }
    else { out.spine = spineBones[0]; out.chest = spineBones[Math.floor((spineBones.length - 1) / 2)]; out.upperChest = top; }

    const branch = boneChildren(top);
    const tp = pos.get(top);
    const neck = branch.slice().sort((a, b) => pos.get(b).y - pos.get(a).y)[0];
    if (neck && branch.length >= 2) {
      const nc = chain(neck, 2);
      out.neck = nc[0]; if (nc[1]) out.head = nc[1]; else out.head = nc[0];
      for (const arm of branch.filter(x => x !== neck)) {
        const side = pos.get(arm).x >= tp.x ? 'left' : 'right';
        const c = chain(arm, 4);
        const names = c.length >= 4 ? ['Shoulder', 'UpperArm', 'LowerArm', 'Hand'] : ['UpperArm', 'LowerArm', 'Hand'];
        c.forEach((bn, i) => { if (names[i]) out[side + names[i]] = bn; });
      }
    }
  }
  return out;
}

function longestChild(children, boneChildren) {
  let best = null, bestLen = -1;
  for (const c of children) {
    let n = 0, b = c;
    while (b) { n++; const ch = boneChildren(b); b = ch[0]; if (n > 50) break; }
    if (n > bestLen) { bestLen = n; best = c; }
  }
  return best;
}
