import { store } from './store.mjs';
import { DataError } from './db.mjs';
import { accountDirectory } from './account-directory.mjs';
import { readCookie, acceptsMutation, appendCookie } from './shared/cookies.mjs';
import { ipPrefix, csrfToken } from './shared/tokens.mjs';
import { isUuid, expiresAt } from './shared/util.mjs';
import { entitlement, setAccountEntitlement } from './entitlement.mjs';
import { decideAccess, normalizeSettings, yuanText } from './domain.mjs';
import * as accounts from './accounts.mjs';
import * as purchasing from './purchasing.mjs';
import * as catalog from './catalog.mjs';
import * as behavior from './behavior.mjs';
import * as media from './media.mjs';
import { RuntimeKeys } from './runtime-keys.mjs';
import * as migration from './migration.mjs';
import { MIGRATION_TOKEN } from './migration-token.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const PUBLIC_SETTINGS_KEYS = ['brand', 'brand_line', 'watermark_prefix', 'contact_qq', 'purchase_steps', 'promo_line', 'default_preview_seconds', 'max_active_sessions'];

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

// HEAD answers with the GET's status and headers and no body; the byte count stays in
// content-length, which is the whole reason a mobile player sends the probe first.
function headReply(request, response) {
  if (request.method !== 'HEAD') return response;
  return new Response(null, { status: response.status, headers: response.headers });
}

// 邮箱脱敏示例：仅显示部分字符。
function maskEmail(email) {
  const value = String(email ?? '');
  const at = value.indexOf('@');
  if (at < 1) return '';
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
}

const MESSAGE = {
  login_required: '请先登录。',
  admin_required: '这个操作只有管理账号可以做。',
};

async function readBody(request, limit = MAX_BODY_BYTES) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new DataError('body_type_invalid');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) throw new DataError('body_too_large');
  const raw = await request.text();
  if (raw.length > limit) throw new DataError('body_too_large');
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new DataError('body_invalid_json');
  }
}

// 排队这件事的四种拒绝理由，客户端各有专属文案；不映射的话它们一律折成 500「站点处理这个操作时出错了」，
// 站长既分不清"这条还没传完"和"队列满了"，日志里也只留下一行没有原因的 application failure
// （2026-10-17 15:30 那两次就是这样：挂封面后自动排队撞上了行状态还是 uploading）。
const PROCESSING_REFUSALS = ['video_not_found', 'video_not_ready', 'video_delete_pending', 'processing_queue_full'];
function asProcessingRefusal(error) {
  if (PROCESSING_REFUSALS.includes(error?.message)) throw new DataError(error.message);
  throw error;
}

