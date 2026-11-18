import { fromBase64Url, toBase64Url, randomBytes, encodeText, decodeText } from './util.mjs';

const IV_BYTES = 12;

function bufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function kek(secret) {
  const key = fromBase64Url(secret);
  if (key.byteLength !== 32) throw new Error('APP_DATA_KEY must be 32 random bytes, base64url encoded');
  return crypto.subtle.importKey('raw', bufferOf(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Envelope format: base64url(iv).base64url(ciphertext+tag). Plaintext is always
// UTF-8 text, which keeps every wrapped value a plain text column.
export async function seal(secret, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferOf(iv) }, await kek(secret), encodeText(String(plaintext)));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function open(secret, sealed) {
  if (typeof sealed !== 'string' || !sealed.includes('.')) throw new Error('sealed value malformed');
  const [ivPart, bodyPart] = sealed.split('.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufferOf(fromBase64Url(ivPart)) },
    await kek(secret),
    bufferOf(fromBase64Url(bodyPart)),
  );
  return decodeText(new Uint8Array(plain));
}

export async function tryOpen(secret, sealed) {
  try {
    return await open(secret, sealed);
  } catch {
    return null;
  }
}

export function secretConfigured(secret, name, report) {
  if (typeof secret === 'string' && secret.length > 0) return true;
  report.push(name);
  return false;
}
