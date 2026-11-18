import { previewBytes, decryptRangePieces, encryptedChunkLength, decryptChunk, chunkCount } from './shared/video-crypto.mjs';
import { readCapped } from './shared/read-bytes.mjs';
import { issuePlayback, readPlayback } from './shared/tokens.mjs';
import { issuePlaybackProof, verifyPlaybackProof, PLAYBACK_PROOF_HEADER } from './shared/playback-proof.mjs';
import { objectPath, unsealCipher, publicVideo, posterUrl, posterVersionOf } from './catalog.mjs';
import { deriveHlsCipher, hlsObjectId, parseHlsHeader, buildPlaylist, buildMasterPlaylist, previewSegmentCount, renditionInfo, PLAYLIST_TYPE, SEGMENT_TYPE, KEY_TYPE } from './shared/hls-bundle.mjs';
import { watermarkText, previewSecondsFor } from './domain.mjs';
import { isUuid, randomId, isoNow } from './shared/util.mjs';
import { DataError } from './db.mjs';

// 一次 Range 响应给 128 MiB。这条站的访问额度按**请求条数**按天算，而烧额度的就是取流：
// 库里最长那条（419 MB / 14 分半）在 8 MiB 窗口下要 53 次对外请求，32 MiB → 14 次，64 MiB → 7 次，
// 128 MiB → 4 次。响应是边取边发的（下面 serveMedia），窗口不再决定单次请求的内存，
// 所以这里的约束换成了另外两条：一次调用能读多少片（平台没写，要在线上探），
// 以及"点开就走"的人一次浪费多少字节。
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
// 预取窗口：边缘到对象存储每一片都要一个来回，逐片取会把一个窗口拖成上百个来回。
export const PARALLEL_CHUNKS = 8;
// 每人每分钟的字节日预算。判据是"不能挡住合法的最坏情况"：站内允许 1 GiB 的片，
// 8 Mbps 看一小时就要 ~60 MiB/分钟，而快进会重复取整个窗口 —— 所以它按窗口大小跟着放大，
// 固定 256 MiB 在 64 MiB 窗口下等于一个人快进四次就被判成爬虫。
// 但窗口翻倍不等于预算也能跟着无限翻倍：上限钉在 1 GiB/分钟，否则 128 MiB 窗口按八倍算出来是
// "一个网段一分钟可以拉走 8 GiB"，那不叫限成本。
// 匿名访客按网段前缀共用一个键，所以这个闸门是限成本，不是硬配额（每个边缘实例各算各的）。
export const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_FLOOR_BYTES = 256 * 1024 * 1024;
const THROTTLE_CEILING_BYTES = 1024 * 1024 * 1024;
export const THROTTLE_BYTES_PER_WINDOW = Math.min(
  THROTTLE_CEILING_BYTES,
  Math.max(THROTTLE_FLOOR_BYTES, 8 * MAX_RESPONSE_BYTES),
);
const transferLedger = new Map();

export function throttleKey(ctx) {
  // Anonymous viewers all share the subject 'anon', so keying the damper on it
  // alone would let one scraper exhaust the budget for everyone on the isolate.
  // ctx.ip is already reduced to a prefix, so no full address is retained.
  return ctx.viewer?.user?.id ?? `anon:${ctx.ip}`;
}

function throttle(subject, now = Date.now()) {
  const key = String(subject);
  const entry = transferLedger.get(key);
  if (!entry || now - entry.started > THROTTLE_WINDOW_MS) {
    transferLedger.set(key, { started: now, bytes: 0 });
    if (transferLedger.size > 500) {
      for (const [stale, value] of transferLedger) {
        if (now - value.started > THROTTLE_WINDOW_MS) transferLedger.delete(stale);
      }
    }
    return 0;
  }
  return entry.bytes;
}

// 这一分钟真往外发了多少字节。闸门只认这个数，不认"请求里写的窗口有多大"。
export function transferUsed(subject, now = Date.now()) {
  return throttle(subject, now);
}

export function recordTransfer(subject, bytes, now = Date.now()) {
  const entry = transferLedger.get(String(subject));
  if (!entry) return;
  entry.bytes += bytes;
}

// 这句要给站长看，所以窗口和上限都从常数里长出来，不在文案里另抄一份。
// 这里以前写死「一天内的传输量到顶」，而闸门看的是 60 秒：买家被 429 的时候，
// 站长会以为他被锁了一整天，从而去改"每日额度"或者去道歉 —— 实际上一分钟就好了。
export const budgetNote = (damperKey) => `这一 ${THROTTLE_WINDOW_MS / 1000} 秒内往外发的量到了顶`
  + `（上限 ${Math.round(THROTTLE_BYTES_PER_WINDOW / 1048576)} MiB，键 ${damperKey}），这一条没给字节 —— 下个窗口就重新计，不是当天上限`;

// 「一个账号同时开几路」。端口只有 20 Mbps，一条片 2.7 Mbps ⇒ 满打满算约 7 路，
// 两个人同时看就把所有人拖成"5 秒一卡"，而"一个激活码几个人共用"是他卖码之后最常见的用法。
// 一路的身份是**这条片**，不是这次的令牌。第一版按令牌算，结果把我自己的验收探针掐了：
// 令牌每次点开放行都换一把，于是"一分钟内连看三条片"这种最正常的用法被数成"同时开三路"。
// 窗口跟着从 60 秒收到 15 秒 —— 正在放的一路每 2~4 秒就来取一段，中途走掉的路十几秒内自动出数；
// 暂停超过 15 秒本来就没在占带宽，让它出数不算放水。
//
// 只数**登录账号的完整版播放**，两件事是故意的：
// ① 匿名试看共用 `anon:<网段前缀>` 这个键，而手机流量走运营商级 NAT，一条基站能把几十个访客
//    挤在同一个前缀下 —— 拿它当"账号"来掐，掐的是自己门口最想留的人；
// ② 站长豁免。他要同时开两个窗口取封面帧、和产物对字节，被自己的规则挡在片外是这站反复犯过的错。
const STREAM_WINDOW_MS = 15_000;
const STREAM_MAX_PER_ACCOUNT = 2;
const streamLedger = new Map();

function activeStreams(subject, now) {
  const lanes = streamLedger.get(String(subject));
  if (!lanes) return null;
  for (const [key, seen] of lanes) if (now - seen > STREAM_WINDOW_MS) lanes.delete(key);
  return lanes;
}

export function overStreamLimit({ subject, streamKey, now = Date.now(), max = STREAM_MAX_PER_ACCOUNT }) {
  const lanes = activeStreams(subject, now);
  return Boolean(lanes) && !lanes.has(streamKey) && lanes.size >= max;
}

// 路数是站点设置里改得动的一项（默认还是上面那个常数）。
// 上限夹在 1~8：端口就 20 Mbps，写 50 不会多出带宽，只会让站长以为自己能多卖人。
const streamCap = (ctx) => Math.min(8, Math.max(1, Number(ctx?.settings?.max_concurrent_streams) || STREAM_MAX_PER_ACCOUNT));

export function noteStream({ subject, streamKey, now = Date.now() }) {
  const key = String(subject);
  if (!streamLedger.has(key)) streamLedger.set(key, new Map());
  streamLedger.get(key).set(streamKey, now);
  if (streamLedger.size > 500) {
    for (const [stale, lanes] of streamLedger) {
      for (const [lane, seen] of lanes) if (now - seen > STREAM_WINDOW_MS) lanes.delete(lane);
      if (!lanes.size) streamLedger.delete(stale);
    }
  }
}

// 「整片拖走」闸门。手机浏览器壳自己嗅探出来的「下载」按钮删不掉（播放器早就写了
// controlsList="nodownload"），能做的只有识别出"几分钟取走整片"这个行为。
// 判据：去重后真正到手的字节 ≥ 整片 95%，且墙上时间 < 片长的 25%（也就是快过 4 倍速）。
// 4 倍速这条线是照着"最激进的合法倍速"留的：iOS Safari 原生控件最高 2×，安卓壳里见过 3×，
// 掐在 4× 以上就不会把倍速党误伤；而实测公网单流 1.1 MB/s、端口 2.5 MB/s，
// 拖片的人对一条 2.9 Mbps 的片是 3～8 倍速，正好落进这条线以外。
// 试算（tmp/check-grab-gate.mjs）：1× / 2× / 3.5× 看完都不掐，只拖 6 分钟不掐，
// 换一条片不掐，5 分钟拖完整片掐。误判 30 分钟后自动解除，重启服务立刻清。
const GRAB_MIN_BYTES = 32 * 1024 * 1024;
const GRAB_SHARE = 0.95;
const GRAB_TIME_SHARE = 0.25;
const GRAB_COOLDOWN_MS = 30 * 60 * 1000;
const GRAB_BLOCKS_PLAYBACK = true;
const grabLedger = new Map();

