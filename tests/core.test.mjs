import test from "node:test";
import assert from "node:assert/strict";
import { createTTS, eduKey } from "../netlify/lib/core.mjs";
import { engineText, syllableRule } from "../netlify/lib/pronunciation.mjs";
import { memoryStore } from "./memory-store.mjs";
import { fakeProvider } from "./fake-provider.mjs";

const ADMIN = "s3cret-admin";
function setup(envExtra = {}, withProvider = true) {
  const store = memoryStore(), provider = withProvider ? fakeProvider() : null;
  let t = Date.parse("2026-10-26T09:00:00Z");
  const tts = createTTS({ store, provider, env: { TTS_ADMIN_PASSWORD: ADMIN, ...envExtra }, now: () => (t += 1000) });
  const get = (path) => tts.handlePublic(new Request("https://x.test" + path));
  const admin = (action, body, method = "POST", key = ADMIN) => tts.handleAdmin(new Request(`https://x.test/api/tts-admin/${action}`, {
    method, headers: { "x-admin-key": key, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  return { store, provider, tts, get, admin };
}
const q = (o) => "/api/tts?" + new URLSearchParams(o).toString();

test("health reports disabled without an API key, enabled with one", async () => {
  assert.equal((await (await setup({}, false).get("/api/tts/health")).json()).enabled, false);
  assert.equal((await (await setup().get("/api/tts/health")).json()).enabled, true);
});

test("UI speech is generated once, then served from cache", async () => {
  const { get, provider } = setup();
  const r1 = await get(q({ kind: "ui", style: "praise", text: "כל הכבוד!" }));
  assert.equal(r1.status, 200); assert.equal(r1.headers.get("x-tts-source"), "generated");
  const r2 = await get(q({ kind: "ui", style: "praise", text: "כל הכבוד!" }));
  assert.equal(r2.headers.get("x-tts-source"), "cache");
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].speed, 1.05, "praise style speed");
  await get(q({ kind: "ui", style: "instruction", text: "כל הכבוד!" }));
  assert.equal(provider.calls.length, 2, "a different style is a different clip");
  assert.match(r1.headers.get("cache-control"), /immutable/);
});

test("emoji are stripped and NFC normalization gives one cache entry", async () => {
  const { get, provider } = setup();
  const composed = "שָׁלוֹם";
  const decomposed = "ש\u05B8\u05C1לו\u05B9ם"; // marks in a different order
  await get(q({ kind: "ui", style: "instruction", text: composed + " 🦁" }));
  await get(q({ kind: "ui", style: "instruction", text: decomposed }));
  assert.equal(provider.calls[0].text, composed);
  assert.equal(provider.calls.length, 1);
});

test("input validation", async () => {
  const { get, provider } = setup();
  assert.equal((await get(q({ kind: "ui", text: "א".repeat(201) }))).status, 400);
  assert.equal((await get(q({ kind: "ui", text: "<script>" }))).status, 400);
  assert.equal((await get(q({ kind: "nope", text: "דָג" }))).status, 400);
  assert.equal((await get(q({ kind: "ui", style: "shout", text: "דָג" }))).status, 400);
  assert.equal(provider.calls.length, 0);
});

test("educational speech is never generated on the fly", async () => {
  const { get, provider } = setup();
  const r = await get(q({ kind: "word", text: "דָג" }));
  assert.equal(r.status, 404); assert.equal((await r.json()).error, "not-approved");
  assert.equal(provider.calls.length, 0);
});

test("admin endpoints require the password", async () => {
  const { admin } = setup();
  assert.equal((await admin("status", null, "GET", "wrong")).status, 401);
  assert.equal((await admin("status", null, "GET", "")).status, 401);
  assert.equal((await admin("status", null, "GET")).status, 200);
});

test("approval flow: candidate -> approve -> served; unapprove -> gone", async () => {
  const { get, admin, provider } = setup();
  const c = await (await admin("candidate", { text: "דָ", kind: "syllable" })).json();
  assert.equal(c.sendText, "דָה", "single-syllable rule"); assert.equal(provider.calls[0].speed, 0.8);
  assert.equal((await get(q({ kind: "syllable", text: "דָ" }))).status, 404, "candidate alone is not public");
  const a = await (await admin("approve", { text: "דָ", kind: "syllable" })).json();
  assert.equal(a.source, "generated");
  const idx = await (await get("/api/tts/approved")).json();
  assert.deepEqual(idx.items, [eduKey("דָ", "syllable")]);
  const r = await get(q({ kind: "syllable", text: "דָ" }));
  assert.equal(r.status, 200); assert.equal(r.headers.get("x-tts-source"), "approved");
  await admin("unapprove", { text: "דָ", kind: "syllable" });
  assert.equal((await get(q({ kind: "syllable", text: "דָ" }))).status, 404);
});

test("approve without listening to a candidate first is refused", async () => {
  const { admin } = setup();
  assert.equal((await admin("approve", { text: "יָד", kind: "word" })).status, 404);
});

test("uploaded recording overrides generated speech", async () => {
  const { get, admin, tts } = setup();
  await admin("candidate", { text: "גַג", kind: "word" }); await admin("approve", { text: "גַג", kind: "word" });
  const fd = new FormData(); fd.set("text", "גַג"); fd.set("kind", "word");
  fd.set("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" }), "gag.mp3");
  const up = await tts.handleAdmin(new Request("https://x.test/api/tts-admin/upload", { method: "POST", headers: { "x-admin-key": ADMIN }, body: fd }));
  assert.equal(up.status, 200); assert.equal((await up.json()).source, "recording");
  const r = await get(q({ kind: "word", text: "גַג" }));
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [1, 2, 3, 4]);
  const bad = new FormData(); bad.set("text", "גַג"); bad.set("kind", "word"); bad.set("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
  assert.equal((await tts.handleAdmin(new Request("https://x.test/api/tts-admin/upload", { method: "POST", headers: { "x-admin-key": ADMIN }, body: bad }))).status, 415);
});

