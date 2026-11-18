const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

export function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/.test(hex)) throw new Error('invalid hex');
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export function encodeText(value) {
  return encoder.encode(value);
}

export function decodeText(bytes) {
  return decoder.decode(bytes);
}

export async function sha256Hex(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomId() {
  return crypto.randomUUID();
}

// RFC 4122 v4 layout with random octets replaced by a digest, so a retry of the
// same logical operation resolves to the same primary key instead of a duplicate.
export function uuidFromHex(hex) {
  const clean = hex.replace(/-/g, '').padEnd(32, '0').slice(0, 32);
  return [clean.slice(0, 8), clean.slice(8, 12), `4${clean.slice(13, 16)}`, `8${clean.slice(17, 20)}`, clean.slice(20, 32)].join('-');
}

export async function deriveUuid(...parts) {
  return uuidFromHex(await sha256Hex(parts.join('|')));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacSign(secret, payload) {
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload))));
}

export async function hmacVerify(secret, payload, expectedHex) {
  if (typeof expectedHex !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), hexToBytes(expectedHex).buffer, encoder.encode(payload));
}

const codeAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function createHumanCode(length = 16) {
  const limit = Math.floor(256 / codeAlphabet.length) * codeAlphabet.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(Math.max(16, length))) {
      if (byte >= limit) continue;
      out += codeAlphabet[byte % codeAlphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  // NFKC first: a code pasted out of a QQ chat in full-width characters (Ａ５ＮＥ…) would
  // otherwise be stripped to nothing and read back to the buyer as "激活码不正确".
  return value.normalize('NFKC').toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, '').slice(0, 32);
}

export function formatCode(value) {
  return (value.match(/.{1,4}/g) ?? []).join('-');
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return null;
  return /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed) ? trimmed : null;
}

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!trimmed || [...trimmed].length > maxLength) return null;
  return trimmed;
}

export function oneOf(value, allowed) {
  return allowed.includes(value) ? value : null;
}

export function isoNow(offsetSeconds = 0) {
  // A non-numeric offset would make Date throw RangeError, and a throw inside an error path
  // turns one failure into an unexplained 500.
  const seconds = Number(offsetSeconds);
  return new Date(Date.now() + (Number.isFinite(seconds) ? seconds : 0) * 1000).toISOString();
}

export function parseTime(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

// For anything that decides access from an expiry: `null` means "no expiry stored", which is
// a permanent grant for a membership and an endless shelf for a key. A value that is present
// but unreadable is not a permanent grant — it is corrupt, and collapses to long expired.
export function expiresAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