function liveGrabEntry(key, now) {
  const entry = grabLedger.get(key);
  if (!entry || now - entry.started > GRAB_COOLDOWN_MS) return null;
  return entry;
}

// 掐人那一条给站长的句子。后台原先只写「已掐（键 …）」，三件事他都得猜：掐的是这个人还是这一条片、
// 什么时候解开、有没有杠杆。写清楚的成本是一行，猜错的成本是他去道歉或者去重启服务。
// 数从账本里长出来（flaggedTaken/flaggedTotal 是判定那一刻记下的），不在界面上另抄一份阈值。
// 「只记不掐」那一档（GRAB_BLOCKS_PLAYBACK=false）回 null：那种模式下根本没有掐人这回事，
// 挂了开关还回一句"已掐"就是假话，而这句话和那道掐人的闸必须由同一个开关说了算。
export function grabBlockInfo({ videoId, subject, now = Date.now() }) {
  if (!GRAB_BLOCKS_PLAYBACK) return null;
  const entry = liveGrabEntry(`${subject}:${videoId}`, now);
  if (!entry?.flagged) return null;
  const leftMs = GRAB_COOLDOWN_MS - (now - entry.started);
  const minutesLeft = Math.max(1, Math.ceil(leftMs / 60_000));
  const miB = (value) => Math.round(value / 1048576);
  return {
    minutesLeft,
    notice: (entry.flagReason === 'partial_second_strike'
      // 两句都得让站长一眼看出"为什么掐"，而原因只有两种，所以由 flagReason 决定，不在别处重抄。
      ? '这是这条片 24 小时内第二次取走大半，第二下直接掐。'
      : '')
      + `掐的是这一条片，不是这个人：判定那一刻取走 ${miB(entry.flaggedTaken ?? 0)}/${miB(entry.flaggedTotal ?? 0)} MiB，`
      + `约 ${minutesLeft} 分钟后自己解除（别的片照看；重启服务会立刻清掉这本账）`,
  };
}

// 记一行"比正常看快得多、而且已经取走大半"的等级线。它**不掐人**，只把事留在后台：
// 掐人的那条线要 95% 字节 + 快过 4 倍，落在它下面、又明显不是人在看的取用（3 倍速刷完整条课、
// 半路把整条片拖走）以前一条都不留 —— 站长要看的是"这个人拿走了多少"，不是"我掐了谁"。
// 判据用速率而不是墙上时间占比：短片用时间占比会在"正常看完一条 20 秒的片"上误报
// （播放器几秒就把整条缓冲完了），按这条片自己的码率折算倍数才和片长无关。
// 这一档的"片要多大才记"直接由上面那条 GRAB_MIN_BYTES 决定（它在更前面就把小片整条 return 掉了），
// 所以这里不再另设一个 MiB 下限 —— 以前那个 16 MiB 的地板永远数不到（60% × 32 MiB 已经比它高），
// 却被导出成后台阈值表的一格，等于给站长印一个不生效的数。
const PARTIAL_SHARE = 0.6;
const PARTIAL_RATE_TIMES = 2.5;
// 这一档第二下才掐：第一次可能是真学员在刷课，隔天对同一条片再来一遍取走大半的，不给第三次。
// 窗口用 24 小时而不是上面那 30 分钟 —— 30 分钟记的是"这一次会话"，而"歇一会儿再来"正是拖片的走法。
const PARTIAL_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
const partialLedger = new Map();

// 掐人和那行"取走几成"看的是**去重之后真正到手的字节**：来回拖进度条会把同一段再取一遍，
// 按线上传输量算，一个人好好看片也能被记成"拖走 63%"，再多拖一点就会被掐。
// "快不快"仍然按线上传输量判（那是带宽问题），"拿到多少"必须去重。
// 去重记的是**占整条片的比例**而不是字节偏移：同一条片在高清与流畅之间切档是常事（自动抬档就是这条路的），
// 而两档的整条大小差一倍多 —— 拿高清那半条的字节偏移去和流畅的整条比大小，会把"看了 60%"记成"取走 100%"，
// 掐人那条线就在这一格把人掐掉。每一档内部码率近似恒定，所以"占整条几成"这一把尺在两档之间是对齐的。
const spanTotal = (spans) => spans.reduce((sum, one) => sum + (one[1] - one[0]), 0);
const addSpan = (spans, start, end) => {
  const sorted = [...spans, [start, end]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const one of sorted) {
    const last = out[out.length - 1];
    if (last && one[0] <= last[1]) last[1] = Math.max(last[1], one[1]);
    else out.push([one[0], one[1]]);
  }
  return out;
};

export function noteGrab({ videoId, subject, plainSize, durationSeconds, bytes, rangeStart, rangeEnd, now = Date.now() }) {
  if (!(Number(durationSeconds) > 0)) return null;
  const key = `${subject}:${videoId}`;
  let entry = liveGrabEntry(key, now);
  if (!entry) {
    entry = { started: now, bytes: 0, spans: null, flagged: false, partial: false };
    grabLedger.set(key, entry);
    if (grabLedger.size > 500) {
      for (const [stale, value] of grabLedger) {
        if (now - value.started > GRAB_COOLDOWN_MS) grabLedger.delete(stale);
      }
    }
  }
  entry.bytes += bytes;
  if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd > rangeStart && Number(plainSize) > 0) {
    entry.spans = addSpan(entry.spans ?? [],
      Math.max(0, rangeStart / plainSize), Math.min(1, rangeEnd / plainSize));
  }
  const distinct = entry.spans ? Math.min(spanTotal(entry.spans), 1) * plainSize : entry.bytes;
  // 小于这条线的片照样记账，但不参与"掐人"：一本 12 MiB 的分段包半站加起来才够看，
  // 以前这里是整条 return，结果是跨片那条线永远数不到短片（sd 档大半都是短片）。
  if (entry.flagged || plainSize < GRAB_MIN_BYTES) return null;
  const elapsedMs = now - entry.started;
  if (distinct >= plainSize * GRAB_SHARE && elapsedMs < durationSeconds * 1000 * GRAB_TIME_SHARE) {
    entry.flagged = true;
    entry.flaggedTaken = distinct;
    entry.flaggedTotal = plainSize;
    console.warn(`疑似整片拖走${GRAB_BLOCKS_PLAYBACK ? '（已掐断）' : '（只记录，未掐断）'} subject=${subject} video=${videoId} 取走(去重)=${Math.round(distinct / 1048576)}MiB/共${Math.round(plainSize / 1048576)}MiB 线上发出=${Math.round(entry.bytes / 1048576)}MiB 用时=${Math.round(elapsedMs / 1000)}s 片长=${Math.round(durationSeconds)}s`);
    return null;
  }
  if (entry.partial) return null;
  const filmRate = plainSize / (durationSeconds * 1000);
  if (distinct < plainSize * PARTIAL_SHARE) return null;
  if (!(filmRate > 0) || elapsedMs <= 0 || entry.bytes / elapsedMs < filmRate * PARTIAL_RATE_TIMES) return null;
  entry.partial = true;
  const miB = (value) => Math.round(value / 1048576);
  const dup = entry.bytes - distinct;
  const strikes = countPartialStrike(key, now);
  // 第二下落回上面那条掐人的路：entry.flagged 一置，grabBlockInfo 就有数，
  // serveHls / serveMedia 那两处的 deny(403, 'bulk_grab_suspected') 自动接住，不另起一套闸。
  if (strikes >= 2) {
    entry.flagged = true;
    entry.flaggedTaken = distinct;
    entry.flaggedTotal = plainSize;
    entry.flagReason = 'partial_second_strike';
    console.warn(`半档二犯掐断 subject=${subject} video=${videoId} 24小时内第${strikes}次 取走(去重)=${miB(distinct)}MiB/共${miB(plainSize)}MiB`);
  }
  return {
    videoId, subject,
    // 第二下是一件不同的事：第一下只是"看着不像人"，第二下是"这个人这条片已经被掐"。
    // 分成两个动作码，清单那一路才能按 severity 把它摆到台面上（同一动作码下按文案判高低会把
    // 判据写进字符串里 —— 文案一改，分类就漂）。
    action: strikes >= 2 ? 'media_partial_cut' : 'media_bulk_partial',
    detail: `取走这条片 ${Math.round((distinct / plainSize) * 100)}%（${miB(distinct)} MiB，整条 ${miB(plainSize)} MiB`
      + (dup > 1048576 ? `，另外重复取用 ${miB(dup)} MiB：来回拖进度条会把同一段再取一遍，没算进这个百分比` : '')
      + `），速度是正常观看的 ${(entry.bytes / elapsedMs / filmRate).toFixed(1)} 倍 —— `
      + (strikes >= 2 ? `24 小时内第 ${strikes} 次，已掐` : '这条只记，没掐'),
  };
}

