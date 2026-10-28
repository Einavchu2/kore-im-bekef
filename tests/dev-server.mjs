// Local test server: serves public/ with the production CSP and mounts the real core
// with a scriptable fake provider and an in-memory store. Used by the browser tests.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createTTS } from "../netlify/lib/core.mjs";
import { ProviderError } from "../netlify/lib/providers/sonex.mjs";
import { memoryStore } from "./memory-store.mjs";

const ROOT = new URL("../public/", import.meta.url).pathname;
const CSP = (await readFile(ROOT + "_headers", "utf8")).split("\n").find((l) => l.includes("Content-Security-Policy")).split(": ").slice(1).join(": ");
function wav(ms = 300) { // silent PCM WAV
  const n = Math.round(8000 * ms / 1000), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}
export const ctl = { fail: null, delayMs: 0, calls: [] };
const provider = {
  name: "fake",
  async synthesize(a) { ctl.calls.push(a); if (ctl.delayMs) await new Promise((r) => setTimeout(r, ctl.delayMs)); if (ctl.fail !== null) throw new ProviderError(ctl.fail, "scripted"); return { audio: wav(), contentType: "audio/wav", charsBilled: a.text.length, voiceFallback: false }; },
  async voices() { return [{ id: "v1", name: "Liz", language: "English" }]; },
  async balance() { return { wallet: { balance: 0, currency: "USD" }, credits: [{ service: "tts", available: 10000 }] }; },
};
let tts = createTTS({ store: memoryStore(), provider, env: { TTS_ADMIN_PASSWORD: "pw" } });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain" };

async function toNode(res, r) {
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}
export function start(port = 8790) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const wreq = new Request(url, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
    if (url.pathname === "/__ctl") { Object.assign(ctl, JSON.parse(body || "{}")); if (ctl.reset) { tts = createTTS({ store: memoryStore(), provider, env: { TTS_ADMIN_PASSWORD: "pw" } }); ctl.calls = []; ctl.reset = false; } res.end("ok"); return; }
    if (url.pathname.startsWith("/api/tts-admin/")) return toNode(res, await tts.handleAdmin(wreq));
    if (url.pathname.startsWith("/api/tts")) { if (ctl.down) { res.writeHead(500); res.end(); return; } return toNode(res, await tts.handlePublic(wreq)); }
    let p = decodeURIComponent(url.pathname); if (p.endsWith("/")) p += "index.html";
    try { const data = await readFile(path.join(ROOT, p)); res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream", "content-security-policy": CSP }); res.end(data); }
    catch { res.writeHead(404); res.end("nf"); }
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}
if (process.argv[1] === new URL(import.meta.url).pathname) start(Number(process.argv[2]) || 8790).then(() => console.log("dev server up"));
