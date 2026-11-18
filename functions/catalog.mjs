import { readSeriesState, saveSeries } from './lesson-series.mjs';
import { randomId, isoNow, cleanText, isUuid } from './shared/util.mjs';
import { seal, open } from './shared/vault.mjs';
import { DataError } from './db.mjs';
import { CHUNK_SIZE, chunkCount, encryptedTotalSize, encryptedChunkLength, isValidCipher } from './shared/video-crypto.mjs';
import { verifyUploadedObject } from './shared/storage-validation.mjs';
import { assertSignablePath } from './runtime-keys.mjs';
import { readCapped } from './shared/read-bytes.mjs';
import { posterFramePath, posterFramePaths, isGeneratedJpeg, POSTER_FRAME_MAX_BYTES } from './shared/auto-poster.mjs';
import { VIDEO_STATUSES, previewSecondsFor } from './domain.mjs';
import { rangeParams, paginate } from './db.mjs';
import { catalogOrderState, saveCatalogOrder } from './catalog-order.mjs';

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const ALLOWED_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const MAX_POSTER_BYTES = 2 * 1024 * 1024;
// A batch is consumed one chunk at a time, and each chunk takes seconds of encrypting and
// uploading, so a write address must not be handed out far ahead of the moment it is used.
const URL_BATCH = 20;

export function objectPath(videoId, index) {
  return `v/${videoId}/${String(index).padStart(6, '0')}.bin`;
}

export function posterPath(videoId) {
  return `poster/${videoId}.jpg`;
}

// 服务端给浏览器的封面地址只在这里拼一次（播放器那一栏也用它），规则和 web/assets/app.js
// 里的 posterSrc 一致：带版本把手，改了封面不会被一天的缓存挡住。
export function posterUrl(videoId, version) {
  const base = `/functions/v1/app?a=poster&v=${encodeURIComponent(videoId)}`;
  return version ? `${base}&t=${encodeURIComponent(version)}` : base;
}

// 版本把手取行的更新时间：换封面走 updateVideo，而它一定会写 updated_at，所以站长挂上新图的
// 那一刻地址就变了，浏览器会重新取一次，不会让一天的缓存把旧封面钉在买家屏幕上。
// 只留数字是因为它要直接进 URL；留到毫秒是因为"两次改封面落在同一秒"是真实会发生的事
// （后台连着点两下），截到秒的话第二次改动就等于没生效。
export const posterVersionOf = (row) => (row.poster_path
  ? String(row.updated_at ?? row.created_at ?? '').replace(/[^0-9]/g, '')
  : null);

function sizeInput(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_VIDEO_BYTES) throw new DataError('video_size_invalid');
  return number;
}

function timeInput(value, max = 24 * 3600) {
  if (value === null || value === undefined || value === '') return null;
  const number = Math.round(Number(value));
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new DataError('duration_invalid');
  return number;
}

function rankInput(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 99) throw new DataError('tier_invalid');
  return number;
}

// 平台的 DDL 不许写 DEFAULT，所以这列可空："没选"在代码里必须有含义 ——
// 0002 之前的行和白名单外的值都读成真实教学。认不出的文本是改写不是报错，
// 一条手改过的行不该让整个片库空白。
export const VIDEO_KINDS = ['live', 'anime'];
export const DEFAULT_KIND = 'live';

export function kindOf(value) {
  return VIDEO_KINDS.includes(value) ? value : DEFAULT_KIND;
}

function kindInput(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_KIND;
  if (!VIDEO_KINDS.includes(value)) throw new DataError('video_kind_invalid');
  return value;
}

