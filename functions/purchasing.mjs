import { createHumanCode, normalizeCode, formatCode, deriveUuid, isoNow, randomId, normalizeEmail, cleanText, isUuid, expiresAt as readExpiry } from './shared/util.mjs';
import { fingerprint, shortId } from './shared/tokens.mjs';
import { seal, open } from './shared/vault.mjs';
import { DataError } from './db.mjs';
import { CARD_SOURCE, DAY, entitlement } from './entitlement.mjs';
import { DEFAULT_PLANS } from './domain.mjs';

const KEY_LENGTH = 16;
const MAX_BATCH = 1000;
const REDEEM_FAILS_PER_HOUR = 8;
const DAY_MS = 86_400_000;
const MAX_ADJUST_DAYS = 3650;

// 站长按 QQ 谈生意，"这位多送 7 天"和"他其实只该到上周"都是日常。
// 加在天数上而不是写成绝对日期，是因为他已经续过费的时候，日期会把前面的赠送抹掉。
export async function adjustMembershipDays(ctx, { id, days }) {
  if (!isUuid(id)) throw new DataError('membership_not_found');
  const amount = Number(days);
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_ADJUST_DAYS) {
    throw new DataError('member_days_invalid');
  }
  const { row } = await ctx.store.editableMembership(id);
  if (row.revoked_at) throw new DataError('membership_revoked_locked');
  // 永久权益没有"到期"可以加减。把它改成一个具体日期是另一件事（撤了重发），
  // 静默把永久变成有期限会直接砍掉买家以为还有的东西。
  if (!row.expires_at) throw new DataError('membership_permanent');
  const current = Date.parse(row.expires_at);
  if (!Number.isFinite(current)) throw new DataError('membership_permanent');
  // 已经过期的人加天数从现在起算；还没到期的人接着原来的时间往后加。
  const from = row.source === CARD_SOURCE ? current : Math.max(Date.now(), current);
  const expiresAt = new Date(from + amount * DAY_MS).toISOString();
  const updated = await ctx.store.setMembershipExpiry({ id, expiresAt, expectedSignature: row.signature });
  if (!updated) throw new DataError('membership_conflict');
  await ctx.store.audit({
    actorId: ctx.viewer?.user?.id,
    action: 'membership_adjust',
    target: id,
    ipPrefix: ctx.ip,
    detail: { days: amount, from: row.expires_at, to: expiresAt },
  });
  return { ok: true, days: amount, previous: row.expires_at, expiresAt, extended: amount > 0 };
}

export async function seedDefaultPlans(ctx) {
  const existing = await ctx.store.listPlans({ includeDisabled: true });
  const created = [];
  for (const draft of DEFAULT_PLANS) {
    if (existing.some((row) => row.code === draft.code)) continue;
    const saved = await ctx.store.upsertPlan({ ...draft, enabled: true });
    if (saved) created.push(saved.code);
  }
  await ctx.store.audit({
    actorId: ctx.viewer?.user?.id, action: 'plans_seed', target: created.join(',') || 'none', ipPrefix: ctx.ip,
    detail: { created },
  });
  return { created, skipped: DEFAULT_PLANS.length - created.length };
}

