// 后台「用户行为」那一屏的数据层。
//
// 为什么在服务层算完再回给界面：这块要的是"这个号今天看了哪几条、实际在哪一档、有没有像在整片拖"，
// 判断条件（95% 字节 / 快过 4 倍速 / 第三路 / 这一分钟传输量到顶）全都住在 media.mjs 那一道闸上。
// 让前端自己拉全表再拼一遍，等于把同一套判据抄第二份 —— 这一类"抄两份必漂"的缺陷站内已经犯过几次。
//
// 数据来源只有两张已有的表：
//   audit      —— 被闸门拦下的动作 + 观众自己点的档位（noteBehavior 写进去的那些）
//   watch_logs —— 每 30 秒一次的进度心跳，"谁真的在看"只有这张表认得
// 只按 audit 统计会把一个正常看完十条片的人算成"没来"：他一条闸都没撞过，那本来就是好事。

import { behaviorRules, listHlsRenditions, PROGRESS_SLACK_SECONDS, WATCHED_SHARE } from './media.mjs';

const DOWNLOAD_FLAGS = {
  media_bulk_grab: '拖片判定掐住',
  media_bulk_partial: '大半被取走、快过正常看（只记录，没掐）',
  media_library_sweep: '短时间搬走半站（只记录，没掐）',
  media_wholefile_denied: '想整片拿被拒',
  media_preview_overrun: '试看越界取段',
  media_stream_cap: '同账号第三路',
  media_byte_budget: '这一分钟传输量到顶（不是当天）',
};
const VIEW_FLAGS = {
  viewer_quality_pick: '自己点了档位',
  viewer_quality_failed: '点了档位没换成',
  viewer_auto_boost: '按速度替他抬了档',
  viewer_auto_release: '缓冲跟不上，替他退回自动',
  viewer_rendition: '屏幕实际画质',
  viewer_frag_rate: '实测取段速度',
};
// 卡顿不是"下载类"，但它是站长最早发现线路/码率不对的那个信号（他原话是"5 秒卡一次"）。
const STALL_FLAGS = { viewer_stall: '这一阵卡过' };
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- 违规案头
// 案头和上面那些标签是两件事：上面回答"播放得怎么样"，案头回答"该处理谁、处理到哪一步了"。
// 所以案头**不跟着界面上那个 days 走** —— 判据只按窗口取行，30 天一过撞线记录就不进计算了，
// 站长处理到一半的案子会自己从后台消失（这一类"第二天失忆"的缺陷站内已经吃过几次）。
const CASE_GATE = {
  media_bulk_grab: { label: '整条视频被拖走（已掐断）', severity: 'high' },
  media_library_sweep: { label: '短时间内搬走多条视频', severity: 'high' },
  media_stream_cap: { label: '同一个账号同时开第三路播放', severity: 'high' },
  media_bulk_partial: { label: '一次取走大半条，比正常看快', severity: 'mid' },
  // 同一个人同一条片 24 小时内第二次越上面那条线，服务端就不只是记账了，直接掐（站长 2026-10-17 定的）。
  // 这是另一件事，所以是另一个动作码：severity 不能靠读 detail 里那句中文来判断。
  media_partial_cut: { label: '大半条被取走两次，第二下已掐断', severity: 'high' },
  media_wholefile_denied: { label: '想下载整条视频被拦下', severity: 'mid' },
  media_preview_overrun: { label: '试看时取走了付费部分', severity: 'mid' },
  media_byte_budget: { label: '一分钟内传输量到顶', severity: 'low' },
};
// 400 天 ≈ 这个站有记录以来的全部。案头要的是"还有没结案的没有"，不是流水条数。
const CASE_LOOKBACK_MS = 400 * DAY_MS;
// 账号共用：同一账号几个网段、且会话时间真的重叠才算。只看"网段不同"会把出差和家里 WiFi 判成共用。
const SHARE_MIN_NETBLOCKS = 2;
// 试码与登录这两类按"一个短窗口内重复几次"算，一次输错不算违规。
const KEY_PROBE_MIN = 3;
const KEY_PROBE_WINDOW_MS = 10 * 60_000;
const LOGIN_BRUTE_MIN = 5;
const LOGIN_BRUTE_WINDOW_MS = 60 * 60_000;
// 测试号（后台自己造的、验证用的）与站长自己的管理员号都不算买家违规，单独一栏摆着，
// 不藏起来：它们照样要看得见，只是不混进"待处理"里。
const TEST_EMAIL_SUFFIX = '@example.com';
const SEVERITY_RANK = { high: 0, mid: 1, low: 2 };