export async function startUpload(ctx, input) {
  const title = cleanText(input.title, 120);
  if (!title) throw new DataError('title_invalid');
  const contentType = input.contentType;
  if (!ALLOWED_TYPES.includes(contentType)) throw new DataError('video_type_unsupported');
  const plainSize = sizeInput(input.plainSize);
  const durationSeconds = timeInput(input.durationSeconds);
  const previewSeconds = input.previewSeconds === undefined
    ? ctx.settings.default_preview_seconds
    : timeInput(input.previewSeconds, 3600);
  const tierRank = rankInput(input.tierRank ?? 1);
  const chunkTotal = chunkCount(plainSize);

  const id = randomId();
  const record = {
    id,
    title,
    description: cleanText(input.description ?? '', 500),
    object_prefix: `v/${id}`,
    content_type: contentType,
    plain_size: plainSize,
    enc_size: encryptedTotalSize(plainSize, CHUNK_SIZE),
    chunk_size: CHUNK_SIZE,
    chunk_total: chunkTotal,
    duration_seconds: durationSeconds,
    preview_seconds: previewSeconds,
    tier_rank: tierRank,
    kind: kindInput(input.kind),
    key_cipher: null,
    cipher_version: 'aes-256-gcm-chunk-1m',
    faststart: input.faststart === true,
    status: 'uploading',
    published_at: null,
    created_at: isoNow(),
    updated_at: isoNow(),
    poster_path: null,
  };
  await ctx.store.createVideo(record);
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'upload_start', target: id, ipPrefix: ctx.ip, detail: { title, plainSize } });
  // 封面的写入地址不在这里发：建档时发的那一个要等到分片传完才用得上，而封面是传完之前先写的，
  // 中间隔着整条视频的加密和上传 —— 一个只用一次、还会过期的地址不值得让上传会话带着。
  // 现在三条路（上传、传完重试、片库里补图）都走 admin-poster-url 现要现写。
  return {
    videoId: id,
    chunkSize: CHUNK_SIZE,
    chunkTotal,
    plainSize,
    status: 'uploading',
  };
}

export async function uploadUrls(ctx, { videoId, from }) {
  const video = await mustOwnVideo(ctx, videoId);
  if (video.status !== 'uploading') throw new DataError('upload_not_open');
  const start = Number(from);
  if (!Number.isSafeInteger(start) || start < 0) throw new DataError('chunk_range_invalid');
  const last = Math.min(start + URL_BATCH - 1, video.chunk_total - 1);
  const parts = [];
  for (let index = start; index <= last; index += 1) {
    const signed = await ctx.storage.createSignedUploadUrl(assertSignablePath(objectPath(video.id, index)), { upsert: true });
    parts.push({ index, url: signed?.signedUrl ?? signed });
  }
  return { parts, next: last + 1 < video.chunk_total ? last + 1 : null, chunkTotal: video.chunk_total };
}

