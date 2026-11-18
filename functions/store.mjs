import { one, many, create, mutate, paginate, rangeParams, DataError } from './db.mjs';
import { LESSON_SERIES_KEY, lessonSeriesSignature, lessonSeriesIsAuthentic } from './lesson-series.mjs';
import { CATALOG_ORDER_KEY, catalogOrderSignature, catalogOrderIsAuthentic } from './catalog-order.mjs';
import {
  planIsAuthentic, membershipIsAuthentic, videoAccessIsAuthentic, membershipSignature,
  planSignature, videoAccessSignature, normalizeSettings, settingsIsAuthentic, settingsSignature,
} from './domain.mjs';
import { randomId, isoNow, isUuid } from './shared/util.mjs';

export const COLUMNS = {
  users: 'id,email,display_name,pw_cipher,created_at,last_login_at,disabled_at,failed_count,locked_until,contact_qq,note',
  sessions: 'id,user_id,token_hash,created_at,last_seen_at,expires_at,revoked_at,device_label,ua_hash,ip_prefix',
  plans: 'id,code,name,tier_rank,price_cents,price_text,duration_days,description,enabled,sort_order,signature',
  keys: 'id,code_cipher,code_tail,fingerprint,plan_id,batch_id,status,created_at,created_by,expires_at,redeemed_user_id,redeemed_at,note',
  memberships: 'id,user_id,plan_id,tier_rank,source,key_id,starts_at,expires_at,signature,created_at,revoked_at',
  videos: 'id,title,description,object_prefix,content_type,plain_size,enc_size,chunk_size,chunk_total,duration_seconds,preview_seconds,tier_rank,key_cipher,cipher_version,faststart,status,published_at,created_at,updated_at,poster_path,access_signature,kind',
  requests: 'id,email,plan_id,note,contact_qq,status,created_at,updated_at,handled_by,batch_id',
  settings: 'id,config_key,value,updated_at,signature',
  audit: 'id,actor_id,action,target,ip_prefix,created_at,detail',
  watch_logs: 'id,user_id,video_id,session_id,access_mode,position_seconds,updated_at,created_at',
};

const TABLES = Object.keys(COLUMNS);

