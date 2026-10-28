// Sonex Labs Pāṇini TTS provider.
// Verified against https://docs.sonexlabs.com/quickstart (fetched 26 Oct 2026):
//   POST https://api.sonexlabs.com/v1/speech, header "Authorization: Bearer <key>", JSON body.
//   Body: text (required, <= 5,000 chars), voice_id, language ("auto"), speed (0.5–2.0, clamped),
//         output_format (wav|mp3|ogg|opus|mulaw), sample_rate. Response: raw audio bytes.
//   Headers: X-Chars-Billed, X-Voice-Fallback ("true"/"false"), X-Voice-Fallback-Reason.
//   GET /v1/voices, GET /v1/balance. Errors: 401, 402, 422, 429 (+Retry-After), 502.
//   Rate limits: 5 req/s, 120 req/min per workspace.
// There are no documented emotion or style parameters, so this adapter exposes only voice and speed.
export class ProviderError extends Error {
  constructor(status, detail, retryAfter) {
    super(`provider ${status}: ${detail || ""}`.trim());
    this.status = status; this.detail = detail; this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSonexProvider({ apiKey, fetchImpl = fetch, baseUrl = "https://api.sonexlabs.com/v1", timeoutMs = 15000 }) {
  if (!apiKey) throw new Error("SONEX_API_KEY is not set");
  const auth = { Authorization: `Bearer ${apiKey}` };

  async function call(path, init = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(baseUrl + path, { ...init, headers: { ...auth, ...(init.headers || {}) }, signal: ac.signal });
    } catch (e) {
      throw new ProviderError(0, e.name === "AbortError" ? "timeout" : String(e.message || e));
    } finally { clearTimeout(t); }
  }
  async function detail(r) { try { return (await r.text()).slice(0, 300); } catch { return ""; } }

  return {
    name: "sonex",
    async synthesize({ text, voiceId, speed }) {
      const body = { text, output_format: "mp3", speed: Math.min(2, Math.max(0.5, speed || 1)) };
      if (voiceId) body.voice_id = voiceId;
      const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      let r = await call("/speech", init);
      if (r.status === 429) {
        const ra = Number(r.headers.get("retry-after")) || 1;
        if (ra <= 2) { await sleep(ra * 1000); r = await call("/speech", init); }
        if (r.status === 429) throw new ProviderError(429, await detail(r), ra);
      }
      if (!r.ok) throw new ProviderError(r.status, await detail(r));
      const audio = await r.arrayBuffer();
      if (!audio.byteLength) throw new ProviderError(502, "empty audio");
      return {
        audio,
        contentType: r.headers.get("content-type") || "audio/mpeg",
        charsBilled: Number(r.headers.get("x-chars-billed")) || null,
        voiceFallback: r.headers.get("x-voice-fallback") === "true",
        voiceFallbackReason: r.headers.get("x-voice-fallback-reason") || null,
      };
    },
    async voices() {
      const r = await call("/voices");
      if (!r.ok) throw new ProviderError(r.status, await detail(r));
      return (await r.json()).map((v) => ({ id: v.id, name: v.name, language: v.language, languages: v.languages, gender: v.gender, type: v.type, tags: v.tags, preview_url: v.preview_url }));
    },
    async balance() {
      const r = await call("/balance");
      if (!r.ok) throw new ProviderError(r.status, await detail(r));
      return r.json();
    },
  };
}
