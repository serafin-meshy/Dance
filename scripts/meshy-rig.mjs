#!/usr/bin/env node
/**
 * Rig a humanoid model with the Meshy Rigging API and download everything it produces.
 *
 *   node scripts/meshy-rig.mjs --model ./character.glb            # local file -> data URI
 *   node scripts/meshy-rig.mjs --model-url https://.../model.glb  # public URL
 *   node scripts/meshy-rig.mjs --task-id 0193…                     # output of a Meshy Text/Image-to-3D task
 *   options: --height 1.7  --texture <image url>  --out ./output  --animate 5,12  --dry-run
 *
 * Needs MESHY_API_KEY in the environment (or a .env file in the repo root).
 * Output: <out>/<rigTaskId>/rigged.glb, basic animations, any requested animation-library clips,
 *         and task.json with the raw API responses.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const API = process.env.MESHY_API_BASE || 'https://api.meshy.ai';

// --- tiny .env loader (no dependency)
try {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

function parseArgs(argv) {
  const a = { height: 1.7, out: './output', animate: [], dryRun: false, pollMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--model': a.model = v; i++; break;
      case '--model-url': a.modelUrl = v; i++; break;
      case '--task-id': a.taskId = v; i++; break;
      case '--height': a.height = parseFloat(v); i++; break;
      case '--texture': a.texture = v; i++; break;
      case '--out': a.out = v; i++; break;
      case '--animate': a.animate = v.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite); i++; break;
      case '--poll-ms': a.pollMs = parseInt(v, 10); i++; break;
      case '--dry-run': a.dryRun = true; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

export function buildRiggingBody(a) {
  const body = { height_meters: a.height };
  if (a.taskId) body.input_task_id = a.taskId;
  else if (a.modelUrl) body.model_url = a.modelUrl;
  else if (a.model) {
    const buf = fs.readFileSync(a.model);
    const mime = a.model.toLowerCase().endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary';
    body.model_url = `data:${mime};base64,${buf.toString('base64')}`;
  } else throw new Error('one of --model, --model-url or --task-id is required');
  if (a.texture) body.texture_image_url = a.texture;
  return body;
}

/** Recursively collect every GLB / FBX url in a task result. */
export function collectAssetUrls(obj, prefix = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^https?:\/\//.test(v) && /_(glb|fbx)_url$|\.(glb|fbx)(\?|$)/i.test(k + ' ' + v)) {
      out.push({ key: (prefix + k).replace(/_url$/, ''), url: v, ext: /fbx/i.test(k) || /\.fbx(\?|$)/i.test(v) ? 'fbx' : 'glb' });
    } else if (v && typeof v === 'object') collectAssetUrls(v, prefix + k + '.', out);
  }
  return out;
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
    const line = `${label}: ${t.status} ${t.progress ?? 0}%`;
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
  return dest;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0]); return; }
  const body = buildRiggingBody(a);
  if (a.dryRun) {
    const preview = { ...body, model_url: body.model_url?.startsWith('data:') ? body.model_url.slice(0, 48) + `…(${body.model_url.length} chars)` : body.model_url };
    console.log(JSON.stringify({ endpoint: `POST ${API}/openapi/v1/rigging`, body: preview, animate: a.animate, out: a.out }, null, 2));
    return;
  }
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new Error('MESHY_API_KEY is not set');

  const { result: rigId } = await api(key, '/openapi/v1/rigging', { method: 'POST', body: JSON.stringify(body) });
  process.stderr.write(`rigging task ${rigId}\n`);
  const rig = await waitFor(key, `/openapi/v1/rigging/${rigId}`, { pollMs: a.pollMs, label: 'rigging' });

  const dir = path.join(a.out, rigId);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  const assets = collectAssetUrls(rig.result || {});
  for (const asset of assets) {
    const name = /rigged_character/.test(asset.key) ? `rigged.${asset.ext}` : `${asset.key.replace(/[^a-z0-9_.-]/gi, '_')}.${asset.ext}`;
    const dest = path.join(dir, name);
    process.stderr.write(`downloading ${asset.key} -> ${dest}\n`);
    await download(asset.url, dest); saved.push(dest);
  }

  const anims = [];
  for (const actionId of a.animate) {
    const { result: animId } = await api(key, '/openapi/v1/animations', { method: 'POST', body: JSON.stringify({ rig_task_id: rigId, action_id: actionId }) });
    const anim = await waitFor(key, `/openapi/v1/animations/${animId}`, { pollMs: a.pollMs, label: `animation ${actionId}` });
    anims.push(anim);
    for (const asset of collectAssetUrls(anim.result || {})) {
      const dest = path.join(dir, `action_${actionId}.${asset.ext}`);
      await download(asset.url, dest); saved.push(dest);
    }
  }
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ rigging: rig, animations: anims }, null, 2));
  console.log(JSON.stringify({ rigTaskId: rigId, dir, files: saved }, null, 2));
  process.stderr.write(`\nDone. Load ${path.join(dir, 'rigged.glb')} in the app (or copy it into public/ and open ?model=/your.glb).\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
