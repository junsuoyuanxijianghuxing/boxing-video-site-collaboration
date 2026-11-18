// Stand-in for the injected platform Storage SDK. Signed URLs are opaque keys the
// test resolves through __put/__get, mirroring the same-origin PUT/GET the browser
// performs against the real signed URLs.
export function fakeStorage() {
  const objects = new Map();
  const uploadTargets = new Map();
  const readTargets = new Map();
  let counter = 0;
  const state = { failList: false };

  const toBytes = (value) => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value?.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('unsupported body');
  };

  // 和 dev/disk-storage.mjs 同一个 code：上层靠它区分"这批地址不能用了"和"服务器出错"。
  const badSignedUrl = () => Object.assign(new Error('unknown or expired signed url'), { code: 'bad_signed_url' });

  return {
    __objects: objects,
    async upload(path, body, options = {}) {
      objects.set(path, { bytes: toBytes(body), contentType: options.contentType ?? 'application/octet-stream' });
      return { Key: path };
    },
    async download(path) {
      const found = objects.get(path);
      if (!found) throw new Error(`not_found ${path}`);
      return new Response(found.bytes.slice(), { headers: { 'content-type': found.contentType } });
    },
    async remove(paths) {
      const list = Array.isArray(paths) ? paths : [paths];
      for (const path of list) objects.delete(path);
      return { deleted: list };
    },
    async list(prefix, options = {}) {
      // The platform's own listing caps a page at 100 objects, and its SDK throws when asked
      // for more. The double has to refuse the same way, or a check that only works against
      // `limit: 1000` passes here and fails in the field — which is what happened on
      // 2026-10-06 when a complete 80-chunk upload was rejected.
      if (state.failList) throw new Error('listing unavailable');
      const entries = [...objects.keys()].filter((key) => key.startsWith(prefix)).map((Key) => ({
        name: Key.slice(prefix.length), id: Key,
      }));
      const limit = Math.min(options.limit ?? 100, 100);
      return { data: entries.slice(options.offset ?? 0, (options.offset ?? 0) + limit), error: null };
    },
    async createSignedUploadUrl(path) {
      counter += 1;
      const url = `/storage/v1/object/sign/upload/${counter}?path=${encodeURIComponent(path)}`;
      uploadTargets.set(url, path);
      return { signedUrl: url };
    },
    async createSignedUrl(path, ttlSeconds) {
      counter += 1;
      const url = `/storage/v1/object/sign/read/${counter}?expires=${ttlSeconds}`;
      readTargets.set(url, path);
      return { signedUrl: url };
    },
    // Simulates the browser PUT to a signed upload URL.
    __put(url, body, contentType = 'application/octet-stream') {
      const path = uploadTargets.get(url);
      if (!path) throw badSignedUrl();
      objects.set(path, { bytes: toBytes(body), contentType });
      return { path, size: toBytes(body).byteLength };
    },
    __get(url) {
      const path = readTargets.get(url);
      if (!path) throw badSignedUrl();
      return objects.get(path);
    },
    __has(path) {
      return objects.has(path);
    },
    __pathCount() {
      return objects.size;
    },
    // Makes the bucket listing fail, the way a rejected page size or a provider hiccup does
    // in the field. An upload must still complete: the inventory may only ever refuse a video
    // it has positively measured, never one it failed to look at.
    __failList(on) {
      state.failList = Boolean(on);
    },
  };
}
