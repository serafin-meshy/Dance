/**
 * meshy-dance library entry: everything you need to make a rigged humanoid dance to music in a
 * three.js game, without the demo UI.
 *
 *   import { AudioAnalyzer, buildBoneMap, Dancer } from 'meshy-dance';
 *   const analyzer = new AudioAnalyzer();  await analyzer.playFile(songUrl);
 *   const dancer = new Dancer(gltf.scene, buildBoneMap(gltf.scene));
 *   // per frame:
 *   dancer.update(analyzer.update(), dt);
 *
 * Offline / baking (no playback needed):
 *   const analysis = analyzeOffline(monoPcm, sampleRate);
 *   const clip = bakeDance(dancer, analysis, { fps: 30 });   // THREE.AnimationClip
 *   const glb = await exportGlb(gltf.scene, [clip]);          // ArrayBuffer
 */
export { AudioAnalyzer, DemoBeat } from './audio/AudioAnalyzer.js';
export { FeaturePipeline, scaleBeat, emptyFeatures } from './audio/pipeline.js';
export { OnsetDetector, BeatTracker, EnvelopeFollower, Spring, DEFAULT_BANDS } from './audio/dsp.js';
export { analyzeOffline, replayTimeline, backfillLock } from './audio/offline.js';
export { FFT, blackman } from './audio/fft.js';
export { buildBoneMap, classifyName, collectBones, SLOTS } from './rig/BoneMap.js';
export { Dancer } from './rig/Dancer.js';
export { MOVES, DANCE_MOVES, POSE_KEYS, zeroPose, lerpPose, pickMove } from './rig/Moves.js';
export { DanceRecorder, bakeDance, exportGlb } from './rig/Baker.js';
export { buildMannequin } from './viewer/Mannequin.js';