export async function generateKeys(ctx, { planCode, count, note, validDays, requestId }) {
  const plan = await ctx.store.findPlan(planCode);
  if (!plan || !plan.authentic || !plan.enabled) throw new DataError('plan_unavailable');
  const requested = Number(count);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_BATCH) throw new DataError('batch_size_invalid');
  // 绑单出码才有"这枚码是发给谁的"这件事：停用账号时靠它知道该冻哪几枚。
  const linked = requestId ? await ctx.store.findRequest(String(requestId)) : null;
  if (requestId && !linked) throw new DataError('request_not_found');
  const shelfLife = Number.isSafeInteger(Number(validDays)) && Number(validDays) > 0 ? Number(validDays) : null;

  const batchId = randomId();
  const records = [];
  for (let index = 0; index < requested; index += 1) {
    const code = createHumanCode(KEY_LENGTH);
    records.push({
      id: randomId(),
      code_cipher: await seal(ctx.dataKey, code),
      code_tail: code.slice(-4),
      fingerprint: await fingerprint(ctx.dataKey, code),
      plan_id: plan.id,
      batch_id: batchId,
      status: 'unused',
      created_at: isoNow(),
      created_by: ctx.viewer?.user?.id ?? null,
      expires_at: shelfLife ? isoNow(shelfLife * 86400) : null,
      redeemed_user_id: null,
      redeemed_at: null,
      note: cleanText(note ?? '', 60),
    });
  }
  let created;
  try {
    created = await ctx.store.insertKeys(records);
  } catch (error) {
    // Only a unique fingerprint collision can reject a whole batch.
    if (error?.code !== 'key_write_failed') throw error;
    throw new DataError('key_batch_failed');
  }
  const withCodes = [];
  for (const row of created) {
    withCodes.push({ ...row, code: await open(ctx.dataKey, row.code_cipher) });
  }
  if (linked) await ctx.store.setRequestBatch(linked.id, batchId);
  await ctx.store.audit({
    actorId: ctx.viewer?.user?.id, action: 'keys_generate', target: batchId, ipPrefix: ctx.ip,
    detail: { plan: plan.code, count: created.length, request: linked ? shortId(linked.id) : null },
  });
  return { batchId, plan: { code: plan.code, name: plan.name }, keys: withCodes.map((row) => ({ id: row.id, code: formatCode(row.code), tail: row.code_tail, note: row.note })) };
}

export async function revealKey(ctx, row) {
  if (!row?.code_cipher) return null;
  try {
    return formatCode(await open(ctx.dataKey, row.code_cipher));
  } catch {
    return null;
  }
}

export async function listKeys(ctx, { offset, limit, status, statuses, q }) {
  // 查询串里带不过来数组，回收站传的是 'revoked,frozen' 这种逗号串。
  // 只认登记过的状态名：状态值会被拼进查询条件，不能让调用方塞任意字符串。
  const KEY_STATUSES = new Set(['unused', 'reserved', 'redeemed', 'revoked', 'frozen']);
  const wanted = (typeof statuses === 'string' ? statuses.split(',') : (statuses ?? []))
    .map((word) => String(word).trim()).filter((word) => KEY_STATUSES.has(word));
  const page = await ctx.store.listKeys({ offset, limit, status, statuses: wanted });
  const planIds = [...new Set(page.items.map((row) => row.plan_id).filter(Boolean))];
  const plans = new Map();
  for (const id of planIds) {
    const plan = await ctx.store.findPlanById(id);
    if (plan) plans.set(id, plan);
  }
  // 「绑定对象」这一栏以前印的是 shortId（`ee608528` 这种），站长对着它既认不出人也没法核对。
  // 改成优先印他给的备注，其次邮箱：备注是后台写的，所以后台改了界面就得跟着变，不能让他去猜编号。
  const redeemerIds = [...new Set(page.items.map((row) => row.redeemed_user_id).filter(Boolean))];
  const people = new Map((await ctx.store.findUsersByIds(redeemerIds)).map((u) => [u.id, u]));
  const items = [];
  for (const row of page.items) {
    const plan = plans.get(row.plan_id);
    const who = people.get(row.redeemed_user_id);
    items.push({
      id: row.id,
      code: await revealKey(ctx, row),
      tail: row.code_tail,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      redeemedAt: row.redeemed_at,
      // 认不出人时才退回编号（号被删了、或这一页没取到那个人），并且把编号说清是编号。
      redeemedUser: who ? (who.note || who.display_name || who.email)
        : (row.redeemed_user_id ? `账号 ${shortId(row.redeemed_user_id)}` : null),
      redeemedEmail: who?.email ?? '',
      redeemedQq: who?.contact_qq ?? '',
      batchId: row.batch_id,
      note: row.note,
      plan: plan ? { code: plan.code, name: plan.name, rank: plan.tier_rank } : null,
    });
  }
  // 回收站的搜索：整码（去掉连字符后）或码尾、批次备注里含这个词。
  // 只在已经取回来的这一页里筛，所以界面要写明"筛的是这一页"，不假装搜了全站。
  const needle = String(q ?? '').trim().toLowerCase().replace(/[-\s]/g, '');
  const matched = !needle ? items : items.filter((row) => [row.code, row.tail, row.note, row.batchId]
    .some((field) => String(field ?? '').toLowerCase().replace(/[-\s]/g, '').includes(needle)));
  return { items: matched, pageItems: items.length, hasMore: page.hasMore, nextOffset: page.nextOffset };
}

