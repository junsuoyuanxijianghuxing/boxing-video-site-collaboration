// A storage object is only trusted after its bytes are measured, so reads are
// capped before allocation instead of calling arrayBuffer() on an unknown size.
export async function readCapped(response, maxBytes, { timeoutMs = 15000 } = {}) {
  if (!response || !response.ok || !response.body) throw new Error('object_unavailable');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('limit_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  let timedOut = false;
  try {
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, timeoutMs);
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error('read_timeout');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('read_too_large');
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
