import {
  sealPassword, checkPassword, hashPassword, createSessionToken, sessionTokenHash,
  csrfToken, ipPrefix, userAgentHash,
} from './shared/tokens.mjs';
import { normalizeEmail, isoNow, cleanText, deriveUuid } from './shared/util.mjs';
import { SESSION_COOKIE, CSRF_COOKIE, readCookie, serializeCookie, clearCookie } from './shared/cookies.mjs';
import { DataError } from './db.mjs';

export const SESSION_TTL_SECONDS = 45 * 24 * 60 * 60;
// 锁是为了压住"猜密码"，不是为了管住一个在手机上手打邮箱的人。站长自己就被 5 次 / 15 分钟
// 这套关在门外过（2026-10-15 截图：主站登录页印「密码错误次数过多，请 15 分钟后再试」），
// 所以阈值放宽到 10 次、锁 5 分钟：猜中一格密码的机会仍然按分钟被压着，
// 而同一台网络地址上另有 20 次 / 15 分钟那道闸（下面 LOGIN_FAIL_BUDGET）没动。
export const MAX_FAILED_LOGINS = 10;
export const LOCK_SECONDS = 5 * 60;
// 回给浏览器的"还要等几分钟"由这一刻算，不由文案记：锁长改一次，话不会跟着说谎。
const minutesUntil = (at) => Math.max(1, Math.ceil((at - Date.now()) / 60000));
// A per-account lock does not stop password spraying: one guess against a thousand
// addresses locks nobody. Only failures count toward this budget, so a household or
// a phone network sharing one address is never limited by logging in normally.
const LOGIN_FAIL_BUDGET = 20;
const LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
// The purchase channel is a human QQ chat, so a forgotten password is recoverable.
// The cost of blocking these is near zero and the cost of one guessed account is a
// leaked membership plus a watermark that traces back to the wrong person.
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'passw0rd', 'qwertyui', 'abc12345',
  '11111111', '00000000', 'iloveyou', 'woaini', 'a1234567', '123123123', 'qwer1234',
]);
const DUMMY_RECORD = 'pbkdf2-sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// 登录只校验"密码存在且短到能哈希"。强度规则只放在用户还改得了的两个地方
// （注册、改密码）：当年合规的密码不能因为弱口令表变长就登不进来。
function loginPasswordProblem(password) {
  if (typeof password !== 'string' || password.length === 0) return 'password_missing';
  if (password.length > PASSWORD_MAX) return 'password_too_long';
  return null;
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length === 0) return 'password_missing';
  if (password.length < PASSWORD_MIN) return 'password_too_short';
  if (password.length > PASSWORD_MAX) return 'password_too_long';
  const shape = password.toLowerCase().replace(/[0o]/g, '0').replace(/[il]/g, '1');
  if (WEAK_PASSWORDS.has(password.toLowerCase()) || WEAK_PASSWORDS.has(shape)) return 'password_too_weak';
  if (/^(.)\1+$/.test(password)) return 'password_too_weak';
  if (/^(?:0123456789|abcdefghijklmnopqrstuvwxyz|qwertyuiop|asdfghjkl|zxcvbnm)/i.test(password)) return 'password_too_weak';
  return null;
}

export function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge });
}

export function csrfCookie(token) {
  return serializeCookie(CSRF_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, httpOnly: false });
}

export const authedCookies = (token, csrf) => [sessionCookie(token), csrfCookie(csrf)];
export const loggedOutCookies = () => [clearCookie(SESSION_COOKIE), clearCookie(CSRF_COOKIE)];

export async function currentViewer(ctx) {
  const token = readCookie(ctx.request, SESSION_COOKIE);
  if (!token || token.length > 200) return null;
  const hash = await sessionTokenHash(token);
  const session = await ctx.store.findSessionByTokenHash(hash);
  // The reason is reported back to whoever presented the cookie, so they can be told why
  // the site stopped trusting them instead of silently seeing a login page again.
  if (!session) { ctx.viewerLost = 'unknown'; return null; }
  if (session.revoked_at) { ctx.viewerLost = 'revoked'; return null; }
  const expires = Date.parse(session.expires_at ?? '');
  if (!Number.isFinite(expires) || expires <= Date.now()) { ctx.viewerLost = 'expired'; return null; }
  const user = await ctx.store.findUserById(session.user_id);
  if (!user) { ctx.viewerLost = 'unknown'; return null; }
  if (user.disabled_at) { ctx.viewerLost = 'disabled'; return null; }
  return {
    user,
    session,
    privileged: ctx.adminEmails.includes(String(user.email).toLowerCase()),
    csrf: readCookie(ctx.request, CSRF_COOKIE),
  };
}

