// Google Cloud Text-to-Speech provider (REST v1, API key).
// Docs: https://cloud.google.com/text-to-speech/docs  (pricing: https://cloud.google.com/text-to-speech/pricing)
//   POST https://texttospeech.googleapis.com/v1/text:synthesize?key=KEY
//     { input:{text}, voice:{languageCode:"he-IL", name?}, audioConfig:{audioEncoding:"MP3", speakingRate} }
//     -> { audioContent: <base64 MP3> }
//   GET  https://texttospeech.googleapis.com/v1/voices?languageCode=he-IL&key=KEY -> { voices:[{name, ssmlGender, ...}] }
// Errors arrive as { error:{ code, message, status } }: 400 bad request, 403 key/API not allowed, 429 quota.
// Same interface as the Sonex adapter, so the rest of the service does not change.
import { ProviderError } from "./sonex.mjs";

const VOICE_RANK = (n) => (/Chirp3-HD/.test(n) ? 0 : /Chirp/.test(n) ? 1 : /Neural2/.test(n) ? 2 : /Wavenet/.test(n) ? 3 : 4);
const voiceType = (n) => (/Chirp3-HD/.test(n) ? "Chirp 3 HD" : /Neural2/.test(n) ? "Neural2" : /Wavenet/.test(n) ? "WaveNet" : /Standard/.test(n) ? "Standard" : "");

export function createGoogleProvider({ apiKey, fetchImpl = fetch, baseUrl = "https://texttospeech.googleapis.com/v1", timeoutMs = 15000, languageCode = "he-IL" }) {
  if (!apiKey) throw new Error("GOOGLE_TTS_API_KEY is not set");
  const k = `key=${encodeURIComponent(apiKey)}`;

  async function call(path, init = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(baseUrl + path + (path.includes("?") ? "&" : "?") + k, { ...init, signal: ac.signal });
    } catch (e) {
      throw new ProviderError(0, e.name === "AbortError" ? "timeout" : String(e.message || e));
    } finally { clearTimeout(t); }
  }
  async function fail(r) {
    let msg = "";
    try { const j = await r.json(); msg = j?.error?.message || ""; } catch { /* not json */ }
    // Map Google's statuses onto the ones the service already understands.
    let status = r.status;
    if (status === 403 && /billing|disabled|has not been used|API key not valid|permission/i.test(msg)) status = 401;
    if (status === 429 && /quota/i.test(msg)) status = 402;
    return new ProviderError(status, msg.slice(0, 300));
  }

  return {
    name: "google",
    async synthesize({ text, voiceId, speed }) {
      const body = {
        input: { text },
        // a voice saved while another provider was active (not "he-IL-...") is ignored
        voice: voiceId && voiceId.startsWith(languageCode + "-") ? { languageCode, name: voiceId } : { languageCode },
        audioConfig: { audioEncoding: "MP3", speakingRate: Math.min(2, Math.max(0.25, speed || 1)) },
      };
      const r = await call("/text:synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw await fail(r);
      const j = await r.json();
      if (!j.audioContent) throw new ProviderError(502, "empty audio");
      const buf = Buffer.from(j.audioContent, "base64");
      return {
        audio: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        contentType: "audio/mpeg",
        charsBilled: text.length,
        voiceFallback: false,
        voiceFallbackReason: null,
      };
    },
    async voices() {
      const r = await call(`/voices?languageCode=${languageCode}`);
      if (!r.ok) throw await fail(r);
      const { voices = [] } = await r.json();
      return voices
        .filter((v) => (v.languageCodes || []).includes(languageCode))
        .sort((a, b) => VOICE_RANK(a.name) - VOICE_RANK(b.name) || a.name.localeCompare(b.name))
        .map((v) => ({
          id: v.name,
          name: v.name.replace(`${languageCode}-`, ""),
          language: [voiceType(v.name), v.ssmlGender === "FEMALE" ? "נשי" : v.ssmlGender === "MALE" ? "גברי" : ""].filter(Boolean).join(" · "),
          type: "prebuilt",
        }));
    },
    // Google has no balance API; usage and the free tier are shown in the Google Cloud console.
    async balance() { return null; },
  };
}
