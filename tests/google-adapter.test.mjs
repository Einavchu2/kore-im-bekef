// Checks the Google adapter speaks the documented REST protocol, against a local mock server.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createGoogleProvider } from "../netlify/lib/providers/google.mjs";
import { ProviderError } from "../netlify/lib/providers/sonex.mjs";
import { pickProvider } from "../netlify/lib/runtime.mjs";

const mock = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, () => r(s)); });
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const base = (s) => `http://127.0.0.1:${s.address().port}/v1`;

test("synthesize: URL, key, body and base64 decoding", async () => {
  let seen;
  const srv = await mock(async (req, res) => {
    seen = { method: req.method, url: req.url, body: JSON.parse(await body(req)) };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ audioContent: Buffer.from([0xff, 0xfb, 7]).toString("base64") }));
  });
  const p = createGoogleProvider({ apiKey: "AIza-test", baseUrl: base(srv) });
  const r = await p.synthesize({ text: "דָג בַּיָם", voiceId: "he-IL-Chirp3-HD-Test", speed: 0.8 });
  srv.close();
  assert.equal(seen.method, "POST"); assert.equal(seen.url, "/v1/text:synthesize?key=AIza-test");
  assert.deepEqual(seen.body, { input: { text: "דָג בַּיָם" }, voice: { languageCode: "he-IL", name: "he-IL-Chirp3-HD-Test" }, audioConfig: { audioEncoding: "MP3", speakingRate: 0.8 } });
  assert.deepEqual([...new Uint8Array(r.audio)], [0xff, 0xfb, 7]); assert.equal(r.contentType, "audio/mpeg");
});

test("a voice id from another provider is ignored", async () => {
  let seen;
  const srv = await mock(async (req, res) => { seen = JSON.parse(await body(req)); res.end(JSON.stringify({ audioContent: "AA==" })); });
  await createGoogleProvider({ apiKey: "k", baseUrl: base(srv) }).synthesize({ text: "א", voiceId: "sonex-voice-123" });
  srv.close();
  assert.deepEqual(seen.voice, { languageCode: "he-IL" });
});

test("voices: Hebrew only, Chirp 3 HD first", async () => {
  const srv = await mock((req, res) => res.end(JSON.stringify({ voices: [
    { name: "he-IL-Standard-A", languageCodes: ["he-IL"], ssmlGender: "FEMALE" },
    { name: "he-IL-Chirp3-HD-Zed", languageCodes: ["he-IL"], ssmlGender: "MALE" },
    { name: "en-US-X", languageCodes: ["en-US"] }] })));
  const v = await createGoogleProvider({ apiKey: "k", baseUrl: base(srv) }).voices(); srv.close();
  assert.deepEqual(v.map((x) => x.id), ["he-IL-Chirp3-HD-Zed", "he-IL-Standard-A"]);
  assert.equal(v[0].language, "Chirp 3 HD · גברי");
});

test("errors map onto the service's statuses", async () => {
  for (const [code, msg, want] of [[403, "API key not valid", 401], [403, "This API method requires billing to be enabled", 401], [429, "Quota exceeded", 402], [400, "bad", 400]]) {
    const srv = await mock(async (req, res) => { await body(req); res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code, message: msg } })); });
    await assert.rejects(createGoogleProvider({ apiKey: "k", baseUrl: base(srv) }).synthesize({ text: "א" }), (e) => e instanceof ProviderError && e.status === want);
    srv.close();
  }
});

test("provider choice: Google wins when both keys are set", () => {
  const env = (o) => (k) => o[k];
  assert.equal(pickProvider(env({ GOOGLE_TTS_API_KEY: "g", SONEX_API_KEY: "s", GOOGLE_TTS_VOICE: "he-IL-x" })).provider.name, "google");
  assert.equal(pickProvider(env({ SONEX_API_KEY: "s" })).provider.name, "sonex");
  assert.equal(pickProvider(env({})).provider, null);
});