// Playback issues many requests; the session is only stamped once every 5 minutes
// so a seeking viewer does not write a row per Range request.
export async function touchSession(ctx, viewer) {
  if (!viewer?.session) return;
  const last = Date.parse(viewer.session.last_seen_at ?? '');
  if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1000) return;
  await ctx.store.touchSession(viewer.session.id, isoNow());
}

export async function register(ctx, { email, password, displayName }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new DataError('email_invalid');
  const problem = passwordProblem(password);
  if (problem) throw new DataError(problem);
  const name = cleanText(displayName ?? '', 40) ?? normalized.split('@')[0];

  if (await ctx.store.countAuditSince({ action: 'register', ipPrefix: ctx.ip, sinceIso: isoNow(-86400) }) >= 6) {
    throw new DataError('register_rate_limited');
  }
  if (await ctx.store.findUserByEmail(normalized)) throw new DataError('email_taken');

  const pwCipher = await sealPassword(ctx.dataKey, await hashPassword(password));
  let user;
  try {
    user = await ctx.store.createUser({ email: normalized, displayName: name, pwCipher });
  } catch (error) {
    // The unique index rejects a race; report the stable application code.
    if (await ctx.store.findUserByEmail(normalized)) throw new DataError('email_taken');
    throw error;
  }
  await ctx.store.audit({ actorId: user.id, action: 'register', target: user.id, ipPrefix: ctx.ip });
  return { user };
}

export async function login(ctx, { email, password }) {
  const normalized = normalizeEmail(email);
  const problem = loginPasswordProblem(password);
  if (!normalized || problem) throw new DataError(problem ?? 'email_invalid');

  if (await ctx.store.countAuditSince({ action: 'login_fail', ipPrefix: ctx.ip, sinceIso: isoNow(-LOGIN_FAIL_WINDOW_SECONDS) }) >= LOGIN_FAIL_BUDGET) {
    throw new DataError('login_rate_limited', null, { retryMinutes: Math.ceil(LOGIN_FAIL_WINDOW_SECONDS / 60) });
  }

  const user = await ctx.store.findUserByEmail(normalized);
  if (!user) {
    // Same work as a real check, so response time does not reveal account names.
    await checkPassword(ctx.dataKey, password, await sealPassword(ctx.dataKey, DUMMY_RECORD));
    // A spray mostly targets addresses that do not exist, so this path has to leave
    // the same trace as a wrong password or the per-address budget never fills up.
    await ctx.store.audit({ action: 'login_fail', target: null, ipPrefix: ctx.ip });
    throw new DataError('credentials_invalid');
  }
  const lockedUntil = Date.parse(user.locked_until ?? '');
  const stillLocked = Number.isFinite(lockedUntil) && lockedUntil > Date.now();
  if (stillLocked) {
    throw new DataError('login_locked', null, { retryMinutes: minutesUntil(lockedUntil) });
  }

  const result = await checkPassword(ctx.dataKey, password, user.pw_cipher);
  if (!result.ok) {
    const failures = Number(user.failed_count ?? 0) + 1;
    const shouldLock = failures >= MAX_FAILED_LOGINS;
    await ctx.store.noteLoginFailure(user.id, shouldLock ? 0 : failures, shouldLock ? isoNow(LOCK_SECONDS) : null);
    await ctx.store.audit({ actorId: user.id, action: 'login_fail', target: user.id, ipPrefix: ctx.ip });
    throw new DataError(shouldLock ? 'login_locked' : 'credentials_invalid',
      null, shouldLock ? { retryMinutes: minutesUntil(Date.now() + LOCK_SECONDS * 1000) } : null);
  }
  if (user.disabled_at) throw new DataError('account_disabled');

  if (result.needsUpgrade) {
    await ctx.store.setPassword(user.id, await sealPassword(ctx.dataKey, await hashPassword(password)));
  }
  // A guessable password still opens the door — it is the owner's own password, and
  // refusing it would lock them out. The admin panel issues codes, so the reminder can only
  // live here: this is the one moment the server is allowed to see the plaintext.
  const session = await createViewerSession(ctx, user);
  const evicted = await enforceSessionCap(ctx, user.id, session.session?.id);
  // Telling the browser how many sessions this login displaced is what makes "为什么我电脑
  // 上退出去了" answerable: the number comes from the cap the owner can tune himself.
  return {
    ...session,
    evicted: (session.replaced ?? 0) + evicted,
    passwordIsWeak: Boolean(passwordProblem(password)),
  };
}

