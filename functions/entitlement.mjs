import { DataError } from './db.mjs';
import { expiresAt, isUuid, sha256Hex } from './shared/util.mjs';

export const CARD_SOURCE = 'card-credit';
export const DAY = 86400000;
const endOf = row => expiresAt(row.expires_at) ?? Infinity;
const startOf = row => Date.parse(row.starts_at || row.created_at) || 0;
const iso = time => (Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null);

// Old same-plan renewals store a cumulative expiry. At cutover each plan
// contributes its longest remaining balance exactly once. New cards store
// individual durations, so two simultaneous redemptions commute.
export function entitlement(rows, epoch, override = null, now = Date.now()) {
  const base = override?.value;
  const covered = new Set(base?.covered || []);
  const valid = rows.filter(
    row =>
      row.verified &&
      !row.revoked_at &&
      !covered.has(row.id) &&
      Number.isInteger(Number(row.tier_rank)) &&
      Number(row.tier_rank) > 0 &&
      startOf(row) <= now
  );
  const anchor = base ? Date.parse(base.at) : epoch;
  const oldEnds = new Map();
  let rank = base?.rank || 0;
  let end = base ? (expiresAt(base.until) ?? Infinity) : 0;
  let last = base && !rank ? anchor : 0;
  const credits = [];
  for (const row of valid.sort((a, b) => startOf(a) - startOf(b) || String(a.id).localeCompare(String(b.id)))) {
    const start = startOf(row),
      expiry = endOf(row),
      level = Number(row.tier_rank);
    if (row.source === CARD_SOURCE) {
      if (expiry > start) credits.push({ at: Math.max(anchor, start), level, duration: expiry - start });
      continue;
    }
    const previous = oldEnds.get(row.plan_id) ?? 0;
    oldEnds.set(row.plan_id, Math.max(previous, expiry));
    if (start <= anchor) {
      if (expiry <= anchor) {
        last = Math.max(last, expiry);
        continue;
      }
      rank = Math.max(rank, level);
      // Earlier entries of the same plan have already contributed up to previous.
      if (expiry > Math.max(previous, anchor)) end = Math.max(end, anchor) + (expiry - Math.max(previous, anchor));
    } else if (expiry > Math.max(start, previous)) {
      credits.push({ at: start, level, duration: expiry - Math.max(start, previous) });
    }
  }
  for (const credit of credits) {
    if (end <= credit.at) {
      last = Math.max(last, end);
      rank = 0;
    }
    end = Math.max(credit.at, end) + credit.duration;
    rank = Math.max(rank, credit.level);
  }
  if (end <= now) {
    last = Math.max(last, end);
    rank = 0;
  }
  return { rank, until: rank ? iso(end) : null, lapsedAt: rank ? null : iso(last) };
}

export function entitlementRevision(rows, override) {
  const entries = rows.filter(row => row.verified).map(row => [row.id, row.signature, expiresAt(row.revoked_at)]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return sha256Hex(JSON.stringify([override?.signature || '', entries]));
}

export async function setAccountEntitlement(ctx, { userId, rank: inputRank, mode, days, until, revision }) {
  if (!isUuid(userId) || !(await ctx.store.findUserById(userId))) throw new DataError('member_not_found');
  if (typeof inputRank !== 'number' || !Number.isInteger(inputRank) || inputRank < 0 || inputRank > 90)
    throw new DataError('plan_rank_invalid');
  const [rows, overrides] = await Promise.all([
    ctx.store.listMemberships(userId),
    ctx.store.entitlementOverrides([userId]),
  ]);
  const previous = overrides.get(userId);
  if ((await entitlementRevision(rows, previous)) !== revision) throw new DataError('membership_conflict');
  const now = Date.now();
  const before = entitlement(rows, ctx.mergeEpoch, previous, now);
  let end;
  if (inputRank === 0) end = now;
  else if (mode === 'keep' && before.rank) end = expiresAt(before.until) ?? Infinity;
  else if (mode === 'permanent') end = Infinity;
  else if (mode === 'until') {
    if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(until))
      throw new DataError('membership_duration_invalid');
    end = Date.parse(until);
    if (!Number.isFinite(end) || end <= now) throw new DataError('membership_duration_invalid');
  } else if (mode === 'days' || mode === 'extend') {
    if (!Number.isSafeInteger(days) || !days || Math.abs(days) > 3650 || (mode === 'days' && days < 1))
      throw new DataError('member_days_invalid');
    if (mode === 'extend' && before.rank && !before.until) throw new DataError('membership_permanent');
    end = (mode === 'extend' && before.rank ? Date.parse(before.until) : now) + days * DAY;
  } else throw new DataError('membership_duration_invalid');
  const value = {
    at: new Date(now).toISOString(),
    rank: inputRank,
    until: iso(end),
    covered: rows
      .filter(row => row.verified)
      .map(row => row.id)
      .sort(),
  };
  const saved = await ctx.store.writeEntitlementOverride(userId, value, previous?.signature ?? null);
  if (!saved) throw new DataError('membership_conflict');
  const after = entitlement(await ctx.store.listMemberships(userId), ctx.mergeEpoch, saved, Date.now());
  await ctx.store.audit({
    actorId: ctx.viewer.user.id,
    action: 'account_entitlement',
    target: userId,
    ipPrefix: ctx.ip,
    detail: { fromRank: before.rank, from: before.until, rank: after.rank, to: after.until },
  });
  return { ok: true, ...after };
}