export async function revokeKey(ctx, id) {
  const updated = await ctx.store.revokeKey(id);
  if (!updated) {
    // 「没有这枚码」和「这枚码已经兑换或已作废，撤不了」是两件事。共用一句话的时候，
    // 站长会照着错的结论去处理——比如以为码还在别人手里，其实那条批次根本没写进去。
    const rows = await ctx.store.listKeysByIds([id]);
    throw new DataError(rows.length === 0 ? 'key_not_found' : 'key_not_reversible');
  }
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'key_revoke', target: id, ipPrefix: ctx.ip });
  return { ok: true };
}

// 回收站里的"放回未兑换"：只有从没兑换过的作废码能回来，判据写在 store 那条 update 的
// where 里（status='revoked' 且 redeemed_at IS NULL），不靠调用方先查一遍。
export async function restoreKey(ctx, id) {
  if (!isUuid(id)) throw new DataError('key_not_found');
  const updated = await ctx.store.restoreKey(id);
  if (!updated) {
    const rows = await ctx.store.listKeysByIds([id]);
    const row = rows[0];
    // 说清为什么放回不了：已经被人用掉的码放回去等于凭空多一枚，这一句要拦住站长。
    throw new DataError(row ? (row.redeemed_at ? 'key_already_redeemed' : 'key_not_restorable') : 'key_not_found');
  }
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'key_restore', target: id, ipPrefix: ctx.ip });
  return { ok: true };
}

// Redeeming is fenced by one compare-and-set on the key row. The membership row
// uses a key-derived primary key, so a lost response can be replayed safely.
export async function redeemCode(ctx, { code }) {
  if (!ctx.viewer) throw new DataError('login_required');
  const normalized = normalizeCode(code);
  if (normalized.length !== KEY_LENGTH) throw new DataError('code_invalid');
  const userId = ctx.viewer.user.id;

  if (await ctx.store.countAuditSince({ action: 'redeem_fail', userId, sinceIso: isoNow(-3600) }) >= REDEEM_FAILS_PER_HOUR) {
    throw new DataError('redeem_rate_limited');
  }

  const key = await ctx.store.findKeyByFingerprint(await fingerprint(ctx.dataKey, normalized));
  if (!key) {
    await ctx.store.audit({ actorId: userId, action: 'redeem_fail', target: 'unknown', ipPrefix: ctx.ip });
    throw new DataError('code_invalid');
  }
  const membershipId = await deriveUuid('membership', key.id);
  const recovering = key.status === 'redeemed' && key.redeemed_user_id === userId;
  if (key.status === 'redeemed' && (!recovering || await ctx.store.findMembershipById(membershipId))) throw new DataError('code_used');
  if (key.status === 'revoked') throw new DataError('code_revoked');
  if (key.status === 'frozen') throw new DataError('code_frozen');
  if (!recovering && key.status !== 'unused') throw new DataError('code_unavailable');
  const shelfEnd = readExpiry(key.expires_at);
  if (!recovering && shelfEnd !== null && shelfEnd <= Date.now()) throw new DataError('code_expired');
  const plan = await ctx.store.findPlanById(key.plan_id);
  if (!plan || !plan.authentic) throw new DataError('plan_unavailable');
  const fenced = recovering ? key : await ctx.store.redeemKey({ id: key.id, userId, at: isoNow() });
  if (!fenced) throw new DataError('code_used');
  const startsAt = fenced.redeemed_at;
  const expiresAt = plan.duration_days > 0 ? new Date(Date.parse(startsAt) + Number(plan.duration_days) * DAY).toISOString() : null;

  try {
    await ctx.store.insertMembership({
      id: membershipId, userId, planId: plan.id, rank: plan.tier_rank, source: CARD_SOURCE,
      keyId: key.id, startsAt, expiresAt,
    });
  } catch (error) {
    if (error?.code === 'membership_write_failed') {
      const rows = await ctx.store.listMemberships(userId);
      if (!rows.some((row) => row.id === membershipId)) {
        // The key is consumed but the membership did not persist: keep the exact
        // state visible so an admin can re-issue instead of silently losing it.
        await ctx.store.audit({ actorId: userId, action: 'redeem_incomplete', target: key.id, ipPrefix: ctx.ip, detail: { plan: plan.code } });
        throw new DataError('redeem_incomplete');
      }
    } else throw error;
  }

  await ctx.store.audit({ actorId: userId, action: 'redeem', target: key.id, ipPrefix: ctx.ip, detail: { plan: plan.code } });
  const [memberships, overrides] = await Promise.all([ctx.store.listMemberships(userId), ctx.store.entitlementOverrides([userId])]);
  const standing = entitlement(memberships, ctx.mergeEpoch, overrides.get(userId));
  return {
    ok: true, plan: { code: plan.code, name: plan.name, rank: plan.tier_rank },
    membership: { id: membershipId, expiresAt: standing.until }, rank: standing.rank, until: standing.until, overlap: false,
  };
}