export async function completeUpload(ctx, { videoId, cipher, faststart }) {
  const video = await mustOwnVideo(ctx, videoId);
  if (video.status !== 'uploading') throw new DataError('upload_not_open');
  if (!isValidCipher(cipher) || cipher.chunkSize !== video.chunk_size) throw new DataError('cipher_invalid');

  // Stored bytes are proved, not trusted: ciphertext chunks are read back and
  // measured against the declared plaintext size before the video becomes usable.
  const lastIndex = video.chunk_total - 1;
  const probe = [0, Math.max(0, Math.floor(lastIndex / 2)), lastIndex];
  for (const index of new Set(probe)) {
    const expected = encryptedChunkLength(index, video.plain_size, video.chunk_size);
    try {
      const object = await ctx.storage.download(objectPath(video.id, index));
      await verifyUploadedObject(object, {
        maxBytes: video.chunk_size + 4096,
        expectedBytes: expected,
        allowedContentTypes: ['application/octet-stream'],
      });
    } catch {
      throw new DataError('chunk_verify_failed');
    }
  }

  // 抽样三个分片会让"中间缺一片"的视频看起来是完整的：存得下、发得出去，
  // 观众正好停在缺的那一片。清单是分页列名，不是逐片下载，1 GiB 也只花几次调用。
  // 清单挂了不许判死：它只是探测之外的加分项，报错时退回弱检查（见 media 的抽样下载）。
  const dir = `v/${video.id}/`;
  const PAGE = 100;
  const present = new Set();
  let cursor = 0;
  let previousFirst = null;
  let inventoryComplete = true;
  let stopped = false;
  for (let guard = 0; guard < 60; guard += 1) {
    let page;
    try {
      page = await ctx.storage.list(dir, { limit: PAGE, offset: cursor });
    } catch {
      inventoryComplete = false;
      break;
    }
    const entries = Array.isArray(page?.data) ? page.data
      : Array.isArray(page?.objects) ? page.objects
        : Array.isArray(page) ? page : [];
    if (entries.length === 0) { stopped = true; break; }
    for (const entry of entries) {
      // The provider may hand back the name relative to the prefix or the whole key, so the
      // index is taken from the trailing digits instead of assuming one shape.
      const match = /(\d+)\.bin$/.exec(String(entry?.name ?? entry?.path ?? ''));
      const index = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(index) && index >= 0) present.add(index);
    }
    if (entries.length < PAGE) { stopped = true; break; }
    // A provider that ignores `offset` hands back the same page forever. Enforcing an
    // inventory built that way would report every chunk past page one as missing.
    const first = String(entries[0]?.name ?? entries[0]?.path ?? entries[0]?.id ?? '');
    if (first === '' || first === previousFirst) break;
    previousFirst = first;
    cursor += entries.length;
  }
  // Reaching the loop limit means the listing never told us it was done.
  if (!stopped) inventoryComplete = false;

  if (inventoryComplete && present.size > 0) {
    for (let index = 0; index < video.chunk_total; index += 1) {
      if (!present.has(index)) throw new DataError('chunk_verify_failed');
    }
  } else {
    console.warn(`chunk inventory unavailable for ${video.id}; relying on sampled probes`);
  }

  const updated = await ctx.store.updateVideo(video.id, {
    key_cipher: await seal(ctx.dataKey, JSON.stringify({ key: cipher.key, nonce: cipher.nonce })),
    cipher_version: 'aes-256-gcm-chunk-1m',
    faststart: faststart === true || video.faststart === true,
    status: 'draft',
  }, true, 'uploading');
  if (!updated) throw new DataError('upload_not_open');
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'upload_complete', target: video.id, ipPrefix: ctx.ip, detail: { title: video.title } });
  return { videoId: video.id, status: 'draft', encSize: encryptedTotalSize(video.plain_size, video.chunk_size) };
}

export async function abortUpload(ctx, { videoId }) {
  if (!isUuid(videoId)) throw new DataError('video_not_found');
  let video = await ctx.store.findVideo(videoId);
  if (!video) return { ok: true };
  if (video.status === 'uploading') {
    const marked = await ctx.store.updateVideo(video.id, { status: 'aborting' }, true, 'uploading');
    video = marked ?? await ctx.store.findVideo(videoId);
    if (!video) return { ok: true };
  }
  if (video.status !== 'aborting') throw new DataError('upload_not_open');
  await removeObjects(ctx, video);
  await ctx.store.deleteVideo(video.id);
  // 中止会把这一行删掉，之后再也查不到片名，所以片名必须此刻写进日志。
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'upload_abort', target: video.id, ipPrefix: ctx.ip, detail: { title: video.title } });
  return { ok: true };
}

async function mustOwnVideo(ctx, videoId) {
  if (!isUuid(videoId)) throw new DataError('video_not_found');
  const video = await ctx.store.findVideo(videoId);
  if (!video) throw new DataError('video_not_found');
  return video;
}

async function removeObjects(ctx, video) {
  const total = Number(video.chunk_total) || 0;
  const paths = [];
  for (let index = 0; index < total; index += 1) paths.push(objectPath(video.id, index));
  // 封面 PUT 可能完成而登记尚未回来；确定性路径也必须一起清掉。
  paths.push(posterPath(video.id), ...await posterFramePaths(video.id));
  if (video.poster_path && video.poster_path !== posterPath(video.id)) paths.push(video.poster_path);
  for (let index = 0; index < paths.length; index += 1000) {
    await ctx.storage.remove(paths.slice(index, index + 1000));
  }
}

// A fresh write address for the cover object, so a cover that failed to attach can be
// retried without re-uploading the video.
export async function posterUploadUrl(ctx, { videoId }) {
  const video = await mustOwnVideo(ctx, videoId);
  if (video.status === 'aborting') throw new DataError('upload_not_open');
  if (ctx.processing?.isDeleting(video.id)) throw new DataError('video_delete_pending');
  const signed = await ctx.storage.createSignedUploadUrl(assertSignablePath(posterPath(video.id)), { upsert: true });
  return { uploadUrl: signed?.signedUrl ?? signed ?? null, maxBytes: MAX_POSTER_BYTES };
}