const ROUTES = {
  boot: { method: 'GET', auth: 'any', run: (ctx, input) => ctx.boot(input) },
  plans: { method: 'GET', auth: 'any', run: (ctx) => ctx.plans() },
  library: { method: 'GET', auth: 'any', run: (ctx, input) => catalog.library(ctx, input) },
  'library-tabs': { method: 'GET', auth: 'any', run: (ctx, input) => catalog.libraryTabs(ctx, input) },
  'lesson-series': {method:'GET',auth:'any',run:ctx=>catalog.lessonSeries(ctx)},
  'lesson-series-detail': {method:'GET',auth:'any',run:(ctx,input)=>catalog.lessonSeriesDetail(ctx,input)},
  'admin-lesson-series': {method:'GET',auth:'admin',run:ctx=>catalog.adminLessonSeries(ctx)},
  'admin-lesson-series-save': {method:'POST',auth:'admin',maxBodyBytes:512*1024,run:(ctx,input)=>catalog.adminLessonSeriesSave(ctx,input)},
  play: { method: 'GET', auth: 'any', run: (ctx, input) => media.issuePlayToken(ctx, { videoId: input.v ?? input.videoId, fallback: input.fallback, quality: input.q }) },
  // 播放器在那台设备上到底播成什么样，我这边看不见手机 —— 这一条只往 journald 打一行。
  'play-report': { method: 'GET', auth: 'any', run: (ctx, input) => media.reportPlayback(ctx, input) },
  media: { method: 'GET', auth: 'any', raw: true, run: (ctx) => media.serveMedia(ctx) },
  poster: { method: 'GET', auth: 'any', raw: true, run: (ctx) => catalog.servePoster(ctx) },
  // 迁移用的两个口子。导出挂在 admin- 前缀上：备用站那一版构建按前缀整面删后台动作，
  // 导出口自然跟着消失，不会在只有观众的那一站上留一个能读全库的接口。
  'admin-export-rows': { method: 'GET', auth: 'admin', run: (ctx, input) => migration.exportRows(ctx, input) },
  // 灌数和核对不带 admin- 前缀（备用站上还没有任何账号，谈不上站长身份），靠构建里写死的一次性口令把关；
  // 主站那份 migration-token.mjs 是 null，这两个动作在主站上永远回 migration_disabled。
  'migration-import-rows': { method: 'POST', auth: 'any', maxBodyBytes: 2 * 1024 * 1024, run: (ctx, input) => migration.importRows(ctx, input) },
  'migration-count-rows': { method: 'POST', auth: 'any', run: (ctx, input) => migration.countRows(ctx, input) },
  // 灌字节：一条原始 POST 送一片密文进桶（raw 表示自己发 Response，不当 JSON 包一层）。
  'migration-object': { method: 'POST', auth: 'any', raw: true, run: (ctx) => migration.putIngestObject(ctx) },
  'migration-video-row': { method: 'POST', auth: 'any', maxBodyBytes: 256 * 1024, run: (ctx, input) => migration.putVideoRow(ctx, input) },
  register: {
    method: 'POST',
    auth: 'any',
    run: async (ctx, input) => {
      const { user } = await accounts.register(ctx, input);
      await ctx.keys.claimOwner(user.email);
      ctx.adminEmails = (await ctx.keys.load()).adminEmails;
      ctx.privileged = ctx.adminEmails.includes(String(user.email).toLowerCase());
      return accounts.createViewerSession(ctx, user);
    },
  },
  login: {
    method: 'POST',
    auth: 'any',
    run: async (ctx, input) => {
      const session = await accounts.login(ctx, input);
      // Ownership is claimed by whichever authenticated action happens first, so a
      // site left unpublished between the two actions cannot end up ownerless.
      if (session?.user) {
        await ctx.keys.claimOwner(session.user.email);
        ctx.adminEmails = (await ctx.keys.load()).adminEmails;
      }
      return session;
    },
  },
  logout: { method: 'POST', auth: 'login', run: (ctx) => accounts.logout(ctx, ctx.viewer) },
  'session-revoke': { method: 'POST', auth: 'login', run: (ctx, input) => accounts.revokeOwnSession(ctx, input) },
  account: { method: 'GET', auth: 'login', run: (ctx) => ctx.account() },
  'password-change': { method: 'POST', auth: 'login', run: (ctx, input) => accounts.changePassword(ctx, ctx.viewer, input) },
  redeem: { method: 'POST', auth: 'login', run: (ctx, input) => purchasing.redeemCode(ctx, input) },
  heartbeat: { method: 'POST', auth: 'login', run: (ctx, input) => media.reportProgress(ctx, input) },

  'admin-videos': { method: 'GET', auth: 'admin', run: (ctx, input) => catalog.adminVideos(ctx, input) },
  'admin-catalog-order': { method: 'GET', auth: 'admin', run: (ctx) => catalog.adminCatalogOrder(ctx) },
  'admin-catalog-order-save': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.adminCatalogOrderSave(ctx, input) },
  'admin-upload-start': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.startUpload(ctx, input) },
  'admin-upload-parts': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.uploadUrls(ctx, input) },
  'admin-upload-complete': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.completeUpload(ctx, input) },
  'admin-upload-abort': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.abortUpload(ctx, input) },
  'admin-processing': { method: 'GET', auth: 'admin', run: (ctx) => ctx.processing?.status() ?? { enabled: false, items: [] } },
  'admin-processing-retry': { method: 'POST', auth: 'admin', run: async (ctx, input) => {
    if (!ctx.processing) throw new DataError('processing_unavailable');
    return ctx.processing.enqueue(input.videoId, { retry: true }).catch(asProcessingRefusal);
  } },
  'admin-poster-generate': { method: 'POST', auth: 'admin', run: async (ctx, input) => {
    if (!ctx.processing) throw new DataError('processing_unavailable');
    return ctx.processing.enqueue(input.videoId, { retry: true, posterOnly: true }).catch(asProcessingRefusal);
  } },
  'admin-poster-frames': { method: 'GET', auth: 'admin', run: (ctx, input) => ctx.processing?.frames(input.v) ?? { state: 'missing', frames: [] } },
  'admin-poster-frame': { method: 'GET', auth: 'admin', raw: true, run: (ctx) => catalog.servePosterFrame(ctx) },
  'admin-poster': { method: 'GET', auth: 'admin', raw: true, run: (ctx) => catalog.servePoster(ctx, { admin: true }) },
  'admin-poster-url': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.posterUploadUrl(ctx, input) },
  'admin-poster-done': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.setPoster(ctx, input) },
  'admin-video-update': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.updateVideo(ctx, input) },
  'admin-video-delete': { method: 'POST', auth: 'admin', run: (ctx, input) => catalog.deleteVideo(ctx, input) },
  'admin-keys-create': { method: 'POST', auth: 'admin', run: (ctx, input) => purchasing.generateKeys(ctx, input) },
  'admin-keys': { method: 'GET', auth: 'admin', run: (ctx, input) => purchasing.listKeys(ctx, input) },
  'admin-key-revoke': { method: 'POST', auth: 'admin', run: (ctx, input) => purchasing.revokeKey(ctx, input.id) },
  'admin-key-restore': { method: 'POST', auth: 'admin', run: (ctx, input) => purchasing.restoreKey(ctx, input.id) },
  'admin-trash-counts': { method: 'GET', auth: 'admin', run: (ctx) => ctx.adminTrashCounts() },
  'admin-members': { method: 'GET', auth: 'admin', run: (ctx, input) => ctx.adminMembers(input) },
  'admin-accounts': { method: 'GET', auth: 'admin', run: (ctx, input) => accountDirectory(ctx, input) },
  'admin-user-reset-password': { method: 'POST', auth: 'admin', run: (ctx, input) => accounts.resetPasswordByAdmin(ctx, input) },
  'admin-admins': { method: 'GET', auth: 'admin', run: (ctx) => accounts.adminList(ctx) },
  'admin-admin-grant': { method: 'POST', auth: 'admin', run: (ctx, input) => accounts.grantAdmin(ctx, input) },
  'admin-admin-revoke': { method: 'POST', auth: 'admin', run: (ctx, input) => accounts.revokeAdmin(ctx, input) },
  'admin-account-entitlement': { method: 'POST', auth: 'admin', run: setAccountEntitlement },
  'admin-member-revoke': { method: 'POST', auth: 'admin', run: (ctx, input) => ctx.adminRevokeMembership(input.id) },
  'admin-member-restore': { method: 'POST', auth: 'admin', run: (ctx, input) => ctx.adminRestoreMembership(input.id) },
  'admin-member-adjust-days': { method: 'POST', auth: 'admin', run: (ctx, input) => purchasing.adjustMembershipDays(ctx, { id: input.id, days: input.days }) },
  'admin-user-disable': { method: 'POST', auth: 'admin', run: (ctx, input) => accounts.setAccountEnabled(ctx, { userId: input.userId, enabled: false }) },
  'admin-user-enable': { method: 'POST', auth: 'admin', run: (ctx, input) => accounts.setAccountEnabled(ctx, { userId: input.userId, enabled: true }) },
  'admin-user-note': { method: 'POST', auth: 'admin', run: (ctx, input) => accounts.setAccountNote(ctx, input) },
  'admin-requests': { method: 'GET', auth: 'admin', run: (ctx, input) => purchasing.listRequests(ctx, input) },
  'admin-request-create': { method: 'POST', auth: 'admin', run: (ctx, input) => purchasing.createManualRequest(ctx, input) },
  'admin-request-update': { method: 'POST', auth: 'admin', run: (ctx, input) => purchasing.updateRequest(ctx, input) },
  'admin-plans': { method: 'GET', auth: 'admin', run: (ctx) => ctx.adminPlans() },
  'admin-plan-save': { method: 'POST', auth: 'admin', run: (ctx, input) => ctx.adminSavePlan(input) },
  'admin-plans-seed': { method: 'POST', auth: 'admin', run: (ctx) => purchasing.seedDefaultPlans(ctx) },
  'admin-settings': { method: 'GET', auth: 'admin', run: (ctx) => ctx.adminSettings() },
  'admin-settings-save': { method: 'POST', auth: 'admin', run: (ctx, input) => ctx.adminSaveSettings(input) },
  'admin-watchers': { method: 'GET', auth: 'admin', run: (ctx, input) => ctx.adminWatchers(input) },
  'admin-member-activity': { method: 'GET', auth: 'admin', run: (ctx, input) => ctx.adminMemberActivity(input) },
  'admin-audit': { method: 'GET', auth: 'admin', run: (ctx, input) => ctx.adminAudit(input) },
  // 后台「用户行为」那块屏的数：谁看了哪几条、实际在哪一档、有没有像在整片拖（判据见 behavior.mjs）。
  'admin-behavior-board': { method: 'GET', auth: 'admin', run: (ctx, input) => behavior.board(ctx, input) },
  // 案头上「已看过／已处理」那一笔：只在 audit 落一行，不动会员权益、不建新表（behavior.ackCase）。
  'admin-case-ack': { method: 'POST', auth: 'admin', run: (ctx, input) => behavior.ackCase(ctx, input) },
};