// The seller records a sale themselves; buyers no longer file requests from the site.
// The typed address is used as-is on purpose: this is the owner naming the buyer, so
// rewriting it to the owner's own account address would empty the whole record.
export async function createManualRequest(ctx, { email, planCode, note, contactQq }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new DataError('email_invalid');
  const plan = await ctx.store.findPlan(planCode);
  if (!plan || !plan.authentic || !plan.enabled) throw new DataError('plan_unavailable');
  const qq = String(contactQq ?? '').replace(/[^0-9]/g, '').slice(0, 12);
  const record = {
    id: randomId(), email: normalized, plan_id: plan.id, note: cleanText(note ?? '', 300),
    contact_qq: qq || null, status: 'new', created_at: isoNow(), updated_at: isoNow(),
    // Recording a sale is not the same as having issued the code; that is what
    // 「已成交」 means, and it sets handled_by.
    handled_by: null, batch_id: null,
  };
  const created = await ctx.store.createRequest(record);
  if (!created) throw new DataError('request_write_failed');
  await ctx.store.audit({ actorId: ctx.viewer.user.id, action: 'purchase_request', target: created.id, ipPrefix: ctx.ip, detail: { plan: plan.code } });
  return {
    id: created.id,
    reference: shortId(created.id),
    email: normalized,
    plan: { code: plan.code, name: plan.name },
  };
}

export async function listRequests(ctx, { offset, limit, status }) {
  const page = await ctx.store.listRequests({ offset, limit, status });
  // 一单一码：站长判断"这单到底出没出码、买家兑换了没有"以前要在两个标签之间来回跳。
  // 这里按批次一次取回，把计数直接挂到那一行上。
  const batchIds = [...new Set(page.items.map((row) => row.batch_id).filter(Boolean))];
  const byBatch = new Map();
  for (const key of await ctx.store.listKeysByBatches(batchIds)) {
    const held = byBatch.get(key.batch_id) ?? { total: 0, unused: 0, redeemed: 0, revoked: 0, frozen: 0, tails: [] };
    held.total += 1;
    if (held[key.status] !== undefined) held[key.status] += 1;
    if (held.tails.length < 3 && key.code_tail) held.tails.push(key.code_tail);
    byBatch.set(key.batch_id, held);
  }
  const items = [];
  const plans = new Map();
  for (const row of page.items) {
    if (!plans.has(row.plan_id)) {
      const plan = await ctx.store.findPlanById(row.plan_id);
      plans.set(row.plan_id, plan);
    }
    const plan = plans.get(row.plan_id);
    items.push({
      id: row.id, reference: shortId(row.id), email: row.email, note: row.note, contactQq: row.contact_qq,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      plan: plan ? { code: plan.code, name: plan.name } : null,
      codes: row.batch_id ? (byBatch.get(row.batch_id) ?? null) : null,
    });
  }
  return { items, hasMore: page.hasMore, nextOffset: page.nextOffset };
}

const REQUEST_STATUSES = ['new', 'quoted', 'done', 'cancelled'];

export async function updateRequest(ctx, { id, status }) {
  if (!REQUEST_STATUSES.includes(status)) throw new DataError('status_invalid');
  const updated = await ctx.store.updateRequest(id, { status, handled_by: ctx.viewer?.user?.id ?? null });
  if (!updated) throw new DataError('request_not_found');
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'request_update', target: id, ipPrefix: ctx.ip, detail: { status } });
  return { ok: true, status };
}