export async function setPoster(ctx, { videoId, sizeBytes }) {
  const video = await mustOwnVideo(ctx, videoId);
  if (video.status === 'aborting') throw new DataError('upload_not_open');
  if (ctx.processing?.isDeleting(video.id)) throw new DataError('video_delete_pending');
  const declared = Number(sizeBytes);
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_POSTER_BYTES) throw new DataError('poster_size_invalid');
  try {
    const object = await ctx.storage.download(posterPath(video.id));
    await verifyUploadedObject(object, {
      maxBytes: MAX_POSTER_BYTES,
      expectedBytes: declared,
      allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    });
  } catch {
    throw new DataError('poster_verify_failed');
  }
  const updated = await ctx.store.updateVideo(video.id, { poster_path: posterPath(video.id) }, false);
  if (!updated) throw new DataError('video_write_failed');
  return { ok: true };
}

// Cover art is public for any card the visitor can already see, but the bytes live in a
// private bucket. Serving them from this route rather than redirecting to a signed URL is
// what keeps the page's own `img-src 'self'` CSP intact: a cross-origin redirect is blocked
// by it, and the card silently renders an empty box. The objects are capped at 2 MB on the
// way in, so proxying them costs nothing worth optimising.
// Candidates are private administrator previews. Generating one never selects it as the cover.
export async function servePosterFrame(ctx) {
  const query = new URL(ctx.request.url).searchParams;
  const videoId = query.get('v'), index = Number(query.get('n'));
  if (!isUuid(videoId) || !/^[0-5]$/.test(query.get('n') || '')) return new Response('not found', { status: 404 });
  const video = await ctx.store.findVideo(videoId);
  if (!video?.authentic || !['draft', 'published', 'retired'].includes(video.status)
    || !ctx.processing?.frames(videoId)?.frames.some(frame => frame.index === index)) return new Response('not found', { status: 404 });
  try {
    const object = await ctx.storage.download(await posterFramePath(videoId, index));
    const bytes = await readCapped(object, POSTER_FRAME_MAX_BYTES, { timeoutMs: 10000 });
    if (!isGeneratedJpeg(bytes)) throw Error('poster_image_invalid');
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  } catch { return new Response('frame unavailable', { status: 503 }); }
}

// admin=true 是站长侧那一条路（?a=admin-poster）：草稿的封面也必须画得出来。
// 以前只有观众那一条，而它对草稿回 404，于是站长挂完封面一刷新，两处界面都只剩一句
// 文字、看不到图，看上去跟"没挂上"一模一样（2026-10-17 就是这么被判定失败的）。
// 观众的门槛一条没动：!admin 时仍然是"没有封面或没发布就不给"。
export async function servePoster(ctx, { admin = false } = {}) {
  const videoId = new URL(ctx.request.url).searchParams.get('v') ?? '';
  if (!isUuid(videoId)) return new Response('not found', { status: 404 });
  const video = await ctx.store.findVideo(videoId);
  if (!video?.poster_path || (!admin && video.status !== 'published')) return new Response('not found', { status: 404 });
  try {
    const object = await ctx.storage.download(assertSignablePath(video.poster_path));
    // 2026-10-12 线上量到整页加载时 15 张封面里有 12～14 条从这一行掉进 catch（回 503），
    // 单独重放同一条 URL 又全好 —— 定性没做完，别当成已修。能确定的只有"五秒在这个时刻太紧"：
    // 一张不超过 2 MB 的图，慢也慢不到五秒，所以把预算放到十秒，让慢的那几次 succeed 而不是失败。
    // 请求条数一条没少，白等的也不是观众的请求（浏览器那边本来就在等图）。
    const bytes = await readCapped(object, MAX_POSTER_BYTES, { timeoutMs: 10000 });
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': object.contentType || 'image/jpeg',
        // 这个 max-age 在平台上是空的：2026-10-14 实测 /functions/** 的响应头会被 CDN 改写成
        // private, no-store，浏览器每次回访都重新发一条封面请求。所以省额度靠的是客户端
        // "只取屏幕上看得见的那几张"，不是这里写的天数。留着它对本地验收和真实 CDN 有意义，
        // 但别把它当成已经在省钱。站长那一条不给缓存：草稿封面随时会被换掉，别让一天的旧图
        // 在他确认后还顶着"已挂上"。
        'cache-control': admin ? 'private, no-store' : 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new Response('poster unavailable', { status: 503 });
  }
}

