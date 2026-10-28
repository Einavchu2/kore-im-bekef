// Public speech endpoint used by the app. The API key never leaves the server.
import { buildTTS } from "../lib/runtime.mjs";

export default async (req) => {
  try { return await buildTTS().handlePublic(req); }
  catch (e) { console.error("tts error", e); return Response.json({ error: "server-error" }, { status: 500 }); }
};

export const config = {
  path: ["/api/tts", "/api/tts/health", "/api/tts/approved"],
  method: ["GET"],
  rateLimit: { windowLimit: 240, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
