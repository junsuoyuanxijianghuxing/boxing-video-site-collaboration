// HLS 分段包的"两边共用的那一套"：灌库时怎么算出存放位置和密钥、播放时怎么把包里的
// 播放列表改写成带令牌的绝对地址。写在这里而不是各写一遍，是因为这两边算错任何一步
// 的症状都是"解不开"，而线上看不出来是哪一步错。
//
// 三条不能省的规矩：
// 1) 分段包另用一把密钥，从父片那把 HKDF 派生 —— 同一把 key+nonce 加密两份不同明文
//    等于 keystream 重用，把两份明文互相异或出来。
// 2) 存放路径仍要走 SHARD_PATH 那个白名单（v/<uuid>/<6位>.bin），所以给分段包算一个
//    确定性的假 uuid：同一个视频永远算出同一个，重灌不产生第二套，也不用给数据库加列。
// 3) 播放列表里的每一行地址都必须带播放令牌 —— 密钥地址也是，取不到令牌就拿不到密钥。
import { createHash, hkdfSync } from 'node:crypto';
import { toBase64Url } from './util.mjs';

export const BUNDLE_MAGIC = 'boxvault-hls-1';
export const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
export const SEGMENT_TYPE = 'video/mp2t';
export const KEY_TYPE = 'application/octet-stream';

const mediaUrl = ({ videoId, token, query }) =>
  `/functions/v1/app?a=media&v=${encodeURIComponent(videoId)}&pt=${encodeURIComponent(token)}${query}`;

