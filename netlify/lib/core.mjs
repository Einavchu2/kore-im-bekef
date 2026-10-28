// Speech service core: validation, pronunciation, approval workflow, caching, limits, usage log.
// Provider-agnostic and storage-agnostic, so it can be unit-tested and the TTS vendor can be swapped.
import { createHash, timingSafeEqual } from "node:crypto";
import { engineText } from "./pronunciation.mjs";
import { ProviderError } from "./providers/sonex.mjs";

export const EDU_KINDS = ["word", "syllable", "sentence", "term"];
export const STYLES = ["word", "instruction", "praise", "correction", "encourage", "intro"];
// Speed is the only expressive control the provider documents. Values are starting points; adjust on the review page.
export const DEFAULT_SPEEDS = { word: 0.8, instruction: 0.95, praise: 1.05, correction: 0.9, encourage: 0.95, intro: 1.0 };
const MAX_LEN = 200;
const ALLOWED = /^[\u05B0-\u05C7\u05D0-\u05EA\u05F3\u05F4\uFB1D-\uFB4F A-Za-z0-9.,!?:;'"\-–—…()\u05BE]+$/u;

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 40);
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const audioRes = (buf, contentType, source, cache) => new Response(buf, { status: 200, headers: { "content-type": contentType || "audio/mpeg", "cache-control": cache, "x-tts-source": source } });
const IMMUTABLE = "public, max-age=31536000, immutable";

