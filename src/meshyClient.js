/**
 * Browser-side client for the Meshy Rigging / Animation API, routed through the dev-server
 * proxy in vite.config.js (which injects MESHY_API_KEY so the key never reaches the browser).
 */
const BASE = '/api/meshy';

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (json.raw !== undefined && /<!doctype|<html/i.test(text)) {
    throw new Error('The Meshy proxy is not available on this host. Run the app locally with `npm run dev` and MESHY_API_KEY in .env, or use `npm run rig` (CLI), then load the rigged GLB here.');
  }
  if (!res.ok) throw new Error(`Meshy ${res.status}: ${json.message || json.error || text.slice(0, 200)}`);
  return json;
}

/** POST /openapi/v1/rigging */
export async function createRiggingTask({ modelUrl, inputTaskId, heightMeters = 1.7, textureImageUrl }) {
  const body = { height_meters: heightMeters };
  if (inputTaskId) body.input_task_id = inputTaskId; else body.model_url = modelUrl;
  if (textureImageUrl) body.texture_image_url = textureImageUrl;
  const r = await api('/openapi/v1/rigging', { method: 'POST', body: JSON.stringify(body) });
  return r.result;
}

export const getRiggingTask = (id) => api(`/openapi/v1/rigging/${id}`);

/** POST /openapi/v1/animations  (action ids come from Meshy's animation library) */
export async function createAnimationTask({ rigTaskId, actionId }) {
  const r = await api('/openapi/v1/animations', { method: 'POST', body: JSON.stringify({ rig_task_id: rigTaskId, action_id: actionId }) });
  return r.result;
}
export const getAnimationTask = (id) => api(`/openapi/v1/animations/${id}`);

/** Poll a task until SUCCEEDED / FAILED. */
export async function waitForTask(getter, id, { interval = 4000, onProgress } = {}) {
  for (;;) {
    const t = await getter(id);
    onProgress && onProgress(t);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED' || t.status === 'EXPIRED') {
      throw new Error(`Task ${id} ${t.status}: ${t.task_error?.message || ''}`);
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

/** Find every *_glb_url inside a task result (robust to field-name drift). */
export function collectGlbUrls(obj, prefix = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /_glb_url$|\.glb(\?|$)/i.test(k + (v.includes('.glb') ? v : ''))) out.push({ key: prefix + k, url: v });
    else if (v && typeof v === 'object') collectGlbUrls(v, prefix + k + '.', out);
  }
  return out;
}

/** Fetch a Meshy asset URL through the proxy (avoids CORS on asset hosts). */
export const proxiedAssetUrl = (url) => `/api/fetch?url=${encodeURIComponent(url)}`;