// 每次越这一档的线记一笔，24 小时外的自动不看。账本和拖片那本同构：都在进程内存里，
// 重启即清 —— 所以这一档的"二犯"跨不过一次部署，够用但不假装是持久记录。
function countPartialStrike(key, now) {
  const kept = (partialLedger.get(key) ?? []).filter((at) => now - at < PARTIAL_STRIKE_WINDOW_MS);
  kept.push(now);
  partialLedger.set(key, kept);
  if (partialLedger.size > 500) {
    for (const [stale, stamps] of partialLedger) {
      if (now - (stamps[stamps.length - 1] ?? 0) >= PARTIAL_STRIKE_WINDOW_MS) partialLedger.delete(stale);
    }
  }
  return kept.length;
}

// 「半天站被一个人搬走」看的是跨片，不是单片。上面那两条线只对一条片成立，而 2026-10-15 晚上
// 真发生的事是：16:22–17:31 同一个键把 17 条片各取走大半（合计 920 MiB）——
// 每条都不到 95%，所以一条都不响；日预算那条线又是进程内存里的，服务一重启就归零。
// 判据：同一个键在 90 分钟内让 ≥ 8 条片各自取到 ≥ 半档，就记一行。
// 只记不掐：掐下去会误伤一口气刷完八条课的真学员，那是站长的决定，不是这里能替他定的；
// 这一行的作用是让这件事在后台看得见、事后查得到是谁、在哪一条片上被发现。
const SWEEP_WINDOW_MS = 90 * 60 * 1000;
const SWEEP_MIN_FILMS = 8;
const SWEEP_FILM_SHARE = 0.5;
const sweepLedger = new Map();

// 返回这次越线时已数到的片数，没越线返回 0。累计字节直接读拖片账本（noteGrab 刚写过），
// 所以这里不另开一份"每人每条片取了多少"的账 —— 两份账迟早会给出两个数。
export function noteSweep({ subject, videoId, plainSize, now = Date.now() }) {
  const key = String(subject ?? '');
  if (!key || !(plainSize > 0) || !videoId) return 0;
  let entry = sweepLedger.get(key);
  if (!entry || now - entry.started > SWEEP_WINDOW_MS) {
    entry = { started: now, half: new Set() };
    sweepLedger.set(key, entry);
    if (sweepLedger.size > 500) {
      for (const [stale, value] of sweepLedger) {
        if (now - value.started > SWEEP_WINDOW_MS) sweepLedger.delete(stale);
      }
    }
  }
  // 和单片那两条线同一本账：**去重之后**真正拿到大半条才算数，来回拖进度条不该被数成"搬站"。
  // 账本里存的是"占整条几成"（见 noteGrab 上面那段），所以这里乘当前这一档的整条大小。
  const grab = liveGrabEntry(`${key}:${videoId}`, now);
  const taken = grab ? (grab.spans ? Math.min(spanTotal(grab.spans), 1) * plainSize : grab.bytes) : 0;
  if (taken >= plainSize * SWEEP_FILM_SHARE) entry.half.add(videoId);
  return entry.half.size >= SWEEP_MIN_FILMS ? entry.half.size : 0;
}

// 同一个键在一个窗口里只留一行（越线之后每取一段都会再满足条件，不挡住就是几十行）。
const sweepNoted = new Map();
export function sweepAlreadyNoted(subject, now = Date.now()) {
  const seen = sweepNoted.get(String(subject ?? ''));
  return typeof seen === 'number' && now - seen < SWEEP_WINDOW_MS;
}
export function markSweepNoted(subject, now = Date.now()) {
  sweepNoted.set(String(subject ?? ''), now);
  if (sweepNoted.size > 500) {
    for (const [stale, seen] of sweepNoted) {
      if (now - seen > SWEEP_WINDOW_MS) sweepNoted.delete(stale);
    }
  }
}

// ---- HLS 分段包 ----
// 一条片除了原来那份 mp4，还可以带一个分段包（dev/package-hls.mjs 打的）：播放列表 +
// 几十个已经用 AES-128 加密好的小段，整包再套一层站点自己的分片加密，密钥是从这条片那把
// 派生出来的另一把（规矩写在 shared/hls-bundle.mjs 顶上）。
// 目的只有一个：手机浏览器壳那个"下载"存下来的是一堆打不开的碎片，而播放器自己会来取列表和密钥。
const hlsCache = new Map();

// "这条片打没打分段包"在站内只算这一次：a=play 用它决定发 m3u8 还是发 mp4，
// a=media 用它决定要不要拒掉整片取用。两处各问一遍迟早会给出不一样的答案，
// 而两边不一致正是这里要防的那个漏（发的是分段地址、整片却还放行）。
async function hasHlsBundle(ctx, videoId, rendition = 'hd') {
  return ctx.storage.__has(objectPath(hlsObjectId(videoId, rendition), 0));
}

// 这条片该发哪一档：低码率档（sd）在就发它，不在才发原来那档（hd），两档都没有才算没打包。
// `?q=hd` 是给站长和将来那个"高清"入口留的出口，不是绕过权限的口子 —— 走的是同一个令牌、同一套模式判断。
export async function pickHlsRendition(ctx, videoId, requested = '') {
  if (requested === 'hd' && await hasHlsBundle(ctx, videoId, 'hd')) return 'hd';
  if (await hasHlsBundle(ctx, videoId, 'sd')) return 'sd';
  return await hasHlsBundle(ctx, videoId, 'hd') ? 'hd' : null;
}

// 界面上那句"自动 / 高清 / 流畅"的中文只在这一处定义：客户端照 qualities 渲染，
// 不在前端再抄一份档位名字（抄两份必漂，这个站已经栽过好几次）。
export const QUALITY_LABELS = { auto: '自动（推荐）', sd: '流畅（省流量）', hd: '高清' };

// 心跳允许报到"片尾之后再过 120 秒"（最后一秒取整、拖到结尾都会落在这一带）。
// 后台判"这条数据不对"必须用同一个宽度，否则闸门放行的行会被看板报成"片长写错了"。
export const PROGRESS_SLACK_SECONDS = 120;

// 「看完」的那条线：看到片尾的几成才算看完。它和拖片判定那条 `GRAB_SHARE` 是**两件不同的事**
// （这一条量的是进度位置 ÷ 片长，那一条量的是取走的字节 ÷ 文件大小），以前界面上两句都印
// `grabShare` 那个 95%，改拖片阈值会把「看完」的统计口径一起改掉而没人知道。
export const WATCHED_SHARE = 0.95;

export async function listHlsRenditions(ctx, videoId) {
  const out = [];
  for (const name of ['sd', 'hd']) if (await hasHlsBundle(ctx, videoId, name)) out.push(name);
  return out;
}

// 一次播放该给什么地址：两档都在 → 主列表（播放器自己按带宽挑，网好会升回 1080p）；
// 只有一档 → 直接给那一档的媒体列表；观众显式点了某档（?q=sd / ?q=hd）→ 钉住那一档，不出主列表。
export async function planPlayback(ctx, videoId, requested) {
  const renditions = await listHlsRenditions(ctx, videoId);
  if (!renditions.length) return { renditions, mode: null, rendition: null };
  if (requested === 'sd' || requested === 'hd') {
    const one = renditions.includes(requested) ? requested : renditions.at(-1);
    return { renditions, mode: 'single', rendition: one };
  }
  if (renditions.length >= 2) return { renditions, mode: 'master', rendition: 'auto' };
  return { renditions, mode: 'single', rendition: renditions[0] };
}

async function loadHlsBundle({ ctx, video, rendition = 'hd' }) {
  const parent = await unsealCipher(ctx, video);
  const cipher = deriveHlsCipher(parent, rendition);
  const objectId = hlsObjectId(video.id, rendition);
  const cacheKey = `${video.id}:${rendition}:${video.updated_at ?? ''}:${cipher.key}`;
  if (hlsCache.has(cacheKey)) return hlsCache.get(cacheKey);
  if (!(await ctx.storage.__has(objectPath(objectId, 0)))) return null;
  const object = await ctx.storage.download(objectPath(objectId, 0));
  const first = Buffer.from(await object.arrayBuffer());
  const plain = Buffer.from(await decryptChunk(new Uint8Array(first), cipher, 0));
  const header = parseHlsHeader(plain);
  const entry = {
    cipher,
    objectId,
    header,
    bodyAt: 4 + plain.readUInt32BE(0),
    bundleBytes: 4 + plain.readUInt32BE(0) + header.bodyBytes,
  };
  if (hlsCache.size > 200) hlsCache.clear();
  hlsCache.set(cacheKey, entry);
  return entry;
}