const shortId = (value) => String(value ?? '').slice(0, 8);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value ?? ''));

// 行为明细那一列要的是一行字，而库里有些动作的 detail 存的是结构（`{count: 4}` 那种）。
// 直接 String(对象) 会得到 "[object Object]" —— 那一列就白印了，所以在读的时候拼成人能读的一句。
// 「操作日志」那一屏按动作读结构、说得更准，这里只是这张表的兜底写法。
const detailText = (value) => {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
};

// 一张行表按人起账；Set 只在这一层用，回给界面之前一律换成数组（JSON 里没有 Set）。
function newPerson(id) {
  return {
    userId: id, perVideo: new Map(), flags: {}, picks: 0, renditions: new Set(),
    stallEvents: 0, stallNote: '',
    flagEvents: 0, lastSeenAt: '', fullViews: 0, previewViews: 0, email: '', displayName: '',
    tierRank: 0, expiresAt: '',
  };
}

// 案头的一案 = 一个主体 × 一类行为。纯函数，不碰数据库：单测和变异验证都只测这一层。
// 输入都是已经读出来的行，输出分三栏：待处理 / 自家与测试 / 已处理。
export function buildCases({ auditRows = [], sessionRows = [], users = [], memberships = [], titleOf = new Map(), adminEmails = [], selfNetblocks = [] } = {}) {
  const nowIso = new Date().toISOString();
  const userById = new Map(users.map((u) => [u.id, u]));
  // 等级只看当前有效的那张（撤销的、过期的都不算）—— 和「按人看」同一把尺。
  const rankOf = new Map();
  for (const m of memberships) {
    if (m.revoked_at || (m.expires_at && m.expires_at < nowIso)) continue;
    const rank = Number(m.tier_rank) || 0;
    if (rank > (rankOf.get(m.user_id) ?? 0)) rankOf.set(m.user_id, rank);
  }
  const cases = new Map();
  const touch = (key, seed, row) => {
    let c = cases.get(key);
    // accountIds：这一条案子里出现过的账号。按网段起账的那两类必须数得出来有几个账号，
    // 因为一个 /24 常常是整栋楼共用出口，"网段在试密码"与"某个账号在试密码"是两件事。
    if (!c) { c = { key, videos: new Map(), accountIds: new Set(), count: 0, lastAt: '', firstAt: '', detail: '', ...seed }; cases.set(key, c); }
    if (row.actor_id) c.accountIds.add(row.actor_id);
    c.count += 1;
    if (!c.firstAt || row.created_at < c.firstAt) c.firstAt = row.created_at;
    if (row.created_at >= c.lastAt) { c.lastAt = row.created_at; c.detail = detailText(row.detail); }
    if (isUuid(row.target)) c.videos.set(row.target, (c.videos.get(row.target) ?? 0) + 1);
    return c;
  };

  // 1) 撞过播放闸门的：判据那句活原样从闸门那边带过来，界面上不重写一遍。
  for (const row of auditRows) {
    const meta = CASE_GATE[row.action];
    if (!meta) continue;
    const subject = row.actor_id ? `u:${row.actor_id}` : `ip:${row.ip_prefix || '未知网段'}`;
    const c = touch(`gate:${row.action}:${subject}`, {
      kind: 'gate', action: row.action, label: meta.label, severity: meta.severity,
      userId: row.actor_id ?? '', ipPrefix: row.ip_prefix ?? '',
    }, row);
    if (!c.ipPrefix && row.ip_prefix) c.ipPrefix = row.ip_prefix;
  }

  // 2) 同一个账号在几个地方同时在线：网段不同**且**会话时间真的重叠才算。
  //    只看"出现过两个网段"会把出差、换 5G、家里换路由器都判成共用 —— 那是冤枉人。
  const byUser = new Map();
  for (const s of sessionRows) {
    if (!s.user_id) continue;
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  for (const [userId, list] of byUser) {
    const prefixes = [...new Set(list.map((s) => s.ip_prefix).filter(Boolean))];
    if (prefixes.length < SHARE_MIN_NETBLOCKS) continue;
    let overlapMs = 0;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (!a.ip_prefix || !b.ip_prefix || a.ip_prefix === b.ip_prefix) continue;
        const span = Math.min(Date.parse(a.last_seen_at || a.created_at), Date.parse(b.last_seen_at || b.created_at))
          - Math.max(Date.parse(a.created_at), Date.parse(b.created_at));
        if (span > overlapMs) overlapMs = span;
      }
    }
    if (overlapMs <= 0) continue;
    const kernels = new Set(list.map((s) => String(s.ua_hash ?? '').slice(0, 8)).filter(Boolean));
    const last = list.reduce((m, s) => (String(s.last_seen_at ?? '') > m ? String(s.last_seen_at) : m), '');
    const first = list.reduce((m, s) => (!m || s.created_at < m ? s.created_at : m), '');
    cases.set(`share:${userId}`, {
      key: `share:${userId}`, kind: 'sharing', label: '同一个账号在几个地方同时在线',
      severity: 'high', userId, ipPrefix: prefixes.join(' '), videos: new Map(), count: list.length,
      firstAt: first, lastAt: last,
      detail: `${prefixes.length} 个网段（${prefixes.join('、')}）的会话时间重叠 ${Math.round(overlapMs / 60_000)} 分钟，${kernels.size || '?'} 种浏览器内核`,
      devices: list.map((s) => s.device_label || '未记设备'),
    });
  }

  // 3) 短窗口内重复的试码 / 登录失败：一次输错不算违规，所以要按窗口起账。
  const asc = (rows) => [...rows].sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1));
  const cluster = (rows, windowMs, min) => {
    const runs = [];
    let run = [];
    for (const row of rows) {
      if (run.length && Date.parse(row.created_at) - Date.parse(run[0].created_at) > windowMs) run = [];
      run.push(row);
      if (run.length === min) runs.push(run);
      else if (run.length > min) runs[runs.length - 1].push(row);
    }
    return runs;
  };
  for (const run of cluster(asc(auditRows.filter((r) => r.action === 'redeem_fail' && r.actor_id)), KEY_PROBE_WINDOW_MS, KEY_PROBE_MIN)) {
    const userId = run[0].actor_id;
    for (const row of run) {
      touch(`keyprobe:${userId}`, {
        kind: 'keyprobe', action: 'redeem_fail', label: '短时间内反复输错激活码', severity: 'mid',
        userId, ipPrefix: row.ip_prefix ?? '',
      }, row);
    }
  }
  for (const run of cluster(asc(auditRows.filter((r) => r.action === 'login_fail' && r.ip_prefix)), LOGIN_BRUTE_WINDOW_MS, LOGIN_BRUTE_MIN)) {
    const ip = run[0].ip_prefix;
    for (const row of run) {
      touch(`brute:${ip}`, {
        kind: 'loginbrute', action: 'login_fail', label: '同一个 IP 前缀反复登录不成功', severity: 'mid',
        userId: row.actor_id ?? '', ipPrefix: ip,
      }, row);
    }
  }

  // 4) 结案状态：站长点过的「已看过／已处理」是 audit 里的 admin_case_ack 行，重启不丢。
  //    结完案又撞了一次线，案子要自己回到"待处理"（并说明是重新撞的），不能悄悄少一条。
  const ackByKey = new Map();
  for (const row of asc(auditRows.filter((r) => r.action === 'admin_case_ack' && r.target))) {
    const note = row.detail && typeof row.detail === 'object' ? row.detail : {};
    ackByKey.set(row.target, { at: row.created_at, by: row.actor_id ?? '', status: note.status === 'done' ? 'done' : 'seen', note: String(note.note ?? '') });
  }

  const list = [];
  for (const c of cases.values()) {
    const ids = c.accountIds?.size ? [...c.accountIds] : (c.userId ? [c.userId] : []);
    const isOwnId = (id) => {
      const u = userById.get(id);
      const e = u?.email ?? '';
      return Boolean(e) && (adminEmails.includes(e) || e.endsWith(TEST_EMAIL_SUFFIX));
    };
    const ownIds = ids.filter(isOwnId);
    // 一个账号都对不上（纯匿名）时不算"自家"，照旧进待处理；只要掺着一个外人账号就不算自家。
    const own = ids.length > 0 && ownIds.length === ids.length;
    // 按网段起的账，多个账号时不把第一个人的邮箱钉在案子上当嫌疑人：那一栏会印「匿名 <网段>」，
    // 具体几个账号、几个是自己人，写在下面那句话里。
    const singleId = ids.length === 1 ? ids[0] : '';
    const user = singleId ? userById.get(singleId) : null;
    const email = user?.email ?? '';
    const ack = ackByKey.get(c.key) ?? null;
    const state = !ack ? 'open' : (ack.at >= c.lastAt ? 'closed' : 'reopened');
    let detail = c.detail;
    if (!detail) {
      // `login_fail`／`redeem_fail` 这些行本身没有闸门那句判据，界面上就会剩一格空白，
      // 站长读到像"这条案子没告诉我为何在这儿"。这句只数已经在这条案子手上的东西，
      // 阈值那几个字仍只在 thresholds 那一处（不在每一行重抄一遍）。
      const spanMin = Math.max(0, Math.round((Date.parse(c.lastAt) - Date.parse(c.firstAt)) / 60_000));
      detail = c.count > 1 ? `${c.count} 次，前后跨 ${spanMin} 分钟` : '只有这一笔';
    }
    if (ids.length && (c.kind === 'loginbrute' || c.key.includes(':ip:'))) {
      // login_fail 那些行本身没有判据句，直接从"；"起头会在界面上留一个孤零零的分号。
      const sep = detail ? '；' : '';
      detail = `${detail}${sep}这个 IP 前缀下有 ${ids.length} 个账号试过（其中 ${ownIds.length} 个是站长自己的号或测试号）`;
      if (ids.length > 1) detail = `${detail}；同一栋楼常常共用一个网络出口，账号多时更像各人输错自己的`;
    }
    // 这台机器自己也会撞上闸门（取片脚本、验收工具走的是本站域名的 hairpin NAT，源地址就是本站公网 IP）。
    // 只加一句"这是本站自己的出口"，行数一条不减：/24 是机房整段，隔壁客户的扫描器也在这一段里，
    // 按网段把它归进「自家与测试」等于给邻居开后门。名单来自 SELFHOST_SELF_NETBLOCKS，不设就什么都不标。
    const selfExit = Boolean(c.ipPrefix) && selfNetblocks.includes(c.ipPrefix);
    if (selfExit) detail = `${detail}（这一条是网站自己服务器上的操作，IP ${c.ipPrefix}，通常是站内的取片脚本或验收工具，不是买家）`;
    list.push({
      key: c.key, kind: c.kind, action: c.action, label: c.label, severity: c.severity,
      userId: singleId ?? '',
      email: email || '', displayName: user?.display_name ?? '', ipPrefix: c.ipPrefix || '',
      tierRank: singleId ? (rankOf.get(singleId) ?? 0) : 0,
      disabledAt: user?.disabled_at ?? '', note: user?.note ?? '',
      admin: Boolean(email && adminEmails.includes(email)), own,
      selfExit,
      accountCount: ids.length, ownAccountCount: ownIds.length,
      count: c.count, firstAt: c.firstAt, lastAt: c.lastAt, detail,
      devices: c.devices ?? [],
      videos: [...c.videos.entries()].map(([id, n]) => ({ videoId: shortId(id), title: titleOf.get(id) ?? '（这条已删或在回收站）', times: n })),
      state, ackAt: ack?.at ?? '', ackStatus: ack?.status ?? '',
    });
  }
  const order = (a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    || (a.lastAt < b.lastAt ? 1 : -1);
  // 台面上只放高风险（站长 2026-10-17 要求"只提示高风险的事情"）；中/低折成一行摆在下面。
  // 折起来不等于删：他最初那句"保留在仪表盘上"是硬要求，一条都不许多或更少。
  const pending = list.filter((c) => !c.own && c.state !== 'closed').sort(order);
  const open = pending.filter((c) => c.severity === 'high');
  const minor = pending.filter((c) => c.severity !== 'high');
  const own = list.filter((c) => c.own).sort(order);
  const closed = list.filter((c) => !c.own && c.state === 'closed').sort(order);
  return { open, minor, own, closed };
}