const EDITABLE = new Set(['title', 'description', 'preview_seconds', 'tier_rank', 'duration_seconds', 'status', 'poster_path', 'kind']);

export async function updateVideo(ctx, input) {
  const video = await mustOwnVideo(ctx, input.videoId);
  if (video.status === 'aborting') throw new DataError('upload_not_open');
  if (ctx.processing?.isDeleting(video.id)) throw new DataError('video_delete_pending');
  const patch = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title, 120);
    if (!title) throw new DataError('title_invalid');
    patch.title = title;
  }
  if (input.description !== undefined) patch.description = cleanText(input.description ?? '', 500) ?? '';
  if (input.preview_seconds !== undefined) patch.preview_seconds = timeInput(input.preview_seconds, 3600) ?? 0;
  if (input.tier_rank !== undefined) patch.tier_rank = rankInput(input.tier_rank);
  if (input.duration_seconds !== undefined) patch.duration_seconds = timeInput(input.duration_seconds);
  if (input.kind !== undefined) patch.kind = kindInput(input.kind);
  for (const key of Object.keys(patch)) if (!EDITABLE.has(key)) throw new DataError('field_not_editable');

  let status = video.status;
  if (input.status !== undefined) {
    if (video.status === 'uploading') throw new DataError('video_not_ready');
    if (input.status === 'uploading' || input.status === 'aborting') throw new DataError('status_invalid');
    if (!VIDEO_STATUSES.includes(input.status)) throw new DataError('status_invalid');
    if (input.status === 'published') {
      if (video.status === 'uploading' || !video.key_cipher) throw new DataError('video_not_ready');
      status = 'published';
      patch.published_at = video.published_at ?? isoNow();
    } else status = input.status;
  }

  const result = await ctx.store.updateVideo(video.id, { ...patch, status }, true, video.status);
  if (!result) throw new DataError('video_write_failed', 'no_match');
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'video_update', target: video.id, ipPrefix: ctx.ip, detail: patch });
  return publicVideo(result, { privileged: true });
}

export async function deleteVideo(ctx, { videoId, confirm }) {
  const video = await mustOwnVideo(ctx, videoId);
  if (video.status === 'uploading' || video.status === 'aborting') return abortUpload(ctx, { videoId });
  // The typed title exists to stop deleting something an audience is using. A draft that was
  // never published has no audience, so making the owner retype it is friction with no
  // protective value — and failed uploads are exactly the thing he deletes most.
  if (video.published_at && confirm !== video.title) throw new DataError('confirm_title_required');
  await ctx.processing?.cancel(video.id);
  await removeObjects(ctx, video);
  const removed = await ctx.store.deleteVideo(video.id);
  if (!removed) throw new DataError('video_delete_failed');
  // 只有行确已删除才清理派生包；失败时保留持久化删除待办，由处理队列继续收尾。
  try { await ctx.processing?.cleanupDeleted(video.id); }
  catch { console.warn('derived media cleanup deferred'); }
  await ctx.store.audit({ actorId: ctx.viewer?.user?.id, action: 'video_delete', target: video.id, ipPrefix: ctx.ip, detail: { title: video.title } });
  return { ok: true };
}

export function publicVideo(row, { privileged = false, access = null, rank = null } = {}) {
  const preview = previewSecondsFor(row);
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    durationSeconds: Number(row.duration_seconds) || 0,
    sizeBytes: Number(row.plain_size) || 0,
    status: privileged ? row.status : (row.status === 'published' ? 'published' : 'hidden'),
    tierRank: Number(row.tier_rank) || 0,
    kind: kindOf(row.kind),
    previewSeconds: preview,
    faststart: row.faststart === true,
    // `created_at` must not stand in for "has ever been visible": the admin row uses this
    // field to decide whether deleting needs the title retyped, so the fallback re-armed the
    // friction that `published_at` alone is supposed to lift (and no display uses it).
    publishedAt: row.published_at ?? null,
    access,
    rank,
    ready: privileged ? Boolean(row.key_cipher) : undefined,
    authentic: row.authentic !== false,
    hasPoster: Boolean(row.poster_path),
    posterVersion: posterVersionOf(row),
  };
}

