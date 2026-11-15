// Wires the core to Netlify Blobs, environment variables and the configured provider.
// Provider choice: GOOGLE_TTS_API_KEY (Google Cloud) if set, otherwise SONEX_API_KEY (Sonex Labs).
import { getStore } from "@netlify/blobs";
import { createTTS } from "./core.mjs";
import { createSonexProvider } from "./providers/sonex.mjs";
import { createGoogleProvider } from "./providers/google.mjs";

export function pickProvider(get) {
  const google = get("GOOGLE_TTS_API_KEY"), sonex = get("SONEX_API_KEY");
  if (google) return { provider: createGoogleProvider({ apiKey: google }), voice: get("GOOGLE_TTS_VOICE") };
  if (sonex) return { provider: createSonexProvider({ apiKey: sonex }), voice: get("SONEX_VOICE_ID") };
  return { provider: null, voice: null };
}

export function buildTTS() {
  const get = (k) => Netlify.env.get(k);
  const { provider, voice } = pickProvider(get);
  const env = {
    TTS_VOICE_ID: voice,
    TTS_ADMIN_PASSWORD: get("TTS_ADMIN_PASSWORD"),
    TTS_DAILY_NEW_LIMIT: get("TTS_DAILY_NEW_LIMIT"),
  };
  const store = getStore({ name: "tts", consistency: "strong" });
  return createTTS({ store, provider, env });
}