// 每个写操作只认这几个字段名，多出来的当场拒绝：字段名写错时服务端从不报错，
// 只是没读到那个键，于是"保存"提示成功而库里一个字没动。
// 这张表必须按动作逐个列 —— 上传接口用驼峰、行内编辑用蛇形，做成全局规则就错了。
const POST_FIELDS = {
  register: ['email', 'password', 'displayName'],
  login: ['email', 'password'],
  logout: [],
  'session-revoke': ['id'],
  'password-change': ['currentPassword', 'newPassword'],
  redeem: ['code'],
  'migration-import-rows': ['table', 'rows', 'token'],
  'migration-count-rows': ['table', 'token'],
  'migration-video-row': ['token', 'video', 'key', 'nonce', 'chunkSize'],
  // 灌字节那条是 raw POST：body 就是分片本身，字段只有查询串上的这两个。
  'migration-object': ['p', 'token'],
  heartbeat: ['videoId', 'position', 'mode'],
  'admin-upload-start': ['title', 'description', 'contentType', 'plainSize', 'durationSeconds', 'previewSeconds', 'tierRank', 'kind', 'faststart'],
  'admin-upload-parts': ['videoId', 'from'],
  'admin-upload-complete': ['videoId', 'cipher', 'faststart'],
  'admin-upload-abort': ['videoId'],
  'admin-processing-retry': ['videoId'],
  'admin-poster-generate': ['videoId'],
  'admin-poster-url': ['videoId'],
  'admin-poster-done': ['videoId', 'sizeBytes'],
  'admin-video-update': ['videoId', 'title', 'description', 'preview_seconds', 'tier_rank', 'duration_seconds', 'kind', 'status'],
  'admin-video-delete': ['videoId', 'confirm'],
  'admin-catalog-order-save': ['videoIds', 'revision'],
  'admin-lesson-series-save': ['series','revision'],
  'admin-keys-create': ['planCode', 'count', 'note', 'validDays', 'requestId'],
  'admin-key-revoke': ['id'],
  'admin-key-restore': ['id'],
  'admin-user-reset-password': ['userId', 'newPassword'],
  'admin-admin-grant': ['email'],
  'admin-admin-revoke': ['email'],
  'admin-account-entitlement': ['userId', 'rank', 'mode', 'days', 'until', 'revision'],
  'admin-member-revoke': ['id'],
  'admin-member-restore': ['id'],
  'admin-member-adjust-days': ['id', 'days'],
  'admin-case-ack': ['key', 'status', 'note'],
  'admin-user-disable': ['userId'],
  'admin-user-enable': ['userId'],
  'admin-user-note': ['userId', 'note', 'contactQq'],
  'admin-request-create': ['email', 'planCode', 'note', 'contactQq'],
  'admin-request-update': ['id', 'status'],
  'admin-plan-save': ['code', 'name', 'rank', 'priceCents', 'durationDays', 'priceText', 'description', 'enabled', 'sortOrder'],
  'admin-plans-seed': [],
  'admin-settings-save': ['brand', 'brand_line', 'watermark_prefix', 'contact_qq', 'purchase_steps', 'promo_line', 'default_preview_seconds', 'max_active_sessions', 'max_concurrent_streams'],
};

// 派发器自己认的键：`a` 是动作名，`as` 是站长试看某个等级时的身份参数。
const COMMON_FIELDS = ['a', 'as'];

// 按名字拒绝已知的 AI 抓取器和通用命令行爬虫来取视频、封面和分片。
// 说清楚这一层挡不住什么：改一行 UA 就能绕过，真正的保护是分片加密 + 按账号签的授权；
// 这一层只是让"照着 robots.txt 来的"和懒得伪装的批量搬运拿不到东西。
// 名单里不放 okhttp：安卓上 QQ/微信内置浏览器取流会走它，误伤的是真买家。
const BLOCKED_AGENTS = /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|claude-ai|anthropic-ai|PerplexityBot|CCBot|Diffbot|Bytespider|Amazonbot|Applebot-Extended|Google-Extended|meta-externalagent|meta-externalfetcher|cohere-ai|YouBot|ImagesiftBot|omgili|Scrapy|python-requests|python-urllib|Go-http-client|libwww|HTTrack|WebReaper|wget|curl\/|node-fetch|axios\/|AhrefsBot|SemrushBot|MJ12bot|DotBot|DataForSeoBot|PetalBot|SerpstatBot|Nuclei|Zgrab|masscan|sqlmap)/i;
const MEDIA_ACTIONS = new Set(['media', 'poster', 'play']);