// 分段包的分片 id：sha1('boxvault-hls:'+视频id) 的前 32 个 hex 按 uuid 形状摆开。
// 分段包按**派生的假 uuid** 存放，所以库里不用加列：知道片 id 就算得出对象在哪。
// ⚠️ 两条派生字符串都是**已经上线那批包的地址**，改动任何一个字都会让线上 17 条包一起变成"找不到"，
// 症状是买家一律回退到整片 mp4 而对非管理员又回 410 —— 整站播不了。'hd' 这一档必须沿用原来那串，
// 新的低码率档只能**加**一条字符串，不能改旧的。
export function hlsObjectId(videoId, rendition = 'hd') {
  const seed = rendition === 'hd' ? `boxvault-hls:${videoId}` : `boxvault-hls-${rendition}:${videoId}`;
  const hex = createHash('sha1').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 从父片的 {key, nonce} 派生分段包自己的 {key, nonce}。
// 编码沿用站点那套 base64url、nonce 长度也沿用 8 字节（video-crypto.mjs 的 KEY_BYTES/NONCE_BYTES），
// 否则派生出来的这把喂不进同一套 encryptChunk/decryptChunk。
// salt 固定、info 分开，所以两边（灌库、播放）拿同一个父密钥必然算出同一把。
export function deriveHlsCipher(cipher, rendition = 'hd') {
  const parentKey = Buffer.from(String(cipher.key), 'base64url');
  const parentNonce = Buffer.from(String(cipher.nonce), 'base64url');
  if (parentKey.byteLength !== 32 || parentNonce.byteLength !== 8) throw new Error('hls_cipher_parent_shape');
  const salt = Buffer.from('boxvault-hls-salt');
  // 同上面那条规矩：'hd' 用的 info 必须保持原来的 'key' / 'nonce'，否则线上那批包的密钥换了一把，
  // 解出来是垃圾字节，而界面上只会是黑屏。低码率档往后缀，两档各用各的一把。
  const tag = rendition === 'hd' ? '' : `:${rendition}`;
  const key = toBase64Url(Buffer.from(hkdfSync('sha256', parentKey, salt, Buffer.from(`key${tag}`), 32)));
  const nonce = toBase64Url(Buffer.from(hkdfSync('sha256', parentKey, salt, Buffer.from(`nonce${tag}`), 8)));
  return { key, nonce, chunkSize: Number(cipher.chunkSize) };
}

// bundle = [4 字节头长度][JSON 头][段字节拼接]。头里带每段偏移和那把 AES-128 密钥。
export function parseHlsHeader(head) {
  if (head.byteLength < 4) throw new Error('hls_bundle_short');
  const length = head.readUInt32BE(0);
  if (!Number.isSafeInteger(length) || length <= 0 || length > 1024 * 1024) throw new Error('hls_bundle_header_size');
  if (head.byteLength < 4 + length) throw new Error('hls_bundle_header_incomplete');
  const header = JSON.parse(head.subarray(4, 4 + length).toString('utf8'));
  if (header.magic !== BUNDLE_MAGIC) throw new Error('hls_bundle_magic');
  if (!Array.isArray(header.segments) || !header.segments.length) throw new Error('hls_bundle_no_segments');
  if (typeof header.playlist !== 'string' || !header.playlist.startsWith('#EXTM3U')) throw new Error('hls_bundle_playlist');
  let end = 0;
  for (const seg of header.segments) {
    if (!Number.isSafeInteger(seg.offset) || !Number.isSafeInteger(seg.bytes) || seg.bytes <= 0) throw new Error('hls_bundle_segment_shape');
    if (seg.offset !== end) throw new Error('hls_bundle_segment_gap');
    end = seg.offset + seg.bytes;
  }
  header.bodyBytes = end;
  return header;
}

const durationOf = (line) => Number(/^#EXTINF:([\d.]+)/.exec(line)?.[1] ?? 0);

// 一条档位的"每秒要吃多少字节"。头里没有码率字段（打包时没记），但列表里每段的 #EXTINF
// 加起来就是这条档的总时长，用 字节×8÷秒 算出来的就是播放器该拿来判断带宽的那个数。
// 为什么不能用 mp4 行里的 duration_seconds：档位之间时长一样、字节不一样，而主列表要的是字节率。
export function renditionInfo(header) {
  const seconds = header.playlist.split('\n').reduce((sum, line) => sum + durationOf(line), 0);
  if (!(seconds > 0)) throw new Error('hls_bundle_no_duration');
  const bandwidth = Math.round(header.bodyBytes * 8 / seconds);
  return { seconds, bandwidth };
}

// 主列表（master playlist）：一条片的两档各占一行，播放器按自己的带宽估算挑，
// 挑错了还能中途换 —— 这就是"网好自动回 1080p、网差自动降到 720p"的机制，
// 不靠观众去点任何按钮（靠按钮的那一版是"没人会点的默认值"）。
// RESOLUTION 故意不写：头里没记分辨率，而这个字段在规范里是可省的，写了个猜的数反而更坏。
export function buildMasterPlaylist({ variants, videoId, token }) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const variant of variants) {
    const info = renditionInfo(variant.header);
    const url = mediaUrl({ videoId, token, query: `&hls=m3u8&q=${variant.rendition}` });
    out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${info.bandwidth},CODECS="${variant.codecs ?? 'avc1.4d0028,mp4a.40.2'}"`);
    out.push(url);
  }
  return {
    text: `${out.join('\n')}\n`,
    variants: variants.map((variant) => ({
      rendition: variant.rendition,
      ...renditionInfo(variant.header),
    })),
  };
}

// 播放列表里每段多长，只能从 #EXTINF 读（打包时 ffmpeg 按关键帧切，实际每段 8 秒上下，
// 不等于我们要求的 -hls_time 6）。返回的顺序与 header.segments 一致。
function segmentDurations(playlist) {
  const durs = [];
  let pending = 0;
  for (const line of playlist.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#EXTINF')) { pending = durationOf(trimmed); continue; }
    if (/^seg\d+\.ts$/.test(trimmed)) { durs.push(pending); pending = 0; }
  }
  return durs;
}

// 试看只能整段整段地给，于是"承诺 30 秒"和"实际给到第几段"必然差半段。
// 一律向下取会让界面印的 30 秒只给到 24 秒（假状态），一律向上等于白送一整段。
// 这里取最接近承诺秒数的那个段数，平手时取少的那头，误差因此不超过半段。
function pickSegments(durs, limitSeconds) {
  if (!(limitSeconds > 0)) return durs.length;
  const totalSeconds = durs.reduce((a, b) => a + b, 0);
  if (limitSeconds >= totalSeconds) return durs.length;
  let total = 0;
  let best = 0;
  let bestError = limitSeconds;
  for (let n = 0; n < durs.length; n += 1) {
    total += durs[n];
    const error = Math.abs(total - limitSeconds);
    if (error < bestError - 1e-6) { bestError = error; best = n + 1; }
  }
  // 承诺短于半段时宁可多给到一整段，也不能给出一张一段都没有的列表 ——
  // 空列表在播放器里是黑屏，站长只会看到"这个视频坏了"。
  return Math.max(1, best);
}

// 试看这一路"到底给到第几段"，在站内只算这一次：媒体列表按它截断，取某一段也按它放行。
// 分两处各算一遍迟早会给出不一样的答案，而这里的分歧不是显示错，是付费内容整片漏出去 ——
// 列表只写前 1 段、取段却不看编号，等于把"一位一位往后要"这条路留给访客。
// 上限取半个包（和整片那条路的 previewBytes 同一个规矩）：preview_seconds 被人写成不短于
// 片长时，这一档不能变成"试看=全片"。
export function previewSegmentCount(header, previewSeconds) {
  const durs = segmentDurations(header.playlist);
  if (durs.length !== header.segments.length) throw new Error('hls_bundle_playlist_shape');
  if (!(previewSeconds > 0)) return header.segments.length;
  const keep = pickSegments(durs, previewSeconds);
  const ceiling = Math.max(1, Math.floor(header.segments.length / 2));
  return Math.min(keep, ceiling);
}
// 把打包时那份"相对文件名"的列表改写成能直接给播放器的绝对地址。
// 试看（mode=preview）在上面那一步就定好给几段，所以这里不会留下没有地址的 #EXTINF ——
// Safari 的原生解析器见到孤零零的时长标记会判整张列表坏掉，试看当场黑屏。
export function buildPlaylist({ header, videoId, token, previewSeconds = 0, rendition = 'hd' }) {
  // 取段地址要自己带档位，因为 hls.js 和 Safari 都是照列表里写的地址去取的。
  // 默认档不带后缀（'&hls=…' 原样），少一处和旧地址不一致的地方。
  const q = rendition === 'hd' ? '' : `&q=${rendition}`;
  const lines = header.playlist.split('\n');
  const durs = segmentDurations(header.playlist);
  if (durs.length !== header.segments.length) throw new Error('hls_bundle_playlist_shape');
  const keep = previewSegmentCount(header, previewSeconds);
  const out = [];
  let index = 0;
  let marker = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#EXT-X-KEY')) {
      out.push(`#EXT-X-KEY:METHOD=AES-128,URI="${mediaUrl({ videoId, token, query: `&hls=key${q}` })}",IV=0x${header.iv}`);
      continue;
    }
    // 时长标记先攥在手里，等确认这一段真的要发出去才写进列表 ——
    // 一旦留下没有后续地址的 #EXTINF，Safari 的原生解析器会判整张列表坏掉。
    if (trimmed.startsWith('#EXTINF')) { marker = trimmed; continue; }
    if (/^seg\d+\.ts$/.test(trimmed)) {
      if (index >= keep) break;
      const seg = header.segments[index];
      if (!seg) throw new Error('hls_bundle_playlist_longer');
      out.push(marker ?? `#EXTINF:${durs[index]},`);
      out.push(mediaUrl({ videoId, token, query: `&hls=seg&n=${index}${q}` }));
      marker = null;
      index += 1;
      continue;
    }
    if (trimmed === '#EXT-X-ENDLIST') continue;
    out.push(trimmed);
  }
  out.push('#EXT-X-ENDLIST');
  return { text: `${out.join('\n')}\n`, segments: index, seconds: durs.slice(0, index).reduce((a, b) => a + b, 0) };
}
