export const SESSION_COOKIE = 'lvs_session';
export const CSRF_COOKIE = 'lvs_csrf';
// The platform reference adapter removes `cookie` before calling business code, so
// the entry point copies only this site's own cookies into this header. A visitor
// forging it gains nothing: it still has to carry a session token that exists in
// the database, which is the same requirement as sending the real cookie.
export const FORWARDED_COOKIE_HEADER = 'x-lvs-cookie';

function parsePairs(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name !== SESSION_COOKIE && name !== CSRF_COOKIE) continue;
    const raw = part.slice(index + 1).trim();
    try {
      out.set(name, decodeURIComponent(raw));
    } catch {
      out.set(name, raw);
    }
  }
  return out;
}

export function readCookie(request, name) {
  const forwarded = parsePairs(request.headers.get(FORWARDED_COOKIE_HEADER)).get(name);
  if (forwarded !== undefined) return forwarded;
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const raw = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

// Only the application's own cookies are handed to business code; platform and
// third-party cookies on the same host stay out of the request the handler sees.
export function onlyAppCookies(header) {
  const pairs = parsePairs(header);
  if (pairs.size === 0) return null;
  return [...pairs].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

// The site is only ever served over HTTPS, so Secure is required and plain HTTP
// development must use a local override instead of relaxing these flags.
export function serializeCookie(name, value, { maxAge = 0, path = '/', httpOnly = true, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${Math.max(0, Math.floor(maxAge))}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}

export function appendCookie(response, ...cookies) {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) if (cookie) headers.append('set-cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Same-origin check for state-changing requests. The public host comes from the
// forwarded Host header because the edge runtime's own request URL is not
// guaranteed to be the browser-visible one.
export function acceptsMutation(request, csrfFromCookie) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const publicHost = request.headers.get('x-forwarded-host')
    || request.headers.get('host')
    || new URL(request.url).host;
  if (originHost !== publicHost) return false;
  const supplied = request.headers.get('x-csrf-token');
  return Boolean(supplied && csrfFromCookie && supplied === csrfFromCookie);
}
