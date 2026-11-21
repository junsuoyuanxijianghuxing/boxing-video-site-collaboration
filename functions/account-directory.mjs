import { rangeParams } from './db.mjs';
import { entitlement, entitlementRevision } from './entitlement.mjs';
import { publicUser } from './accounts.mjs';
import { expiresAt, isUuid } from './shared/util.mjs';
import { shortId } from './shared/tokens.mjs';

const scanSize = 64;
const week = 7 * 86400000;
const searchFields = ['email', 'display_name', 'note', 'contact_qq'];

async function accountRecord(user, history, plans, owners, epoch, override, now) {
  const verified = history.filter(grant => grant.verified);
  const revoked = verified.filter(grant => grant.revoked_at);
  const grants = verified
    .filter(grant => !grant.revoked_at)
    .sort(
      (a, b) =>
        (expiresAt(b.expires_at) ?? Infinity) - (expiresAt(a.expires_at) ?? Infinity) ||
        String(a.id).localeCompare(String(b.id))
    );
  const { rank, until, lapsedAt: expiredAt } = entitlement(history, epoch, override, now);
  const covered = new Set(override?.value.covered || []);
  const unverified = history.length - verified.length;
  let memberState = 'none';
  if (rank) memberState = 'active';
  else if (expiredAt) memberState = 'expired';
  else if (revoked.length) memberState = 'revoked';
  else if (unverified) memberState = 'unverified';
  const end = expiresAt(until);
  return {
    user: publicUser(user),
    registeredAt: user.created_at,
    lastLoginAt: user.last_login_at ?? null,
    disabledAt: user.disabled_at ?? null,
    note: user.note ?? '',
    contactQq: user.contact_qq ?? '',
    isOwner: owners.includes(String(user.email).toLowerCase()),
    memberState,
    expiredAt,
    expiring: Boolean(rank && end !== null && end <= now + week),
    revision: await entitlementRevision(history, override),
    membership: rank ? { rank, expiresAt: until } : null,
    grants: grants.map(grant => ({
      id: grant.id,
      plan: plans.get(grant.plan_id)?.name ?? '未知档位',
      planCode: plans.get(grant.plan_id)?.code ?? '',
      rank: grant.tier_rank,
      expiresAt: grant.expires_at ?? null,
      source: grant.source,
      createdAt: grant.created_at,
      settled: covered.has(grant.id),
      revokedAt: null,
      verified: true,
      expired: (expiresAt(grant.expires_at) ?? Infinity) <= now,
    })),
    revokedGrants: revoked.length,
    unverifiedGrants: unverified,
  };
}

export async function accountDirectory(ctx, input = {}) {
  const { first: offset, pageSize } = rangeParams(input.offset, input.limit ?? 60);
  const term = String(input.q ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 254);
  const emailShaped = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(term);
  const exact = emailShaped && (await ctx.store.listUsers({ emailExact: term, limit: 1 })).items.length > 0;
  const idExact = isUuid(term) ? term : '';
  const short = /^#?[\da-f]{8}$/.test(term) ? term.replace(/^#/, '') : '';
  // The database expression accepts ordinary words only. Punctuation and short
  // watermark IDs are matched literally over successive pages of public account fields.
  const word = !exact && !idExact && !short && /^[\p{L}\p{N}@+ -]+$/u.test(term) ? term : '';
  const literal = term && !exact && !idExact && !word;
  const account =
    input.account ??
    (input.disabled === '1' || input.disabled === true
      ? 'disabled'
      : input.disabled === '0' || input.active === '1'
        ? 'active'
        : 'all');
  const scope = {
    emailExact: exact ? term : '',
    idExact,
    searchWord: word,
    disabledOnly: account === 'disabled',
    activeOnly: account === 'active',
  };
  const state = input.membership || 'all';
  const rank = /^\d{1,2}$/.test(String(input.rank)) ? Number(input.rank) : null;
  const plans = new Map((await ctx.store.listPlans({ includeDisabled: true })).map(plan => [plan.id, plan]));
  const ranks = [
    ...new Set(
      [...plans.values()]
        .filter(plan => plan.authentic)
        .map(plan => Number(plan.tier_rank))
        .filter(n => n > 0)
    ),
  ].sort((a, b) => a - b);
  const now = Date.now();
  const enrich = async users => {
    const ids = users.map(user => user.id);
    const [histories, overrides] = await Promise.all([
      ctx.store.membershipsForAccounts(ids),
      ctx.store.entitlementOverrides(ids),
    ]);
    return Promise.all(
      users.map(user =>
        accountRecord(
          user,
          histories.get(user.id) || [],
          plans,
          ctx.adminEmails,
          ctx.mergeEpoch,
          overrides.get(user.id),
          now
        )
      )
    );
  };
  const reply = (items, hasMore, nextCursor = null) => ({
    items,
    hasMore,
    nextOffset: hasMore ? offset + items.length : null,
    nextCursor,
    ranks,
    searchedExact: exact,
    searchScope: null,
    searchScopeCapped: false,
  });
  if (!literal && state === 'all' && rank === null && account !== 'owner') {
    const page = await ctx.store.listUsers({ ...scope, offset, limit: pageSize });
    return reply(await enrich(page.items), page.hasMore);
  }

  const cursor = Number(input.cursor);
  const hasCursor = input.cursor != null && input.cursor !== '' && Number.isSafeInteger(cursor) && cursor >= 0;
  let start = hasCursor ? cursor : 0;
  let skip = hasCursor ? 0 : offset;
  const result = [];
  for (;;) {
    const page = await ctx.store.listUsers({ ...scope, offset: start, limit: scanSize });
    const positions = new Map(page.items.map((user, i) => [user.id, start + i]));
    const candidates = page.items.filter(
      user =>
        (account !== 'owner' || ctx.adminEmails.includes(String(user.email).toLowerCase())) &&
        (!literal ||
          (short && shortId(user.id).toLowerCase() === short) ||
          searchFields.some(key =>
            String(user[key] ?? '')
              .toLowerCase()
              .includes(term)
          ))
    );
    for (const row of await enrich(candidates)) {
      if (state !== 'all' && !(state === 'expiring' ? row.expiring : row.memberState === state)) continue;
      if (rank !== null && (row.membership?.rank ?? 0) !== rank) continue;
      if (skip > 0) {
        skip--;
        continue;
      }
      if (result.length === pageSize) return reply(result, true, positions.get(row.user.id));
      result.push(row);
    }
    if (!page.hasMore) return reply(result, false);
    start = page.nextOffset;
  }
}