// 整包的第 0 片一定装着列表头（头长度上限 1 MiB），其余按绝对字节区间取覆盖到的那几片。
// 这里不借 decryptRangePieces：它的入参是"往外发的窗口"，而分段要的是一小段精确区间，
// 自己按片解 + 切片更好核对，也少一处语义要记在脑子里的边界。
async function readBundleRange({ ctx, entry, start, length }) {
  const size = entry.cipher.chunkSize;
  const out = Buffer.alloc(length);
  for (let index = Math.floor(start / size); index * size < start + length; index += 1) {
    const object = await ctx.storage.download(objectPath(entry.objectId, index));
    const bytes = new Uint8Array(await object.arrayBuffer());
    const plain = Buffer.from(await decryptChunk(bytes, entry.cipher, index));
    const absFrom = Math.max(start, index * size);
    const absTo = Math.min(start + length, index * size + plain.byteLength);
    if (absTo > absFrom) plain.copy(out, absFrom - start, absFrom - index * size, absTo - index * size);
  }
  return out;
}

const hlsFail = (status, message) => new Response(message, {
  status,
  headers: { 'content-type': 'text/plain;charset=utf-8', 'cache-control': 'no-store' },
});

// 三种取用：列表（按这次会话的令牌改写每一行地址）、密钥（令牌有效才给）、某一段。
// 试看模式下列表会被截到 previewSeconds 以内，而"某一段"用同一个段数放行 ——
// 买家手机上进度条的尽头就是试看的尽头，把地址里的编号往后加也一样拿不到东西。
export async function serveHls({ ctx, video, token, mode, kind, segmentIndex, subject, rendition = 'hd' }) {
  // 主列表先接、先返回：它要同时读两档的头，和"这一路看哪一档"没有关系。
  if (kind === 'master') {
    const variants = [];
    for (const name of ['sd', 'hd']) {
      let one = null;
      try {
        one = await loadHlsBundle({ ctx, video, rendition: name });
      } catch (error) {
        console.error(`hls master variant unreadable video=${video.id} rendition=${name} type=${error?.name}`);
      }
      if (one) variants.push({ rendition: name, header: one.header });
    }
    if (variants.length < 2) return hlsFail(404, 'master needs two renditions');
    let built;
    try {
      built = buildMasterPlaylist({ variants, videoId: video.id, token });
    } catch (error) {
      return hlsFail(410, `video data incomplete: ${error?.name ?? ''}`);
    }
    const body = Buffer.from(built.text, 'utf8');
    recordTransfer(subject, body.byteLength);
    return new Response(body, {
      status: 200,
      headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-type': PLAYLIST_TYPE, 'content-length': String(body.byteLength) },
    });
  }
  let entry = null;
  try {
    entry = await loadHlsBundle({ ctx, video, rendition });
  } catch (error) {
    console.error(`hls bundle unreadable video=${video.id} type=${error?.name}`);
    return hlsFail(410, 'video data incomplete');
  }
  if (!entry) return hlsFail(404, 'hls not packaged');
  // 试看给到第几段，只在这里算一次：下面既用它截断列表，也用它放行取段。
  // 以前只有列表截断、取段那一支只看令牌不看编号，于是"把地址里的 n 一位一位往后加"
  // 就能拿走整片 —— 而密钥那一支对试看令牌也是开的（播放器解自己那几段必须要它）。
  const previewSeconds = mode === 'preview' ? Math.max(1, previewSecondsFor(video)) : 0;
  let allowedSegments = 0;
  try {
    allowedSegments = previewSegmentCount(entry.header, previewSeconds);
  } catch {
    return hlsFail(410, 'video data incomplete');
  }
  const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
  if (kind === 'key') {
    const key = Buffer.from(entry.header.key, 'hex');
    if (key.byteLength !== 16) return hlsFail(410, 'video data incomplete');
    recordTransfer(subject, key.byteLength);
    return new Response(key, { status: 200, headers: { ...headers, 'content-type': KEY_TYPE } });
  }
  if (kind === 'seg') {
    const index = Number(segmentIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= entry.header.segments.length) {
      return hlsFail(404, 'segment not found');
    }
    if (index >= allowedSegments) {
      await noteBehavior(ctx, 'media_preview_overrun', video.id, `试看只给到第 ${allowedSegments - 1} 段，这次要的是第 ${index} 段（键 ${subject}）`);
      return hlsFail(403, 'segment beyond preview');
    }
    const seg = entry.header.segments[index];
    const start = entry.bodyAt + seg.offset;
    let body;
    try {
      body = await readBundleRange({ ctx, entry, start, length: seg.bytes });
    } catch {
      return hlsFail(410, 'video data incomplete');
    }
    recordTransfer(subject, body.byteLength);
    // 分段这条路上"拖片判定"以前根本不数字节：noteGrab 只挂在整片那条支路里，而整片
    // 早就对非管理员回了 410 —— 症状是一晚上有人取走 920 MiB 分段，后台一行都没有。
    // 判据的分子分母都用这一档自己的数：包大小和这一档的秒数，不是 mp4 行里的 plain_size。
    const partialNote = noteGrab({
      videoId: video.id,
      subject,
      plainSize: entry.header.bodyBytes,
      durationSeconds: renditionInfo(entry.header).seconds,
      bytes: body.byteLength,
      // 分段才是这个站真正的看片路（整片对非管理员早就 410），所以去重必须挂在这里：
      // hls.js 卡了会重取同一段、观众拖回去重看一分钟又要那几段，按传输量算的话一个认真看片
      // 的人能被记成"取走 63%"，再拖一点就撞上 95% 那条掐人的线。
      // seg.offset 是相对段体开头的偏移，而段与段首尾相接铺满 bodyBytes，所以它和 plainSize 同一把尺子。
      rangeStart: seg.offset,
      rangeEnd: seg.offset + seg.bytes,
    });
    if (partialNote) {
      await noteBehavior(ctx, partialNote.action ?? 'media_bulk_partial', video.id, partialNote.detail);
    }
    const sweptFilms = noteSweep({ subject, videoId: video.id, plainSize: entry.header.bodyBytes });
    if (sweptFilms > 0 && !sweepAlreadyNoted(subject)) {
      markSweepNoted(subject);
      console.warn(`疑似搬站 subject=${subject} 片数=${sweptFilms} 触发于 video=${video.id}`);
      await noteBehavior(ctx, 'media_library_sweep', video.id,
        `${SWEEP_WINDOW_MS / 60_000} 分钟内这条键把 ${sweptFilms} 条片各取走了大半（单条判据 ≥ ${Math.round(SWEEP_FILM_SHARE * 100)}%，条数判据 ≥ ${SWEEP_MIN_FILMS} 条）`);
    }
    return new Response(body, {
      status: 200,
      headers: { ...headers, 'content-type': SEGMENT_TYPE, 'content-length': String(body.byteLength) },
    });
  }
  if (kind !== 'm3u8') return hlsFail(404, 'not found');
  // buildPlaylist 里 0 的含义是"不截断"（会员完整版就是这么传的），所以试看这一路
  // 绝不能把 0 传下去：preview_seconds 被改成 0 时 decideAccess 本来就该判 locked，
  // 真传了 0 等于把整片列表交出去。兜底成至少 1 秒，也就是至少一段。
  let built;
  try {
    built = buildPlaylist({ header: entry.header, videoId: video.id, token, previewSeconds, rendition });
  } catch {
    return hlsFail(410, 'video data incomplete');
  }
  const body = Buffer.from(built.text, 'utf8');
  recordTransfer(subject, body.byteLength);
  return new Response(body, {
    status: 200,
    headers: { ...headers, 'content-type': PLAYLIST_TYPE, 'content-length': String(body.byteLength) },
  });
}

export function parseRange(header, total) {
  if (total <= 0) return null;
  if (!header) return { start: 0, end: Math.min(total - 1, MAX_RESPONSE_BYTES - 1) };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const count = Number(rawEnd);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    return { start: Math.max(0, total - count), end: total - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= total) return null;
  const wanted = rawEnd === '' ? start + MAX_RESPONSE_BYTES - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(wanted) || wanted < start) return null;
  return { start, end: Math.min(wanted, total - 1, start + MAX_RESPONSE_BYTES - 1) };
}

// 浏览器放 MP4 时会一次要多个区间（Chrome 的经典探测：bytes=0-1023, 4194304- —— 先看文件头，
// 再看中间一段确认 moov）。以前只认单区间，多区间整个被判成 416，于是那条 419 MB / 14 分半的
// 片子卡在 0:00：小文件一个窗口就下完了，走不到这一步，所以只有长片坏。
const RANGE_LIMIT = 4;