export function cleanText(t) {
  return String(t || "").normalize("NFC").replace(/\p{Extended_Pictographic}/gu, "").replace(/[\uFE0F\u200D]/g, "").replace(/\s+/g, " ").trim();
}
export const eduKey = (text, kind) => `${kind}|${cleanText(text)}`;
function dayKey(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function providerStatus(e) {
  if (!(e instanceof ProviderError)) return { status: 502, error: "provider-unavailable" };
  if (e.status === 402) return { status: 503, error: "quota-exhausted" };
  if (e.status === 401) return { status: 503, error: "provider-auth" };
  if (e.status === 429) return { status: 503, error: "provider-rate-limited", retryAfter: e.retryAfter };
  if (e.status === 422 || e.status === 400) return { status: 422, error: "provider-rejected-text" };
  return { status: 502, error: "provider-unavailable" };
}

export function createTTS({ store, provider, env = {}, now = () => Date.now() }) {
  const dailyLimit = Number(env.TTS_DAILY_NEW_LIMIT) || 300;

  async function getConfig() {
    const c = (await store.get("config", { type: "json" })) || {};
    return { voiceId: c.voiceId || env.SONEX_VOICE_ID || null, speeds: { ...DEFAULT_SPEEDS, ...(c.speeds || {}) }, version: c.version || "1" };
  }
  async function getIndex() {
    return (await store.get("approved-index", { type: "json" })) || { version: "0", items: {} };
  }
  async function getOverrides() { return (await store.get("pronunciation", { type: "json" })) || {}; }
  async function log(type, data) {
    const t = now();
    await store.setJSON(`log/${dayKey(t)}/${type}-${t}-${Math.random().toString(36).slice(2, 8)}`, { type, at: new Date(t).toISOString(), ...data });
  }
  async function todays(type) {
    const { blobs } = await store.list({ prefix: `log/${dayKey(now())}/${type ? type + "-" : ""}` });
    return blobs;
  }
  function validate(text, kind, style) {
    if (!text) return "empty-text";
    if (text.length > MAX_LEN) return "text-too-long";
    if (!ALLOWED.test(text)) return "unsupported-characters";
    if (kind !== "ui" && !EDU_KINDS.includes(kind)) return "bad-kind";
    if (kind === "ui" && !STYLES.includes(style)) return "bad-style";
    return null;
  }

  // ---------- public endpoint: GET /api/tts, /api/tts/health, /api/tts/approved
  async function handlePublic(req) {
    const url = new URL(req.url);
    if (req.method !== "GET") return json(405, { error: "method-not-allowed" });
    if (url.pathname.endsWith("/health")) {
      const [cfg, idx] = await Promise.all([getConfig(), getIndex()]);
      return json(200, { enabled: !!provider, provider: provider?.name || null, configVersion: cfg.version, approvedVersion: idx.version });
    }
    if (url.pathname.endsWith("/approved")) {
      const idx = await getIndex();
      return json(200, { version: idx.version, items: Object.keys(idx.items) }, { "cache-control": "public, max-age=60" });
    }
    const text = cleanText(url.searchParams.get("text"));
    const kind = url.searchParams.get("kind") || "ui";
    const style = url.searchParams.get("style") || "instruction";
    const bad = validate(text, kind, style);
    if (bad) return json(400, { error: bad });

    if (kind !== "ui") {
      // Educational speech: approved audio only. Never generated on the fly.
      const k = eduKey(text, kind);
      const idx = await getIndex();
      if (!idx.items[k]) return json(404, { error: "not-approved" });
      const audio = await store.get(`approved/${sha(k)}`, { type: "arrayBuffer" });
      if (!audio) return json(404, { error: "not-approved" });
      return audioRes(audio, idx.items[k].contentType, "approved", IMMUTABLE);
    }

    if (!provider) return json(503, { error: "tts-disabled" });
    const cfg = await getConfig();
    const speed = cfg.speeds[style] ?? 1;
    const key = `gen/${sha(["ui", style, text, cfg.voiceId, speed].join("|"))}`;
    const hit = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (hit && hit.data) return audioRes(hit.data, hit.metadata?.contentType, "cache", IMMUTABLE);

    if ((await todays("gen")).length >= dailyLimit) return json(429, { error: "daily-limit" }, { "retry-after": "3600" });
    try {
      const r = await provider.synthesize({ text, voiceId: cfg.voiceId, speed });
      await store.set(key, r.audio, { metadata: { text, style, voiceId: cfg.voiceId, speed, contentType: r.contentType, charsBilled: r.charsBilled, voiceFallback: r.voiceFallback } });
      await log("gen", { chars: r.charsBilled ?? text.length, voiceFallback: r.voiceFallback });
      return audioRes(r.audio, r.contentType, "generated", IMMUTABLE);
    } catch (e) {
      const m = providerStatus(e);
      await log("error", { error: m.error, providerStatus: e.status ?? null, detail: String(e.detail || e.message || "").slice(0, 200) });
      return json(m.status, { error: m.error }, m.retryAfter ? { "retry-after": String(m.retryAfter) } : {});
    }
  }

  // ---------- admin endpoint: /api/tts-admin/<action>, header x-admin-key
  async function handleAdmin(req) {
    if (!env.TTS_ADMIN_PASSWORD) return json(503, { error: "admin-disabled: set TTS_ADMIN_PASSWORD" });
    if (!safeEq(req.headers.get("x-admin-key"), env.TTS_ADMIN_PASSWORD)) return json(401, { error: "unauthorized" });
    const url = new URL(req.url);
    const action = url.pathname.split("/").filter(Boolean).pop();
    const body = req.method === "POST" && (req.headers.get("content-type") || "").includes("application/json") ? await req.json() : null;

    if (action === "status") {
      const [cfg, idx, gens, errs] = await Promise.all([getConfig(), getIndex(), todays("gen"), todays("error")]);
      let balance = null, balanceError = null;
      if (provider) { try { balance = await provider.balance(); } catch (e) { balanceError = providerStatus(e).error; } }
      const recentErrors = [];
      for (const b of errs.slice(-10)) recentErrors.push(await store.get(b.key, { type: "json" }));
      return json(200, { enabled: !!provider, provider: provider?.name || null, config: cfg, approvedCount: Object.keys(idx.items).length, today: { generated: gens.length, dailyLimit, errors: errs.length }, recentErrors, balance, balanceError });
    }
    if (action === "voices") {
      if (!provider) return json(503, { error: "tts-disabled" });
      try { return json(200, await provider.voices()); } catch (e) { const m = providerStatus(e); return json(m.status, { error: m.error }); }
    }
    if (action === "config" && req.method === "POST") {
      const cur = await getConfig();
      const speeds = { ...cur.speeds };
      for (const [k, v] of Object.entries(body?.speeds || {})) {
        if (!STYLES.includes(k) || !(Number(v) >= 0.5 && Number(v) <= 2)) return json(422, { error: `bad speed for ${k}` });
        speeds[k] = Number(v);
      }
      const next = { voiceId: body?.voiceId ?? cur.voiceId, speeds, version: now().toString(36) };
      await store.setJSON("config", next);
      return json(200, next);
    }
    if (action === "items") {
      const [idx, ov] = await Promise.all([getIndex(), getOverrides()]);
      return json(200, { version: idx.version, approved: idx.items, overrides: ov });
    }
    if (action === "preview-text") {
      const text = cleanText(url.searchParams.get("text")); const kind = url.searchParams.get("kind");
      return json(200, engineText(text, kind, await getOverrides()));
    }
    if (action === "pronunciation" && req.method === "POST") {
      const text = cleanText(body?.text), kind = body?.kind, sendText = cleanText(body?.sendText);
      const bad = validate(text, kind) || (sendText && validate(sendText, kind));
      if (bad) return json(400, { error: bad });
      const ov = await getOverrides(); const k = eduKey(text, kind);
      if (sendText && sendText !== text) ov[k] = sendText; else delete ov[k];
      await store.setJSON("pronunciation", ov);
      return json(200, { key: k, sendText: ov[k] || text });
    }
    if (action === "candidate" && req.method === "POST") {
      if (!provider) return json(503, { error: "tts-disabled" });
      const text = cleanText(body?.text), kind = body?.kind;
      const bad = validate(text, kind); if (bad || kind === "ui") return json(400, { error: bad || "bad-kind" });
      const cfg = await getConfig();
      const { sendText, rule } = engineText(text, kind, await getOverrides());
      try {
        const r = await provider.synthesize({ text: sendText, voiceId: cfg.voiceId, speed: cfg.speeds.word });
        const k = eduKey(text, kind);
        await store.set(`candidate/${sha(k)}`, r.audio, { metadata: { key: k, sendText, rule, voiceId: cfg.voiceId, speed: cfg.speeds.word, contentType: r.contentType, charsBilled: r.charsBilled, voiceFallback: r.voiceFallback, createdAt: new Date(now()).toISOString() } });
        await log("candidate", { chars: r.charsBilled ?? sendText.length });
        return json(200, { key: k, sendText, rule, charsBilled: r.charsBilled, voiceFallback: r.voiceFallback, voiceFallbackReason: r.voiceFallbackReason });
      } catch (e) {
        const m = providerStatus(e);
        await log("error", { error: m.error, providerStatus: e.status ?? null, where: "candidate" });
        return json(m.status, { error: m.error });
      }
    }
    if (action === "audio") {
      const text = cleanText(url.searchParams.get("text")), kind = url.searchParams.get("kind");
      const type = url.searchParams.get("type") === "approved" ? "approved" : "candidate";
      const r = await store.getWithMetadata(`${type}/${sha(eduKey(text, kind))}`, { type: "arrayBuffer" });
      if (!r || !r.data) return json(404, { error: "no-audio" });
      return audioRes(r.data, r.metadata?.contentType, type, "no-store");
    }
    if ((action === "approve" || action === "upload") && req.method === "POST") {
      let text, kind, audio, meta;
      if (action === "approve") {
        text = cleanText(body?.text); kind = body?.kind;
        const c = await store.getWithMetadata(`candidate/${sha(eduKey(text, kind))}`, { type: "arrayBuffer" });
        if (!c || !c.data) return json(404, { error: "no-candidate: generate and listen first" });
        audio = c.data; meta = { ...c.metadata, source: "generated" };
      } else {
        const form = await req.formData();
        text = cleanText(form.get("text")); kind = form.get("kind");
        const file = form.get("file");
        if (!file || typeof file === "string") return json(400, { error: "no-file" });
        if (!/^audio\//.test(file.type)) return json(415, { error: "not-audio" });
        if (file.size > 2 * 1024 * 1024) return json(413, { error: "file-too-large (max 2 MB)" });
        audio = await file.arrayBuffer(); meta = { source: "recording", contentType: file.type, fileName: file.name };
      }
      const bad = validate(text, kind); if (bad || kind === "ui") return json(400, { error: bad || "bad-kind" });
      const k = eduKey(text, kind);
      await store.set(`approved/${sha(k)}`, audio, { metadata: { ...meta, key: k } });
      const idx = await getIndex();
      idx.items[k] = { source: meta.source, sendText: meta.sendText || null, voiceId: meta.voiceId || null, contentType: meta.contentType || "audio/mpeg", approvedAt: new Date(now()).toISOString() };
      idx.version = now().toString(36);
      await store.setJSON("approved-index", idx); // single adult reviewer: last write wins is acceptable here
      return json(200, { key: k, ...idx.items[k], approvedVersion: idx.version });
    }
    if (action === "unapprove" && req.method === "POST") {
      const k = eduKey(body?.text, body?.kind);
      await store.delete(`approved/${sha(k)}`);
      const idx = await getIndex(); delete idx.items[k]; idx.version = now().toString(36);
      await store.setJSON("approved-index", idx);
      return json(200, { key: k, approvedVersion: idx.version });
    }
    return json(404, { error: "unknown-action" });
  }

  return { handlePublic, handleAdmin };
}