// 站长点「已看过／已处理」：只在 audit 里落一行，不动会员权益、不建新表。
export async function ackCase(ctx, input = {}) {
  const key = String(input.key ?? '');
  if (!/^[\w:.-]{1,140}$/.test(key)) return { error: 'case_key_invalid' };
  const status = input.status === 'done' ? 'done' : 'seen';
  await ctx.store.audit({
    actorId: ctx.viewer?.id ?? null, action: 'admin_case_ack', target: key, ipPrefix: ctx.ip,
    detail: { status, note: String(input.note ?? '').slice(0, 120) },
  });
  return { ok: true, key, status };
}

const AUDIT_PAGE_ROWS = 3000;
const AUDIT_PAGE_MAX = 40;
// 顺着 (created_at, id) 游标往前翻，直到某页不满或读完 40 页。
// 返回 hitCeiling 而不是悄悄少几页：读到哪儿为止，站长有权知道。
async function readCaseAudit(ctx, sinceIso) {
  const rows = [];
  let cursor = null;
  let hitCeiling = false;
  for (let page = 0; page < AUDIT_PAGE_MAX; page += 1) {
    const part = page === 0
      ? await ctx.store.auditSince({ sinceIso, limit: AUDIT_PAGE_ROWS })
      : await ctx.store.auditSincePage({
        sinceIso, limit: AUDIT_PAGE_ROWS, before: cursor.created_at, beforeId: cursor.id,
      });
    rows.push(...part);
    if (part.length < AUDIT_PAGE_ROWS) return { rows, hitCeiling: false };
    cursor = { created_at: part[part.length - 1].created_at, id: part[part.length - 1].id };
    hitCeiling = page === AUDIT_PAGE_MAX - 1;
  }
  return { rows, hitCeiling };
}