export function parseRanges(header, total) {
  if (total <= 0) return [];
  const text = String(header ?? '').trim();
  if (!text) {
    const whole = parseRange(null, total);
    return whole ? [whole] : [];
  }
  if (!/^bytes=/i.test(text)) return [];
  const specs = text.replace(/^bytes=/i, '').split(',').map((part) => part.trim()).filter(Boolean);
  const ranges = [];
  let budget = MAX_RESPONSE_BYTES;
  for (const spec of specs.slice(0, RANGE_LIMIT)) {
    const one = parseRange(`bytes=${spec}`, total);
    if (!one) continue;
    // 每个区间各自也封顶，合起来不超过一次响应能给的量：多区间不能变成"一次要多少给多少"的口子。
    const size = Math.min(one.end - one.start + 1, budget);
    if (size <= 0) break;
    ranges.push({ start: one.start, end: one.start + size - 1 });
    budget -= size;
    if (budget <= 0) break;
  }
  return ranges;
}

export async function issuePlayToken(ctx, { videoId, fallback, quality }) {
  if (!isUuid(videoId)) throw new DataError('video_not_found');
  const video = await ctx.store.findVideo(videoId);
  if (!video) throw new DataError('video_not_found');
  if (video.authentic === false) throw new DataError('video_tampered');
  const mode = ctx.accessFor(video);
  if (mode === 'hidden') throw new DataError('video_not_found');
  if (mode === 'locked') throw new DataError('membership_required');
  if (mode === 'full' && !ctx.viewer?.session?.id) throw new DataError('login_required');
  const subject = ctx.viewer?.user?.id ?? 'anon';
  // 与 issuePlayback 的实际 15 分钟上限一致；受控播放器按需续签而不重挂源。
  const ttl = 900;
  const token = await issuePlayback(ctx.sessionSecret, { videoId, subject, mode, ttlSeconds: ttl });
  // 进度每 30 秒已经写进 watch_logs 了，续播只是把它读回来 —— 只读这个账号自己的行，
  // 匿名试看不读：那条口令对任何 anon 都有效，报位置等于泄露别人看到哪儿。
  const lastRow = mode === 'full' && ctx.viewer
    ? await ctx.store.latestWatchPosition({ userId: subject, videoId: video.id })
    : null;
  const preview = mode === 'preview' ? previewBytes({
    plainSize: Number(video.plain_size),
    durationSeconds: Number(video.duration_seconds) || 0,
    previewSeconds: previewSecondsFor(video),
    chunkSize: Number(video.chunk_size),
  }) : Number(video.plain_size);
  // 打过分段包的视频直接给 m3u8 地址：Safari / 微信 / QQ 浏览器原生就会播 HLS，
  // 桌面 Chrome 那类不原生的由 /assets/hls-shim.js 接手（它认地址里的 hls=m3u8）。
  // 没打包的照旧给 mp4 —— 所以这条是逐条生效、随时可退回，不是全站一刀切。
  let plan = { renditions: [], mode: null, rendition: null };
  try {
    plan = await planPlayback(ctx, videoId, quality);
  } catch (error) {
    console.error(`hls probe failed video=${videoId} type=${error?.name}`);
  }
  // 设备两种播法都失败时，脚本会带着 fallback=mp4 再来要一次地址。**只有试看这一档允许退**：
  // 匿名试看的 mp4 路本来就只给 previewBytes 那个字节窗口（服务端算的，不是客户端），
  // 退过去一个字节都多给不了，却能让"免费试看"这个入口在任何设备上都不至于死掉。
  // 会员不能退 —— 整片 mp4 交出去等于这一路加密白做，所以 mode 不是 preview 时这个参数直接忽略。
  const useHls = Boolean(plan.rendition) && !(fallback === 'mp4' && mode === 'preview');
  const proof = mode === 'full' ? await issuePlaybackProof(ctx.sessionSecret, {
    videoId, subject, sessionId: ctx.viewer?.session?.id,
  }) : null;
  const mediaBase = `/functions/v1/app?a=media&v=${encodeURIComponent(videoId)}&pt=${encodeURIComponent(token)}`;
  const hlsUrl = plan.mode === 'master' ? `${mediaBase}&hls=master`
    : `${mediaBase}&hls=m3u8${plan.rendition === 'hd' ? '' : `&q=${plan.rendition}`}`;
  return {
    video: publicVideo(video, { access: mode, rank: ctx.rank }),
    mode,
    hls: useHls,
    hlsPackaged: Boolean(plan.rendition),
    // 发出去的是哪一档，界面要能说出来（"当前：自动"），排查时也是唯一能对上号的字段。
    quality: useHls ? plan.rendition : null,
    // 档位名字与可选档位由服务端给：界面只负责排版，不在客户端再抄一份中文。
    // "自动"只在真的有两个档时列出来 —— 给一条只有一档的片挂个"自动"是句假话。
    qualities: useHls ? [
      ...(plan.mode === 'master' ? [{ rendition: 'auto', label: QUALITY_LABELS.auto }] : []),
      ...plan.renditions.map((r) => ({ rendition: r, label: QUALITY_LABELS[r] })),
    ] : [],
    protectedPlayback: mode === 'full',
    playbackProof: proof,
    // 未处理的视频不发完整 MP4；等待后台生成分段包。
    mediaUrl: mode === 'full' && !useHls ? null : useHls ? hlsUrl : mediaBase,
    expiresInSeconds: ttl,
    lastPosition: lastRow ? Number(lastRow.position_seconds) : null,
    previewBytes: mode === 'preview' ? preview : null,
    watermark: watermarkText({
      settings: ctx.settings,
      user: ctx.viewer?.user ?? null,
      video,
      mode,
      deviceLabel: ctx.viewer?.session?.device_label ?? null,
    }),
    // Same origin on purpose: the document's CSP only allows images from 'self', so a
    // signed bucket URL would leave the player showing a black box before the first frame.
    posterUrl: video.poster_path ? posterUrl(video.id, posterVersionOf(video)) : null,
  };
}

