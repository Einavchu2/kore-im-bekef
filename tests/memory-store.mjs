// In-memory stand-in for a Netlify Blobs store (same method names and return shapes used by core.mjs).
export function memoryStore() {
  const m = new Map();
  const toBuf = async (v) => typeof v === "string" ? Buffer.from(v) : v instanceof ArrayBuffer ? Buffer.from(v.slice(0)) : Buffer.from(await v.arrayBuffer());
  const out = (buf, type) => type === "json" ? JSON.parse(buf.toString()) : type === "arrayBuffer" ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.toString();
  return {
    _map: m,
    async get(key, { type } = {}) { const e = m.get(key); return e ? out(e.data, type) : null; },
    async getWithMetadata(key, { type } = {}) { const e = m.get(key); return e ? { data: out(e.data, type), metadata: e.metadata, etag: "x" } : null; },
    async set(key, value, { metadata } = {}) { m.set(key, { data: await toBuf(value), metadata: metadata || {} }); return { modified: true }; },
    async setJSON(key, obj, opts) { return this.set(key, JSON.stringify(obj), opts); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, etag: "x" })) }; },
    async delete(key) { m.delete(key); },
  };
}
