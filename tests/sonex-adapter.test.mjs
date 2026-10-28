// Checks the adapter speaks the documented Sonex protocol, against a local mock HTTP server.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSonexProvider, ProviderError } from "../netlify/lib/providers/sonex.mjs";

function mock(handler) {
  return new Promise((res) => { const srv = http.createServer(handler); srv.listen(0, () => res(srv)); });
}
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

test("request format, headers and response metadata", async () => {
  let seen;
  const srv = await mock(async (req, res) => {
    seen = { method: req.method, url: req.url, auth: req.headers.authorization, ct: req.headers["content-type"], body: JSON.parse(await body(req)) };
    res.writeHead(200, { "content-type": "audio/mpeg", "x-chars-billed": "7", "x-voice-fallback": "true", "x-voice-fallback-reason": "voice not found" });
    res.end(Buffer.from([0xff, 0xfb, 0x90]));
  });
  const p = createSonexProvider({ apiKey: "vsk_test", baseUrl: `http://127.0.0.1:${srv.address().port}/v1` });
  const r = await p.synthesize({ text: "דָג בַּיָם", voiceId: "abc", speed: 9 });
  srv.close();
  assert.equal(seen.method, "POST"); assert.equal(seen.url, "/v1/speech");
  assert.equal(seen.auth, "Bearer vsk_test"); assert.equal(seen.ct, "application/json");
  assert.deepEqual(seen.body, { text: "דָג בַּיָם", output_format: "mp3", speed: 2, voice_id: "abc" });
  assert.equal(r.charsBilled, 7); assert.equal(r.voiceFallback, true); assert.equal(r.audio.byteLength, 3);
});

test("429 with short Retry-After is retried once", async () => {
  let n = 0;
  const srv = await mock(async (req, res) => { n++; await body(req);
    if (n === 1) { res.writeHead(429, { "retry-after": "1" }); res.end("slow down"); }
    else { res.writeHead(200, { "content-type": "audio/mpeg" }); res.end(Buffer.from([1])); } });
  const p = createSonexProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${srv.address().port}/v1` });
  await p.synthesize({ text: "א" }); srv.close();
  assert.equal(n, 2);
});

test("402 surfaces as ProviderError(402); timeouts become status 0", async () => {
  const srv = await mock(async (req, res) => { await body(req); if (req.url.includes("speech")) { res.writeHead(402); res.end("Insufficient balance"); } });
  const p = createSonexProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${srv.address().port}/v1` });
  await assert.rejects(p.synthesize({ text: "א" }), (e) => e instanceof ProviderError && e.status === 402); srv.close();
  const hang = await mock(() => {});
  const p2 = createSonexProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${hang.address().port}/v1`, timeoutMs: 300 });
  await assert.rejects(p2.synthesize({ text: "א" }), (e) => e.status === 0 && e.detail === "timeout");
  hang.closeAllConnections(); hang.close();
});

test("no key, no provider", () => { assert.throws(() => createSonexProvider({ apiKey: "" })); });
