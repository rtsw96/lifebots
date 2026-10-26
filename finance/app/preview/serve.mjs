// Local preview server for the Money app's views (no crypto, no Telegram).
// Every response goes through the real Worker (../worker.js), so the page gets
// the production Content-Security-Policy and a CSP mistake shows up here.
//
//   node finance/app/preview/serve.mjs [port] [data-dir]
//   open http://localhost:8788/preview/views.html?data=/data/fixture.json&tab=flows
//
// /preview/* is this folder, /data/* is data-dir (default ../test, which holds
// the synthetic fixture), everything else is ../public as deployed. Snapshots
// with real numbers belong in a scratch folder passed as data-dir, never here.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain", ".svg": "image/svg+xml" };

export function previewServer(dataDir = resolve(HERE, "../test")) {
  const roots = [["/preview/", HERE], ["/data/", resolve(dataDir)], ["/", resolve(HERE, "../public")]];
  const ASSETS = {
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const [prefix, root] = roots.find(([p]) => path.startsWith(p));
      const rel = normalize(path.slice(prefix.length) || "index.html");
      if (rel.startsWith("..")) return new Response("Not found", { status: 404 });
      try {
        const body = await readFile(join(root, rel));
        return new Response(body, { headers: { "Content-Type": TYPES[extname(rel)] || "application/octet-stream" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
  return createServer(async (req, res) => {
    const r = await worker.fetch(new Request(`http://localhost${req.url}`, { method: req.method }), { ASSETS });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8788);
  previewServer(process.argv[3]).listen(port, () => console.log(`Money preview on http://localhost:${port}/preview/views.html?data=/data/fixture.json`));
}
