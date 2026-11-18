import { fromBase64Url, toBase64Url, randomBytes } from './util.mjs';

export const CHUNK_SIZE = 1024 * 1024;
export const TAG_BYTES = 16;
export const NONCE_BYTES = 8;
export const KEY_BYTES = 32;

function bufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function createCipher(chunkSize = CHUNK_SIZE) {
  return {
    key: toBase64Url(randomBytes(KEY_BYTES)),
    nonce: toBase64Url(randomBytes(NONCE_BYTES)),
    chunkSize,
  };
}

export function isValidCipher(cipher) {
  if (!cipher || typeof cipher !== 'object') return false;
  if (!Number.isSafeInteger(cipher.chunkSize) || cipher.chunkSize < 64 * 1024 || cipher.chunkSize > 8 * 1024 * 1024) return false;
  try {
    return fromBase64Url(cipher.key).byteLength === KEY_BYTES && fromBase64Url(cipher.nonce).byteLength === NONCE_BYTES;
  } catch {
    return false;
  }
}

function chunkIv(nonce, index) {
  if (nonce.byteLength !== NONCE_BYTES) throw new Error('invalid nonce');
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw new Error('invalid chunk index');
  const iv = new Uint8Array(12);
  iv.set(nonce);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}

async function aesKey(cipher, usage) {
  return crypto.subtle.importKey('raw', bufferOf(fromBase64Url(cipher.key)), { name: 'AES-GCM' }, false, [usage]);
}

export function chunkCount(plainSize, chunkSize = CHUNK_SIZE) {
  return Math.max(0, Math.ceil(plainSize / chunkSize));
}

export function plainChunkLength(index, plainSize, chunkSize = CHUNK_SIZE) {
  return Math.min(chunkSize, plainSize - index * chunkSize);
}

export function encryptedChunkLength(index, plainSize, chunkSize = CHUNK_SIZE) {
  const length = plainChunkLength(index, plainSize, chunkSize);
  return length > 0 ? length + TAG_BYTES : 0;
}

export function encryptedTotalSize(plainSize, chunkSize = CHUNK_SIZE) {
  return plainSize <= 0 ? 0 : plainSize + chunkCount(plainSize, chunkSize) * TAG_BYTES;
}

export async function encryptChunk(plainBytes, cipher, index, importedKey) {
  const key = importedKey ?? await aesKey(cipher, 'encrypt');
  const iv = chunkIv(fromBase64Url(cipher.nonce), index);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferOf(iv) }, key, bufferOf(plainBytes)));
}

export async function decryptChunk(encryptedBytes, cipher, index, importedKey) {
  const key = importedKey ?? await aesKey(cipher, 'decrypt');
  const iv = chunkIv(fromBase64Url(cipher.nonce), index);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufferOf(iv) }, key, bufferOf(encryptedBytes)));
}

export async function encryptFileSlice(file, cipher, index, importedKey) {
  const start = index * cipher.chunkSize;
  const plain = new Uint8Array(await file.slice(start, Math.min(file.size, start + cipher.chunkSize)).arrayBuffer());
  return encryptChunk(plain, cipher, index, importedKey);
}

export function chunksForRange(plainStart, plainEnd, chunkSize = CHUNK_SIZE) {
  return { firstChunk: Math.floor(plainStart / chunkSize), lastChunk: Math.floor(plainEnd / chunkSize) };
}

// getChunk(index) must return the exact stored ciphertext bytes for that chunk.
// releaseChunk(index) is called as soon as that chunk has been decrypted, so the caller can drop
// the ciphertext while the plaintext it just produced is still on its way out.
//
// 逐片交回，覆盖范围正好是 [plainStart, plainEnd]。serveMedia 用它把响应改成边取边发，
// 于是"一次给多大窗口"和"这一条请求占多少内存"脱钩了：手上只有预取的几片密文加上正在交回的
// 那一片明文，不再是整段窗口的副本。
export async function* decryptRangePieces({ cipher, plainSize, plainStart, plainEnd, getChunk, releaseChunk }) {
  const { chunkSize } = cipher;
  if (plainStart < 0 || plainEnd < plainStart || plainEnd >= plainSize) throw new Error('invalid plaintext range');
  const { firstChunk, lastChunk } = chunksForRange(plainStart, plainEnd, chunkSize);
  if (lastChunk >= chunkCount(plainSize, chunkSize)) throw new Error('range beyond video');
  const key = await aesKey(cipher, 'decrypt');
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    const expected = encryptedChunkLength(index, plainSize, chunkSize);
    const encrypted = await getChunk(index);
    if (!encrypted || encrypted.byteLength !== expected) throw new Error('incomplete encrypted chunk');
    const plain = await decryptChunk(encrypted, cipher, index, key);
    // 边界片只取落在区间里的那一截：区间可以从一片中间开始，也可以在一片中间结束。
    const from = Math.max(plainStart, index * chunkSize);
    const to = Math.min(plainEnd, (index + 1) * chunkSize - 1);
    const offset = from - index * chunkSize;
    const length = to - from + 1;
    if (plain.byteLength < offset + length) throw new Error('incomplete decrypted chunk');
    // 先放密文再交明文：明文是 decryptChunk 新开的一块缓冲区，和密文那块内存已经没关系了。
    releaseChunk?.(index);
    yield plain.subarray(offset, offset + length);
  }
}

// 一次要完整缓冲区的调用方（测试、校验）用这个；它就是把上面那个逐片生成器拼起来，
// 分片边界怎么切只有 decryptRangePieces 一处定义。
export async function decryptRange(options) {
  const pieces = [];
  let total = 0;
  for await (const piece of decryptRangePieces(options)) {
    pieces.push(piece);
    total += piece.byteLength;
  }
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const piece of pieces) {
    out.set(piece, cursor);
    cursor += piece.byteLength;
  }
  return out;
}

// Truncating the plaintext stream is the only server-side way to stop a
// non-member from pulling more than the preview, so the cut point is approximate
// in time and exact in bytes.
export function previewBytes({ plainSize, durationSeconds, previewSeconds, chunkSize = CHUNK_SIZE }) {
  if (!Number.isSafeInteger(plainSize) || plainSize <= chunkSize) return 0;
  if (!(durationSeconds > 0) || !(previewSeconds > 0)) return 0;
  // A preview that is half the file or more is not a preview any more. This also bounds the
  // damage when the recorded duration is wrong: the upload form accepts a hand-typed number
  // for files the browser cannot decode, and a too-short duration with a long preview would
  // otherwise release the whole purchase to anonymous viewers.
  const ceiling = Math.max(chunkSize, Math.floor(plainSize / 2 / chunkSize) * chunkSize);
  if (previewSeconds >= durationSeconds) return Math.min(ceiling, plainSize - chunkSize);
  const rough = Math.ceil(plainSize * (previewSeconds / durationSeconds));
  const aligned = Math.ceil(rough / chunkSize) * chunkSize;
  // Always leave at least one whole chunk out of the stream, otherwise a preview
  // request would hand over the paid content.
  return Math.min(aligned, ceiling, plainSize - chunkSize);
}
