import { defineConfig, loadEnv } from 'vite';

const MESHY_API = 'https://api.meshy.ai';
const ASSET_HOSTS = /(^|\.)meshy\.ai$/i;

/**
 * Dev/preview middleware:
 *   /api/meshy/<path>   -> https://api.meshy.ai/<path>  with Authorization: Bearer $MESHY_API_KEY
 *   /api/fetch?url=...  -> streams a Meshy asset (CORS-free download of rigged GLBs)
 * The key never leaves the server.
 */
function meshyProxy(env) {
  const handler = async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/meshy/')) {
      const key = env.MESHY_API_KEY || process.env.MESHY_API_KEY;
      if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'MESHY_API_KEY is not set (put it in .env)' })); }
      const target = MESHY_API + url.pathname.replace(/^\/api\/meshy/, '') + url.search;
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      try {
        const r = await fetch(target, {
          method: req.method,
          headers: { authorization: `Bearer ${key}`, 'content-type': req.headers['content-type'] || 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        });
        res.statusCode = r.status;
        res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.statusCode = 502; res.end(JSON.stringify({ message: `proxy error: ${e.message}` })); }
      return;
    }
    if (url.pathname === '/api/fetch') {
      const asset = url.searchParams.get('url') || '';
      let host = ''; try { host = new URL(asset).hostname; } catch {}
      if (!ASSET_HOSTS.test(host)) { res.statusCode = 400; return res.end('only *.meshy.ai assets can be fetched'); }
      try {
        const r = await fetch(asset);
        res.statusCode = r.status;
        res.setHeader('content-type', r.headers.get('content-type') || 'model/gltf-binary');
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.statusCode = 502; res.end(`fetch error: ${e.message}`); }
      return;
    }
    next();
  };
  return {
    name: 'meshy-proxy',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    plugins: [meshyProxy(env)],
    server: { port: 5173, host: true },
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1200 },
  };
});