async function libraryPage(ctx, state, { offset, limit, kind } = {}) {
  const visible = [];
  for (const [displayOrder, row] of state.rows.entries()) {
    if (VIDEO_KINDS.includes(kind) && kindOf(row.kind) !== kind) continue;
    const access = ctx.accessFor(row);
    if (access === 'hidden') continue;
    visible.push({ ...publicVideo(row, { access, rank: ctx.rank }), displayOrder });
  }
  const page = paginate(visible.slice(rangeParams(offset, limit).first), rangeParams(offset, limit));
  const items = page.items;
  // 片库要能回答"哪一节我看过、看到哪儿了"。进度已经在库里（播放器每 30 秒写一次），
  // 这里按这一页的视频一次取回来 —— 只取这个账号自己的，匿名浏览一个字段都不加。
  if (ctx.viewer && items.length) {
    const rows = await ctx.store.watchPositions({ userId: ctx.viewer.user.id, videoIds: items.map((item) => item.id) });
    const newest = new Map();
    for (const row of rows) if (!newest.has(row.video_id)) newest.set(row.video_id, Math.max(0, Number(row.position_seconds) || 0));
    for (const item of items) item.lastPosition = newest.get(item.id) ?? null;
  }
  return { items, hasMore: page.hasMore, nextOffset: page.nextOffset, manualOrder: state.manual, orderRevision: state.revision };
}

export async function library(ctx, input = {}) {
  return libraryPage(ctx, await catalogOrderState(ctx), input);
}

// 两类共享同一次完整目录读取和编排，再各自筛选、分页。
// 每张卡能打开几条片：由已发布的片单数出来，不让后台手打一句"全部"（§14.19 那次就是手打那份漂了）。
// 只数 published：下架的片买家看不见，把它算进分母等于报一个打不开的数字。
export async function planCoverage(ctx) {
  const state = await catalogOrderState(ctx);
  const published = state.rows.filter((row) => row.status === 'published');
  const byRank = new Map();
  for (const row of published) {
    const rank = Number(row.tier_rank) || 0;
    byRank.set(rank, (byRank.get(rank) ?? 0) + 1);
  }
  return { total: published.length, byRank: [...byRank.entries()].sort((a, b) => a[0] - b[0]) };
}

export function visibleFilmCountFor(coverage, rank) {
  const limit = Number(rank) || 0;
  return coverage.byRank.reduce((sum, one) => (one[0] <= limit ? sum + one[1] : sum), 0);
}

export async function libraryTabs(ctx, input = {}) {
  const state = await catalogOrderState(ctx);
  const pages = await Promise.all(VIDEO_KINDS.map((kind) => libraryPage(ctx, state, { ...input, kind })));
  // "最近更新" describes publication time, even when the owner has moved that
  // lesson beyond the first directory page. Derive it from the complete collection.
  const recent = [];
  for (const [displayOrder, row] of state.rows.entries()) {
    const access = ctx.accessFor(row);
    if (access === 'hidden') continue;
    recent.push({ ...publicVideo(row, { access, rank: ctx.rank }), displayOrder });
  }
  const stamp = (item) => Number.isFinite(Date.parse(item.publishedAt)) ? Date.parse(item.publishedAt) : 0;
  recent.sort((a, b) => stamp(b) - stamp(a) || String(b.id).localeCompare(String(a.id)));
  let series = []; let seriesError = null;
  try { series = await seriesSummaries(ctx,state.rows); } catch { seriesError = 'lesson_series_unavailable'; }
  return {
    series, seriesError,
    ...Object.fromEntries(VIDEO_KINDS.map((kind, index) => [kind, pages[index]])),
    latest: { items: recent.slice(0, 3), featured: recent.find((item) => item.hasPoster) ?? recent[0] ?? null },
  };
}

