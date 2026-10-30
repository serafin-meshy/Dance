import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Object3D } from 'three';
import { classifyName, buildBoneMap, SLOTS } from '../src/rig/BoneMap.js';

function chainFrom(names, positions) {
  const root = new Object3D();
  const bones = {};
  let parent = root;
  // positions: [name, parentName, x, y, z]
  for (const [name, parentName, x, y, z] of positions) {
    const b = new Bone(); b.name = name; b.position.set(x, y, z);
    (parentName ? bones[parentName] : root).add(b);
    bones[name] = b;
  }
  return { root, bones };
}

test('classifyName handles Mixamo, Meshy-style, VRM, Unreal and Rigify names', () => {
  const cases = {
    'mixamorig:Hips': 'hips', 'mixamorig:Spine2': 'spine', 'mixamorig:LeftUpLeg': 'leftUpperLeg',
    'mixamorig:LeftLeg': 'leftLowerLeg', 'mixamorig:RightForeArm': 'rightLowerArm', 'mixamorig:LeftToeBase': 'leftToes',
    'mixamorig:HeadTop_End': null, 'mixamorig:LeftHandIndex1': null,
    'Hips': 'hips', 'LeftArm': 'leftUpperArm', 'RightShoulder': 'rightShoulder', 'Head': 'head', 'Neck': 'neck',
    'J_Bip_C_Hips': 'hips', 'J_Bip_L_UpperArm': 'leftUpperArm', 'J_Bip_R_LowerLeg': 'rightLowerLeg', 'J_Bip_C_UpperChest': 'upperChest',
    'pelvis': 'hips', 'spine_01': 'spine', 'clavicle_l': 'leftShoulder', 'upperarm_r': 'rightUpperArm', 'lowerarm_l': 'leftLowerArm',
    'thigh_r': 'rightUpperLeg', 'calf_l': 'leftLowerLeg', 'foot_r': 'rightFoot', 'ball_l': 'leftToes', 'lowerarm_twist_01_l': null,
    'DEF-upper_arm.L': 'leftUpperArm', 'DEF-forearm.R': 'rightLowerArm', 'DEF-shin.L': 'leftLowerLeg', 'DEF-thigh.R': 'rightUpperLeg',
    'CC_Base_L_Upperarm': 'leftUpperArm', 'CC_Base_Pelvis': 'hips', 'Bip001 L Thigh': 'leftUpperLeg',
  };
  for (const [name, expected] of Object.entries(cases)) {
    const got = classifyName(name).slot;
    const norm = got === 'spine' ? 'spine' : got;
    assert.equal(norm, expected, `${name} -> ${got}, expected ${expected}`);
  }
});

test('buildBoneMap resolves a Mixamo/Meshy-style skeleton fully by name', () => {
  const P = [
    ['Hips', null, 0, 1, 0], ['Spine', 'Hips', 0, 0.1, 0], ['Spine1', 'Spine', 0, 0.1, 0], ['Spine2', 'Spine1', 0, 0.1, 0],
    ['Neck', 'Spine2', 0, 0.15, 0], ['Head', 'Neck', 0, 0.1, 0], ['HeadTop_End', 'Head', 0, 0.2, 0],
    ['LeftShoulder', 'Spine2', 0.05, 0.1, 0], ['LeftArm', 'LeftShoulder', 0.1, 0, 0], ['LeftForeArm', 'LeftArm', 0.25, 0, 0], ['LeftHand', 'LeftForeArm', 0.25, 0, 0], ['LeftHandThumb1', 'LeftHand', 0.03, 0, 0.02],
    ['RightShoulder', 'Spine2', -0.05, 0.1, 0], ['RightArm', 'RightShoulder', -0.1, 0, 0], ['RightForeArm', 'RightArm', -0.25, 0, 0], ['RightHand', 'RightForeArm', -0.25, 0, 0],
    ['LeftUpLeg', 'Hips', 0.1, -0.05, 0], ['LeftLeg', 'LeftUpLeg', 0, -0.45, 0], ['LeftFoot', 'LeftLeg', 0, -0.45, 0], ['LeftToeBase', 'LeftFoot', 0, -0.05, 0.1],
    ['RightUpLeg', 'Hips', -0.1, -0.05, 0], ['RightLeg', 'RightUpLeg', 0, -0.45, 0], ['RightFoot', 'RightLeg', 0, -0.45, 0], ['RightToeBase', 'RightFoot', 0, -0.05, 0.1],
  ];
  const { root } = chainFrom(null, P);
  const m = buildBoneMap(root);
  assert.equal(m.coverage, 1);
  assert.equal(m.bones.spine.name, 'Spine');
  assert.equal(m.bones.chest.name, 'Spine1');
  assert.equal(m.bones.upperChest.name, 'Spine2');
  assert.equal(m.bones.leftLowerLeg.name, 'LeftLeg');
  assert.equal(m.bones.rightLowerArm.name, 'RightForeArm');
  for (const s of SLOTS) assert.ok(m.bones[s], `missing ${s}`);
});

