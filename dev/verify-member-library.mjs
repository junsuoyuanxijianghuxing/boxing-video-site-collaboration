import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeSupabase } from './fake-supabase.mjs';
import { schemaFromSql, uniqueFromSql } from './schema.mjs';
import { store } from '../functions/store.mjs';
import {
  CARD_SOURCE,
  DAY,
  entitlement,
  entitlementRevision,
  setAccountEntitlement,
} from '../functions/entitlement.mjs';
import { accountDirectory } from '../functions/account-directory.mjs';
import { membershipSignature, membershipIsAuthentic, decideAccess } from '../functions/domain.mjs';
import { generateKeys, redeemCode, seedDefaultPlans } from '../functions/purchasing.mjs';
import {
  readLibraryState,
  libraryUrl,
  matchesLibraryItem,
  sortLibraryItems,
} from '../web/assets/library-browser.mjs';
import { withinPublicationRange } from '../web/assets/library-date-feed.mjs';

const epoch = Date.UTC(2026, 3, 1);
const at = days => new Date(epoch + days * DAY).toISOString();
const id = n => n.toString(16).padStart(8, '0') + '-7000-4000-8000-000000000001';
const card = (n, plan, rank, start, end, extra = {}) => ({
  id: id(n),
  plan_id: id(plan),
  tier_rank: rank,
  starts_at: at(start),
  expires_at: end === null ? null : at(end),
  verified: true,
  ...extra,
});
const schema = new URL('../migrations/', import.meta.url);
const secret = randomBytes(32).toString('base64url');
async function fixture(count = 1) {
  const users = Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
    email: 'person' + i + '@example.test',
    display_name: '同名',
    note: i === 0 ? '远期 50%_' : '',
    contact_qq: i === 0 ? '70001111' : '',
    created_at: at(i),
    disabled_at: i === 1 ? at(2) : null,
  }));
  const db = fakeSupabase({ users }, { columns: schemaFromSql(schema), unique: uniqueFromSql(schema) });
  const ctx = {
    store: store(db, secret),
    dataKey: secret,
    adminEmails: [],
    ip: 'local',
    viewer: { user: users[0] },
  };
  ctx.mergeEpoch = await ctx.store.membershipEpoch();
  return { ctx, users, db };
}
test('合并旧卡只计算切换日剩余时间，已累计的同一档位去重', () => {
  const rows = [card(1, 21, 1, -15, 10), card(2, 21, 1, -3, 40), card(3, 22, 2, -1, 5), card(4, 23, 8, -30, -1)];
  assert.deepEqual(entitlement(rows, epoch, null, epoch), { rank: 2, until: at(45), lapsedAt: null });
  assert.equal(entitlement(rows, epoch, null, epoch + 30 * DAY).until, at(45));
  assert.equal(entitlement(rows, epoch, null, epoch + 45 * DAY).rank, 0);
  assert.equal(entitlement([rows[3]], epoch, null, epoch).lapsedAt, at(-1));
});
test('永久卡、空档、撤销和未来卡', () => {
  const forever = card(1, 21, 1, -3, null),
    higher = card(2, 22, 2, -2, 1);
  assert.deepEqual(entitlement([forever, higher], epoch, null, epoch + 90 * DAY), {
    rank: 2,
    until: null,
    lapsedAt: null,
  });
  const renewed = card(3, 22, 1, 20, 50, { source: CARD_SOURCE });
  assert.equal(entitlement([higher, renewed], epoch, null, epoch + 12 * DAY).rank, 0);
  assert.equal(entitlement([higher, renewed], epoch, null, epoch + 25 * DAY).rank, 1);
  assert.equal(
    entitlement(
      [
        { ...forever, revoked_at: at(0) },
        { ...higher, verified: false },
      ],
      epoch,
      null,
      epoch
    ).rank,
    0
  );
});
test('新兑换按面值累加，两张同时兑换与重复提交', async () => {
  const { ctx } = await fixture();
  await seedDefaultPlans(ctx);
  const key = async planCode => (await generateKeys(ctx, { planCode, count: 1 })).keys[0].code;
  const [month, year] = await Promise.all([key('month'), key('year')]);
  const before = Date.now();
  await Promise.all([redeemCode(ctx, { code: year }), redeemCode(ctx, { code: month })]);
  await assert.rejects(redeemCode(ctx, { code: month }), { code: 'code_used' });
  const rows = await ctx.store.listMemberships(ctx.viewer.user.id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.verified));
  const result = entitlement(rows, ctx.mergeEpoch);
  assert.equal(result.rank, 2);
  assert.ok(Date.parse(result.until) >= before + 395 * DAY && Date.parse(result.until) <= Date.now() + 395 * DAY);
  assert.equal(decideAccess({ video: { tier_rank: 2, status: 'published' }, rank: result.rank }), 'full');
  assert.equal(await membershipIsAuthentic(secret, { ...rows[0], starts_at: at(-20) }), false);
});
test('直接开通、保留到期降级、设置日期、缩短、永久、结束与过期表单', async () => {
  const { ctx, users } = await fixture();
  const userId = users[0].id;
  const revision = async () =>
    entitlementRevision(
      await ctx.store.listMemberships(userId),
      (await ctx.store.entitlementOverrides([userId])).get(userId)
    );
  const save = async (rank, mode, extra = {}) =>
    setAccountEntitlement(ctx, { userId, rank, mode, revision: await revision(), ...extra });
  const before = await revision();
  const initial = await save(4, 'days', { days: 30 });
  assert.equal(initial.rank, 4);
  assert.ok(initial.until);
  assert.deepEqual(await save(1, 'keep'), { ...initial, rank: 1 });
  await assert.rejects(setAccountEntitlement(ctx, { userId, rank: 2, mode: 'keep', revision: before }), {
    code: 'membership_conflict',
  });
  const end = new Date(Date.now() + 25 * DAY).toISOString();
  assert.equal((await save(2, 'until', { until: end })).until, end);
  assert.equal(Date.parse((await save(2, 'extend', { days: -3 })).until), Date.parse(end) - 3 * DAY);
  assert.equal((await save(2, 'permanent')).until, null);
  assert.equal((await save(2, 'days', { days: 5 })).rank, 2);
  assert.equal((await save(0, 'keep')).rank, 0);
});
test('账户调整覆盖旧卡，新入账的卡保留，即使恰好在调整时兑换', () => {
  const a = card(1, 2, 5, -4, 18),
    b = card(2, 3, 3, 1, 31, { source: CARD_SOURCE });
  const manual = { value: { at: at(2), until: at(7), rank: 1, covered: [a.id] } };
  assert.deepEqual(entitlement([a, b], epoch, manual, epoch + 4 * DAY), {
    rank: 3,
    until: at(37),
    lapsedAt: null,
  });
});
test('并发后台保存只有一份生效', async () => {
  const { ctx, users } = await fixture();
  const revision = await entitlementRevision([], null);
  const write = rank =>
    setAccountEntitlement(ctx, { userId: users[0].id, revision, rank, mode: 'days', days: 30 });
  const out = await Promise.allSettled([write(2), write(4)]);
  assert.equal(out.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(out.find(x => x.status === 'rejected').reason.code, 'membership_conflict');
});
test('跨过 200 个新账号、400 条权益，按昵称、备注、QQ、编号、状态筛查', async () => {
  const { ctx, users, db } = await fixture(244);
  const userId = users[0].id;
  const seed = Array.from({ length: 412 }, (_, i) => ({
    id: id(i + 1000),
    user_id: users[243].id,
    plan_id: id(555),
    tier_rank: 1,
    expires_at: at(-7),
    source: 'key',
    starts_at: at(-9),
  }));
  seed.push({
    id: id(900),
    user_id: userId,
    plan_id: id(555),
    tier_rank: 7,
    expires_at: null,
    source: 'key',
    starts_at: at(-10),
  });
  for (const row of seed) row.signature = await membershipSignature(secret, row);
  db.__tables.set('memberships', seed);
  for (const q of ['远期', '50%_', '70001111', '#00000001', 'person0@example.te', users[0].email]) {
    const found = await accountDirectory(ctx, { q, rank: '7', membership: 'active' });
    assert.equal(found.items[0].user.id, userId);
    assert.equal(found.items[0].membership.rank, 7);
    assert.equal(found.items[0].grants.length, 1);
  }
  assert.equal((await ctx.store.listMemberships(users[243].id)).length, 412);
  assert.equal((await accountDirectory(ctx, { q: '同名', account: 'disabled' })).items[0].user.id, users[1].id);
  const page = await accountDirectory(ctx, { membership: 'none', limit: 20 });
  const next = await accountDirectory(ctx, {
    membership: 'none',
    limit: 20,
    offset: page.nextOffset,
    cursor: page.nextCursor,
  });
  assert.equal(new Set([...page.items, ...next.items].map(r => r.user.id)).size, 40);
});
test('日期和时长可组合，2 与 5 分钟边界明确，排序不改原目录且缺值排最后', () => {
  const ui = readLibraryState('?duration=medium&sort=shortest&range=7');
  assert.equal(ui.period, '7');
  assert.equal(ui.sort, 'shortest');
  assert.equal(
    readLibraryState(new URL(libraryUrl(ui, 'https://example.test/library'), 'https://example.test').search)
      .duration,
    'medium'
  );
  const rows = [119, 120, 299, 300, null].map((durationSeconds, i) => ({
    id: String(i),
    durationSeconds,
    publishedAt: at(i === 2 ? -8 : -1),
  }));
  assert.deepEqual(
    rows.filter(r => matchesLibraryItem(r, ui)).map(r => r.durationSeconds),
    [120, 299]
  );
  assert.deepEqual(
    rows
      .filter(r => matchesLibraryItem(r, ui) && withinPublicationRange(r, ui.period, epoch))
      .map(r => r.durationSeconds),
    [120]
  );
  assert.deepEqual(
    sortLibraryItems(rows, 'longest').map(r => r.durationSeconds),
    [300, 299, 120, 119, null]
  );
  assert.equal(sortLibraryItems([{ id: 0 }, { id: 1, publishedAt: at(1) }], 'oldest')[1].id, 0);
  assert.equal(rows[0].durationSeconds, 119);
});

test('兑换中断后同一账号可补记，重试只累计一次', async () => {
  const { ctx } = await fixture();
  await seedDefaultPlans(ctx);
  const code = (await generateKeys(ctx, { planCode: 'month', count: 1 })).keys[0].code;
  const insert = ctx.store.insertMembership.bind(ctx.store);
  let first = true;
  ctx.store.insertMembership = async values => {
    if (first) {
      first = false;
      const error = new Error('synthetic storage interruption');
      error.code = 'membership_write_failed';
      throw error;
    }
    return insert(values);
  };
  await assert.rejects(redeemCode(ctx, { code }), { code: 'redeem_incomplete' });
  assert.equal((await redeemCode(ctx, { code })).rank, 1);
  assert.equal((await ctx.store.listMemberships(ctx.viewer.user.id)).length, 1);
  await assert.rejects(redeemCode(ctx, { code }), { code: 'code_used' });
});

test('跨进程重读沿用同一合并时间，直接调级后的老卡只供核对', async () => {
  const { ctx, db, users } = await fixture();
  const another = store(db, secret);
  assert.equal(await another.membershipEpoch(), ctx.mergeEpoch);
  await seedDefaultPlans(ctx);
  const code = (await generateKeys(ctx, { planCode: 'month', count: 1 })).keys[0].code;
  await redeemCode(ctx, { code });
  const rows = await ctx.store.listMemberships(users[0].id);
  const revision = await entitlementRevision(rows, null);
  await setAccountEntitlement(ctx, { userId: users[0].id, rank: 3, mode: 'keep', revision });
  await assert.rejects(another.editableMembership(rows[0].id), { code: 'membership_settled' });
  assert.equal((await accountDirectory(ctx, { q: users[0].email })).items[0].grants[0].settled, true);
});
