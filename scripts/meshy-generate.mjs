#!/usr/bin/env node
/**
 * Generate a rig-ready humanoid with Meshy Text to 3D (preview -> refine) and download it.
 *
 *   node scripts/meshy-generate.mjs --prompt "stylized robot dancer" [--out ./output] [--polycount 30000]
 *          [--pose a-pose|t-pose] [--model latest] [--texture-prompt "..."] [--poll-ms 5000]
 *
 * Output: <out>/<refine_task_id>/model.glb (+ thumbnail.png, task.json). Feed the refine task id to
 * `npm run rig -- --task-id <refine_task_id>` or paste it into the app's Meshy panel.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const API = process.env.MESHY_API_BASE || 'https://api.meshy.ai';
try {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

function parseArgs(argv) {
  const a = { out: './output', polycount: 30000, pose: 'a-pose', model: 'latest', pollMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--prompt': a.prompt = v; i++; break;
      case '--texture-prompt': a.texturePrompt = v; i++; break;
      case '--out': a.out = v; i++; break;
      case '--polycount': a.polycount = parseInt(v, 10); i++; break;
      case '--pose': a.pose = v; i++; break;
      case '--model': a.model = v; i++; break;
      case '--poll-ms': a.pollMs = parseInt(v, 10); i++; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

async function api(key, p, init = {}) {
  const res = await fetch(API + p, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${p} -> ${res.status}: ${json.message || text.slice(0, 300)}`);
  return json;
}

async function waitFor(key, p, { pollMs, label }) {
  let last = '';
  for (;;) {
    const t = await api(key, p);
    const line = `${label}: ${t.status} ${t.progress ?? 0}%${t.preceding_tasks ? ` (queue ${t.preceding_tasks})` : ''}`;
    if (line !== last) { process.stderr.write(line + '\n'); last = line; }
    if (t.status === 'SUCCEEDED') return t;
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(t.status)) throw new Error(`${label} ${t.status}: ${t.task_error?.message || JSON.stringify(t)}`);
    await new Promise(r => setTimeout(r, pollMs));
  }
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} -> ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.prompt) { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0]); process.exit(a.help ? 0 : 1); }
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new Error('MESHY_API_KEY is not set');

  const previewBody = { mode: 'preview', prompt: a.prompt, ai_model: a.model, should_remesh: true, topology: 'triangle', target_polycount: a.polycount, pose_mode: a.pose };
  const { result: previewId } = await api(key, '/openapi/v2/text-to-3d', { method: 'POST', body: JSON.stringify(previewBody) });
  process.stderr.write(`preview task ${previewId}\n`);
  const preview = await waitFor(key, `/openapi/v2/text-to-3d/${previewId}`, { pollMs: a.pollMs, label: 'preview' });

  const refineBody = { mode: 'refine', preview_task_id: previewId, enable_pbr: false, texture_resolution: '2k' };
  if (a.texturePrompt) refineBody.texture_prompt = a.texturePrompt;
  const { result: refineId } = await api(key, '/openapi/v2/text-to-3d', { method: 'POST', body: JSON.stringify(refineBody) });
  process.stderr.write(`refine task ${refineId}\n`);
  const refine = await waitFor(key, `/openapi/v2/text-to-3d/${refineId}`, { pollMs: a.pollMs, label: 'refine' });

  const dir = path.join(a.out, refineId);
  fs.mkdirSync(dir, { recursive: true });
  await download(refine.model_urls.glb, path.join(dir, 'model.glb'));
  if (refine.thumbnail_url) await download(refine.thumbnail_url, path.join(dir, 'thumbnail.png'));
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ preview, refine }, null, 2));
  console.log(JSON.stringify({ previewTaskId: previewId, refineTaskId: refineId, glb: path.join(dir, 'model.glb'), credits: (preview.consumed_credits || 0) + (refine.consumed_credits || 0) }, null, 2));
  process.stderr.write(`\nNext: npm run rig -- --task-id ${refineId}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