export async function board(ctx, input = {}) {
  const requested = Number(input.days);
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : 7, 1), 90);
  const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();
  // 案头问的是"还有没有没结案的案子"，所以读全量；诊断那一半再按界面上那个 days 自己筛。
  // 一次读两遍不如一次读宽的再筛：auditSince 本来就是按时间倒序取，窗口内的行一定在前面。
  const caseSinceIso = new Date(Date.now() - CASE_LOOKBACK_MS).toISOString();
  const startedAt = new Date().toISOString();
  // 一页 3000 行，而库里现在每天两百多行：单页只够覆盖最近两周，案头却印着"近 400 天"。
  // 所以这里顺着游标把窗口读到底（有上限兜着，别让一次后台刷新把内存吃掉）。
  const { rows: auditAll, hitCeiling } = await readCaseAudit(ctx, caseSinceIso);
  const [watchRows, memberships, sessionRows] = await Promise.all([
    ctx.store.watchSince({ sinceIso }),
    ctx.store.listMembersWithPlans(500),
    ctx.store.listActiveSessions({ before: startedAt }),
  ]);
  const auditRows = auditAll.filter((row) => String(row.created_at ?? '') >= sinceIso);

  const people = new Map();
  const anonBuckets = new Map();
  const person = (id) => {
    if (!people.has(id)) people.set(id, newPerson(id));
    return people.get(id);
  };

  // 会员等级取当前有效那一张里最高的档；已经过期或签名不对的不算（那是回收站里的东西）。
  const nowIso = new Date().toISOString();
  for (const row of memberships) {
    if (row.verified === false || row.revoked_at) continue;
    if (row.expires_at && row.expires_at < nowIso) continue;
    const p = person(row.user_id);
    const rank = Number(row.tier_rank) || 0;
    if (rank >= p.tierRank && (!p.expiresAt || row.expires_at > p.expiresAt)) {
      p.tierRank = rank;
      p.expiresAt = row.expires_at ?? '';
    }
  }

  for (const row of watchRows) {
    const p = person(row.user_id);
    const videoId = row.video_id;
    if (!videoId) continue;
    const seconds = Number(row.position_seconds) || 0;
    const seen = p.perVideo.get(videoId);
    // 同一个 (人, 片) 只留最远那一次：进度是"绝对位置"不是增量，逐行相加会把一条片算成看了八遍。
    if (!seen || seconds > seen.position) p.perVideo.set(videoId, { position: seconds, at: row.updated_at });
    if (row.updated_at > p.lastSeenAt) p.lastSeenAt = row.updated_at;
    if (row.access_mode === 'full') p.fullViews += 1;
    else if (row.access_mode === 'preview') p.previewViews += 1;
  }

  const byAction = {};
  const videoTouch = new Map();
  const events = [];
  for (const row of auditRows) {
    byAction[row.action] = (byAction[row.action] ?? 0) + 1;
    const isDownload = Boolean(DOWNLOAD_FLAGS[row.action]);
    const isView = Boolean(VIEW_FLAGS[row.action]);
    const isStall = Boolean(STALL_FLAGS[row.action]);
    if (!isDownload && !isView && !isStall) continue;
    const detail = detailText(row.detail);
    if (row.actor_id) {
      const p = person(row.actor_id);
      if (isDownload) {
        p.flags[row.action] = (p.flags[row.action] ?? 0) + 1;
        p.flagEvents += 1;
      }
      if (row.action === 'viewer_quality_pick') p.picks += 1;
      if (isStall) { p.stallEvents += 1; p.stallNote = detail; }
      if (row.action === 'viewer_rendition') {
        const size = /(\d{3,4}x\d{3,4})/.exec(detail)?.[1];
        if (size) p.renditions.add(size);
      }
      if (row.created_at > p.lastSeenAt) p.lastSeenAt = row.created_at;
    } else {
      // 没登录的人只有网段前缀可认。单独一桶：他照样能把整片拖走，漏掉这一桶就是漏掉最常见的那种。
      const key = row.ip_prefix || '未知网段';
      const bucket = anonBuckets.get(key) ?? { ipPrefix: key, flags: {}, flagEvents: 0, stallEvents: 0, lastSeenAt: '' };
      if (isDownload) {
        bucket.flags[row.action] = (bucket.flags[row.action] ?? 0) + 1;
        bucket.flagEvents += 1;
      }
      if (isStall) bucket.stallEvents += 1;
      if (row.created_at > bucket.lastSeenAt) bucket.lastSeenAt = row.created_at;
      anonBuckets.set(key, bucket);
    }
    // target 只认片 id 那种形状。早先有一条上报把"没带片 id"写成了 '-'，照原样当 id 用会
    // 在「按片看」里长出一条叫「（这条已删或在回收站）」的假片 —— 写入侧已经修了，这里要能扛住旧行。
    const videoTarget = isUuid(row.target);
    if (videoTarget) {
      const v = videoTouch.get(row.target) ?? { videoId: row.target, flagEvents: 0, stallEvents: 0, renditions: new Map(), viewers: new Set() };
      if (isDownload) v.flagEvents += 1;
      if (isStall) v.stallEvents += 1;
      if (row.action === 'viewer_rendition') {
        // 按片记一份"屏幕上出现过哪些尺寸"：站长要问的是"这条片在慢线上有没有人降下去"，
        // 按人那一栏答不了这个问题。
        const size = /(\d{3,4}x\d{3,4})/.exec(detail)?.[1];
        if (size) v.renditions.set(size, (v.renditions.get(size) ?? 0) + 1);
      }
      if (row.actor_id) v.viewers.add(row.actor_id);
      videoTouch.set(row.target, v);
    }
    if (events.length < 80) {
      events.push({
        at: row.created_at, action: row.action,
        kind: isDownload ? 'download' : (isStall ? 'stall' : 'view'),
        label: DOWNLOAD_FLAGS[row.action] ?? STALL_FLAGS[row.action] ?? VIEW_FLAGS[row.action],
        detail: detail.slice(0, 120), videoId: videoTarget ? shortId(row.target) : '',
        who: row.actor_id ? 'member' : 'anon', ipPrefix: row.ip_prefix ?? '',
      });
    }
  }

  const videoIds = new Set();
  for (const p of people.values()) for (const id of p.perVideo.keys()) videoIds.add(id);
  for (const id of videoTouch.keys()) videoIds.add(id);
  // 案头那几行引用到的片也要有标题：窗口外的老案子不能因为没查标题就印成"这条已删"。
  for (const row of auditAll) if (CASE_GATE[row.action] && isUuid(row.target)) videoIds.add(row.target);
  const videoRows = videoIds.size ? await ctx.store.findVideosByIds([...videoIds]) : [];
  const titleOf = new Map(videoRows.map((v) => [v.id, v.title]));
  const durationOf = new Map(videoRows.map((v) => [v.id, Number(v.duration_seconds) || 0]));
  const editedOf = new Map(videoRows.map((v) => [v.id, String(v.updated_at ?? '')]));

  const userIds = [...people.keys()];
  // 案头的主体来自全量撞线行和会话表，比"这段时间活跃的人"宽：只查后者会让老案子印成"这个号不在了"。
  const caseUserIds = new Set(userIds);
  for (const row of auditAll) if (row.actor_id) caseUserIds.add(row.actor_id);
  for (const s of sessionRows) if (s.user_id) caseUserIds.add(s.user_id);
  const identities = caseUserIds.size ? await ctx.store.findUsersByIds([...caseUserIds].slice(0, 500)) : [];
  for (const user of identities) {
    const p = people.get(user.id);
    if (!p) continue;
    p.email = user.email ?? '';
    p.displayName = user.display_name ?? '';
    // 站长在后台给人写的备注是第一优先的身份标识：他记不住邮箱，但记得住"这是我给谁开的"。
    p.note = user.note ?? '';
    p.disabledAt = user.disabled_at ?? '';
  }

  const list = [...people.values()].map((p) => {
    const videos = [...p.perVideo.entries()].map(([id, seen]) => {
      const duration = durationOf.get(id) || 0;
      const editedAt = editedOf.get(id) ?? '';
      // 位置超过"闸门允许写进来的最远值"（片长 + PROGRESS_SLACK_SECONDS）才是真的对不上：
      // 片尾那两分钟的越界是播放器自己取整的正常结果，报成"数据坏了"就是狼来了。
      const impossible = duration > 0 && seen.position > duration + PROGRESS_SLACK_SECONDS;
      // 对不上有两种，动作完全相反：进度写在本次改动之前 = 这条记录属于旧版本（换过内容、切过条都会这样，
      // 不是片长写错，也不该照着现在的片长判"看完"）；写在改动之后 = 库里那个时长确实错了，要重探回写。
      const fromBeforeEdit = impossible && Boolean(editedAt) && Date.parse(seen.at) < Date.parse(editedAt);
      return {
        videoId: shortId(id), title: titleOf.get(id) ?? '（这条已删或在回收站）',
        positionSeconds: Math.round(seen.position),
        durationSeconds: duration,
        progressAt: seen.at, videoEditedAt: editedAt,
        durationLooksWrong: impossible,
        staleBeforeEdit: fromBeforeEdit,
        finished: duration > 0 && !impossible && seen.position >= duration * WATCHED_SHARE,
        lastAt: seen.at,
      };
    });
    const watched = videos.length;
    const finished = videos.filter((v) => v.finished).length;
    const furthest = videos.reduce((sum, v) => sum + v.positionSeconds, 0);
    return {
      userId: p.email ? p.userId : shortId(p.userId), email: p.email || '（这个号已经不在了）', note: p.note ?? '',
      displayName: p.displayName, tierRank: p.tierRank, expiresAt: p.expiresAt,
      disabledAt: p.disabledAt ?? '', lastSeenAt: p.lastSeenAt,
      videosWatched: watched, videosFinished: finished,
      watchedSeconds: furthest, minutesWatched: Math.round(furthest / 60),
      fullHeartbeats: p.fullViews, previewHeartbeats: p.previewViews,
      flags: p.flags, flagEvents: p.flagEvents, downloadSuspect: p.flagEvents > 0,
      stallEvents: p.stallEvents, stallNote: p.stallNote,
      qualityPicks: p.picks, renditions: [...p.renditions],
      videos: videos.sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1)),
    };
  }).sort((a, b) => b.flagEvents - a.flagEvents || b.stallEvents - a.stallEvents || b.minutesWatched - a.minutesWatched);

  const flaggedAnonymous = [...anonBuckets.values()]
    .filter((b) => b.flagEvents > 0 || b.stallEvents > 0)
    .sort((a, b) => b.flagEvents - a.flagEvents || b.stallEvents - a.stallEvents)
    .map((b) => ({
      ipPrefix: b.ipPrefix, flags: b.flags, flagEvents: b.flagEvents,
      stallEvents: b.stallEvents, lastSeenAt: b.lastSeenAt,
    }));

  // 位置大过闸门允许写进来的上限（这一轮实测：库里 300 秒，有人看到 874 秒）不能悄悄吃掉 ——
  // 库里那个时长一错，「看完」那条线（`WATCHED_SHARE` × 片长）就跟着算错，界面上的"看完几人"是假的。
  // 但两种对不上要分开列，因为站长的动作正好相反：
  // 进度写在本次改动之前，说明那是这条的旧版本（换成三段、重灌内容都会这样），该留档不该改数据；
  // 写在改动之后，才是库里那个 duration_seconds 真写错了，要重探一次再回写。
  const staleProgress = [];
  const durationWrong = [];
  for (const p of list) {
    for (const v of p.videos) {
      if (!v.durationLooksWrong) continue;
      const row = {
        email: p.email, videoId: v.videoId, title: v.title,
        positionSeconds: v.positionSeconds, storedDurationSeconds: v.durationSeconds,
        progressAt: v.progressAt, videoEditedAt: v.videoEditedAt,
      };
      (v.staleBeforeEdit ? staleProgress : durationWrong).push(row);
    }
  }

  // 「按片看」这一栏要答的是"哪条片在被整片拿、哪条片有人在卡、哪条片根本没得降"。
  // 档位那一列只给列出来的这几条查（一次文件存在性检查，不解密），不然 17 条要白查 34 次。
  const filmList = [...videoTouch.entries()]
    .map(([id, v]) => ({
      videoId: id, title: titleOf.get(id) ?? '（这条已删或在回收站）',
      flagEvents: v.flagEvents, stallEvents: v.stallEvents, viewersFlagged: v.viewers.size,
      renditions: [...v.renditions.entries()].sort((a, b) => b[1] - a[1])
        .map(([size, count]) => ({ size, count })),
    }))
    .sort((a, b) => (b.flagEvents + b.stallEvents) - (a.flagEvents + a.stallEvents) || b.viewersFlagged - a.viewersFlagged)
    .slice(0, 20);
  const videos = await Promise.all(filmList.map(async (row) => ({
    ...row,
    rungs: await listHlsRenditions(ctx, row.videoId).catch(() => null),
  })));

  // 案头单独起账：读的是全量撞线行，与上面那套按 days 的诊断互不影响。
  const caseDesk = buildCases({
    auditRows: auditAll, sessionRows, users: identities, memberships, titleOf,
    adminEmails: ctx.adminEmails ?? [],
    selfNetblocks: String(process.env.SELFHOST_SELF_NETBLOCKS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  });

  return {
    days, since: sinceIso, generatedAt: nowIso,
    totals: {
      peopleActive: list.filter((p) => p.lastSeenAt).length,
      peopleFlagged: list.filter((p) => p.downloadSuspect).length,
      downloadEvents: Object.keys(DOWNLOAD_FLAGS).reduce((sum, a) => sum + (byAction[a] ?? 0), 0),
      stallEvents: byAction.viewer_stall ?? 0,
      // 卡顿那条是设备侧脚本报上来的。这段时间一条都没有时，界面必须说"还没收到上报"，
      // 不能说成"没人卡" —— 把"没测到"写成"没问题"是这一类看板最贵的一种错。
      stallReported: (byAction.viewer_stall ?? 0) > 0,
      anonymousFlagged: flaggedAnonymous.length,
      watchRows: watchRows.length, auditRows: auditRows.length,
      // 取满上限的是"全量那次读"，不是窗口那次筛 —— 报错了对象，站长会以为窗口太小。
      truncatedByCap: watchRows.length >= 5000 || hitCeiling,
    },
    // 阈值原样从那道闸那边拿：站长看得见线画在哪儿，才谈得上改它。
    rules: behaviorRules(ctx),
    downloadLabels: DOWNLOAD_FLAGS,
    caseDesk: {
      ...caseDesk,
      lookbackDays: Math.round(CASE_LOOKBACK_MS / DAY_MS),
      thresholds: {
        shareNetblocks: SHARE_MIN_NETBLOCKS,
        keyProbeMin: KEY_PROBE_MIN, keyProbeWindowMinutes: KEY_PROBE_WINDOW_MS / 60_000,
        loginBruteMin: LOGIN_BRUTE_MIN, loginBruteWindowMinutes: LOGIN_BRUTE_WINDOW_MS / 60_000,
      },
    },
    people: list.slice(0, 200),
    anonymousFlagged: flaggedAnonymous,
    dataNotes: { staleProgress: staleProgress.slice(0, 40), durationWrong: durationWrong.slice(0, 40) },
    videos,
    events,
  };
}
