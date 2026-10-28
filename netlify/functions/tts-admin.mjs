// Adult review endpoint (review.html). Protected by TTS_ADMIN_PASSWORD.
import { buildTTS } from "../lib/runtime.mjs";

export default async (req) => {
  try { return await buildTTS().handleAdmin(req); }
  catch (e) { console.error("tts-admin error", e); return Response.json({ error: "server-error" }, { status: 500 }); }
};

export const config = {
  path: "/api/tts-admin/*",
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
