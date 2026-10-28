import { ProviderError } from "../netlify/lib/providers/sonex.mjs";
// Scriptable provider double: records calls, can be told to fail.
export function fakeProvider() {
  const p = {
    name: "fake", calls: [], failWith: null, voiceFallback: false,
    async synthesize(args) {
      p.calls.push(args);
      if (p.failWith !== null) throw new ProviderError(p.failWith, "scripted failure", 5);
      const audio = new TextEncoder().encode(`AUDIO:${args.text}|${args.voiceId}|${args.speed}`).buffer;
      return { audio, contentType: "audio/mpeg", charsBilled: args.text.length, voiceFallback: p.voiceFallback, voiceFallbackReason: p.voiceFallback ? "unknown voice" : null };
    },
    async voices() { return [{ id: "v1", name: "Test", language: "Hebrew" }]; },
    async balance() { return { wallet: { balance: 0 }, credits: [{ service: "tts", available: 9000 }] }; },
  };
  return p;
}
