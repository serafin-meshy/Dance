import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRiggingBody, collectAssetUrls } from '../scripts/meshy-rig.mjs';

test('buildRiggingBody: task id, url, and local file -> data URI', () => {
  assert.deepEqual(buildRiggingBody({ taskId: 'abc', height: 1.7 }), { height_meters: 1.7, input_task_id: 'abc' });
  assert.deepEqual(buildRiggingBody({ modelUrl: 'https://x/y.glb', height: 1.8, texture: 'https://x/t.png' }), { height_meters: 1.8, model_url: 'https://x/y.glb', texture_image_url: 'https://x/t.png' });
  const tmp = path.join(os.tmpdir(), `m-${Date.now()}.glb`);
  fs.writeFileSync(tmp, Buffer.from('glTF'));
  const b = buildRiggingBody({ model: tmp, height: 1.7 });
  assert.ok(b.model_url.startsWith('data:model/gltf-binary;base64,'));
  fs.unlinkSync(tmp);
  assert.throws(() => buildRiggingBody({ height: 1 }), /required/);
});

test('collectAssetUrls finds nested glb/fbx urls', () => {
  const r = {
    rigged_character_glb_url: 'https://assets.meshy.ai/a/rigged.glb', rigged_character_fbx_url: 'https://assets.meshy.ai/a/rigged.fbx',
    basic_animations: { walking_glb_url: 'https://assets.meshy.ai/a/walk.glb', running_fbx_url: 'https://assets.meshy.ai/a/run.fbx' },
    thumbnail_url: 'https://assets.meshy.ai/a/t.png',
  };
  const got = collectAssetUrls(r);
  assert.equal(got.length, 4);
  assert.deepEqual(got.find(g => g.key === 'rigged_character_glb'), { key: 'rigged_character_glb', url: r.rigged_character_glb_url, ext: 'glb' });
  assert.equal(got.find(g => g.key === 'basic_animations.running_fbx').ext, 'fbx');
});

test('CLI --dry-run prints the request without a key', () => {
  const out = execFileSync(process.execPath, ['scripts/meshy-rig.mjs', '--task-id', 'task123', '--height', '1.6', '--animate', '5,12', '--dry-run'], { env: { ...process.env, MESHY_API_KEY: '' } }).toString();
  const j = JSON.parse(out);
  assert.equal(j.endpoint, 'POST https://api.meshy.ai/openapi/v1/rigging');
  assert.deepEqual(j.body, { height_meters: 1.6, input_task_id: 'task123' });
  assert.deepEqual(j.animate, [5, 12]);
});