export function store(db, secret) {
  const table = (name) => {
    if (!TABLES.includes(name)) throw new Error('unknown table');
    return db.from(name);
  };

  async function settingRow() {
    return one(table('settings').select(COLUMNS.settings).eq('config_key', 'site').maybeSingle(), 'settings_read_failed');
  }

  return {
    // ---------------------------------------------------------------- users
    async findUserByEmail(email) {
      return one(table('users').select(COLUMNS.users).eq('email', email).maybeSingle(), 'user_read_failed');
    },
    async findUserById(id) {
      return one(table('users').select(COLUMNS.users).eq('id', id).maybeSingle(), 'user_read_failed');
    },
    async findUsersByIds(ids) {
      if (ids.length === 0) return [];
      return many(table('users').select(COLUMNS.users).in('id', ids).limit(500), 'users_read_failed');
    },
    async findVideosByIds(ids) {
      if (ids.length === 0) return [];
      // 只取这四列：日志和观看记录要的是"动了哪一条、这条多长、这条最近一次改动是什么时候"
      // （最后那列用来分辨"进度是旧版本留下的"还是"片长真写错了"）。把 key_cipher / object_prefix
      // 读进内存没有任何用处。
      return many(table('videos').select('id,title,duration_seconds,updated_at').in('id', ids).limit(500), 'videos_read_failed');
    },
    async createUser({ email, displayName, pwCipher }) {
      return create(table('users'), {
        id: randomId(), email, display_name: displayName, pw_cipher: pwCipher,
        created_at: isoNow(), failed_count: 0, note: null, contact_qq: null,
        disabled_at: null, last_login_at: null, locked_until: null,
      }, COLUMNS.users, 'user_create_failed');
    },
    async setPassword(id, pwCipher) {
      return mutate(
        table('users').update({ pw_cipher: pwCipher, failed_count: 0, locked_until: null }).eq('id', id),
        COLUMNS.users, 'password_write_failed',
      );
    },
    async noteLoginSuccess(id, at) {
      return mutate(table('users').update({ last_login_at: at, failed_count: 0, locked_until: null }).eq('id', id), 'id', 'login_state_write_failed');
    },
    async noteLoginFailure(id, failedCount, lockedUntil) {
      return mutate(table('users').update({ failed_count: failedCount, locked_until: lockedUntil }).eq('id', id), 'id', 'login_state_write_failed');
    },
    async setUserNote(id, patch) {
      return mutate(table('users').update(patch).eq('id', id), COLUMNS.users, 'user_write_failed');
    },
    async listUsers({ offset, limit, emailExact, disabledOnly, activeOnly }) {
      const page = rangeParams(offset, limit);
      let query = table('users').select(COLUMNS.users);
      // PostgREST filter strings are easy to break out of, so admin search only
      // accepts a normalized exact email.
      if (emailExact) query = query.eq('email', emailExact);
      // 回收站只要停用过的；主表反过来把它们整个排除，不再混在一栏里靠红 pill 区分。
      if (disabledOnly) query = query.not('disabled_at', 'is', null);
      if (activeOnly) query = query.is('disabled_at', null);
      const rows = await many(query.order('created_at', { ascending: false }).range(page.first, page.last), 'users_read_failed');
      return paginate(rows, page);
    },

    // ------------------------------------------------------------- sessions
    async createSession({ id, userId, tokenHash, expiresAt, deviceLabel, uaHash, ipPrefix }) {
      return create(table('sessions'), {
        id, user_id: userId, token_hash: tokenHash, created_at: isoNow(), last_seen_at: isoNow(),
        expires_at: expiresAt, revoked_at: null, device_label: deviceLabel, ua_hash: uaHash, ip_prefix: ipPrefix,
      }, COLUMNS.sessions, 'session_write_failed');
    },
    async findSessionByTokenHash(tokenHash) {
      return one(table('sessions').select(COLUMNS.sessions).eq('token_hash', tokenHash).maybeSingle(), 'session_read_failed');
    },
    async touchSession(id, at) {
      return mutate(table('sessions').update({ last_seen_at: at }).eq('id', id), 'id', 'session_touch_failed');
    },
    async revokeSession(id) {
      return mutate(table('sessions').update({ revoked_at: isoNow() }).eq('id', id).is('revoked_at', null), 'id', 'session_revoke_failed');
    },
    // 后台的"谁在看"要说得出是哪一台设备，所以按 id 批量取设备名和网段。
    // 只取这两列：token_hash / ua_hash 一律不出这层。
    async findSessionsByIds(ids) {
      const list = (ids ?? []).filter(isUuid);
      if (!list.length) return [];
      return many(
        table('sessions').select('id,device_label,ip_prefix').in('id', list).limit(500),
        'sessions_read_failed',
      );
    },
    // A browser that logs in again replaces its own previous session rather than taking a
    // second slot: WeChat's webview opens a fresh session on every cold start, and those
    // ghosts were pushing the owner's own devices out of the cap.
    async revokeSessionsByDevice(userId, uaHash, ipPrefixValue, before) {
      const rows = await many(
        table('sessions').select('id').eq('user_id', userId).eq('ua_hash', uaHash)
          .eq('ip_prefix', ipPrefixValue).is('revoked_at', null).gt('expires_at', before),
        'sessions_read_failed',
      );
      let changed = 0;
      for (const row of rows) {
        const done = await mutate(table('sessions').update({ revoked_at: isoNow() }).eq('id', row.id).is('revoked_at', null), 'id', 'session_revoke_failed');
        if (done) changed += 1;
      }
      return changed;
    },
    async activeSessions(userId, before) {
      return many(
        table('sessions').select(COLUMNS.sessions).eq('user_id', userId).is('revoked_at', null)
          .gt('expires_at', before).order('created_at', { ascending: true }).limit(50),
        'sessions_read_failed',
      );
    },
    // 「违规案头」要按账号找"同一个号在几个地方同时在线"，得一次看全部人的有效会话 ——
    // 按人查 N 次既慢又会漏掉那些这段时间没看片、但会话还挂在两个网段上的号。
    async listActiveSessions({ before, limit = 500 }) {
      return many(
        table('sessions').select(COLUMNS.sessions).is('revoked_at', null).gt('expires_at', before)
          .order('user_id', { ascending: true }).limit(limit),
        'sessions_read_failed',
      );
    },

    // ---------------------------------------------------------------- plans
    async listPlans({ includeDisabled = false } = {}) {
      let query = table('plans').select(COLUMNS.plans);
      if (!includeDisabled) query = query.eq('enabled', true);
      const rows = await many(query.order('sort_order', { ascending: true }).order('tier_rank', { ascending: true }).limit(50), 'plans_read_failed');
      const verified = [];
      for (const row of rows) verified.push({ ...row, authentic: await planIsAuthentic(secret, row) });
      return verified;
    },
    async findPlan(codeOrId) {
      const byCode = await one(table('plans').select(COLUMNS.plans).eq('code', codeOrId).maybeSingle(), 'plan_read_failed');
      if (byCode) return { ...byCode, authentic: await planIsAuthentic(secret, byCode) };
      return null;
    },
    async findPlanById(id) {
      const row = await one(table('plans').select(COLUMNS.plans).eq('id', id).maybeSingle(), 'plan_read_failed');
      return row ? { ...row, authentic: await planIsAuthentic(secret, row) } : null;
    },
    async upsertPlan(values) {
      const existing = await one(table('plans').select(COLUMNS.plans).eq('code', values.code).maybeSingle(), 'plan_read_failed');
      // The id must exist before signing, because the signature covers the stored row.
      const id = existing?.id ?? randomId();
      const signature = await planSignature(secret, { ...existing, ...values, id });
      const record = { ...values, signature };
      if (existing) {
        return mutate(table('plans').update(record).eq('id', existing.id), COLUMNS.plans, 'plan_write_failed');
      }
      return create(table('plans'), { id, created_at: isoNow(), ...record }, COLUMNS.plans, 'plan_write_failed');
    },

    // ---------------------------------------------------------- memberships
    async listMemberships(userId) {
      const rows = await many(
        table('memberships').select(COLUMNS.memberships).eq('user_id', userId)
          .order('expires_at', { ascending: false }).limit(100),
        'memberships_read_failed',
      );
      const out = [];
      for (const row of rows) out.push({ ...row, verified: await membershipIsAuthentic(secret, row) });
      return out;
    },
    async insertMembership({ id, userId, planId, rank, source, keyId, expiresAt, startsAt }) {
      const base = { user_id: userId, plan_id: planId, tier_rank: rank, expires_at: expiresAt, key_id: keyId };
      const signature = await membershipSignature(secret, base);
      return create(table('memberships'), {
        id, user_id: userId, plan_id: planId, tier_rank: rank, source, key_id: keyId,
        starts_at: startsAt, expires_at: expiresAt, created_at: isoNow(), revoked_at: null, signature,
      }, COLUMNS.memberships, 'membership_write_failed');
    },
    async listMembersWithPlans(limit = 200, { includeRevoked = false } = {}) {
      let query = table('memberships').select(COLUMNS.memberships);
      if (!includeRevoked) query = query.is('revoked_at', null);
      const rows = await many(
        query.order('expires_at', { ascending: false }).limit(limit),
        'members_read_failed',
      );
      const out = [];
      for (const row of rows) out.push({ ...row, verified: await membershipIsAuthentic(secret, row) });
      return out;
    },
    // 回收站要的是"只列已经撤销的、每页 20 条"，和主表那句"默认不返回已撤销"是同一份判据的
    // 两个方向，所以两个都住在这里，不在调用方各拼一次 where。
    async listMembersPage({ offset, limit, revokedOnly, userIds } = {}) {
      const page = rangeParams(offset, limit);
      let query = table('memberships').select(COLUMNS.memberships);
      if (revokedOnly) query = query.not('revoked_at', 'is', null);
      else query = query.is('revoked_at', null);
      if (Array.isArray(userIds)) query = query.in('user_id', userIds);
      const rows = await many(
        query.order('expires_at', { ascending: false }).order('id', { ascending: false }).range(page.first, page.last),
        'members_read_failed',
      );
      // 签名核对不能省：直接写进表里的行没有合法签名，主表和回收站都不许把它当会员。
      const checked = [];
      for (const row of rows) checked.push({ ...row, verified: await membershipIsAuthentic(secret, row) });
      return paginate(checked, page);
    },
    async restoreMembershipById(id) {
      return mutate(table('memberships').update({ revoked_at: null }).eq('id', id).not('revoked_at', 'is', null), COLUMNS.memberships, 'membership_restore_failed');
    },
    async revokeMembershipById(id) {
      return mutate(table('memberships').update({ revoked_at: isoNow() }).eq('id', id).is('revoked_at', null), COLUMNS.memberships, 'membership_revoke_failed');
    },
    async findMembershipById(id) {
      return one(table('memberships').select(COLUMNS.memberships).eq('id', id).maybeSingle(), 'membership_read_failed');
    },
    async findMembershipsByIds(ids) {
      if (ids.length === 0) return [];
      return many(table('memberships').select(COLUMNS.memberships).in('id', ids).limit(500), 'membership_read_failed');
    },
    // 到期时间在签名覆盖的字段里：只改 expires_at 不改 signature，这一行下次读出来就是
    // "签名不一致"，权益按被篡改处理 —— 想给买家多送几天，反而把人关在外面。
    // 条件更新带上旧签名，两个人同时改一条时后一次不会悄悄盖掉前一次。
    async setMembershipExpiry({ id, expiresAt, expectedSignature }) {
      const row = await one(table('memberships').select(COLUMNS.memberships).eq('id', id).maybeSingle(), 'membership_read_failed');
      if (!row || row.revoked_at) return null;
      const signature = await membershipSignature(secret, {
        user_id: row.user_id,
        plan_id: row.plan_id,
        tier_rank: row.tier_rank,
        expires_at: expiresAt,
        key_id: row.key_id,
      });
      return mutate(
        table('memberships').update({ expires_at: expiresAt, signature })
          .eq('id', id).eq('signature', expectedSignature ?? row.signature).is('revoked_at', null),
        COLUMNS.memberships, 'membership_write_failed',
      );
    },

    // ----------------------------------------------------------------- keys
    async insertKeys(records) {
      const created = await one(table('keys').insert(records).select(COLUMNS.keys), 'key_write_failed');
      if (!Array.isArray(created)) throw new Error('key insert returned no rows');
      return created;
    },
    async findKeyByFingerprint(fingerprint) {
      return one(table('keys').select(COLUMNS.keys).eq('fingerprint', fingerprint).maybeSingle(), 'key_read_failed');
    },
    async redeemKey({ id, userId, at }) {
      return mutate(
        table('keys').update({ status: 'redeemed', redeemed_user_id: userId, redeemed_at: at })
          .eq('id', id).eq('status', 'unused'),
        COLUMNS.keys, 'key_redeem_failed',
      );
    },
    async revokeKey(id) {
      // 冻结是"账号停用中"，作废是"这枚码没有了"：站长要能把冻着的码直接作废。
      return mutate(table('keys').update({ status: 'revoked' }).eq('id', id).in('status', ['unused', 'reserved', 'frozen']), 'id', 'key_revoke_failed');
    },
    async restoreKey(id) {
      // 只有从没兑换过的作废码能放回未兑换。已经兑换过的码放回去等于凭空多一枚，
      // 所以条件里带着 redeemed_at IS NULL —— 不靠调用方自觉。
      return mutate(table('keys').update({ status: 'unused' }).eq('id', id).eq('status', 'revoked').is('redeemed_at', null),
        'id', 'key_restore_failed');
    },
    async listKeys({ offset, limit, status, statuses, batchId }) {
      const page = rangeParams(offset, limit);
      let query = table('keys').select(COLUMNS.keys);
      if (status) query = query.eq('status', status);
      else if (Array.isArray(statuses) && statuses.length) query = query.in('status', statuses);
      if (batchId) query = query.eq('batch_id', batchId);
      const rows = await many(query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(page.first, page.last), 'keys_read_failed');
      return paginate(rows, page);
    },
    async listKeysByIds(ids) {
      return many(table('keys').select(COLUMNS.keys).in('id', ids).limit(500), 'keys_read_failed');
    },
    // 购买记录那一屏要顺手回答"这单出没出码、兑换了没有"，所以按批次一次取回，
    // 而不是让前端为每一单再发一次请求。
    async listKeysByBatches(batchIds) {
      if (!batchIds.length) return [];
      return many(table('keys').select(COLUMNS.keys).in('batch_id', batchIds).limit(500), 'keys_read_failed');
    },
    // 停用账号要把发给他的那几单里没兑换的码一起冻上，恢复时原样解冻。
    // 认的是 batch_id（码是哪一单发出去的），不做备注模糊匹配 —— 误冻别人的码比冻不到更糟。
    async setKeysStatusInBatches({ batchIds, from, to }) {
      if (!batchIds.length) return 0;
      const rows = await many(
        table('keys').select('id').in('batch_id', batchIds).eq('status', from).limit(500),
        'keys_read_failed',
      );
      if (!rows.length) return 0;
      await mutate(
        table('keys').update({ status: to }).in('id', rows.map((row) => row.id)),
        'id', 'key_status_failed',
      );
      return rows.length;
    },

    // --------------------------------------------------------------- videos
    async listVideos({ onlyPublished = true, offset, limit, kind } = {}) {
      const page = rangeParams(offset, limit);
      let query = table('videos').select(COLUMNS.videos);
      if (onlyPublished) query = query.eq('status', 'published');
      // Rows written before migration 0002 carry no kind at all, and the platform's DDL
      // forbade a DEFAULT, so "真实教学" has to match NULL too — filtering on eq alone would
      // show the owner an empty tab for the videos he uploaded first.
      if (kind === 'anime') query = query.eq('kind', 'anime');
      else if (kind === 'live') query = query.or('kind.eq.live,kind.is.null');
      // 买家那一份仍按"最近发布"倒序；后台那一份改成按"最新入库"倒序。
      // 草稿的 published_at 是空的，按 published_at 排会被 NULLS LAST 挤到列表最底下——
      // 站长传完新片要在第一屏改时长、挂封面、发布，翻到最后找不到就是他说的"新视频应该在管理的最上方"。
      const ordered = onlyPublished
        ? query.order('published_at', { ascending: false }).order('id', { ascending: false })
        : query.order('created_at', { ascending: false }).order('id', { ascending: false });
      const rows = await many(
        ordered.range(page.first, page.last),
        'videos_read_failed',
      );
      const out = [];
      for (const row of rows) out.push({ ...row, authentic: await videoAccessIsAuthentic(secret, row) });
      return paginate(out, page);
    },
    async findVideo(id) {
      const row = await one(table('videos').select(COLUMNS.videos).eq('id', id).maybeSingle(), 'video_read_failed');
      return row ? { ...row, authentic: await videoAccessIsAuthentic(secret, row) } : null;
    },
    async createVideo(record) {
      return create(table('videos'), { ...record, access_signature: await videoAccessSignature(secret, record) }, COLUMNS.videos, 'video_create_failed');
    },
    async updateVideo(id, patch, reaccess = false, expectedStatus) {
      const next = { ...patch, updated_at: isoNow() };
      if (reaccess) {
        const current = await one(table('videos').select(COLUMNS.videos).eq('id', id).maybeSingle(), 'video_read_failed');
        if (!current) return null;
        next.access_signature = await videoAccessSignature(secret, { ...current, ...next });
      }
      let query = table('videos').update(next).eq('id', id);
      if (expectedStatus !== undefined) query = query.eq('status', expectedStatus);
      return mutate(query, COLUMNS.videos, 'video_write_failed');
    },
    async deleteVideo(id) {
      return mutate(table('videos').delete().eq('id', id), 'id', 'video_delete_failed');
    },

    // ------------------------------------------------------------- requests
    async createRequest(record) {
      return create(table('requests'), record, COLUMNS.requests, 'request_write_failed');
    },
    async listRequests({ offset, limit, status }) {
      const page = rangeParams(offset, limit);
      let query = table('requests').select(COLUMNS.requests);
      if (status) query = query.eq('status', status);
      const rows = await many(query.order('created_at', { ascending: false }).range(page.first, page.last), 'requests_read_failed');
      return paginate(rows, page);
    },
    async findRequest(id) {
      return one(table('requests').select(COLUMNS.requests).eq('id', id).maybeSingle(), 'request_read_failed');
    },
    async findRequestsByIds(ids) {
      if (ids.length === 0) return [];
      // 日志只需要知道"这一单是谁的"，所以只取这两列。
      return many(table('requests').select('id,email').in('id', ids).limit(500), 'requests_read_failed');
    },
    async updateRequest(id, patch) {
      return mutate(table('requests').update({ ...patch, updated_at: isoNow() }).eq('id', id), COLUMNS.requests, 'request_write_failed');
    },
    async requestsByEmail(email) {
      return many(table('requests').select(COLUMNS.requests).eq('email', email).limit(200), 'requests_read_failed');
    },
    // 「给这一单出的码」就是这一批：绑定之后，停用一个账号才知道该冻哪几枚码。
    async setRequestBatch(id, batchId) {
      return mutate(
        table('requests').update({ batch_id: batchId, updated_at: isoNow() }).eq('id', id),
        COLUMNS.requests, 'request_write_failed',
      );
    },

    // ------------------------------------------------------------- settings
    async readLessonSeries() {
      const row = await one(table('settings').select(COLUMNS.settings).eq('config_key', LESSON_SERIES_KEY).maybeSingle(), 'lesson_series_read_failed');
      if (!row) return { value:null, row:null };
      if (!await lessonSeriesIsAuthentic(secret,row.value,row.signature)) throw new DataError('lesson_series_tampered');
      return { value:row.value, row };
    },
    async writeLessonSeries(value,expectedSignature) {
      const payload={config_key:LESSON_SERIES_KEY,value,updated_at:isoNow(),signature:await lessonSeriesSignature(secret,value)};
      if (expectedSignature !== null) return mutate(table('settings').update(payload).eq('config_key',LESSON_SERIES_KEY).eq('signature',expectedSignature), COLUMNS.settings,'lesson_series_write_failed');
      try { return await create(table('settings'),{id:randomId(),...payload},COLUMNS.settings,'lesson_series_write_failed'); }
      catch(error) { if(error instanceof DataError && error.detail==='23505') throw new DataError('lesson_series_conflict'); throw error; }
    },
    async readCatalogOrder() {
      const row = await one(table('settings').select(COLUMNS.settings).eq('config_key', CATALOG_ORDER_KEY).maybeSingle(), 'catalog_order_read_failed');
      if (!row) return { value: null, row: null };
      if (!(await catalogOrderIsAuthentic(secret, row.value, row.signature))) throw new DataError('catalog_order_tampered');
      return { value: row.value, row };
    },
    async writeCatalogOrder(value, expectedSignature) {
      const payload = { config_key: CATALOG_ORDER_KEY, value, updated_at: isoNow(), signature: await catalogOrderSignature(secret, value) };
      if (expectedSignature !== null) {
        return mutate(table('settings').update(payload).eq('config_key', CATALOG_ORDER_KEY).eq('signature', expectedSignature), COLUMNS.settings, 'catalog_order_write_failed');
      }
      // config_key is UNIQUE in the existing schema. Two first saves cannot both
      // create an ordering row; turn that known refusal into the same CAS conflict.
      try {
        return await create(table('settings'), { id: randomId(), ...payload }, COLUMNS.settings, 'catalog_order_write_failed');
      } catch (error) {
        if (error instanceof DataError && error.detail === '23505') throw new DataError('catalog_order_conflict');
        throw error;
      }
    },
    async readSettings() {
      const row = await settingRow();
      if (!row) return { values: normalizeSettings(null), authentic: true, row: null };
      const values = normalizeSettings(row.value);
      const authentic = row.signature ? await settingsIsAuthentic(secret, values, row.signature) : false;
      return { values, authentic, row };
    },
    async writeSettings(values) {
      const signature = await settingsSignature(secret, values);
      const row = await settingRow();
      const payload = { config_key: 'site', value: values, updated_at: isoNow(), signature };
      if (row) {
        return mutate(table('settings').update(payload).eq('id', row.id), COLUMNS.settings, 'settings_write_failed');
      }
      return create(table('settings'), { id: randomId(), ...payload }, COLUMNS.settings, 'settings_write_failed');
    },

    // ------------------------------------------------------------ watch log
    async findWatchLog({ userId, videoId, sessionId }) {
      // Newest row wins rather than `maybeSingle`, which answers PGRST116 when two rows
      // match: heartbeats can interleave before either writes, and a duplicate row must
      // not break progress reporting for that session forever.
      const rows = await many(
        table('watch_logs').select(COLUMNS.watch_logs).eq('user_id', userId).eq('video_id', videoId)
          .eq('session_id', sessionId).order('updated_at', { ascending: false }).limit(1),
        'watch_log_read_failed',
      );
      return rows[0] ?? null;
    },
    // One page-worth of positions for the whole library grid: rows come back newest first
    // and the caller keeps the first one per video.
    async watchPositions({ userId, videoIds }) {
      const ids = (videoIds ?? []).filter(isUuid);
      if (!ids.length) return [];
      return many(
        table('watch_logs').select(COLUMNS.watch_logs).eq('user_id', userId).in('video_id', ids)
          .order('updated_at', { ascending: false }).limit(500),
        'watch_log_read_failed',
      );
    },
    async createWatchLog(record) {
      return create(table('watch_logs'), record, COLUMNS.watch_logs, 'watch_log_write_failed');
    },
    // Resume reads across sessions: a member starts a lesson on the PC and finishes it on
    // the phone, so the last position has to survive the device that wrote it.
    async latestWatchPosition({ userId, videoId }) {
      const rows = await many(
        table('watch_logs').select(COLUMNS.watch_logs).eq('user_id', userId).eq('video_id', videoId)
          .order('updated_at', { ascending: false }).limit(1),
        'watch_log_read_failed',
      );
      return rows[0] ?? null;
    },
    // Only progress columns move: the primary key is never rewritten by an upsert.
    async advanceWatchLog(id, { positionSeconds, accessMode }) {
      return mutate(
        table('watch_logs').update({ position_seconds: positionSeconds, access_mode: accessMode, updated_at: isoNow() }).eq('id', id),
        COLUMNS.watch_logs, 'watch_log_write_failed',
      );
    },
    async listWatchLogs(videoId, limit = 200) {
      return many(
        table('watch_logs').select(COLUMNS.watch_logs)
          .eq('video_id', videoId).order('updated_at', { ascending: false }).limit(limit),
        'watch_logs_read_failed',
      );
    },
    // 站长从"这个人"这一侧反查他看过什么：一台片一部地翻「谁在看」在纠纷里按不动。
    // 行数会随人和设备增长（每人每片每台设备一行），所以这一张要能翻页，取满不许默默截断。
    async listWatchLogsForUser(userId, limit = 200, { before = null, beforeId = null } = {}) {
      const rawStamp = String(before ?? '');
      const stamp = /^[\d-]{10}T[\d:.]{8,12}(Z|[+-]\d{2}:\d{2})$/.test(rawStamp)
        && Number.isFinite(Date.parse(rawStamp)) ? new Date(Date.parse(rawStamp)).toISOString() : null;
      const cursorId = isUuid(beforeId ?? '') ? String(beforeId) : null;
      let query = table('watch_logs').select(COLUMNS.watch_logs).eq('user_id', userId);
      if (stamp && cursorId) {
        query = query.or(`updated_at.lt.${stamp},and(updated_at.eq.${stamp},id.lt.${cursorId})`);
      } else if (stamp) {
        query = query.lt('updated_at', stamp);
      }
      const rows = await many(
        query.order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1),
        'watch_logs_read_failed',
      );
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    // ---------------------------------------------------------------- audit
    async audit({ actorId, action, target, ipPrefix, detail }) {
      // detail 原样存（对象就存对象）：后台「操作日志」那一屏是按动作读它的结构的
      // （`detail.days`、`detail.count`…），在这儿拍平成一串 "k v · k v" 反而让界面读不出数 ——
      // 库里实测过：105 行对象 detail 都存得好好的，磁盘store 不挑类型。
      // 需要纯文本的那个消费方（「用户行为」的详情列）自己在读的时候格式化。
      return create(table('audit'), {
        id: randomId(), actor_id: actorId ?? null, action, target: target ?? null,
        ip_prefix: ipPrefix ?? null, created_at: isoNow(), detail: detail ?? null,
      }, 'id', 'audit_write_failed');
    },
    async countAuditSince({ action, ipPrefix, userId, sinceIso }) {
      let query = table('audit').select('id').eq('action', action);
      if (ipPrefix) query = query.eq('ip_prefix', ipPrefix);
      if (userId) query = query.eq('actor_id', userId);
      const rows = await many(query.gt('created_at', sinceIso).limit(200), 'audit_count_failed');
      return rows.length;
    },
    // 游标是 (created_at, id) 两个值：只用时间戳会在同一毫秒的多行上漏行或重行。
    // 两个值都要先过格式校验才拼进 or() —— PostgREST 的过滤串是拼出来的，
    // 不校验就等于把查询条件交给请求方。
    // 仪表盘一次要读"这段时间里谁干了什么"：分组与计数在服务层做完再回给界面，
    // 不让前端拉全表自己拼（拉全表既慢，又会把不相干的行暴露给只有看的人）。
    // `before`/`beforeId` 和 recentAudit 用的是同一对游标、同一套格式校验：
    // 案头按 400 天读，而这里一次最多回 3000 行 —— 库里现在每天两百多行，
    // 只取一页的话案头印着"近 400 天"、实际只看得到最近两周，更早撞线的记录会静消失。
    async auditSince({ sinceIso, limit = 3000 }) {
      return many(
        table('audit').select(COLUMNS.audit).gt('created_at', sinceIso)
          .order('created_at', { ascending: false }).limit(limit),
        'audit_board_read_failed',
      );
    },
    // 接着上面那一页往后翻：游标是 (created_at, id) 两个值，只用时间戳会在同一毫秒的多行上
    // 漏行或重行；两个值都要先过格式校验才拼进 or()（和 recentAudit 同一条），不校验等于把
    // 查询条件交给请求方。返回空数组代表"这一页没有更多了或游标不对"，调用方据此收尾。
    async auditSincePage({ sinceIso, before, beforeId, limit = 3000 }) {
      const rawStamp = String(before ?? '');
      const stamp = /^[\d-]{10}T[\d:.]{8,12}(Z|[+-]\d{2}:\d{2})$/.test(rawStamp)
        && Number.isFinite(Date.parse(rawStamp)) ? new Date(Date.parse(rawStamp)).toISOString() : null;
      const cursorId = isUuid(beforeId ?? '') ? String(beforeId) : null;
      if (!stamp || !cursorId) return [];
      return many(
        table('audit').select(COLUMNS.audit).gt('created_at', sinceIso)
          .or(`created_at.lt.${stamp},and(created_at.eq.${stamp},id.lt.${cursorId})`)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit),
        'audit_board_read_failed',
      );
    },
    // 按人反查"这段时间真的在看哪些条"要从 watch_logs 出发：audit 里只有被闸门拦下的动作，
    // 一个正常看完十条片的人在那张表里一条都没有，照 audit 统计会把最活跃的买家统计成没来。
    async watchSince({ sinceIso, limit = 5000 }) {
      return many(
        table('watch_logs').select(COLUMNS.watch_logs).gt('updated_at', sinceIso)
          .order('updated_at', { ascending: false }).limit(limit),
        'watch_board_read_failed',
      );
    },
    async recentAudit(limit = 100, { before = null, beforeId = null } = {}) {
      // 回读到的 timestamptz 是 `…+00:00` 而不是写入时的 `…Z`，所以这里既校验格式、也把它
      // 归一成 UTC 的 ISO 串：直接拿人家给的形态去比，同一时刻都会比出两种结果。
      const rawStamp = String(before ?? '');
      const stamp = /^[\d-]{10}T[\d:.]{8,12}(Z|[+-]\d{2}:\d{2})$/.test(rawStamp)
        && Number.isFinite(Date.parse(rawStamp)) ? new Date(Date.parse(rawStamp)).toISOString() : null;
      const cursorId = isUuid(beforeId ?? '') ? String(beforeId) : null;
      let query = table('audit').select(COLUMNS.audit);
      if (stamp && cursorId) {
        query = query.or(`created_at.lt.${stamp},and(created_at.eq.${stamp},id.lt.${cursorId})`);
      } else if (stamp) {
        query = query.lt('created_at', stamp);
      }
      const rows = await many(
        query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1),
        'audit_read_failed',
      );
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },
  };
}