export function createHandler(deps) {
  const { storage, env } = deps;
  const keys = new RuntimeKeys(storage, env);
  // 设置跟着**非** media 的请求读进来，缓存在这个闭包里给 media 用。
  // 为什么不能"media 干脆不读设置"：拦人的那几条线（一个账号同时开几路）就在 media 那条路上，
  // 以前它在这一路上永远读到常数默认值 —— 于是站长在后台把 2 改成 8，界面上写着生效值，
  // 实际一个字节都没变（同一族的"改了没用"这个站已经犯过几次）。
  // 缓存在一次开片里必然已经更新：播放器取分段之前一定先打过 a=play（那是一条非 media 请求）。
  let liveSettings = normalizeSettings(null);
  const mergeEpochs = new WeakMap();

  return async function handle({ request, supabase }) {
    const url = new URL(request.url);
    const action = url.searchParams.get('a') ?? '';
    const route = ROUTES[action];
    if (!route) return json({ error: 'not_found' }, 404);
    if (MEDIA_ACTIONS.has(action)) {
      const agent = request.headers.get('user-agent') ?? '';
      // 真人浏览器一定带 UA；空 UA 的直连脚本一律拒。
      if (!agent || BLOCKED_AGENTS.test(agent)) return json({ error: 'blocked_client' }, 403);
    }
    // HEAD is a GET without a body, and iOS Safari probes media URLs with it before it
    // streams: answering 405 there makes a video unplayable on an iPhone while the very same
    // file plays on a desktop browser.
    const headRequest = request.method === 'HEAD' && route.method === 'GET';
    if (route.method !== request.method && !headRequest) {
      return json({ error: 'method_not_allowed' }, 405, { allow: route.method });
    }

    const config = await keys.load();
    if (!config.appDataKey || !config.sessionSecret) return json({ error: 'service_not_configured' }, 503);

    const clientStore = store(supabase, config.appDataKey);
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('cf-connecting-ip') || 'unknown';
    let viewer = null;
    // 请求一进来先用缓存那一份；下面非 media 的那一路会读到库里最新的值并顶进缓存。
    // 以前这里是每次现算一份默认值，于是 media（分段取用走的就是它）永远按默认值拦人 ——
    // 站长在站点设置改的那个数字只活在后台那张表上。
    let settings = liveSettings;
    const ctx = {
      request,
      url,
      supabase,
      storage,
      store: clientStore,
      keys,
      dataKey: config.appDataKey,
      sessionSecret: config.sessionSecret,
      adminEmails: config.adminEmails,
      // 灌数口令：主站这一份永远是 null（functions/migration-token.mjs），只有 --with-import 那一版备用站构建里才有值。
      migrationToken: MIGRATION_TOKEN,
      ip: ipPrefix(ip),
      settings,
      viewer: null,
      rank: 0,
      privileged: false,
      processing: deps.processing,
      accessFor(video) {
        return decideAccess({ video, rank: ctx.rank, privileged: ctx.privileged });
      },
    };

    try {
      viewer = await accounts.currentViewer(ctx);
      ctx.viewer = viewer;
      ctx.privileged = Boolean(viewer?.privileged);
      if (route.auth === 'login' && !viewer) throw new DataError('login_required');
      if (route.auth === 'admin' && !ctx.privileged) throw new DataError('admin_required');

      // The media path is the hot loop: it skips the settings read entirely.
      if (action !== 'media') {
        const loaded = await clientStore.readSettings();
        settings = loaded.values;
        liveSettings = settings;
        ctx.settings = settings;
        if (!loaded.authentic) ctx.settingsTampered = true;
      }

      if (viewer) {
        if (!mergeEpochs.has(supabase)) {
          mergeEpochs.set(supabase, clientStore.membershipEpoch().catch(error => { mergeEpochs.delete(supabase); throw error; }));
        }
        const [epoch, memberships, overrides] = await Promise.all([mergeEpochs.get(supabase), clientStore.listMemberships(viewer.user.id),
          clientStore.entitlementOverrides([viewer.user.id])]);
        ctx.mergeEpoch = epoch;
        ctx.standing = entitlement(memberships, epoch, overrides.get(viewer.user.id));
        ctx.memberships = memberships;
        ctx.rank = ctx.standing.rank;
        await accounts.touchSession(ctx, viewer);
      }

      let input = {};
      if (request.method === 'POST') {
        if (!acceptsMutation(request, viewer?.csrf ?? readCookie(request, 'lvs_csrf'))) throw new DataError('csrf_rejected');
        // raw 那一类（取流、封面、灌字节）自己读 ctx.request：它们的 body 是字节，
        // 按 JSON 读会当场报 body_type_invalid，而灌数要的字段全在查询串上。
        if (!route.raw) input = await readBody(request, route.maxBodyBytes);
      }
      for (const [key, value] of url.searchParams) {
        if (key !== 'a' && input[key] === undefined) input[key] = value;
      }

      if (request.method === 'POST') {
        const declared = POST_FIELDS[action];
        if (!declared) throw new DataError('field_contract_missing');
        const allowed = new Set([...declared, ...COMMON_FIELDS]);
        for (const key of Object.keys(input)) {
          if (!allowed.has(key)) throw new DataError('field_unsupported', key);
        }
      }

      // The owner cannot see a tier gate by looking at the site: an admin resolves to "full"
      // for everything, so 试播 always plays. `?as=<rank>` lets an admin view one page as a
      // given tier. It only ever removes privilege, and it is ignored for everyone outside
      // the admin list — a buyer sending ?as=99 keeps their own rank.
      if (ctx.privileged && input.as !== undefined) {
        const asRank = Number(input.as);
        if (Number.isSafeInteger(asRank) && asRank >= 0 && asRank <= 99) {
          ctx.rank = asRank;
          ctx.simulatedRank = asRank;
          ctx.privileged = false;
        }
      }

      ctx.boot = async (input = {}) => ({
        settings: Object.fromEntries(PUBLIC_SETTINGS_KEYS.map((key) => [key, settings[key]])),
        processingEnabled: Boolean(ctx.processing),
        limits: { maxVideoBytes: catalog.limits.MAX_VIDEO_BYTES, allowedTypes: catalog.limits.ALLOWED_TYPES },
        viewer: viewer ? accounts.publicUser(viewer.user) : null,
        privileged: ctx.privileged,
        rank: ctx.rank,
        membershipUntil: ctx.standing?.until ?? null,
        membershipLapsedAt: ctx.standing?.lapsedAt ?? null,
        csrf: viewer?.csrf ?? readCookie(request, 'lvs_csrf') ?? null,
        sessionEnded: viewer ? null : ctx.viewerLost ?? null,
        // A logged-in non-admin gets a masked hint of who the owner is: that is the one
        // piece of information that turns "我忘了站长邮箱" into a solvable question, and
        // two characters plus the domain are not enough to guess a password against.
        adminHint: viewer && !ctx.privileged ? maskEmail(ctx.adminEmails[0]) : null,
        // 档位跟着 boot 一起给。页脚那一行价目每一屏都要显示，原来为此每开一屏都多发一条
        // `plans` 请求，而站点额度是按请求条数按天算的 —— 少一条是一条。
        // `plans` 这个动作本身留着：后台预览和验收脚本仍然直接打它。
        plans: (await ctx.plans()).plans,
        // 片库那一屏原来发两条接口：boot 和 library-tabs。额度按请求条数按天算，
        // 所以开屏这一条允许带 `with=tabs`，把标签页要的片单一起带回（首页、片库、封面墙才要）。
        // libraryTabs 内部本来就是两次查询，这里不多花对外请求。
        ...(String(input?.with ?? '').split(',').includes('tabs')
          ? { tabs: await catalog.libraryTabs(ctx, { limit: Math.min(120, Math.max(1, Number(input?.tabsLimit) || 60)) }) }
          : {}),
      });

      ctx.plans = async () => {
        // 每张卡的"这一档能开几条片"在这里数出来，界面那行只读数，不再由人手打一句"全部"（§14.19）。
        const coverage = await catalog.planCoverage(ctx);
        return {
          plans: (await clientStore.listPlans()).filter((row) => row.authentic).map((row) => ({
            code: row.code, name: row.name, rank: row.tier_rank, priceCents: row.price_cents,
            priceText: row.price_text ?? '', durationDays: row.duration_days ?? null,
            description: row.description ?? '',
            filmsVisible: catalog.visibleFilmCountFor(coverage, row.tier_rank),
            filmsTotal: coverage.total,
          })),
        };
      };

      ctx.account = async () => {
        const rows = ctx.memberships ?? [];
        const plans = new Map((await clientStore.listPlans({ includeDisabled: true })).map((row) => [row.id, row]));
        const active = await clientStore.activeSessions(viewer.user.id, new Date(0).toISOString());
        return {
          user: accounts.publicUser(viewer.user),
          rank: ctx.rank,
          privileged: ctx.privileged,
          membership: ctx.standing,
          memberships: rows.map((row) => ({
            id: row.id,
            plan: plans.get(row.plan_id)?.name ?? '未知档位',
            planCode: plans.get(row.plan_id)?.code ?? '',
            rank: row.tier_rank,
            source: row.source,
            startsAt: row.starts_at,
            expiresAt: row.expires_at,
            state: row.revoked_at ? 'revoked' : expiresAt(row.expires_at) === null ? 'active' : expiresAt(row.expires_at) <= Date.now() ? 'expired' : 'active',
            verified: Boolean(row.verified),
          })),
          sessions: active.map((row) => ({ ...accounts.publicSession(row), current: row.id === viewer.session.id })),
          limits: { maxActiveSessions: settings.max_active_sessions },
        };
      };

      ctx.adminMembers = async (input = {}) => {
        // 主表只要还在生效的，回收站只要已撤销的 —— 两个方向都在这条查询里，
        // 不在调用方各拼一次 where。
        const revokedOnly = input.revokedOnly === '1' || input.revokedOnly === true;
        // 会员表里没有邮箱，所以搜索只接受完整邮箱：先把它换成用户 id 再筛。
        // 半截邮箱不做内存扫描：翻页之后"这一页没有"和"全站没有"分不开，那种搜索结果最骗人。
        const needle = String(input.q ?? '').trim().toLowerCase();
        const exact = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(needle) ? needle : '';
        const wanted = exact ? (await clientStore.listUsers({ emailExact: exact, limit: 20 })).items.map((row) => row.id) : [];
        if (exact && wanted.length === 0) return { items: [], hasMore: false, nextOffset: 0, searchedEmptyEmail: true };
        const page = await clientStore.listMembersPage({
          offset: input.offset,
          limit: input.limit ?? 20,
          revokedOnly,
          userIds: exact ? wanted : undefined,
        });
        const rows = page.items;
        const plans = new Map((await clientStore.listPlans({ includeDisabled: true })).map((row) => [row.id, row]));
        // 一条会员查一次账号，名单涨到几十条时手机上就是一次转圈几十个请求。
        const users = new Map((await clientStore.findUsersByIds([...new Set(rows.map((row) => row.user_id).filter(Boolean))]))
          .map((row) => [row.id, row]));
        const items = [];
        for (const row of rows) {
          if (!row.user_id) continue;
          const user = users.get(row.user_id);
          if (!user) continue;
          const plan = plans.get(row.plan_id);
          items.push({
            id: row.id,
            user: accounts.publicUser(user),
            plan: plan?.name ?? '未知档位',
            planCode: plan?.code ?? '',
            rank: row.tier_rank,
            verified: Boolean(row.verified),
            revokedAt: row.revoked_at ?? null,
            disabledAt: user.disabled_at ?? null,
            note: user.note ?? '',
            contactQq: user.contact_qq ?? '',
            registeredAt: user.created_at,
            lastLoginAt: user.last_login_at ?? null,
            expiresAt: row.expires_at,
            source: row.source,
            createdAt: row.created_at,
          });
        }
        return { items, hasMore: page.hasMore, nextOffset: page.nextOffset };
      };

      // 回收站顶部那四个数：一次请求拿全，别为了数数发四次。
      // 每一类都只数到 200 条为止，所以界面拿到 more=true 时要写"200+"而不是那个数。
      ctx.adminTrashCounts = async () => {
        const buckets = await Promise.all([
          clientStore.listUsers({ limit: 200, disabledOnly: true }),
          clientStore.listMembersPage({ limit: 200, revokedOnly: true }),
          clientStore.listKeys({ limit: 200, statuses: ['revoked', 'frozen'] }),
          clientStore.listRequests({ limit: 200, status: 'cancelled' }),
        ]);
        const shape = (page) => ({ count: page.items.length, more: Boolean(page.hasMore) });
        return {
          accounts: shape(buckets[0]),
          memberships: shape(buckets[1]),
          keys: shape(buckets[2]),
          requests: shape(buckets[3]),
        };
      };

      ctx.adminRestoreMembership = async (id) => {
        if (!isUuid(id)) throw new DataError('membership_not_found');
        const { row, override } = await clientStore.editableMembership(id);
        if (!row.revoked_at) throw new DataError('membership_not_revoked');
        const now = Date.now();
        if (row.expires_at && Date.parse(row.expires_at) <= now) {
          const rows = await clientStore.listMemberships(row.user_id);
          const before = entitlement(rows, ctx.mergeEpoch, override, now);
          const revived = rows.map(card => card.id === id ? { ...card, revoked_at: null } : card);
          const after = entitlement(revived, ctx.mergeEpoch, override, now);
          if (!after.rank || (before.rank === after.rank && before.until === after.until)) throw new DataError('membership_already_expired');
        }
        const updated = await clientStore.restoreMembershipById(id);
        if (!updated) throw new DataError('membership_restore_failed');
        await clientStore.audit({ actorId: viewer?.user?.id, action: 'membership_restore', target: id, ipPrefix: ctx.ip });
        return { ok: true, expiresAt: row.expires_at };
      };
      ctx.adminRevokeMembership = async (id) => {
        if (!isUuid(id)) throw new DataError('membership_not_found');
        await clientStore.editableMembership(id);
        const updated = await clientStore.revokeMembershipById(id);
        if (!updated) throw new DataError('membership_not_found');
        await clientStore.audit({ actorId: viewer?.user?.id, action: 'membership_revoke', target: id, ipPrefix: ctx.ip });
        return { ok: true };
      };

      ctx.adminPlans = async () => ({
        plans: await clientStore.listPlans({ includeDisabled: true }),
        settingsTampered: Boolean(ctx.settingsTampered),
      });

      ctx.adminSavePlan = async (values) => {
        const code = String(values.code ?? '').toLowerCase();
        if (!/^[a-z][a-z0-9_]{1,20}$/.test(code)) throw new DataError('plan_code_invalid');
        const name = String(values.name ?? '').trim().slice(0, 40);
        if (!name) throw new DataError('plan_name_invalid');
        const rank = Number(values.rank);
        if (!Number.isSafeInteger(rank) || rank < 1 || rank > 90) throw new DataError('plan_rank_invalid');
        const priceCents = Number(values.priceCents);
        if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100000000) throw new DataError('plan_price_invalid');
        const days = values.durationDays === null || values.durationDays === '' || values.durationDays === undefined
          ? null : Number(values.durationDays);
        if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 36500)) throw new DataError('plan_duration_invalid');
        const saved = await clientStore.upsertPlan({
          code,
          name,
          tier_rank: rank,
          price_cents: priceCents,
          // 显示出来的那句价格由服务端从"分"算出来，不接前端传来的文本：
          // 签名只覆盖 [id, code, tier_rank, duration_days, price_cents]，价格文字不在签名里，
          // 于是后台"价格（分）"与"显示文字"两格各写一处时，买家看到 ¥30、真正结算按另一档收，
          // 而且这一条永远不会被判成签名不一致。10-17 站长那句"调了价格前台没变化"就断在这儿。
          // 前端那格"显示文字"还留在白名单里，因为线上正在跑的那份后台仍会把它一起 POST 上来
          // （多出来的字段名会被 POST_FIELDS 当场拒），只是它的值不再被采用。
          price_text: yuanText(priceCents),
          duration_days: days,
          description: String(values.description ?? '').trim().slice(0, 200),
          enabled: values.enabled !== false,
          sort_order: Number.isSafeInteger(Number(values.sortOrder)) ? Number(values.sortOrder) : rank * 10,
        });
        if (!saved) throw new DataError('plan_write_failed', 'no_match');
        await clientStore.audit({ actorId: viewer?.user?.id, action: 'plan_save', target: saved.id, ipPrefix: ctx.ip, detail: { code, rank, days } });
        return { plan: saved };
      };

      ctx.adminSettings = async () => ({ values: settings, tampered: Boolean(ctx.settingsTampered) });

      ctx.adminSaveSettings = async (values) => {
        const merged = normalizeSettings({ ...settings, ...values });
        const saved = await clientStore.writeSettings(merged);
        if (!saved) throw new DataError('settings_write_failed');
        // 刚写完的这一份立刻顶进缓存：写的人不该下一个请求还读到旧值
        // （否则站长存完 8 路，紧接着的那一段取用还是按 1 路拦 —— 而这一步中间没有别的请求来刷新）。
        liveSettings = merged;
        settings = merged;
        await clientStore.audit({ actorId: viewer?.user?.id, action: 'settings_save', target: 'site', ipPrefix: ctx.ip });
        return { values: merged };
      };

      ctx.adminWatchers = async (values) => {
        if (!isUuid(values.videoId)) throw new DataError('video_not_found');
        // 多取一条只为回答"还有没有更多"：这一栏看的是此刻谁在这节片上，取满 200 条要明说。
        const fetched = await clientStore.listWatchLogs(values.videoId, 201);
        const rows = fetched.slice(0, 200);
        const users = new Map((await clientStore.findUsersByIds([...new Set(rows.map((row) => row.user_id).filter(Boolean))]))
          .map((row) => [row.id, row]));
        const sessions = new Map((await clientStore.findSessionsByIds(rows.map((row) => row.session_id)))
          .map((row) => [row.id, row]));
        const items = rows.map((row) => {
          const user = users.get(row.user_id);
          const session = sessions.get(row.session_id);
          return {
            id: row.id,
            email: user?.email ?? '已删除账号',
            // 「会话 343b523c」对站长没有信息量：他要看的是同一账号是不是在几台设备上看。
            device: session?.device_label ?? null,
            ip: session?.ip_prefix && session.ip_prefix !== 'unknown' ? session.ip_prefix : '',
            access: row.access_mode ?? row.access,
            position: row.position_seconds,
            updatedAt: row.updated_at,
          };
        });
        return { items, truncated: fetched.length > 200 };
      };

      // 纠纷里站长问的是"这个人看过什么、在哪台设备上看、看不看完"，而「谁在看」只能一部
      // 一片地反查。这里按账号取，一次给全：同一节片在几台设备上有记录，直接写在行上。
      ctx.adminMemberActivity = async (values) => {
        if (!isUuid(values.userId)) throw new DataError('member_not_found');
        const user = await clientStore.findUserById(values.userId);
        if (!user) throw new DataError('member_not_found');
        const page = await clientStore.listWatchLogsForUser(user.id, 200, {
          before: values.before, beforeId: values.beforeId,
        });
        const rows = page.rows;
        const sessions = new Map((await clientStore.findSessionsByIds(rows.map((row) => row.session_id)))
          .map((row) => [row.id, row]));
        const videos = new Map((await clientStore.findVideosByIds([...new Set(rows.map((row) => row.video_id).filter(isUuid))]))
          .map((row) => [row.id, row]));
        // rows 已经按 updated_at 倒序，所以每个 video 第一次出现的那条就是"最新看到哪儿"。
        const byVideo = new Map();
        for (const row of rows) {
          const item = byVideo.get(row.video_id);
          if (!item) {
            byVideo.set(row.video_id, {
              videoId: row.video_id,
              title: videos.get(row.video_id)?.title ?? '（这条教学影像已删除）',
              duration: Number(videos.get(row.video_id)?.duration_seconds ?? 0),
              position: Number(row.position_seconds ?? 0),
              access: row.access_mode ?? row.access,
              updatedAt: row.updated_at,
              devices: [],
            });
          }
          const session = sessions.get(row.session_id);
          const label = session?.device_label ?? '';
          const ip = session?.ip_prefix && session.ip_prefix !== 'unknown' ? session.ip_prefix : '';
          const key = `${label}|${ip}`;
          const seen = byVideo.get(row.video_id).devices;
          if (!seen.some((device) => device.key === key)) seen.push({ key, label, ip });
        }
        // 行本来就是按 updated_at 倒序进来的，所以 byVideo 的插入顺序就是"最近在前的"；
        // 再按时间字符串排一次反而会把 `…Z` 与 `…+00:00` 两种形态排成两个顺序。
        // 游标形状与操作日志那一条保持一致：{before, beforeId}，取完了就是 null。
        return {
          email: user.email,
          items: [...byVideo.values()],
          hasMore: page.hasMore,
          nextCursor: page.hasMore && rows.length > 0
            ? { before: rows[rows.length - 1].updated_at, beforeId: rows[rows.length - 1].id }
            : null,
        };
      };

      // 「对象」栏只有 UUID 截断时，这一栏对站长没有信息量：他要读的是"动了谁的哪一条"。
      const AUDIT_USER_TARGET = new Set(['account_entitlement', 'user_disable', 'user_enable', 'user_note', 'user_password_reset', 'login_fail']);
      const AUDIT_MEMBER_TARGET = new Set(['membership_revoke', 'membership_adjust', 'membership_restore']);
      const AUDIT_KEY_TARGET = new Set(['key_revoke', 'key_restore']);
      // 播放闸门与设备上报这几类的 target 也是片 id：不进这张表，日志里那一栏就只剩「编号 1a2b3c4d」，
      // 站长看到的是"哪一条"而不是一串十六进制。加一类闸门就得同时进这张表和 behavior.mjs 的标签表，
      // 少一处就是"库里有一行、界面上读不出是谁的哪条片"。
      const AUDIT_VIDEO_TARGET = new Set([
        'upload_start', 'upload_complete', 'upload_abort', 'video_update', 'video_delete',
        'media_byte_budget', 'media_bulk_grab', 'media_bulk_partial', 'media_library_sweep', 'media_preview_overrun', 'media_stream_cap', 'media_wholefile_denied',
        'viewer_quality_pick', 'viewer_quality_failed', 'viewer_auto_boost', 'viewer_auto_release', 'viewer_rendition', 'viewer_stall', 'viewer_frag_rate',
      ]);
      // 「记下一笔成交」和「改了成交状态」的 target 都是 requests 表的行 id，
      // 少一个动作进这张表，那一行就只剩档位、说不出是谁的单。
      const AUDIT_REQUEST_TARGET = new Set(['request_update', 'purchase_request']);
      ctx.adminAudit = async (input = {}) => {
        const page = await clientStore.recentAudit(100, { before: input.before ?? null, beforeId: input.beforeId ?? null });
        const rows = page.rows;
        const personIds = new Set();
        const membershipIds = new Set();
        const keyIds = new Set();
        const videoIds = new Set();
        const requestIds = new Set();
        for (const row of rows) {
          if (row.actor_id) personIds.add(row.actor_id);
          if (AUDIT_USER_TARGET.has(row.action) && row.target) personIds.add(row.target);
          if (AUDIT_MEMBER_TARGET.has(row.action) && row.target) membershipIds.add(row.target);
          if (AUDIT_KEY_TARGET.has(row.action) && row.target) keyIds.add(row.target);
          if (AUDIT_REQUEST_TARGET.has(row.action) && row.target) requestIds.add(row.target);
          // 只有 detail 里没带标题时才需要回查（upload_complete 那类自己就写了片名）。
          if (AUDIT_VIDEO_TARGET.has(row.action) && row.target && !(row.detail ?? {}).title) videoIds.add(row.target);
        }
        const [planRows, keyRows, membershipRows, videoRows, requestRows] = await Promise.all([
          clientStore.listPlans({ includeDisabled: true }),
          keyIds.size > 0 ? clientStore.listKeysByIds([...keyIds]) : [],
          clientStore.findMembershipsByIds([...membershipIds]),
          clientStore.findVideosByIds([...videoIds]),
          clientStore.findRequestsByIds([...requestIds]),
        ]);
        for (const row of membershipRows) if (row.user_id) personIds.add(row.user_id);
        const planNames = new Map(planRows.map((row) => [String(row.code), row.name]));
        const keyTails = new Map(keyRows.map((row) => [row.id, row.code_tail]));
        const memberUser = new Map(membershipRows.map((row) => [row.id, row.user_id]));
        const videoTitles = new Map(videoRows.map((row) => [row.id, row.title]));
        const requestEmails = new Map(requestRows.map((row) => [row.id, row.email]));
        const emails = new Map((await clientStore.findUsersByIds([...personIds])).map((row) => [row.id, row.email]));
        return {
          items: rows.map((row) => ({
            // 'unknown' 是"这次请求没带转发头"的内部哨兵（本地开发、直接打 IP 时都会出现），
            // 限流按它分桶有用，但它不该出现在站长看的表格里。
            id: row.id, action: row.action, target: row.target ?? '',
            ip: row.ip_prefix && row.ip_prefix !== 'unknown' ? row.ip_prefix : '',
            actorId: row.actor_id ?? '',
            createdAt: row.created_at,
            actor: row.actor_id
              ? (emails.get(row.actor_id) ?? `已删除的账号 ${String(row.actor_id).slice(0, 8)}`)
              : '未登录',
            targetEmail: (AUDIT_USER_TARGET.has(row.action) ? emails.get(row.target) : null)
              ?? (AUDIT_MEMBER_TARGET.has(row.action) ? emails.get(memberUser.get(row.target)) : null)
              ?? (AUDIT_REQUEST_TARGET.has(row.action) ? requestEmails.get(row.target) : null) ?? null,
            targetTail: AUDIT_KEY_TARGET.has(row.action) ? (keyTails.get(row.target) ?? null) : null,
            targetTitle: AUDIT_VIDEO_TARGET.has(row.action) ? (videoTitles.get(row.target) ?? null) : null,
            planName: planNames.get(String((row.detail ?? {}).plan ?? (row.detail ?? {}).code ?? '')) ?? null,
            detail: row.detail ?? null,
          })),
          // 翻到更早的：把这一批最后一行的 (时间, id) 原样带回来当下一次游标。
          hasMore: page.hasMore,
          oldestAt: rows.length ? rows[rows.length - 1].created_at : null,
          nextCursor: page.hasMore && rows.length > 0
            ? { before: rows[rows.length - 1].created_at, beforeId: rows[rows.length - 1].id }
            : null,
        };
      };

      const result = await route.run(ctx, input);

      if (route.raw) return result;
      let response = json(result ?? { ok: true });
      if (action === 'login' || action === 'register') {
        const issued = result?.token ? accounts.authedCookies(result.token, result.csrf) : [];
        response = appendCookie(json(publicSessionResult(result, ctx)), ...issued);
      } else if (action === 'logout') {
        response = appendCookie(json({ ok: true }), ...accounts.loggedOutCookies());
      }
      // Anonymous browsers still need the double-submit cookie for their first POST.
      if (!readCookie(request, 'lvs_csrf') && action !== 'media') {
        response = appendCookie(response, accounts.csrfCookie(csrfToken()));
      }
      // A HEAD reply carries the GET's status and headers with no body; the byte count stays
      // in content-length, which is the whole reason a player sends the probe.
      return headReply(request, response);
    } catch (error) {
      if (route.raw) {
        return json({ error: 'media_failed' }, 500);
      }
      const code = error instanceof DataError ? error.code : 'internal_error';
      if (code === 'internal_error') {
        // Only stable application codes reach the browser. Server diagnostics keep
        // the failure type and message, never credentials, SQL or provider bodies.
        try {
          console.error(`application failure action=${action} method=${request.method} type=${error?.name}`);
          console.error(String(error?.stack ?? '').split('\n').slice(0, 4).join('\n'));
        } catch {
          /* logging must not mask the response */
        }
      }
      // The detail slot carries only a backend error code or a one-word shape ("transport",
      // "no_row_returned"), which is what turns an undiagnosable "保存失败" into a class the
      // owner can act on. Raw provider messages are never forwarded: they name columns.
      const detail = error instanceof DataError ? error.detail ?? null : null;
      // A refusal means the row was not touched, so the browser must not downgrade it into
      // "it may have gone through, check first" — that advice is only for lost replies.
      // REFUSALS 比的是 detail（上游数据库的返回码）；字段契约这两条的 detail 是字段名，
      // 只能按错误码判，所以两个集合分开，别把它们混成一个。
      const REFUSALS = new Set(['42501', '42703', '23502', '23505', '22P02', 'PGRST204', 'PGRST116', 'no_match']);
      const REFUSED_CODES = new Set(['field_unsupported', 'field_contract_missing']);
      const outcome = (REFUSALS.has(String(detail ?? '')) || REFUSED_CODES.has(code)) ? 'rejected' : null;
      // extra 里只放服务端自己算出来的数（如 retryMinutes），让"还要等多久"这种话由算它的那一处说。
      const extra = error instanceof DataError && error.extra && typeof error.extra === 'object' ? error.extra : {};
      return json({ error: code, message: MESSAGE[code] ?? detail, outcome, ...extra }, statusFor(code));
    }
  };
}