async function enforceSessionCap(ctx, userId, keepId) {
  const limit = ctx.settings.max_active_sessions;
  const active = await ctx.store.activeSessions(userId, isoNow(0));
  const others = active.filter((row) => row.id !== keepId);
  const excess = others.length - (limit - 1);
  if (excess <= 0) return 0;
  for (const row of others.slice(0, excess)) await ctx.store.revokeSession(row.id);
  return excess;
}

export async function createViewerSession(ctx, user) {
  const token = createSessionToken();
  const hash = await sessionTokenHash(token);
  const uaHash = await userAgentHash(ctx.request.headers.get('user-agent'));
  const replaced = await ctx.store.revokeSessionsByDevice(user.id, uaHash, ipPrefix(ctx.ip), isoNow(0));
  const session = await ctx.store.createSession({
    id: await deriveUuid('session', hash),
    userId: user.id,
    tokenHash: hash,
    expiresAt: isoNow(SESSION_TTL_SECONDS),
    deviceLabel: deviceLabel(ctx.request.headers.get('user-agent')),
    uaHash,
    ipPrefix: ipPrefix(ctx.ip),
  });
  await ctx.store.noteLoginSuccess(user.id, isoNow());
  return {
    user,
    session,
    token,
    csrf: csrfToken(),
    privileged: ctx.adminEmails.includes(String(user.email).toLowerCase()),
    replaced,
  };
}