test('buildBoneMap falls back to structure for meaningless bone names', () => {
  const P = [
    ['b0', null, 0, 1, 0], ['b1', 'b0', 0, 0.1, 0], ['b2', 'b1', 0, 0.1, 0],
    ['b3', 'b2', 0, 0.15, 0], ['b4', 'b3', 0, 0.1, 0],
    ['b5', 'b2', 0.05, 0.1, 0], ['b6', 'b5', 0.1, 0, 0], ['b7', 'b6', 0.25, 0, 0], ['b8', 'b7', 0.25, 0, 0],
    ['b9', 'b2', -0.05, 0.1, 0], ['b10', 'b9', -0.1, 0, 0], ['b11', 'b10', -0.25, 0, 0], ['b12', 'b11', -0.25, 0, 0],
    ['b13', 'b0', 0.1, -0.05, 0], ['b14', 'b13', 0, -0.45, 0], ['b15', 'b14', 0, -0.45, 0],
    ['b16', 'b0', -0.1, -0.05, 0], ['b17', 'b16', 0, -0.45, 0], ['b18', 'b17', 0, -0.45, 0],
  ];
  const { root } = chainFrom(null, P);
  const m = buildBoneMap(root);
  assert.equal(m.bones.hips.name, 'b0');
  assert.equal(m.bones.head.name, 'b4');
  assert.equal(m.bones.leftUpperArm.name, 'b6');
  assert.equal(m.bones.rightHand.name, 'b12');
  assert.equal(m.bones.leftUpperLeg.name, 'b13');
  assert.equal(m.bones.rightFoot.name, 'b18');
  assert.equal(m.coverage, 1);
});

test('generic CesiumMan-style names never map two slots onto one bone', () => {
  const P = [
    ['Skeleton_torso_joint_1', null, 0, 1, 0], ['Skeleton_torso_joint_2', 'Skeleton_torso_joint_1', 0, 0.15, 0], ['torso_joint_3', 'Skeleton_torso_joint_2', 0, 0.15, 0],
    ['Skeleton_neck_joint_1', 'torso_joint_3', 0, 0.12, 0], ['Skeleton_neck_joint_2', 'Skeleton_neck_joint_1', 0, 0.1, 0],
    ['Skeleton_arm_joint_L__4_', 'torso_joint_3', 0.15, 0.08, 0], ['Skeleton_arm_joint_L__3_', 'Skeleton_arm_joint_L__4_', 0.25, 0, 0], ['Skeleton_arm_joint_L__2_', 'Skeleton_arm_joint_L__3_', 0.25, 0, 0],
    ['Skeleton_arm_joint_R', 'torso_joint_3', -0.15, 0.08, 0], ['Skeleton_arm_joint_R__2_', 'Skeleton_arm_joint_R', -0.25, 0, 0], ['Skeleton_arm_joint_R__3_', 'Skeleton_arm_joint_R__2_', -0.25, 0, 0],
    ['leg_joint_L_1', 'Skeleton_torso_joint_1', 0.1, -0.05, 0], ['leg_joint_L_2', 'leg_joint_L_1', 0, -0.45, 0], ['leg_joint_L_3', 'leg_joint_L_2', 0, -0.45, 0], ['leg_joint_L_5', 'leg_joint_L_3', 0, -0.05, 0.12],
    ['leg_joint_R_1', 'Skeleton_torso_joint_1', -0.1, -0.05, 0], ['leg_joint_R_2', 'leg_joint_R_1', 0, -0.45, 0], ['leg_joint_R_3', 'leg_joint_R_2', 0, -0.45, 0], ['leg_joint_R_5', 'leg_joint_R_3', 0, -0.05, 0.12],
  ];
  const { root } = chainFrom(null, P);
  const m = buildBoneMap(root);
  const used = Object.values(m.bones);
  assert.equal(new Set(used).size, used.length, 'no bone used twice: ' + JSON.stringify(m.report.filter(r => r.bone).map(r => r.slot + '=' + r.bone)));
  assert.equal(m.bones.hips.name, 'Skeleton_torso_joint_1');
  assert.equal(m.bones.spine.name, 'Skeleton_torso_joint_2');
  assert.equal(m.bones.leftUpperLeg.name, 'leg_joint_L_1');
  assert.equal(m.bones.leftLowerLeg.name, 'leg_joint_L_2');
  assert.equal(m.bones.leftFoot.name, 'leg_joint_L_3');
  assert.equal(m.bones.head.name, 'Skeleton_neck_joint_2');
  assert.equal(m.bones.leftHand.name, 'Skeleton_arm_joint_L__2_');
});