function orderEditorResponse(ctx, state) {
  return {
    items: state.rows.map((row, displayOrder) => ({ ...publicVideo(row, { privileged: true, access: ctx.accessFor(row), rank: ctx.rank }), displayOrder })),
    revision: state.revision,
    manual: state.manual,
  };
}

export async function adminCatalogOrder(ctx) {
  return orderEditorResponse(ctx, await catalogOrderState(ctx));
}

export async function adminCatalogOrderSave(ctx, input) {
  return orderEditorResponse(ctx, await saveCatalogOrder(ctx, input));
}

export async function adminVideos(ctx, { offset, limit }) {
  const page = await ctx.store.listVideos({ onlyPublished: false, offset, limit });
  const items = page.items.map((row) => publicVideo(row, { privileged: true, access: ctx.accessFor(row), rank: ctx.rank }));
  return { items, hasMore: page.hasMore, nextOffset: page.nextOffset };
}

export async function unsealCipher(ctx, video) {
  if (!video.key_cipher) throw new DataError('video_not_ready');
  if (!video.authentic) throw new DataError('video_tampered');
  const raw = await open(ctx.dataKey, video.key_cipher);
  const parsed = JSON.parse(raw);
  const cipher = { key: parsed.key, nonce: parsed.nonce, chunkSize: Number(video.chunk_size) };
  if (!isValidCipher(cipher)) throw new DataError('cipher_invalid');
  return cipher;
}

export const limits = { MAX_VIDEO_BYTES, MAX_POSTER_BYTES, CHUNK_SIZE, ALLOWED_TYPES };

function projectSeries(ctx,metadata,rows) {
  const available=new Map(rows.filter(row=>row.status==='published' && row.authentic!==false && ctx.accessFor(row)!=='hidden').map(row=>[row.id,row]));
  return metadata.filter(item=>item.published).map(item=>{
    const items=item.videoIds.filter(id=>available.has(id)).map((id,index)=>({...publicVideo(available.get(id),{access:ctx.accessFor(available.get(id)),rank:ctx.rank}),episodeNumber:index+1}));
    return {id:item.id,title:item.title,description:item.description,characterTags:item.characterTags,workTags:item.workTags,
      episodeCount:items.length,totalDurationSeconds:items.reduce((sum,video)=>sum+Math.max(0,Number(video.durationSeconds)||0),0),
      durationIncomplete:items.some(video=>!(Number(video.durationSeconds)>0)),cover:items.find(video=>video.hasPoster)??null,items};
  }).filter(item=>item.items.length);
}
async function seriesSummaries(ctx,rows) {
  const state=await readSeriesState(ctx,rows);
  return projectSeries(ctx,state.series,rows).map(({items,...summary})=>summary);
}
export async function lessonSeries(ctx) {
  return {items:await seriesSummaries(ctx,(await catalogOrderState(ctx)).rows)};
}
export async function lessonSeriesDetail(ctx,input) {
  if ((input.seriesId && !isUuid(input.seriesId)) || (input.videoId && !isUuid(input.videoId)) || (!input.seriesId && !input.videoId)) throw new DataError('lesson_series_not_found');
  const {rows}=await catalogOrderState(ctx); const state=await readSeriesState(ctx,rows);
  const series=projectSeries(ctx,state.series,rows).find(item=>input.seriesId ? item.id===input.seriesId : item.items.some(video=>video.id===input.videoId));
  if (input.seriesId && (!series || (input.videoId && !series.items.some(video=>video.id===input.videoId)))) throw new DataError('lesson_series_not_found');
  return {series:series??null};
}
function seriesEditorResponse(ctx,state,rows) {
  return {series:state.series,revision:state.revision,videos:rows.map(row=>publicVideo(row,{privileged:true,access:ctx.accessFor(row),rank:ctx.rank}))};
}
export async function adminLessonSeries(ctx) {
  const {rows}=await catalogOrderState(ctx);
  return seriesEditorResponse(ctx,await readSeriesState(ctx,rows),rows);
}
export async function adminLessonSeriesSave(ctx,input) {
  const {rows}=await catalogOrderState(ctx); await saveSeries(ctx,input,rows);
  return adminLessonSeries(ctx);
}
