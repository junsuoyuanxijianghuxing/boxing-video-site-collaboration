import { CARD_SOURCE } from './entitlement.mjs';
import { signFields, verifyFields, shortId } from './shared/tokens.mjs';
import { expiresAt } from './shared/util.mjs';

export const FREE_RANK = 0;
export const PLAN_CODES = ['month', 'quarter', 'year'];
export const VIDEO_STATUSES = ['uploading', 'draft', 'published', 'retired'];

export const DEFAULT_SETTINGS = {
  brand: '格斗影库',
  brand_line: 'Boxing with Anime',
  watermark_prefix: 'B站：格斗传教士 · QQ：1841788347',
  contact_qq: '1841788347',
  promo_line: '教学影像节选发布在 B 站「格斗传教士」，完整教学影像与赛后复盘在这里观看。加 QQ 咨询会员档位和更新安排。',
  purchase_steps: '加 QQ 说明要买哪一档，并留下登录邮箱；收到 16 位激活码后到「我的账号」绑定。',
  max_active_sessions: 3,
  max_concurrent_streams: 2,
  default_preview_seconds: 300,
};

// 价格只写"分"这一个数，显示出来那句由 yuanText 现算 —— 不在字面量里再抄一遍文本。
// 抄第二份一定漂：这里原先写着季卡 ¥80/等级 2、年卡 ¥200/等级 3，而站长 2026-10-17 定的是
// 季卡 ¥77/等级 1、豪华季卡 ¥130、年卡 ¥240/等级 2。买家页读的是库里那一份，
// 「一键补默认档位」读的却是这份，两边各按各的数走。
export const yuanText = (cents) => {
  const value = Number(cents) / 100;
  return `¥${Number.isInteger(value) ? String(value) : value.toFixed(2)}`;
};

const defaultPlan = ({ code, name, rank, cents, days, order, description }) => ({
  code, name, tier_rank: rank, price_cents: cents, price_text: yuanText(cents),
  duration_days: days, sort_order: order, description,
});

// 站长的档位表（2026-10-17 定）：月卡与季卡是等级 1，其余等级 2。
export const DEFAULT_PLANS = [
  defaultPlan({ code: 'month', name: '月卡', rank: 1, cents: 3000, days: 30, order: 10, description: '30 天内全部已授权视频' }),
  defaultPlan({ code: 'quarter', name: '季卡', rank: 1, cents: 7700, days: 90, order: 30, description: '90 天，含需要季卡及以上的长篇教学影像复盘' }),
  defaultPlan({ code: 'year', name: '年卡', rank: 2, cents: 24000, days: 365, order: 50, description: '365 天，含全部档位内容' }),
];

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

function numberOr(value, fallback) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
}

// The backend renders a `timestamptz` as "…+00:00" while the Function writes "…Z". Signing
// the raw text therefore made every real membership row verify as tampered — the owner saw
// "签名与后台不一致，已按无效处理" and paying members could not watch, while the local suite
// stayed green because its double returned the writer's own string. The expiry is signed as
// the instant it denotes instead. Rows written before this change keep working: they were
// signed with the Z form, and normalising the read-back value reproduces that same instant.
function stampField(value) {
  if (value === null || value === undefined || value === '') return 'never';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : `unreadable:${String(value).slice(0, 40)}`;
}

// Rows that decide who may watch what are signed with a runtime-only key: a row
// written straight into the table without a valid signature grants nothing.
function signedMembership(row) {
  const fields = [row.user_id, row.plan_id, row.tier_rank, stampField(row.expires_at), row.key_id ?? 'none'];
  return row.source === CARD_SOURCE
    ? ['membership-credit-v1', [...fields, row.id, stampField(row.starts_at)]]
    : ['membership', fields];
}

export function membershipSignature(secret, row) {
  return signFields(secret, ...signedMembership(row));
}

export function membershipIsAuthentic(secret, row) {
  return verifyFields(secret, ...signedMembership(row), row.signature);
}

export function planSignature(secret, row) {
  return signFields(secret, 'plan', [row.id, row.code, row.tier_rank, row.duration_days ?? 'never', row.price_cents ?? 0]);
}

export function planIsAuthentic(secret, row) {
  return verifyFields(secret, 'plan', [row.id, row.code, row.tier_rank, row.duration_days ?? 'never', row.price_cents ?? 0], row.signature);
}

export function videoAccessSignature(secret, row) {
  return signFields(secret, 'video-access', [row.id, row.tier_rank, row.preview_seconds, row.status, row.duration_seconds ?? 'unknown']);
}

export function videoAccessIsAuthentic(secret, row) {
  return verifyFields(secret, 'video-access', [row.id, row.tier_rank, row.preview_seconds, row.status, row.duration_seconds ?? 'unknown'], row.access_signature);
}

