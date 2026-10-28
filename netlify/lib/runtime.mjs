// Wires the core to Netlify Blobs, environment variables and the configured provider.
import { getStore } from "@netlify/blobs";
import { createTTS } from "./core.mjs";
import { createSonexProvider } from "./providers/sonex.mjs";

export function buildTTS() {
  const env = {
    SONEX_API_KEY: Netlify.env.get("SONEX_API_KEY"),
    SONEX_VOICE_ID: Netlify.env.get("SONEX_VOICE_ID"),
    TTS_ADMIN_PASSWORD: Netlify.env.get("TTS_ADMIN_PASSWORD"),
    TTS_DAILY_NEW_LIMIT: Netlify.env.get("TTS_DAILY_NEW_LIMIT"),
  };
  const provider = env.SONEX_API_KEY ? createSonexProvider({ apiKey: env.SONEX_API_KEY }) : null;
  const store = getStore({ name: "tts", consistency: "strong" });
  return createTTS({ store, provider, env });
}
