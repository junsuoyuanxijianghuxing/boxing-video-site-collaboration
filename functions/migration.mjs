// 迁移这一趟要做的两件事：主站把行原样导出去，备用站把行原样灌进来。
//
// 为什么"整行搬过去"就有效：plans / memberships / videos / settings 这些行都带着用
// APP_DATA_KEY 算出来的 signature，而备用站用的就是主站那一份 config/runtime.keys
// （2026-10-14 实测，runbook §125）。两站同一把 KEK ⇒ 签名照样自证为真，不需要重签。
// 反过来说，KEK 一旦不一致，搬过去的密码和会员会一起变成无效行。
//
// 这里刻意不做的事：不导 sessions（把登录会话复制到第二台机器等于把"踢设备"这个开关
// 变成摆设），不导 audit（那是这一站自己的流水，搬过去只会把两个站的记录混成一团）。
import { many, DataError } from './db.mjs';
import { COLUMNS } from './store.mjs';
import { isoNow } from './shared/util.mjs';
import { seal } from './shared/vault.mjs';
import { chunkCount, encryptedTotalSize, isValidCipher } from './shared/video-crypto.mjs';
import { SHARD_PATH, POSTER_PATH } from './shared/object-paths.mjs';

// 白名单，不是"表名随便给"：这两个口子只认迁移要的那几张，别的（sessions、audit）根本读不到。
export const EXPORT_TABLES = ['plans', 'settings', 'users', 'memberships', 'keys', 'videos', 'requests', 'watch_logs'];
export const IMPORT_TABLES = EXPORT_TABLES;

const EXPORT_PAGE_MAX = 300;
const IMPORT_ROWS_MAX = 200;

// 稳定排序：按 id 排，翻页才不会因为 updated_at 被改动而漏行或重行。
export async function exportRows(ctx, { table, offset, limit } = {}) {
  const name = String(table ?? '');
  if (!EXPORT_TABLES.includes(name)) throw new DataError('export_table_invalid');
  const from = Number(offset);
  if (!Number.isSafeInteger(from) || from < 0) throw new DataError('export_offset_invalid');
  const size = Math.min(EXPORT_PAGE_MAX, Math.max(1, Number(limit) || 200));
  const rows = await many(
    ctx.supabase.from(name).select(COLUMNS[name]).order('id').range(from, from + size - 1),
    'export_read_failed',
  );
  await ctx.store.audit({
    actorId: ctx.viewer?.user?.id ?? null,
    action: 'export_rows',
    target: name,
    ipPrefix: ctx.ip,
    detail: { from, count: rows.length },
  });
  return {
    table: name,
    columns: COLUMNS[name].split(','),
    rows,
    hasMore: rows.length === size,
    nextOffset: from + rows.length,
    exportedAt: isoNow(),
  };
}

// 口令从 ctx 上拿：handler 把 migration-token.mjs 里那一个挂上去，单测则直接构造一个 ctx。
// 挂着它判是因为主站这一版构建里的值是 null —— 导入口子在主站上一律回 migration_disabled。
// 灌数只认这个一次性口令：备用站公开之后，任何人 POST 这个动作都进不来。
// 口令只存在于 --with-import 那一版构建里，灌完切回顾客版，这个口子就随构建一起消失。
export async function importRows(ctx, { table, rows, token } = {}) {
  if (!ctx.migrationToken) throw new DataError('migration_disabled');
  if (typeof token !== 'string' || token.length !== String(ctx.migrationToken).length) throw new DataError('migration_token_invalid');
  if (token !== ctx.migrationToken) throw new DataError('migration_token_invalid');
  const name = String(table ?? '');
  if (!IMPORT_TABLES.includes(name)) throw new DataError('import_table_invalid');
  if (!Array.isArray(rows) || rows.length === 0) throw new DataError('import_rows_empty');
  if (rows.length > IMPORT_ROWS_MAX) throw new DataError('import_rows_too_many');

  // 只收这张表已知的列，而且 id 必须在：调用方多塞一个字段名就该当场失败，
  // 而不是"写进去了但那一列其实不在库的清单里"。
  const allowed = COLUMNS[name].split(',');
  const clean = rows.map((row) => {
    if (!row || typeof row !== 'object' || !row.id) throw new DataError('import_row_id_missing');
    const out = {};
    for (const column of allowed) if (column in row) out[column] = row[column];
    if (!('id' in out)) throw new DataError('import_row_id_missing');
    return out;
  });

  // upsert(onConflict:id)：同一批重跑不会多出第二行，也不会因为主键冲突整批失败。
  const written = await many(
    ctx.supabase.from(name).upsert(clean, { onConflict: 'id' }).select(COLUMNS[name]),
    'import_write_failed',
  );
  await ctx.store.audit({
    actorId: ctx.viewer?.user?.id ?? null,
    action: 'import_rows',
    target: name,
    ipPrefix: ctx.ip,
    detail: { count: written.length },
  });
  return { table: name, written: written.length, at: isoNow() };
}