export function settingsSignature(secret, values) {
  const flat = SETTINGS_KEYS.map((key) => String(values[key] ?? ''));
  return signFields(secret, 'settings', flat);
}

export async function settingsIsAuthentic(secret, values, signature) {
  if (!signature) return false;
  return verifyFields(secret, 'settings', SETTINGS_KEYS.map((key) => String(values[key] ?? '')), signature);
}

export function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const key of SETTINGS_KEYS) if (Object.prototype.hasOwnProperty.call(raw, key)) merged[key] = raw[key];
  }
  merged.contact_qq = String(merged.contact_qq ?? '').replace(/[^0-9]/g, '').slice(0, 12);
  merged.watermark_prefix = String(merged.watermark_prefix ?? '').slice(0, 60);
  merged.brand = String(merged.brand ?? DEFAULT_SETTINGS.brand).slice(0, 40);
  merged.purchase_steps = String(merged.purchase_steps ?? '').slice(0, 600);
  merged.max_active_sessions = Math.min(20, Math.max(1, numberOr(merged.max_active_sessions, 3)));
  merged.max_concurrent_streams = Math.min(8, Math.max(1, numberOr(merged.max_concurrent_streams, 2)));
  merged.default_preview_seconds = Math.min(3600, Math.max(0, numberOr(merged.default_preview_seconds, 300)));
  return merged;
}

export function settingsInput(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (key === 'max_active_sessions' || key === 'default_preview_seconds' || key === 'max_concurrent_streams') {
      if (Number.isSafeInteger(Number(value))) out[key] = Number(value);
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 2000);
    }
  }
  return out;
}

export function effectiveRank(memberships, now = Date.now()) {
  let rank = FREE_RANK;
  let until = null;
  for (const row of memberships) {
    if (!row?.verified) continue;
    if (row.revoked_at) continue;
    const expires = expiresAt(row.expires_at);
    if (expires !== null && expires <= now) continue;
    const value = Number(row.tier_rank);
    if (!Number.isSafeInteger(value) || value <= rank) continue;
    rank = value;
    until = row.expires_at ?? null;
  }
  return { rank, until };
}

// 已经用完的那几条里最晚的结束时间：会员过期的第二天，定价页该说"已于 X 到期"，
// 而不是像没有买过一样什么都不说。
export function lapsedEnd(memberships, now = Date.now()) {
  let latest = null;
  let stamp = 0;
  for (const row of memberships) {
    if (!row?.verified || row.revoked_at) continue;
    const expires = expiresAt(row.expires_at);
    if (expires === null || expires > now || expires <= stamp) continue;
    stamp = expires;
    latest = row.expires_at;
  }
  return latest;
}

export function decideAccess({ video, rank, privileged }) {
  if (privileged) return 'full';
  if (video.status !== 'published') return 'hidden';
  const required = Number(video.tier_rank);
  if (Number.isSafeInteger(required) && rank >= required) return 'full';
  const preview = Number(video.preview_seconds);
  if (Number.isSafeInteger(preview) && preview > 0) return 'preview';
  return 'locked';
}

export function previewSecondsFor(video) {
  const preview = Number(video.preview_seconds);
  if (!Number.isSafeInteger(preview) || preview <= 0) return 0;
  const duration = Number(video.duration_seconds);
  return Number.isSafeInteger(duration) && duration > 0 ? Math.min(preview, duration) : preview;
}

// 水印上印出去的东西，站长必须能在后台查到：邮箱→会员名单，会员编号→取证对照，
// 设备→「看过的片」和「谁在看」。会话 id 留在库里给机器对，不印给人看（§60 同一条判据）。
export function watermarkText({ settings, user, video, mode, deviceLabel }) {
  const who = user ? `${user.email}` : '未登录试看';
  const stamp = mode === 'preview' ? '试看' : `会员 #${shortId(user?.id ?? video.id)}`;
  return `${settings.watermark_prefix} · ${who} · ${stamp}${deviceLabel ? ` · 设备「${deviceLabel}」` : ''}`;
}

export function planDurationLabel(days) {
  if (days === null || days === undefined) return '永久';
  if (days === 30) return '30 天';
  if (days === 90) return '90 天';
  if (days === 365) return '365 天';
  return `${days} 天`;
}

export function membershipState(row, now = Date.now()) {
  const expires = expiresAt(row.expires_at);
  if (row.revoked_at) return { state: 'revoked', label: '已撤销' };
  if (expires === null) return { state: 'active', label: '永久有效' };
  if (expires <= now) return { state: 'expired', label: '已到期' };
  const days = Math.ceil((expires - now) / 86_400_000);
  return { state: 'active', label: `剩余 ${days} 天` };
}
