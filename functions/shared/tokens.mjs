import { randomBytes, sha256Hex, toBase64Url, fromBase64Url, encodeText, hmacSign, hmacVerify, bytesToHex } from './util.mjs';
import { seal, tryOpen } from './vault.mjs';

export const PASSWORD_ITERATIONS = 300000;

function bufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function pbkdf2(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', encodeText(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bufferOf(salt), iterations }, baseKey, 256);
  return new Uint8Array(bits);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password, recorded) {
  const parts = String(recorded ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1000 || iterations > 5000000) return false;
  let salt;
  let hash;
  try {
    salt = fromBase64Url(parts[2]);
    hash = fromBase64Url(parts[3]);
  } catch {
    return false;
  }
  const derived = await pbkdf2(password, salt, iterations);
  return constantTimeEqual(derived, hash);
}

export async function sealPassword(dataKey, passwordHash) {
  return seal(dataKey, passwordHash);
}

export async function checkPassword(dataKey, password, sealedHash) {
  const recorded = await tryOpen(dataKey, sealedHash);
  if (!recorded) return { ok: false, needsUpgrade: false };
  const ok = await verifyPassword(password, recorded);
  const iterations = Number(recorded.split('$')[1] ?? 0);
  return { ok, needsUpgrade: ok && iterations < PASSWORD_ITERATIONS };
}

export function createSessionToken() {
  return toBase64Url(randomBytes(32));
}

export function sessionTokenHash(token) {
  return sha256Hex(String(token));
}

export function csrfToken() {
  return toBase64Url(randomBytes(16));
}

const playbackTtlLimit = 15 * 60;

export async function issuePlayback(secret, { videoId, subject, mode, ttlSeconds = 600 }) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(30, Math.min(playbackTtlLimit, ttlSeconds));
  const payload = `play:${videoId}:${subject}:${mode}:${exp}`;
  return `${toBase64Url(encodeText(payload))}.${await hmacSign(secret, payload)}`;
}

export async function readPlayback(secret, token, { videoId, subject, allowedModes }) {
  const [payloadPart, signature, extra] = String(token ?? '').split('.');
  if (!payloadPart || !signature || extra) return null;
  let payload;
  try {
    payload = new TextDecoder().decode(fromBase64Url(payloadPart));
  } catch {
    return null;
  }
  if (!(await hmacVerify(secret, payload, signature))) return null;
  const fields = payload.split(':');
  if (fields.length !== 5 || fields[0] !== 'play') return null;
  const [, id, who, mode, exp] = fields;
  if (id !== videoId || who !== subject || !allowedModes.includes(mode)) return null;
  if (!Number.isSafeInteger(Number(exp)) || Number(exp) * 1000 <= Date.now()) return null;
  return { mode, expiresAt: new Date(Number(exp) * 1000).toISOString() };
}

// Rows that carry privilege are signed by the Function, so a direct table write
// that bypasses the Function cannot create a member, a key or a paid tier.
export function signFields(secret, purpose, fields) {
  return hmacSign(secret, [purpose, ...fields].join('|'));
}

export function verifyFields(secret, purpose, fields, signature) {
  return hmacVerify(secret, [purpose, ...fields].join('|'), signature);
}

export function fingerprint(secret, value) {
  return hmacSign(secret, `fingerprint:${value}`);
}

export function shortId(value) {
  return String(value ?? '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function ipPrefix(ip) {
  const value = String(ip ?? '').trim();
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(value)) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  return v6Prefix(value) ?? 'unknown';
}

// The first three groups of an IPv6 address, with "::" expanded before cutting. Taking
// value.split(':')[0..2] put every compressed address in a bucket of its own, which quietly
// switches off the per-network login budget for the IPv6 ranges carriers hand out — a
// attacker that rotates addresses inside one /48 gets a fresh budget each time.
function v6Prefix(raw) {
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(raw);
  if (mapped) {
    const parts = mapped[1].split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (!raw.includes(':') || !/^[0-9a-f:]+$/i.test(raw)) return null;
  const compressed = raw.includes('::');
  const sides = compressed ? raw.split('::') : [raw, ''];
  if (sides.length !== 2) return null;
  const left = sides[0] === '' ? [] : sides[0].split(':');
  const right = sides[1] === '' ? [] : sides[1].split(':');
  const total = left.length + right.length;
  if (total > 8) return null;
  if (!compressed && total !== 8) return null;
  if ([...left, ...right].some((group) => group === '' || group.length > 4)) return null;
  const groups = [...left, ...Array(8 - total).fill('0'), ...right];
  const head = groups.slice(0, 3).map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''));
  return `${head.join(':')}::/48`;
}

export function userAgentHash(userAgent) {
  return sha256Hex(String(userAgent ?? '').slice(0, 400)).then((hex) => hex.slice(0, 16));
}