function publicSessionResult(result, ctx) {
  if (!result || !result.user) return result;
  // ctx.privileged describes the browser that made the request, which is not yet
  // authenticated while logging in or registering.
  const email = String(result.user.email ?? '').toLowerCase();
  return {
    user: accounts.publicUser(result.user),
    privileged: ctx.adminEmails.includes(email),
    passwordIsWeak: Boolean(result.passwordIsWeak),
    evicted: Number(result.evicted) || 0,
  };
}

function statusFor(code) {
  if (code === 'lesson_series_conflict') return 409;
  if (code === 'lesson_series_tampered') return 503;
  if (code === 'lesson_series_limit_exceeded') return 422;
  if (code === 'lesson_series_not_found') return 404;
  if (code === 'entitlement_invalid') return 503;
  if (code === 'membership_conflict' || code === 'catalog_order_conflict') return 409;
  if (code === 'catalog_order_tampered') return 503;
  if (code === 'catalog_order_limit_exceeded') return 422;
  // A failed verification is a refusal, not a lost reply: the row was definitely not marked
  // usable. Answering 503 made the browser classify it as "outcome unknown" and show
  // "站点没有回话", which buried the actual reason from the owner.
  if (code === 'chunk_verify_failed' || code === 'poster_verify_failed') return 422;
  if (code === 'login_required') return 401;
  if (code === 'admin_required' || code === 'csrf_rejected' || code === 'membership_required' || code === 'video_tampered') return 403;
  if (code === 'register_rate_limited' || code === 'redeem_rate_limited' || code === 'login_locked' || code === 'login_rate_limited') return 429;
  if (code === 'video_not_found' || code === 'not_found' || code === 'membership_not_found' || code === 'member_not_found' || code === 'request_not_found' || code === 'key_not_found') return 404;
  if (code === 'service_not_configured' || code === 'internal_error') return 500;
  if (code === 'email_taken' || code === 'video_not_ready' || code === 'upload_not_open') return 409;
  if (code.endsWith('_failed') || code === 'redeem_incomplete' || code === 'chunk_read_failed') return 503;
  return 400;
}