// Authorization is re-checked on every byte range, so a membership that expires
// or a session that is revoked mid-play stops receiving data.
export async function serveMedia(ctx) {
  const params = new URL(ctx.request.url).searchParams;
  const videoId = params.get('v') ?? '';
  const token = params.get('pt') ?? '';
  const deny = (status, message) => {
    // 拒绝必须留下一行：今晚有 108 个 403 打在同一个访客的分段请求上，而日志里只有 nginx 的状态码，
    // 分不清是"会员到期"还是"令牌过期"——分不清就没法决定界面上要不要有一句人话告诉他。
    // 只打前缀网段（ctx.ip 本来就是 /24），不打令牌。
    console.warn(`media-denied ${status} ${message} video=${videoId} 网段=${ctx.ip}`);
    return new Response(message, {
      status,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'text/plain; charset=utf-8' },
    });
  };
  if (!isUuid(videoId)) return deny(404, 'video not found');

  const video = await ctx.store.findVideo(videoId);
  if (!video || video.authentic === false) return deny(404, 'video not found');

  const subject = ctx.viewer?.user?.id ?? 'anon';
  const granted = await readPlayback(ctx.sessionSecret, token, { videoId, subject, allowedModes: ['full', 'preview'] });
  if (!granted) return deny(403, 'playback authorization expired');

  const fresh = ctx.accessFor(video);
  if (granted.mode === 'full' && fresh !== 'full') return deny(403, 'membership no longer active');
  if (granted.mode === 'preview' && fresh === 'hidden') return deny(403, 'video unavailable');
  // All full manifests, segments, keys and HEAD pass this gate, including admins.
  if (granted.mode === 'full') {
    const proof = ctx.request.headers.get(PLAYBACK_PROOF_HEADER);
    if (!await verifyPlaybackProof(ctx.sessionSecret, proof, {
      videoId, subject, sessionId: ctx.viewer?.session?.id,
    })) return deny(403, 'protected playback proof required');
    if (!params.get('hls')) return deny(410, 'protected segmented playback only');
  }

  const plainSize = Number(video.plain_size);
  const chunkSize = Number(video.chunk_size);
  if (!Number.isSafeInteger(plainSize) || plainSize <= 0 || !Number.isSafeInteger(chunkSize)) return deny(410, 'video unavailable');

  const allowedTotal = granted.mode === 'preview'
    ? previewBytes({
      plainSize,
      durationSeconds: Number(video.duration_seconds) || 0,
      previewSeconds: previewSecondsFor(video),
      chunkSize,
    })
    : plainSize;
  if (allowedTotal <= 0) return deny(403, 'preview not configured');

  const ranges = parseRanges(ctx.request.headers.get('range'), allowedTotal);
  if (ranges.length === 0) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${allowedTotal}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' } });
  }
  const wantedBytes = ranges.reduce((sum, one) => sum + (one.end - one.start + 1), 0);
  // 字节日闸门按"真的往外发了多少"计（下面 pieces 里逐片记），不按"这一窗多大"计：
  // 人中途走了不该继续扣他的预算。匿名按网段前缀分键，登录按账号分键。
  // 这里不能把 wantedBytes 预扣进去：浏览器读大文件的 moov 时会连发十几个 `bytes=N-` 的探测请求，
  // 每个只取走几百 KB 就断开，但按窗口算每个都要记 128 MiB，几秒就把预算扣光，
  // 症状是长片一律 429、播放器只报一个 MediaError code=4，看不出是限流。
  // 超预算的人在下一次请求被挡；单次最多超出一个窗口（128 MiB），成本仍然有上限。
  const damperKey = throttleKey(ctx);
  if (transferUsed(damperKey) >= THROTTLE_BYTES_PER_WINDOW) {
    await noteBehavior(ctx, 'media_byte_budget', video.id, budgetNote(damperKey));
    return deny(429, 'too much transferred');
  }
  const grabbed = grabBlockInfo({ videoId: video.id, subject: damperKey });
  if (grabbed) {
    await noteBehavior(ctx, 'media_bulk_grab', video.id, `取段速度远超观看速度，判为整片拖取，已掐（键 ${damperKey}）。${grabbed.notice}`);
    return deny(403, 'bulk_grab_suspected');
  }
  // 这个账号已经开着两路了，第三路一个字节都不给（判据与豁免的理由见文件头 STREAM_MAX_PER_ACCOUNT）。
  // 只掐登录账号的完整版：匿名试看共用网段前缀那个键，手机流量是运营商级 NAT，会误伤一整片人。
  if (!ctx.privileged && subject !== 'anon' && granted.mode === 'full'
    && overStreamLimit({ subject, streamKey: video.id, max: streamCap(ctx) })) {
    console.warn(`stream-cap subject=${subject} video=${video.id}`);
    await noteBehavior(ctx, 'media_stream_cap', video.id, `同一账号第三路同时播放，已挡（键 ${subject}）`);
    return deny(429, 'this account is already playing two videos');
  }
  // 记档和挡人用同一个条件：只数完整版。之前记档比判断宽（试看也记进去），
  // 后果是"连看三条试看再点开一条会员片"会把人挡在第二条完整版上。
  if (!ctx.privileged && subject !== 'anon' && granted.mode === 'full') noteStream({ subject, streamKey: video.id });
  // 分段包的三种取用走同一道闸门：令牌、会员是否还在期、字节日预算、拖片判定，一条都不绕。
  // 档位只在这一个地方读：m3u8 的地址带 q，列表里生成的 key/seg 地址也带同一个 q，
  // 所以"这一路看的是哪一档"从播放那一刻起就钉死在地址里，改不了也混不了。
  const hlsKind = params.get('hls');
  if (hlsKind) {
    return serveHls({
      ctx, video, token, mode: granted.mode, kind: hlsKind, segmentIndex: params.get('n'),
      subject: damperKey, rendition: params.get('q') === 'sd' ? 'sd' : 'hd',
    });
  }
  // 打了分段包的片不再接受"不带 hls 参数"的取用：同一个令牌把地址里的 &hls=m3u8 一去掉
  // 照样能整片拖走，那这一路加密就只是装了个样子。判据和上面 a=play 那一处是同一个
  // pickHlsRendition，所以"这条片走哪种播法"在站内只有一处定义。
  // 管理员留整片这条路：封面取帧、和产物字节对账都要读原片。
  // 要把某条退回整片播法不是加参数，而是撤掉那条的分段包（见 runbook 的分段包一节）。
  if (!ctx.privileged && await pickHlsRendition(ctx, video.id)) {
    await noteBehavior(ctx, 'media_wholefile_denied', video.id, '这条已经打了分段包，去掉档位参数想整片拿的请求被拒（410）');
    return deny(410, 'segmented playback only');
  }
  const durationSeconds = Number(video.duration_seconds) || 0;

  let cipher;
  try {
    cipher = await unsealCipher(ctx, video);
  } catch {
    return deny(410, 'video unavailable');
  }

  const contentType = String(video.content_type || 'video/mp4');
  const head = (extra = {}) => ({
    'accept-ranges': 'bytes',
    'content-type': contentType,
    'cache-control': 'private, no-store, max-age=0',
    'content-security-policy': "default-src 'none'",
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    ...extra,
  });

  // HEAD 只是探测，不发正文。以前这一趟也要把整个区间从对象存储取下来解一遍、再把结果丢掉：
  // iOS Safari 每次播放前都先发 HEAD，等于白烧一次取片的钱（区间大小本来就是算得出来的）。
  if (ctx.request.method === 'HEAD') {
    const first = ranges[0];
    // HEAD 只回答第一个区间：探测用的就是它，多区间的 HEAD 没有对应的语义。
    return new Response(null, {
      status: 206,
      headers: head({
        'content-range': `bytes ${first.start}-${first.end}/${allowedTotal}`,
        'content-length': String(first.end - first.start + 1),
      }),
    });
  }

  // 响应边取边发：解到哪一片就交哪一片，交完立刻把密文放掉。窗口因此不再决定这一条请求占多少内存
  // —— 手上只有预取的至多 PARALLEL_CHUNKS 片密文，加上正在交回的那一片明文。
  const cache = new Map();
  const fetchChunks = async (indexes) => {
    const fetched = await Promise.all(indexes.map(async (index) => {
      const expected = encryptedChunkLength(index, plainSize, chunkSize);
      if (expected <= 0) throw new DataError('chunk_read_failed');
      try {
        const object = await ctx.storage.download(objectPath(video.id, index));
        const bytes = await readCapped(object, expected);
        if (bytes.byteLength !== expected) throw new Error('chunk size mismatch');
        return [index, bytes];
      } catch {
        throw new DataError('chunk_read_failed');
      }
    }));
    for (const [index, bytes] of fetched) cache.set(index, bytes);
  };
  const chunkReader = (lastChunk) => async (index) => {
    if (!cache.has(index)) {
      const missing = [];
      // 预取不许越过这一段的末尾：越过就会去读文件外的片，症状是整条请求被判 410。
      for (let i = index; i <= Math.min(lastChunk, index + PARALLEL_CHUNKS - 1); i += 1) {
        if (!cache.has(i)) missing.push(i);
      }
      await fetchChunks(missing);
    }
    return cache.get(index);
  };

  const multipart = ranges.length > 1;
  const boundary = `qoder${randomId().replace(/[^0-9a-z]/gi, '')}`;
  const encode = new TextEncoder();
  let sent = 0;
  // multipart 的分隔文字也算正文长度：content-length 必须等于真的会发出去的字节总数，
  // 少报了浏览器会当成截断，多报了会一直等一个永远不会来的尾巴。
  const sectionHeads = ranges.map((range) => encode.encode(
    `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${range.start}-${range.end}/${allowedTotal}\r\n\r\n`,
  ));
  const crlf = encode.encode('\r\n');
  const closing = encode.encode(`--${boundary}--\r\n`);
  const totalBytes = wantedBytes + (multipart
    ? sectionHeads.reduce((sum, one) => sum + one.byteLength, 0) + crlf.byteLength * ranges.length + closing.byteLength
    : 0);

  async function* pieces() {
    for (const [position, range] of ranges.entries()) {
      if (multipart) yield sectionHeads[position];
      const lastChunk = Math.floor(range.end / chunkSize);
      let cursor = range.start;
      for await (const piece of decryptRangePieces({
        cipher,
        plainSize,
        plainStart: range.start,
        plainEnd: range.end,
        getChunk: chunkReader(lastChunk),
        releaseChunk: (index) => { cache.delete(index); },
      })) {
        sent += piece.byteLength;
        recordTransfer(damperKey, piece.byteLength);
        // 去重那本账记的是"真发出去的字节"，不是请求要的那一整个窗口 —— 和上面 recordTransfer
        // 同一条规矩（那条已经测过：按窗口预扣会把探测当成爬虫）。浏览器半路取消一个大 Range 时，
        // 按窗口记账等于把一个字节都没看到的整片记成"取走 100%"，而下一次请求开头就会被掐。
        noteGrab({ videoId: video.id, subject: damperKey, plainSize, durationSeconds,
          bytes: piece.byteLength, rangeStart: cursor, rangeEnd: cursor + piece.byteLength });
        cursor += piece.byteLength;
        yield piece;
      }
      if (multipart) yield crlf;
    }
    if (multipart) yield closing;
  }

  const gen = pieces();
  // 先把"确实解出了明文"那一段取出来再决定状态码：头一旦发出去就改不了，
  // 而密钥写错、分片根本不存在这类"一条字节都不该发出去"的失败必须仍然是 410。
  const primed = [];
  try {
    for (;;) {
      const { value, done } = await gen.next();
      if (done) break;
      primed.push(value);
      if (sent > 0) break;
    }
    if (sent === 0) throw new DataError('chunk_read_failed');
  } catch {
    return deny(410, 'video data incomplete');
  }

  let queued = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (queued < primed.length) { controller.enqueue(primed[queued]); queued += 1; return; }
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // 已经发出去的头改不了状态码，只能断在半路：浏览器把它当成数据不完整，
        // 播放器那一屏有对应的「这一段没取到 / 重新取一次」。
        console.error(`media stream broke video=${video.id} sent=${sent} type=${error?.name}`);
        controller.close();
      }
    },
    cancel() {
      // 人走了就停在当前这片，不再往后取片、也不再往后扣他的字节日预算。
      void gen.return?.();
    },
  });

  return new Response(stream, {
    status: 206,
    headers: head(multipart
      ? { 'content-type': `multipart/byteranges; boundary=${boundary}`, 'content-length': String(totalBytes) }
      : { 'content-range': `bytes ${ranges[0].start}-${ranges[0].end}/${allowedTotal}`, 'content-length': String(totalBytes) }),
  });
}