// 灌完之后核对用的：只报行数和 id 的散列，不把内容再吐出去一次。
export async function countRows(ctx, { table, token } = {}) {
  if (!ctx.migrationToken) throw new DataError('migration_disabled');
  if (typeof token !== 'string' || token !== ctx.migrationToken) throw new DataError('migration_token_invalid');
  const name = String(table ?? '');
  if (!IMPORT_TABLES.includes(name)) throw new DataError('import_table_invalid');
  const rows = await many(ctx.supabase.from(name).select('id').limit(20000), 'import_count_failed');
  return { table: name, count: rows.length, ids: rows.map((row) => row.id).sort() };
}

// ------------------------------------------------------------------ 字节这一侧
// 片库的字节不进 importRows（那是库里的行）。这两条动作把"本机已经拿到的原件"变成
// 备用站桶里的密文分片 + 一条 videos 行，走的是和后台上传同一套格式，只是加密在服务端做：
// 浏览器那侧要先把 2.4 GB 塞进页面再逐片加密，站长那台机器上的对话窗口扛不住这种量。
//
// 分片大小由灌数那侧决定（这个格式自己允许 64 KiB ～ 8 MiB，见 isValidCipher）。
// 按 8 MiB 灌一片的好处：一次 128 MiB 的取流窗口只要读 16 个对象，而不是 1 MiB 分片时的 128 个。
const MAX_INGEST_BYTES = 9 * 1024 * 1024; // 桶里单对象上限 10 MiB；8 MiB 明文加密后带 tag 还有余量

function requireToken(ctx, token) {
  if (!ctx.migrationToken) throw new DataError('migration_disabled');
  if (typeof token !== 'string' || token !== ctx.migrationToken) throw new DataError('migration_token_invalid');
}

// POST ?a=migration-object&p=<桶内相对路径>&token=<口令>，body 就是那几个字节。
// 路径只认两种：某条片的第 N 片、某条片的封面。别的（config/runtime.keys 那些）一律拒绝 ——
// 这个口子能把密钥对象覆盖掉的话，整站数据就成了一次口令泄漏的代价。
export async function putIngestObject(ctx) {
  const params = new URL(ctx.request.url).searchParams;
  requireToken(ctx, params.get('token'));
  const path = String(params.get('p') ?? '');
  if (!SHARD_PATH.test(path) && !POSTER_PATH.test(path)) throw new DataError('ingest_path_invalid');
  const body = new Uint8Array(await ctx.request.arrayBuffer());
  if (body.byteLength === 0) throw new DataError('ingest_body_empty');
  if (body.byteLength > MAX_INGEST_BYTES) throw new DataError('ingest_too_large');
  await ctx.storage.upload(path, body, { upsert: true });
  await ctx.store.audit({
    actorId: null,
    action: 'import_object',
    target: path,
    ipPrefix: ctx.ip,
    detail: { bytes: body.byteLength },
  });
  return Response.json({ path, bytes: body.byteLength }, { status: 201, headers: { 'cache-control': 'no-store' } });
}

// POST ?a=migration-video-row  body:{token, video:<导出的那行>, key, nonce, chunkSize}
// 行里的 access_signature 只盖 id/tier_rank/preview_seconds/status/duration_seconds（见 domain.mjs），
// 换了分片大小不影响它成立，所以整行原样收下，只重写 chunk_*、enc_size、key_cipher、cipher_version。
export async function putVideoRow(ctx, { token, video, key, nonce, chunkSize } = {}) {
  requireToken(ctx, token);
  if (!video || typeof video !== 'object' || !video.id) throw new DataError('import_row_id_missing');
  const size = Number(chunkSize);
  const plainSize = Number(video.plain_size);
  if (!Number.isSafeInteger(size) || size < 64 * 1024 || size > 8 * 1024 * 1024) throw new DataError('ingest_chunk_size_invalid');
  if (!Number.isSafeInteger(plainSize) || plainSize <= 0) throw new DataError('ingest_plain_size_invalid');
  const cipher = { key: String(key ?? ''), nonce: String(nonce ?? ''), chunkSize: size };
  if (!isValidCipher(cipher)) throw new DataError('cipher_invalid');

  const chunkTotal = chunkCount(plainSize, size);
  const row = {
    ...video,
    chunk_size: size,
    chunk_total: chunkTotal,
    enc_size: encryptedTotalSize(plainSize, size),
    cipher_version: `aes-256-gcm-chunk-${Math.round(size / (1024 * 1024))}m`,
    key_cipher: await seal(ctx.dataKey, JSON.stringify({ key: cipher.key, nonce: cipher.nonce })),
  };
  const written = await many(
    ctx.supabase.from('videos').upsert(pick(row, COLUMNS.videos), { onConflict: 'id' }).select(COLUMNS.videos),
    'import_write_failed',
  );
  await ctx.store.audit({ actorId: null, action: 'import_video_row', target: row.id, ipPrefix: ctx.ip, detail: { title: row.title, chunkSize: size, chunkTotal } });
  return { videoId: row.id, chunkTotal: written[0]?.chunk_total ?? null, encSize: written[0]?.enc_size ?? null };
}

function pick(row, columns) {
  const out = {};
  for (const column of columns.split(',')) if (column in row) out[column] = row[column];
  return out;
}