test("pronunciation override changes only the engine input, never the key", async () => {
  const { admin, provider } = setup();
  await admin("pronunciation", { text: "סֵפֶר", kind: "word", sendText: "סֵפֶר." });
  const c = await (await admin("candidate", { text: "סֵפֶר", kind: "word" })).json();
  assert.equal(c.rule, "override"); assert.equal(provider.calls[0].text, "סֵפֶר.");
  assert.equal(c.key, "word|סֵפֶר");
});

test("syllable rules", () => {
  assert.equal(syllableRule("דַ"), "דַה"); assert.equal(syllableRule("דְ"), "דֶה");
  assert.equal(syllableRule("ד"), "דָּלֶת"); assert.equal(syllableRule("קַרְ"), "קַרְ", "multi-letter chunk unchanged");
  assert.equal(engineText("נָה", "syllable").sendText, "נָה");
});

for (const [status, expect] of [[402, [503, "quota-exhausted"]], [401, [503, "provider-auth"]], [429, [503, "provider-rate-limited"]], [502, [502, "provider-unavailable"]], [0, [502, "provider-unavailable"]]]) {
  test(`provider ${status} is reported as ${expect[1]} and logged`, async () => {
    const { get, provider, admin } = setup();
    provider.failWith = status;
    const r = await get(q({ kind: "ui", text: "הקשיבו טוב" }));
    assert.equal(r.status, expect[0]); assert.equal((await r.json()).error, expect[1]);
    const st = await (await admin("status", null, "GET")).json();
    assert.equal(st.today.errors, 1); assert.equal(st.recentErrors[0].error, expect[1]);
  });
}

test("daily new-generation limit protects the quota; cached clips still play", async () => {
  const { get } = setup({ TTS_DAILY_NEW_LIMIT: "2" });
  assert.equal((await get(q({ kind: "ui", text: "אחת" }))).status, 200);
  assert.equal((await get(q({ kind: "ui", text: "שתיים" }))).status, 200);
  const r = await get(q({ kind: "ui", text: "שלוש" }));
  assert.equal(r.status, 429); assert.equal((await r.json()).error, "daily-limit");
  assert.equal((await get(q({ kind: "ui", text: "אחת" }))).headers.get("x-tts-source"), "cache");
});

test("voice fallback from the provider is surfaced to the reviewer", async () => {
  const { admin, provider } = setup();
  provider.voiceFallback = true;
  const c = await (await admin("candidate", { text: "יָם", kind: "word" })).json();
  assert.equal(c.voiceFallback, true);
});

test("config: speeds validated and voice change creates new clips", async () => {
  const { get, admin, provider } = setup();
  assert.equal((await admin("config", { speeds: { praise: 3 } })).status, 422);
  await get(q({ kind: "ui", text: "יופי" }));
  await admin("config", { voiceId: "v2", speeds: { instruction: 0.9 } });
  await get(q({ kind: "ui", text: "יופי" }));
  assert.equal(provider.calls.length, 2); assert.equal(provider.calls[1].voiceId, "v2"); assert.equal(provider.calls[1].speed, 0.9);
});

test("approved audio is served even when the API key is removed", async () => {
  const s = setup();
  await s.admin("candidate", { text: "דַף", kind: "word" }); await s.admin("approve", { text: "דַף", kind: "word" });
  const noKey = createTTS({ store: s.store, provider: null, env: {} });
  const r = await noKey.handlePublic(new Request("https://x.test" + q({ kind: "word", text: "דַף" })));
  assert.equal(r.status, 200);
  assert.equal((await noKey.handlePublic(new Request("https://x.test" + q({ kind: "ui", text: "שלום" })))).status, 503);
});