export function deviceLabel(userAgent) {
  const value = String(userAgent ?? '');
  // A missing UA is itself the signal: browsers send one, scripts do not.
  if (!value.trim()) return '未提供浏览器标识（可能是脚本）';
  // WeChat, QQ and the rest carry "Safari" or "Chrome" in their UA, so without this
  // the buyer's own WeChat and a stranger's Safari render identically in the device
  // list — the one screen where they are supposed to tell those apart.
  const inApp = /MicroMessenger|WeChat/i.test(value) ? '微信'
    : /MQQBrowser|QQBrowser|QQ\//i.test(value) ? 'QQ'
      : /Weibo/i.test(value) ? '微博'
        : /BytedanceWebview|douyin|TikTok|aweme/i.test(value) ? '抖音'
          : /AlipayClient/i.test(value) ? '支付宝'
            : /UCBrowser|UCLightBrowser/i.test(value) ? 'UC'
              : null;
  const browser = inApp ?? (/Edg\//.test(value) ? 'Edge' : /OPR\//.test(value) ? 'Opera' : /Chrome\//.test(value) ? 'Chrome'
    : /Firefox\//.test(value) ? 'Firefox' : /Safari\//.test(value) ? 'Safari' : '浏览器');
  const os = /HarmonyOS|ArkWeb/.test(value) ? '鸿蒙'
    : /Windows/.test(value) ? 'Windows' : /iPhone|iPad|iOS/.test(value) ? 'iOS' : /Android/.test(value) ? 'Android'
      : /Mac OS|Macintosh/.test(value) ? 'macOS' : /Linux/.test(value) ? 'Linux' : '未知';
  const shape = /iPad|iPhone|Android|Mobile|HarmonyOS/.test(value) ? '手机' : '桌面';
  return `${os} ${shape} · ${browser}`;
}

export async function logout(ctx, viewer) {
  if (viewer?.session) await ctx.store.revokeSession(viewer.session.id);
  return { ok: true };
}

// 借出去的号要能自己收回来。设备表现在只能看不能退，唯一能踢掉别人设备的路径是改自己的密码
// —— 那会连密码一起换掉，而且他未必明白为什么"退出那台微信"要改密码。
// 只允许退这个账号自己的会话：别人的会话 id 拿过来一律算"没有这条"，不告诉调用者它存不存在。
export async function revokeOwnSession(ctx, { id }) {
  const sessionId = String(id ?? '');
  if (sessionId === String(ctx.viewer.session.id)) throw new DataError('cannot_revoke_current_session');
  const target = (await ctx.store.activeSessions(ctx.viewer.user.id, isoNow(0))).find((row) => row.id === sessionId);
  if (!target) throw new DataError('session_not_found');
  if (!await ctx.store.revokeSession(target.id)) throw new DataError('session_revoke_failed');
  await ctx.store.audit({
    actorId: ctx.viewer.user.id,
    action: 'session_revoke',
    target: target.id,
    ipPrefix: ctx.ip,
    detail: { device: target.device_label ?? '' },
  });
  return { ok: true, device: target.device_label ?? '', lastSeen: target.last_seen_at };
}

export async function changePassword(ctx, viewer, { currentPassword, newPassword }) {
  const problem = passwordProblem(newPassword);
  if (problem) throw new DataError(problem);
  const check = await checkPassword(ctx.dataKey, currentPassword, viewer.user.pw_cipher);
  if (!check.ok) throw new DataError('credentials_invalid');
  const updated = await ctx.store.setPassword(viewer.user.id, await sealPassword(ctx.dataKey, await hashPassword(newPassword)));
  if (!updated) throw new DataError('password_write_failed');
  const active = await ctx.store.activeSessions(viewer.user.id, isoNow(0));
  for (const row of active) {
    if (row.id !== viewer.session.id) await ctx.store.revokeSession(row.id);
  }
  return { ok: true };
}

// The owner slot used to be a single address claimed at first registration, with no screen
// anywhere that showed who it is — so forgetting it locked the owner out of his own site.
const MAX_ADMIN_EMAILS = 10;

export async function adminList(ctx) {
  return { emails: await ctx.keys.adminEmails(), max: MAX_ADMIN_EMAILS };
}

// Widening the list requires being on it already, and the list lives in the private bucket,
// so a direct database write still cannot grant administration.
export async function grantAdmin(ctx, { email }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new DataError('admin_email_invalid');
  const current = await ctx.keys.adminEmails();
  if (current.includes(normalized)) return { emails: current, already: true };
  if (current.length >= MAX_ADMIN_EMAILS) throw new DataError('admin_list_full');
  const next = [...current, normalized];
  if (!await ctx.keys.setAdminEmails(next)) throw new DataError('admin_write_failed');
  await ctx.store.audit({ actorId: ctx.viewer.user.id, action: 'admin_grant', target: normalized, ipPrefix: ctx.ip });
  return { emails: next };
}

export async function revokeAdmin(ctx, { email }) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const current = await ctx.keys.adminEmails();
  if (!current.includes(normalized)) throw new DataError('admin_email_invalid');
  if (current.length <= 1) throw new DataError('admin_last_owner');
  if (normalized === String(ctx.viewer.user.email).toLowerCase()) throw new DataError('admin_cannot_remove_self');
  const next = current.filter((item) => item !== normalized);
  if (!await ctx.keys.setAdminEmails(next)) throw new DataError('admin_write_failed');
  await ctx.store.audit({ actorId: ctx.viewer.user.id, action: 'admin_revoke', target: normalized, ipPrefix: ctx.ip });
  return { emails: next };
}

