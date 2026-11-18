// 自托管那台服务器的存储实现：对象落在数据目录里，路径形状仍然只认 functions/shared/object-paths.mjs
// 那两种（分片和封面），接口表面和 dev/fake-storage.mjs 一致，所以产品代码一行都不用改。
//
// 签名地址在这台机器上是自己签的：随机 id 的那种好处是"猜不到就写不进去"，落盘版不能退化成
// 一个谁都能 PUT 的公开路径，所以这里带 HMAC + 有效期，校验不过一律当不存在。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isStorePath } from '../functions/shared/object-paths.mjs';

const TYPES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.bin', 'application/octet-stream'],
]);
const LIST_PAGE_MAX = 100;

// functions/runtime-keys.mjs 里那个私有配置对象的路径。两边必须指同一个东西：这里放行它，
// 只是为了让 RuntimeKeys 能把自己的密钥与管理员名单存下来（存不住就等于后台那两个按钮永远按不动）。
export const CONFIG_OBJECT = 'config/runtime.keys';

const toBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value?.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'utf8'));
  throw new Error('unsupported body');
};

const typeOf = (path) => TYPES.get(path.slice(path.lastIndexOf('.')).toLowerCase()) ?? 'application/octet-stream';

export function diskStorage(rootDir, { secret, defaultTtlSeconds = 900, canUpload } = {}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('diskStorage 需要一个至少 16 字节的 secret：落盘版不许发没有校验的写地址');
  }
  const root = resolve(rootDir);
  let failList = false;

  const digest = (text) => createHmac('sha256', secret).update(text).digest('hex').slice(0, 32);

  // isStorePath 已经把 .. 挡在外面了，这里再确认一次：写文件的入口不能信任何一层调用。
  const insideRoot = (path) => {
    const full = resolve(root, ...String(path).split('/'));
    if (full !== root && !full.startsWith(root + sep)) throw new Error(`路径越出数据目录：${path}`);
    return full;
  };

  const fileFor = (path) => {
    if (!isStorePath(path)) throw new Error(`不在允许的路径形状里：${path}`);
    return insideRoot(path);
  };

  // 密钥对象不在 isStorePath 认的两种形状里，但它必须存得下来：存不住的话 RuntimeKeys 只能
  // 退回 source='env'，而那一支的 save() 永远返回 false —— 后台「添加/移除管理员」就成了
  // 永远按不动的按钮（报 admin_write_failed）。所以内部读写多放行这一个确切路径。
  // 签名地址那一侧仍然走上面那个严格的 fileFor，浏览器因此永远拿不到也写不了密钥对象。
  const internalFileFor = (path) => {
    if (String(path) !== CONFIG_OBJECT && !isStorePath(path)) throw new Error(`不在允许的路径形状里：${path}`);
    return insideRoot(path);
  };

  const makeUrl = (mode, path, ttlSeconds) => {
    const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds) || defaultTtlSeconds);
    const payload = Buffer.from(`${path}|${expires}`, 'utf8').toString('base64url');
    return `/storage/v1/object/sign/${mode}/${payload}.${digest(`${mode}|${payload}`)}`;
  };

  // 签名不对、或者这批地址已经过期，都不是"服务器出错"：客户端拿到的是一次性写入地址，
  // 过期了就该重新领一批。带上 code 让上层能回 403，而不是把 500 印到站长的上传页上。
  const badSignedUrl = () => Object.assign(new Error('unknown or expired signed url'), { code: 'bad_signed_url' });

  const parseUrl = (url) => {
    const clean = decodeURIComponent(String(url ?? '').split('?')[0]);
    const match = /^\/storage\/v1\/object\/sign\/(upload|read)\/([A-Za-z0-9_-]+)\.([0-9a-f]{32})$/.exec(clean);
    if (!match) return null;
    const [, mode, payload, signature] = match;
    const want = digest(`${mode}|${payload}`);
    if (want.length !== signature.length || !timingSafeEqual(Buffer.from(want, 'utf8'), Buffer.from(signature, 'utf8'))) return null;
    const text = Buffer.from(payload, 'base64url').toString('utf8');
    const cut = text.lastIndexOf('|');
    if (cut <= 0) return null;
    const path = text.slice(0, cut);
    const expires = Number(text.slice(cut + 1));
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return null;
    return isStorePath(path) ? { mode, path } : null;
  };

  const writeInto = (full, bytes, mode) => {
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { flush: true, mode });
    renameSync(tmp, full);
  };

  // 分片是密文，谁读到都没用；config/runtime.keys 里躺的是明文片钥，读得到就等于能解开全站视频、
  // 也能伪造密码哈希。所以只有它按 0600 落盘 —— keys/main-runtime.keys 那个种子文件本来就是 600，
  // 不能因为换了存放位置就把同一份密钥放宽成 644。
  const modeFor = (path) => (String(path) === CONFIG_OBJECT ? 0o600 : 0o644);

  const write = (path, body, contentType, guard = fileFor) => {
    const full = guard(path);
    const bytes = toBytes(body);
    writeInto(full, bytes, modeFor(path));
    return { path, size: bytes.byteLength, contentType: contentType ?? typeOf(path) };
  };

  function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(next);
      else yield next.slice(root.length + 1).split(sep).join('/');
    }
  }

  return {
    __root: root,
    // 写盘一律同步：8 MiB 一片整片重写在低流量的一人站上不是瓶颈，而"回 200 之前文件必须真的在
    // 磁盘上"是这条路的硬要求（浏览器传完就报成功，下一片马上要读它）。
    async upload(path, body, options = {}) {
      write(path, body, options.contentType, internalFileFor);
      return { Key: path };
    },
    async download(path, { signal } = {}) {
      const bytes = await readFile(internalFileFor(path), { signal });
      return new Response(bytes, { headers: { 'content-type': typeOf(path) } });
    },
    async remove(paths) {
      const list = Array.isArray(paths) ? paths : [paths];
      for (const path of list) {
        try {
          unlinkSync(internalFileFor(path));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return { deleted: list };
    },
    async list(prefix, options = {}) {
      if (failList) throw new Error('listing unavailable');
      const entries = [];
      const base = resolve(root, ...(String(prefix ?? '').split('/').filter(Boolean)));
      try {
        for (const relative of walk(base)) {
          const full = `${String(prefix ?? '')}${relative}`;
          if (!isStorePath(full)) continue;
          entries.push({ name: relative, id: full });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const limit = Math.min(options.limit ?? LIST_PAGE_MAX, LIST_PAGE_MAX);
      return { data: entries.slice(options.offset ?? 0, (options.offset ?? 0) + limit), error: null };
    },
    async createSignedUploadUrl(path) {
      fileFor(path); // 先把形状问一遍：这里抛错比发出去一个签不了的地址好查
      return { signedUrl: makeUrl('upload', path, defaultTtlSeconds) };
    },
    async createSignedUrl(path, ttlSeconds) {
      fileFor(path);
      return { signedUrl: makeUrl('read', path, ttlSeconds) };
    },
    // 浏览器拿着签名地址真的 PUT/GET 时走这两个入口（和替身同一套表面）。这两个必须同步：
    // 服务器那一侧是 `storage.__put(req.url, body)` 直接调完就回 200，异步的话会在写完之前就答。
    __put(url, body, contentType) {
      const parsed = parseUrl(url);
      if (!parsed || parsed.mode !== 'upload') throw badSignedUrl();
      // 与同步写盘之间不能 await：取消先落 aborting，迟到 PUT 无法在清理后写回。
      if (canUpload && canUpload(parsed.path) !== true) throw badSignedUrl();
      return write(parsed.path, body, contentType);
    },
    __get(url) {
      const parsed = parseUrl(url);
      if (!parsed || parsed.mode !== 'read') throw badSignedUrl();
      try {
        return { bytes: new Uint8Array(readFileSync(fileFor(parsed.path))), contentType: typeOf(parsed.path) };
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    __has(path) {
      try {
        return statSync(internalFileFor(path)).isFile();
      } catch {
        return false;
      }
    },
    __pathCount() {
      let total = 0;
      try {
        for (const relative of walk(root)) if (isStorePath(relative)) total += 1;
      } catch {
        return 0;
      }
      return total;
    },
    __failList(on) {
      failList = Boolean(on);
    },
  };
}
