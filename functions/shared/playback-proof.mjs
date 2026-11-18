import { toBase64Url, fromBase64Url, encodeText, hmacSign, hmacVerify } from './util.mjs';

export const PLAYBACK_PROOF_HEADER = 'x-boxvault-playback';
export const PLAYBACK_PROOF_TTL = 300;

// Additional request proof, never a replacement for a live session or membership.
// This is a client-visible bearer credential, not DRM or an unextractable secret.
export async function issuePlaybackProof(secret, { videoId, subject, sessionId }) {
  if (!videoId || !subject || !sessionId) throw new Error('playback_session_required');
  const exp = Math.floor(Date.now() / 1000) + PLAYBACK_PROOF_TTL;
  const payload = JSON.stringify(['protected-play-v1', videoId, subject, sessionId, 'full', exp]);
  return {
    value: `${toBase64Url(encodeText(payload))}.${await hmacSign(secret, payload)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    expiresInSeconds: PLAYBACK_PROOF_TTL,
  };
}

export async function verifyPlaybackProof(secret, token, { videoId, subject, sessionId }) {
  if (!sessionId || typeof token !== 'string' || token.length > 2048) return false;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return false;
  try {
    const payload = new TextDecoder().decode(fromBase64Url(encoded));
    if (!await hmacVerify(secret, payload, signature)) return false;
    const fields = JSON.parse(payload);
    if (!Array.isArray(fields) || fields.length !== 6) return false;
    const [purpose, id, user, session, mode, exp] = fields;
    const now = Math.floor(Date.now() / 1000);
    return purpose === 'protected-play-v1' && id === videoId && user === subject
      && session === sessionId && mode === 'full' && Number.isSafeInteger(exp)
      && exp > now && exp <= now + PLAYBACK_PROOF_TTL;
  } catch { return false; }
}