export async function reportProgress(ctx, { videoId, position, mode }) {
  if (!ctx.viewer) throw new DataError('login_required');
  if (!isUuid(videoId)) throw new DataError('video_not_found');
  const video = await ctx.store.findVideo(videoId);
  if (!video || ctx.accessFor(video) === 'hidden') throw new DataError('video_not_found');
  const duration = Number(video.duration_seconds) || 0;
  const seconds = Math.round(Number(position));
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > duration + PROGRESS_SLACK_SECONDS) throw new DataError('position_invalid');
  const allowed = ['full', 'preview'];
  const access = allowed.includes(mode) ? mode : 'preview';
  const scope = { userId: ctx.viewer.user.id, videoId: video.id, sessionId: ctx.viewer.session.id };
  const existing = await ctx.store.findWatchLog(scope);
  if (existing) {
    await ctx.store.advanceWatchLog(existing.id, { positionSeconds: seconds, accessMode: access });
  } else {
    await ctx.store.createWatchLog({
      id: randomId(),
      user_id: scope.userId,
      video_id: scope.videoId,
      session_id: scope.sessionId,
      access_mode: access,
      position_seconds: seconds,
      created_at: isoNow(),
      updated_at: isoNow(),
    });
  }
  return { ok: true };
}

// 买家手机上"为什么黑屏"这件事，服务器日志里本来一个字都没有：分片全 200、令牌有效、
// 权限也对，缺的是**设备那一侧**说它自己试了什么。所以让接管脚本回一行，只进 journald、
// 不进库 —— 这是排查用的，不是业务数据，不该跟着每日备份到处走。
// 字段一律按可打印 ASCII 截断：日志里能塞进换行，就能塞进一条假记录。
const REPORT_WINDOW_MS = 60_000;
const REPORT_LIMIT = 12;
const reportBudget = new Map();

// 后台"操作日志"是他今天就看得到、也看得懂的那一块，所以值得记的行为直接写进 audit：
// 不新建表 = 不用改迁移清单，也不用等他点头重打前端产物。
// 去重键把片也带上：一个脚本半分钟里撞同一道闸门 200 次，不该在站长的清单里留 200 行，
// 但"他今天在这三条片上各撞了一次"是三条不同的事实。
const behaviorWritten = new Map();
const BEHAVIOR_REPEAT_MS = 300_000;
async function noteBehavior(ctx, action, videoId, detail) {
  const who = ctx.viewer?.user?.id ?? ctx.ip ?? '-';
  const key = `${action}:${who}:${videoId ?? '-'}`;
  const now = Date.now();
  if (now - (behaviorWritten.get(key) ?? 0) < BEHAVIOR_REPEAT_MS) return;
  behaviorWritten.set(key, now);
  if (behaviorWritten.size > 4096) behaviorWritten.clear();
  try {
    await ctx.store.audit({
      actorId: ctx.viewer?.user?.id ?? null, action, target: videoId ?? null,
      ipPrefix: ctx.ip, detail: String(detail ?? '').slice(0, 200),
    });
  } catch (error) {
    console.warn(`behavior-note-failed ${action} ${error?.message ?? error}`);
  }
}

// 仪表盘要把"这几条线现在画在哪儿"原样说给站长看。数字只在这里有一份定义：
// 前端抄第二份就会漂，而这一类缺陷站内已经犯过几次（阈值改了、界面上还写着旧的）。
export function behaviorRules(ctx = null) {
  return {
    grabMinBytes: GRAB_MIN_BYTES,
    grabShare: GRAB_SHARE,
    grabTimeShare: GRAB_TIME_SHARE,
    grabCooldownMinutes: GRAB_COOLDOWN_MS / 60_000,
    grabBlocksPlayback: GRAB_BLOCKS_PLAYBACK,
    // "只记不掐"那一档：取到这条片多大半、而且比正常看快好几倍，就在后台留一行。
    partialShare: PARTIAL_SHARE,
    partialRateTimes: PARTIAL_RATE_TIMES,
    // 传了 ctx 就报"现在生效的那个数"（站点设置改过的），不传就报常数默认。
    // 界面上写的是生效值 —— 写常数会让人以为改了没用。
    streamMaxPerAccount: ctx ? streamCap(ctx) : STREAM_MAX_PER_ACCOUNT,
    streamCapSetting: 'max_concurrent_streams',
    streamWindowSeconds: STREAM_WINDOW_MS / 1000,
    throttleBytesPerWindow: THROTTLE_BYTES_PER_WINDOW,
    throttleWindowSeconds: THROTTLE_WINDOW_MS / 1000,
    progressSlackSeconds: PROGRESS_SLACK_SECONDS,
    watchedShare: WATCHED_SHARE,
    // 跨片那条线（只记不掐）：界面上必须写清它和"掐人的那条"不是一回事。
    sweepWindowMinutes: SWEEP_WINDOW_MS / 60_000,
    sweepMinFilms: SWEEP_MIN_FILMS,
    sweepFilmShare: SWEEP_FILM_SHARE,
    qualityLabels: QUALITY_LABELS,
  };
}

export function reportPlayback(ctx, input = {}) {
  const ip = ctx.ip ?? 'unknown';
  const now = Date.now();
  const seen = reportBudget.get(ip) ?? { from: now, count: 0, noted: false };
  if (now - seen.from > REPORT_WINDOW_MS) { seen.from = now; seen.count = 0; seen.noted = false; }
  seen.count += 1;
  reportBudget.set(ip, seen);
  if (reportBudget.size > 4096) reportBudget.clear();
  const clean = (value, max) => String(value ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, max);
  const what = clean(input.what, 24);
  if (!/^[a-z0-9_]+$/.test(what)) return { ok: true, rejected: true };
  // 设备上报不一定带着片 id（预览位、还没绑上源的那一刻）。日志行用 '-' 占位没问题，
  // 但**不能把 '-' 当 target 写进库**：后台「按片看」会把这一格当成一条真片，印出"这条已删"。
  const reported = isUuid(String(input.v ?? '')) ? String(input.v) : '';
  const videoId = reported || '-';
  // 限流只管 journald 那一行，不管后台的行为记录：后者按 (行为, 人, 片) 有 5 分钟去重，淹不掉库。
  // 两条共用额度的时候，站长网段里多人同时看会整批丢掉 frag_stats，而 frag_stats 是唯一能分清
  // "线不够"和"设备算不动"的那一行。
  if (seen.count > REPORT_LIMIT) {
    if (!seen.noted) {
      seen.noted = true;
      console.log(`play-report-dropped ip=${ip} 这一分钟超过 ${REPORT_LIMIT} 条，之后的只进后台不再逐条写日志（后台记录不受影响）`);
    }
    noteDeviceBehavior(ctx, what, reported, input);
    return { ok: true, dropped: true };
  }
  console.log(`play-report ${what} video=${videoId} native=${clean(input.native, 10) || '-'} mse=${input.mse === '1' ? '1' : '0'} detail=${clean(input.detail, 120) || '-'} ua=${clean(ctx.request?.headers?.get('user-agent'), 90)}`);
  noteDeviceBehavior(ctx, what, reported, input);
  return { ok: true };
}

