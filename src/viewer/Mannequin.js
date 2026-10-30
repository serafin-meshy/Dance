import { Bone, Group, Mesh, CapsuleGeometry, SphereGeometry, MeshStandardMaterial, Vector3, Quaternion, Skeleton, SkinnedMesh, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute } from 'three';

/**
 * A procedural humanoid with Mixamo-style bone names, used when no GLB is loaded.
 * Limb meshes are parented to bones (no skinning) so it's cheap and always valid.
 * Built in an A-pose, facing +Z, ~1.75m tall.
 */
export function buildMannequin({ color = 0x7fb3ff } = {}) {
  const group = new Group(); group.name = 'Mannequin';
  const mat = new MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 });
  const jointMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.2 });

  const bones = {};
  const mk = (name, parent, pos) => {
    const b = new Bone(); b.name = name; b.position.copy(pos);
    if (parent) bones[parent].add(b); else group.add(b);
    bones[name] = b; return b;
  };
  // positions are relative to parent (metres)
  mk('Hips', null, new Vector3(0, 0.98, 0));
  mk('Spine', 'Hips', new Vector3(0, 0.1, 0));
  mk('Spine1', 'Spine', new Vector3(0, 0.12, 0));
  mk('Spine2', 'Spine1', new Vector3(0, 0.12, 0));
  mk('Neck', 'Spine2', new Vector3(0, 0.16, 0));
  mk('Head', 'Neck', new Vector3(0, 0.1, 0));
  mk('HeadTop_End', 'Head', new Vector3(0, 0.22, 0));
  const a = Math.PI / 180 * 25; // A-pose arm droop
  for (const [side, s] of [['Left', 1], ['Right', -1]]) {
    mk(`${side}Shoulder`, 'Spine2', new Vector3(s * 0.07, 0.12, 0));
    mk(`${side}Arm`, `${side}Shoulder`, new Vector3(s * 0.12, 0, 0));
    mk(`${side}ForeArm`, `${side}Arm`, new Vector3(s * 0.27 * Math.cos(a), -0.27 * Math.sin(a), 0));
    mk(`${side}Hand`, `${side}ForeArm`, new Vector3(s * 0.25 * Math.cos(a), -0.25 * Math.sin(a), 0));
    mk(`${side}HandEnd`, `${side}Hand`, new Vector3(s * 0.1 * Math.cos(a), -0.1 * Math.sin(a), 0));
    mk(`${side}UpLeg`, 'Hips', new Vector3(s * 0.1, -0.04, 0));
    mk(`${side}Leg`, `${side}UpLeg`, new Vector3(0, -0.44, 0));
    mk(`${side}Foot`, `${side}Leg`, new Vector3(0, -0.44, 0));
    mk(`${side}ToeBase`, `${side}Foot`, new Vector3(0, -0.06, 0.14));
  }

  // limb visuals: capsule from each bone to its first child
  const addLimb = (name, childName, radius) => {
    const b = bones[name], c = bones[childName];
    const len = c.position.length();
    const geo = new CapsuleGeometry(radius, Math.max(0.01, len - radius * 1.2), 6, 12);
    const m = new Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    // capsule is along +Y; orient it along the child direction
    const dir = c.position.clone().normalize();
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
    m.position.copy(c.position).multiplyScalar(0.5);
    b.add(m);
    const j = new Mesh(new SphereGeometry(radius * 1.05, 12, 10), jointMat);
    b.add(j);
  };
  addLimb('Hips', 'Spine', 0.12);
  addLimb('Spine', 'Spine1', 0.11);
  addLimb('Spine1', 'Spine2', 0.12);
  addLimb('Spine2', 'Neck', 0.13);
  addLimb('Neck', 'Head', 0.05);
  addLimb('Head', 'HeadTop_End', 0.11);
  for (const side of ['Left', 'Right']) {
    addLimb(`${side}Shoulder`, `${side}Arm`, 0.05);
    addLimb(`${side}Arm`, `${side}ForeArm`, 0.05);
    addLimb(`${side}ForeArm`, `${side}Hand`, 0.042);
    addLimb(`${side}Hand`, `${side}HandEnd`, 0.04);
    addLimb(`${side}UpLeg`, `${side}Leg`, 0.075);
    addLimb(`${side}Leg`, `${side}Foot`, 0.06);
    addLimb(`${side}Foot`, `${side}ToeBase`, 0.045);
  }
  // a face marker so the facing direction is obvious
  const nose = new Mesh(new SphereGeometry(0.03, 8, 8), jointMat);
  nose.position.set(0, 0.1, 0.11); bones.Head.add(nose);

  group.userData.isMannequin = true;
  return group;
}