// A buyer's password cannot be shown to the seller: only a salted hash, sealed under the
// site key, is stored. So a forgotten password is answered by replacing it — which also
// clears the five-wrong-guess lock, the case that actually reaches the QQ chat.
export async function resetPasswordByAdmin(ctx, { userId, newPassword }) {
  const target = await ctx.store.findUserById(String(userId ?? ''));
  if (!target) throw new DataError('member_not_found');
  const problem = passwordProblem(newPassword);
  if (problem) throw new DataError(problem);
  const updated = await ctx.store.setPassword(target.id, await sealPassword(ctx.dataKey, await hashPassword(newPassword)));
  if (!updated) throw new DataError('password_write_failed');
  for (const row of await ctx.store.activeSessions(target.id, isoNow(0))) await ctx.store.revokeSession(row.id);
  await ctx.store.audit({
    actorId: ctx.viewer.user.id,
    action: 'user_password_reset',
    target: target.id,
    ipPrefix: ctx.ip,
    detail: { email: target.email },
  });
  return { ok: true, email: target.email };
}

// Suspension is the off switch for a paid account that is being resold or shared:
// `currentViewer` rejects a disabled user on every request, so this stops playback
// that is already running instead of only blocking future logins. Sessions are also
// revoked so the owner's device list reflects reality immediately.
export async function setAccountEnabled(ctx, { userId, enabled }) {
  const target = await ctx.store.findUserById(String(userId ?? ''));
  if (!target) throw new DataError('member_not_found');
  if (!enabled && target.id === ctx.viewer.user.id) throw new DataError('cannot_disable_self');
  const updated = await ctx.store.setUserNote(target.id, { disabled_at: enabled ? null : isoNow() });
  if (!updated) throw new DataError('user_write_failed');
  if (!enabled) {
    for (const row of await ctx.store.activeSessions(target.id, isoNow(0))) await ctx.store.revokeSession(row.id);
  }
  // 站长定的语义：停用连这个账号名下还没兑换的码一起冻，恢复时原样解冻。
  // 只认「绑单出码」留在 requests.batch_id 上的那几批 —— 拿备注做模糊匹配会误冻别人的码。
  const batches = (await ctx.store.requestsByEmail(target.email))
    .map((row) => row.batch_id).filter((id) => typeof id === 'string' && id.length > 0);
  const frozenCodes = batches.length && !enabled
    ? await ctx.store.setKeysStatusInBatches({ batchIds: batches, from: 'unused', to: 'frozen' }) : 0;
  const thawedCodes = batches.length && enabled
    ? await ctx.store.setKeysStatusInBatches({ batchIds: batches, from: 'frozen', to: 'unused' }) : 0;
  await ctx.store.audit({
    actorId: ctx.viewer.user.id,
    action: enabled ? 'user_enable' : 'user_disable',
    target: target.id,
    ipPrefix: ctx.ip,
    detail: frozenCodes || thawedCodes ? { codes: frozenCodes || thawedCodes } : null,
  });
  return { ok: true, email: target.email, disabled: !enabled, frozenCodes, thawedCodes };
}

// The watermark identifies a session, the suspension switch acts on it, and this is
// where the seller records what happened — without it the reason is gone by next week.
export async function setAccountNote(ctx, { userId, note, contactQq }) {
  const target = await ctx.store.findUserById(String(userId ?? ''));
  if (!target) throw new DataError('member_not_found');
  // Truncate rather than reject: losing a note to a 201st character would be worse
  // than losing its tail.
  const cleanedNote = String(note ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  const qq = String(contactQq ?? '').replace(/[^0-9]/g, '').slice(0, 12);
  const updated = await ctx.store.setUserNote(target.id, {
    note: cleanedNote || null, contact_qq: qq || null,
  });
  if (!updated) throw new DataError('user_write_failed');
  await ctx.store.audit({
    actorId: ctx.viewer.user.id, action: 'user_note', target: target.id, ipPrefix: ctx.ip,
  });
  return { ok: true, note: cleanedNote, contactQq: qq };
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name ?? '',
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at ?? null,
  };
}

export function publicSession(row) {
  return {
    id: row.id,
    device: row.device_label ?? '浏览器',
    createdAt: row.created_at,
    lastSeen: row.last_seen_at,
    expiresAt: row.expires_at,
    // 'unknown' 是"这次请求没带转发头"的内部哨兵（本地开发、直接打 IP 都会出现），
    // 不许顺着设备表印给买家 —— 后台那三处早就归一成空串了，这里是漏掉的第四个入口。
    ip: row.ip_prefix && row.ip_prefix !== 'unknown' ? row.ip_prefix : '',
  };
}