// 设备侧自己说出来的两件事，只有它们能给站长看："这一档是谁主动点的"和"他屏幕上实际跑的是几乘几"。
// 原生 HLS 那批设备（Edge / 苹果 / 微信内置）整个不经过 hls.js，档位从服务端一条都看不出来。
// 上报里的 `rs4ns1d176e0 ` 那段是给排障用的状态前缀，写进操作日志只会让人读不懂，剥掉只留事实。
function noteDeviceBehavior(ctx, what, reported, input) {
  const humanDetail = (value) => String(value ?? '').replace(/^rs\d+ns\d+d\w+e\d+\s*/, '').slice(0, 60);
  if (what === 'quality_pick') {
    noteBehavior(ctx, 'viewer_quality_pick', reported, qualityPickNote(input.detail));
  } else if (what === 'quality_switch_failed') {
    noteBehavior(ctx, 'viewer_quality_failed', reported, qualityFailedNote(input.detail));
  } else if (what === 'auto_boost') {
    // 这条必须说得清"不是观众自己点的"：原生那一路不会自己上跳（§13.16 四臂量过），播放器脚本按
    // 实测缓冲推进速度替他抬了一档。印成"自己点了档位"就是假话，站长会照着这条去改档位文案。
    noteBehavior(ctx, 'viewer_auto_boost', reported, `这一路本来给的是自动，实测${humanDetail(input.detail)}，替他抬到高清（他本人没点）`);
  } else if (what === 'auto_release') {
    // 抬档的退路。抬上去之后 hls.js 的档位就钉死了、原生那侧换成固定高清列表，链路中途变差时播放器
    // 不会自己降下来。没有这一笔后台只看得见抬、看不见退，站长就数不出"抬错了多少次"，也就没法判断阈值。
    noteBehavior(ctx, 'viewer_auto_release', reported, `抬到高清后实测${humanDetail(input.detail)}，替他退回自动（他本人没点）`);
  } else if (what === 'rendition_seen') {
    noteBehavior(ctx, 'viewer_rendition', reported, `屏幕上实际在跑的画质：${humanDetail(input.detail)}`);
  } else if (what === 'stall_stats') {
    noteBehavior(ctx, 'viewer_stall', reported, stallNote(input.detail));
  } else if (what === 'frag_stats') {
    noteBehavior(ctx, 'viewer_frag_rate', reported, fragRateNote(input.detail));
  }
}

// 观众按下去的那一档和这一路实际给的那一档，界面上要分开说 —— 站长要看的是"他点了高清，
// 到底给他高清了没有"。原始上报是 `sd->hd` 这种键，直接印出来是行话，他读不出所以然。
const stripState = (value) => String(value ?? '').replace(/^rs\d+ns\d+d\w+e\d+\s*/, '').trim();
const rungLabel = (key) => QUALITY_LABELS[key] ?? key;

export function qualityPickNote(detail) {
  const raw = stripState(detail);
  // 脚本按实测链路速度替他抬档时，上报会多带一个 ASCII 标记（中文会被上报那层的 `clean` 剥掉，所以用 `auto=boost`）。
  // 这一笔绝不能印成"观众点了「高清」"—— 他根本没点，站长会照着这句假话去改档位文案。
  const boosted = /(^|\s)auto=boost(\s|$)/.test(raw);
  const released = /(^|\s)auto=release(\s|$)/.test(raw);
  const fromPref = /(^|\s)auto=pref(\s|$)/.test(raw);
  const m = /^(auto|sd|hd)->(auto|sd|hd)$/.exec(raw.replace(/\s*auto=(?:boost|release|pref)\s*/g, ' ').trim());
  if (fromPref) {
    // 实际播放记录中出现过以下清晰度切换现象。
    // 库里就多出 5 行"观众点了「高清」"。他一次都没点 —— 是播放脚本照着他上次记住的那一档切的。
    // 印成"他点了"，站长会以为买家在反复折腾画质，而去改档位文案；真正该看的"他到底点没点"就被这行假话盖掉。
    return `这一档是他上次自己选过的那一档：这次打开，播放脚本照着切的（他这一次没点）`;
  }
  if (boosted) {
    return `这一档不是观众点的：播放脚本按实测链路速度抬到了「${rungLabel(m?.[2] ?? 'hd')}」`;
  }
  if (released) {
    return `这一档不是观众点的：抬上去之后缓冲跟不上，播放脚本退回了「${rungLabel(m?.[2] ?? 'auto')}」`;
  }
  if (!m) return `观众自己点了档位：${raw.slice(0, 40)}`;
  const [, pressed, given] = m;
  if (pressed === given) return `观众点了「${rungLabel(pressed)}」，这一路给的就是这一档`;
  return `观众点了「${rungLabel(pressed)}」，这一路给的却是「${rungLabel(given)}」—— 没换成他点的那一档`;
}

export function qualityFailedNote(detail) {
  const raw = stripState(detail);
  const m = /^(auto|sd|hd)\s+(?:http\s+(\d{3})|fetch)$/.exec(raw);
  if (!m) return `点了档位但没换成：${raw.slice(0, 40)}`;
  return `观众点了「${rungLabel(m[1])}」，这一路没换成（${m[2] ? `服务端回 ${m[2]}` : '请求没发出去'}）`;
}

// 设备发过来的是 ASCII 计数（n 次 + 毫秒 + 缓冲余量 + 丢帧 + 画面尺寸），给人看的那句话在这里拼：
// 客户端和服务端各写一套说法的话，改了一处另一处就骗人。
export function stallNote(detail) {
  const text = String(detail ?? '');
  const times = Number(/n(\d+)/.exec(text)?.[1] ?? 0);
  const waited = Number(/\+(\d+)ms/.exec(text)?.[1] ?? 0);
  const bufferLeft = Number(/\+buf([\d.]+)s/.exec(text)?.[1] ?? 0);
  const sizeRaw = /(\d{3,4}x\d{3,4})/.exec(text)?.[1];
  const size = sizeRaw ?? (text.includes('+na') ? '尺寸还没出来' : '未知尺寸');
  const droppedRaw = /\+df(\d+)/.exec(text)?.[1];
  const countedRaw = /\+tf(\d+)/.exec(text)?.[1];
  const base = `这一阵卡了 ${times} 次、一共等了 ${(waited / 1000).toFixed(1)} 秒（当时缓冲只剩 ${bufferLeft.toFixed(1)} 秒`;
  // 后台标签页（屏灭、切到别的窗口）里浏览器本来就不着急播：waiting 会连着发、缓冲还很厚、一帧都不丢。
  // 我这台桌面浏览器就在页面看不见时自己造出一条「卡了 3 次、等了 11.2 秒、缓冲 176 秒、丢帧 0」——
  // 和真访客报上来的那几条一模一样。不把它分出来，就会有人去修一个不存在的问题。
  if (text.includes('+vhidden')) return `${base}，画面 ${size}）—— 报这一阵时页面在后台，浏览器本来就不急着播，别当成卡`;
  // 老客户端没带 df：这一项就明说没量到，不许写"丢帧 0 帧"当成没丢。
  if (droppedRaw === undefined) return `${base}，画面 ${size}）`;
  const dropped = Number(droppedRaw);
  // 整段连"数到几帧"都是 0 —— 这台设备根本没给帧计数（本机实测：`getVideoPlaybackQuality()` 在
  // 后台标签里 totalVideoFrames 恒为 0；部分内核在前台也可能整项不填）。这时 `df0` 是"没量到"，
  // 不是"没丢帧"。而"缓冲很厚却没丢帧"正是排除解码这条路的依据，所以量不到必须明说量不到，
  // 不能让一行读起来像它排除掉了一个它其实没碰过的嫌疑。
  if (countedRaw !== undefined && Number(countedRaw) === 0) {
    return `${base}，画面 ${size}）—— 这一阵一帧都没数到，丢帧那项量不到，不能当成没丢帧`;
  }
  const head = `${base}，画面 ${size}，这一阵丢了 ${dropped} 帧）`;
  // 判据：缓冲还很厚却一直在丢帧 = 设备解码跟不上，不是网速不够。这条把"5 秒卡一次"分成两种病，
  // 两种病的治法相反（一种改档位/编码器，一种改线路），所以必须在这一行就说清是哪一种。
  if (dropped >= 10 && bufferLeft >= 10) return `${head}缓冲够而仍在丢帧 —— 是这台设备解不动，不是网速`;
  if (dropped === 0 && bufferLeft >= 10) return `${head}没丢帧而缓冲还厚 —— 卡的不是画面，是这一阵没收到数据`;
  return head;
}

// 把设备报来的取段计时翻成站长得读的一句话（判据字段含义见 hls-shim.js 里那段注释）。
// 这一行的用处是分清两种"卡"：r（KB/s）很低 = 线不够；r 高、缓冲也厚还卡 = 不是带宽问题。
// 没量到（老客户端还没带 w/k/r）时老实写"这一版没量到"，不许把 0 当速度写上去。
export function fragRateNote(detail) {
  const text = String(detail ?? '');
  const frags = Number(/\bn(\d+)/.exec(text)?.[1] ?? 0);
  const bufferLeft = Number(/\bbuf([\d.]+)s/.exec(text)?.[1] ?? 0);
  const seconds = /\bw([0-9.]+)s/.exec(text)?.[1];
  if (seconds === undefined) return `取了 ${frags} 段（这一版播放器没量到用时，看不了速度）`;
  const spent = Number(seconds);
  const kbytes = Number(/\bk(\d+)/.exec(text)?.[1] ?? 0);
  const rate = Number(/\br(\d+)/.exec(text)?.[1] ?? 0);
  return `取了 ${frags} 段共 ${Math.round(kbytes / 1024 * 10) / 10} MiB 用了 ${spent} 秒（约 ${rate} KB/s），当时缓冲还剩 ${bufferLeft.toFixed(0)} 秒`;
}
