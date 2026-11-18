// Local development server: serves web/ and runs the real Function handler against
// in-memory database and storage fakes. Nothing here is published; the deployed
// runtime uses Deno, the platform Supabase adapter and platform Storage.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, toBase64Url } from '../functions/shared/util.mjs';
import { schemaFromSql, uniqueFromSql } from './schema.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { fakeStorage } from './fake-storage.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// LOCAL_SITE=备用站 让这台本地服务器去服务切出来的顾客侧构建。那套界面是构建脚本用字符串手术
// 从主站源码改出来的，只有真浏览器打开一遍，才知道改完的页面还画不画得出来。
const SITE = process.env.LOCAL_SITE ?? 'main';
const siteRoot = SITE === 'main' ? root : join(root, SITE);
if (!existsSync(join(siteRoot, 'functions', 'handler.mjs'))) {
  throw new Error(`LOCAL_SITE=${SITE} 下没有 functions/handler.mjs —— 先跑 node dev/build-backup-site.mjs`);
}
const { createHandler } = await import(pathToFileURL(join(siteRoot, 'functions', 'handler.mjs')).href);
const { videoAccessSignature } = await import(pathToFileURL(join(siteRoot, 'functions', 'domain.mjs')).href);
const webRoot = join(siteRoot, 'web');
const port = Number(process.argv[2] ?? 4173);

// 站点自己那份 runtime.keys（{version, appDataKey, sessionSecret, adminEmails[]}）就是搬过来要用的
// 凭据：会员行的签名、会话 cookie 的签名都 keyed 在 appDataKey/sessionSecret 上，换了它们，
// 搬过去的账号会全体变成"签名与后台不一致"。所以这里读那一份，而不是重新生成。
let DATA_KEY = process.env.LOCAL_DATA_KEY ?? null;
let SESSION_SECRET = process.env.LOCAL_SESSION_SECRET ?? null;
let ADMIN_EMAILS = process.env.LOCAL_ADMIN_EMAILS ?? 'admin@local.test';
if (process.env.SELFHOST_KEYS) {
  const vault = JSON.parse(await readFile(process.env.SELFHOST_KEYS, 'utf8'));
  DATA_KEY = DATA_KEY ?? vault.appDataKey;
  SESSION_SECRET = SESSION_SECRET ?? vault.sessionSecret;
  if (!process.env.LOCAL_ADMIN_EMAILS && Array.isArray(vault.adminEmails) && vault.adminEmails.length) {
    ADMIN_EMAILS = vault.adminEmails.join(',');
  }
}
// 这行必须说清密钥到底从哪来。以前不管读没读到都印一句"每个进程现生成"，而在真机上
// 片钥是从 SELFHOST_KEYS 那个文件读的 —— 说反了会让人以为重启一次全站视频就解不开了。
// 两把分开说：只固定了会话密钥、片钥还是现生成的那种组合，也必须被如实报出来。
const GENERATED_KEYS = [];
if (!DATA_KEY) GENERATED_KEYS.push('片钥');
if (!SESSION_SECRET) GENERATED_KEYS.push('会话密钥');
DATA_KEY ??= toBase64Url(randomBytes(32));
SESSION_SECRET ??= toBase64Url(randomBytes(32));
const KEYS_NOTE = GENERATED_KEYS.length
  ? `警告：${GENERATED_KEYS.join(' 和 ')}是本进程临时生成的，重启就换一把，之前写下的${GENERATED_KEYS.includes('片钥') ? '视频密文' : '会话'}会解不开。设 SELFHOST_KEYS 或 LOCAL_DATA_KEY / LOCAL_SESSION_SECRET 才会固定`
  : `片钥与会话密钥都来自 ${process.env.SELFHOST_KEYS ? `SELFHOST_KEYS=${process.env.SELFHOST_KEYS}` : 'LOCAL_DATA_KEY / LOCAL_SESSION_SECRET'}：重启后还是同一把，已上传的视频照样解得开`;

const MIGRATION = join(siteRoot, 'migrations');
// SELFHOST_DATA=<目录> 把这同一台服务器换成"能存盘的那一层"：行落进 <目录>/db.json，对象落进
// <目录>/objects/。路由、鉴权、加解密一行都没换，所以浏览器套件跑的就是自托管那台将来跑的代码。
// 密钥走 SELFHOST_KEYS=<runtime.keys 文件>（站点自己那一份格式），没给就退回 LOCAL_* 那三个环境变量。
const diskDir = process.env.SELFHOST_DATA ?? null;
let supabase;
let storage;
// 密钥与管理员名单以存储里那份 config/runtime.keys 为准，还是以 SELFHOST_KEYS 那个文件为准。
// 只有确认存储里那份存在、且两把密钥与文件完全一致时才置真 —— 见下面种子那一段。
let keysFromStorage = false;
if (diskDir) {
  const { diskSupabase } = await import('./disk-store.mjs');
  const { diskStorage, CONFIG_OBJECT } = await import('./disk-storage.mjs');
  supabase = await diskSupabase(join(diskDir, 'db.json'),
    { columns: schemaFromSql(MIGRATION), unique: uniqueFromSql(MIGRATION) });
  storage = diskStorage(join(diskDir, 'objects'), { secret: SESSION_SECRET, canUpload: (path) => {
    const part = /^v\/([^/]+)\/\d+\.bin$/.exec(path);
    const poster = /^poster\/([^/]+)\.[a-z]+$/.exec(path);
    const id = part?.[1] ?? poster?.[1];
    const row = id && supabase.__tables.get('videos')?.find(video => video.id === id);
    return Boolean(row && !processing?.isDeleting(id) && (part ? row.status === 'uploading' : poster && ['uploading', 'draft', 'published', 'retired'].includes(row.status)));
  } });
  if (!GENERATED_KEYS.length) {
    try {
      // 后台「添加/移除管理员」写的是存储里的 config/runtime.keys（functions/runtime-keys.mjs），
      // 而落盘版存储原先不认这个路径形状，写不进去。这里把它种下去一次，之后以存储里那份为准
      // （SELFHOST_KEYS 那个文件退成种子和灾备副本）。
      // 只在密钥固定时种：拿一把本进程随机生成的密钥写进去，下次重启换一把，
      // RuntimeKeys 会因为 appDataKey 对不上而拒绝启动（503），等于把站点写死起不来。
      if (!storage.__has(CONFIG_OBJECT)) {
        await storage.upload(CONFIG_OBJECT, new TextEncoder().encode(JSON.stringify({
          version: 1,
          createdAt: new Date().toISOString(),
          appDataKey: DATA_KEY,
          sessionSecret: SESSION_SECRET,
          adminEmails: ADMIN_EMAILS.split(',').map((item) => item.trim()).filter(Boolean),
        })), { contentType: 'application/octet-stream', upsert: false });
        console.log(`已把 ${CONFIG_OBJECT} 种进数据目录：后台的管理员名单从这次起存得住`);
      }
      // 种下去只是第一步，而且光种不够：RuntimeKeys.#read() 里 env 那一支优先级更高，只要还从
      // env 收到 APP_DATA_KEY / SESSION_SECRET，它就返回 source='env'，而那一支的 save() 直接
      // return false —— 那两个按钮照样永远报 admin_write_failed。所以先把存储里那份读回来核对，
      // 两把密钥都与 SELFHOST_KEYS 一致时，才不再往 env 里塞它们，让 RuntimeKeys 走 source='storage'。
      // 核对不上就保持今天这套 env 接线：那时 RuntimeKeys 会因为密钥冲突拒绝启动（503，看得见、
      // 可回退），而不是让 #create() 现造一把新密钥把已上传的视频全部锁死。
      const stored = await (await storage.download(CONFIG_OBJECT)).json();
      if (stored?.appDataKey === DATA_KEY && stored?.sessionSecret === SESSION_SECRET) {
        keysFromStorage = true;
      } else {
        console.error(`${CONFIG_OBJECT} 里的密钥与 ${process.env.SELFHOST_KEYS ?? 'LOCAL_DATA_KEY / LOCAL_SESSION_SECRET'} 对不上：管理员名单继续存不住（后台会报 admin_write_failed）。先把这两处核对一致，别让 RuntimeKeys 现造一把新密钥`);
      }
    } catch (error) {
      // 种不下去不该让整个站点起不来：少了它只是"后台改不动管理员名单"（那两个按钮会明确
      // 报 admin_write_failed），而崩在这里是全站打不开。所以只把话说明白，继续启动。
      console.error(`没能读写 ${CONFIG_OBJECT}：后台的「添加/移除管理员」会报 admin_write_failed。原因：${error.message}`);
    }
  }
} else {
  supabase = fakeSupabase({
    users: [], sessions: [], plans: [], keys: [], memberships: [], videos: [],
    requests: [], settings: [], audit: [], watch_logs: [],
  }, { columns: schemaFromSql(MIGRATION), unique: uniqueFromSql(MIGRATION) });
  storage = fakeStorage();
}
let processing = null;
if (diskDir && process.env.SELFHOST_PROCESS_MEDIA === '1') {
  const { createVideoProcessor } = await import('./video-processor.mjs');
  const { store } = await import('../functions/store.mjs');
  processing = await createVideoProcessor({ dataDir: diskDir, storage, store: store(supabase, DATA_KEY), dataKey: DATA_KEY,
    rows: () => supabase.__tables.get('videos') ?? [],
    ffmpeg: process.env.SELFHOST_FFMPEG || '/usr/bin/ffmpeg', ffprobe: process.env.SELFHOST_FFPROBE || '/usr/bin/ffprobe' });
}
const handler = createHandler({
  storage,
  processing,
  // keysFromStorage 为真时故意不把两把密钥交给 RuntimeKeys：交了它就认定 source='env'，
  // 而那一支的 save() 永远返回 false，后台的管理员名单就改不动。ADMIN_EMAILS 仍然给 ——
  // 存储里那份缺失或读不出来时，它是 #create() 唯一能拿到的初始名单。
  env: (name) => (keysFromStorage && (name === 'APP_DATA_KEY' || name === 'SESSION_SECRET')
    ? undefined
    : ({ APP_DATA_KEY: DATA_KEY, SESSION_SECRET, ADMIN_EMAILS })[name]),
});

// LOCAL_DEV_SESSION=<email> mints a real session at boot and replays it on every
// request, so a headless browser (which cannot hold the HttpOnly cookie) can be
// pointed at /admin. This file is never published: webDirectory is web/ and the
// deployed runtime is functions/.
let devSessionCookie = null;
async function mintDevSession(email) {
  const csrf = 'dev-csrf-token';
  const call = (action, body) => handler({
    request: new Request(`http://127.0.0.1:${port}/functions/v1/app?a=${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `lvs_csrf=${csrf}`, 'x-csrf-token': csrf, 'x-forwarded-host': `127.0.0.1:${port}` },
      body: JSON.stringify(body),
    }),
    supabase,
  });
  const password = 'Local-Dev-2026-pass';
  const attempt = await call('register', { email, password, displayName: '本地站长' });
  const login = attempt.ok ? attempt : await call('login', { email, password });
  const pairs = (login.headers.getSetCookie() ?? []).map((cookie) => cookie.split(';')[0]);
  const session = pairs.find((pair) => pair.startsWith('lvs_session='));
  if (!session) throw new Error(`LOCAL_DEV_SESSION: could not sign in as ${email}: ${await login.text()}`);
  devSessionCookie = [session, ...pairs.filter((pair) => pair !== session)].join('; ');
  console.log(`dev session minted for ${email}`);
}
if (process.env.LOCAL_DEV_SESSION) await mintDevSession(process.env.LOCAL_DEV_SESSION);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function toWebRequest(req, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.append(key, value.join(', '));
    else headers.set(key, String(value));
  }
  // Mirror the platform adapter: it removes `cookie` before business code runs and
  // the site entry point re-supplies only its own cookies under x-lvs-cookie.
  const { onlyAppCookies, FORWARDED_COOKIE_HEADER } = await import('../functions/shared/cookies.mjs');
  const mine = onlyAppCookies(headers.get('cookie')) ?? '';
  // 重放演练会话时，同名 cookie 以演练会话为准。浏览器自己那枚 lvs_csrf 是它还是匿名访客时
  // 收到的，排在前面会让 acceptsMutation 拿它去比会话里存的那一枚，于是后台所有 POST 一律 403
  // —— 那是脚手架造出来的假失败，不是产品的缺陷。
  const devNames = new Set((devSessionCookie ?? '').split(';').map((pair) => pair.split('=')[0].trim()).filter(Boolean));
  const rest = devNames.size
    ? mine.split(';').map((pair) => pair.trim()).filter((pair) => !devNames.has(pair.split('=')[0])).join('; ')
    : mine;
  const forwarded = [rest, devSessionCookie].filter(Boolean).join('; ');
  headers.delete('cookie');
  if (forwarded) headers.set(FORWARDED_COOKIE_HEADER, forwarded);
  headers.set('x-forwarded-host', `${req.headers.host ?? `127.0.0.1:${port}`}`);
  const url = `http://127.0.0.1:${port}${req.url}`;
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
  return new Request(url, init);
}

// 响应必须边解边发，不能先 arrayBuffer() 攒齐再一次性 end()：
// 取流那一窗最多 128 MiB，攒齐等于一个人看片就吃掉 128 MiB 内存、首帧要等整窗解完；
// 更要命的是业务侧按"往外发了多少字节"记账限流，攒齐时生成速度不受客户端拖累，
// 账上记的是解出来的字节而不是真发出去的字节，看两次片就能把自己的额度扣爆（症状是 429）。
async function pumpBody(response, res) {
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  // 人关掉页面就停止解密：不取消的话服务端会继续把剩下的片解完再丢掉。
  res.on('close', () => {
    if (!res.writableEnded) reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once('drain', resolve));
    }
  } catch {
    // 头已经发出去了，状态码改不了；能做的就是别再往里写半截数据。
  } finally {
    if (!res.writableEnded) res.end();
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    try {
      // Self-hosted production is also reached through nginx. Loopback binding
      // alone does not make the development helpers private.
      if (diskDir && (path.startsWith('/dev-info') || path.startsWith('/dev-seed'))) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not found');
        return;
      }
      if (path.startsWith('/functions/v1/app')) {
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(await collect(req));
        const response = await handler({ request: await toWebRequest(req, body), supabase });
        if (processing && response.ok && req.method === 'POST' && new URL(req.url, 'http://localhost').searchParams.get('a') === 'admin-upload-complete') {
          // 上传已经提交；仅发排队通知，不等转码。通知落盘失败由周期扫描恢复，不把上传误报失败。
          const videoId = JSON.parse(body.toString('utf8')).videoId;
          void processing.enqueue(videoId).catch(() => console.error('media processing enqueue deferred to scan'));
        }
        const plain = Object.fromEntries(response.headers);
        delete plain['set-cookie'];
        // The application always marks cookies Secure because the published site is
        // HTTPS-only. A plain-HTTP loopback harness cannot carry those cookies, so the
        // local server drops the attribute instead of weakening the shipped code.
        // 自托管那台是走 HTTPS 的（SELFHOST_SECURE=1），那时候这层剥掉必须取消 ——
        // 带着 Secure 的 cookie 才不会被明文 HTTP 拿走。
        const cookies = (response.headers.getSetCookie?.() ?? [])
          .map((cookie) => (process.env.SELFHOST_SECURE ? cookie : cookie.replace(/;\s*Secure/i, '')));
        // 演练会话是服务端铸的，浏览器自己从来没有过 lvs_csrf —— 页面读不到它就拿不出
        // x-csrf-token，后台每个 POST 都会 403。把演练会话里那枚发给浏览器，
        // 让「点已看过」走的正是真站长那条双提交校验，而不是给 POST 开后门。
        const devCsrf = (devSessionCookie ?? '').split(';').map((pair) => pair.trim())
          .find((pair) => pair.startsWith('lvs_csrf='));
        if (devCsrf && !/(^|;\s*)lvs_csrf=/.test(req.headers.cookie ?? '')) {
          cookies.push(`${devCsrf}; Path=/; Max-Age=86400`);
        }
        if (cookies.length) plain['set-cookie'] = cookies;
        // 平台会把 /functions 的响应头一律改写成 private, no-store（§126 实测）。本机测试
        // 必须跟着改，否则浏览器自己就把封面缓存住了，"回访零请求"这类断言会因为错误的原因变绿。
        // 自托管这台没有那层平台：应用写的值就是买家浏览器收到的值（封面 public, max-age=86400，
        // 正片字节 private, no-store），在这里抹平等于让每个人每次开片库都重下一遍图。
        if (!process.env.SELFHOST_DATA) plain['cache-control'] = 'private, no-store';
        res.writeHead(response.status, plain);
        await pumpBody(response, res);
        return;
      }
      if (path.startsWith('/storage/v1/object/sign/')) {
        const chunks = await collect(req);
        // 签名不对或这批地址已经过期，是客户端要重新领一批地址，不是服务器出错。回 500 的话
        // 上传页会印「第 N 数据块写入失败（HTTP 500）」，站长读到的是"站点坏了"。
        // 其它异常（磁盘满、权限）仍然往上抛，不能一起吞成 403。
        try {
          if (req.method === 'PUT') {
            storage.__put(req.url, Buffer.concat(chunks), String(req.headers['content-type'] ?? 'application/octet-stream'));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ key: path }));
          } else {
            const object = storage.__get(req.url);
            if (!object) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'object_not_found' }));
              return;
            }
            res.writeHead(200, { 'content-type': object.contentType });
            res.end(Buffer.from(object.bytes));
          }
        } catch (error) {
          if (error?.code !== 'bad_signed_url') throw error;
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'storage_url_rejected' }));
        }
        return;
      }
      if (path.startsWith('/dev-info')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rows: Object.fromEntries([...supabase.__tables].map(([key, value]) => [key, value.length])) }));
        return;
      }
      // 「取满 200 条才会出现的那一支」用真接口造不出来（要注册、兑换、上传 200 节片、
      // 每台设备报一次进度），所以验收脚本要能直接把行写进这个进程内的内存表。
      // 只有本机 127.0.0.1 上起着这个文件，它不在 webDirectory 也不在 functions/，站点上没有这条路。
      if (path === '/dev-seed' && req.method === 'POST') {
        const payload = JSON.parse(Buffer.concat(await collect(req)).toString('utf8'));
        const counts = {};
        for (const [name, rows] of Object.entries(payload.tables ?? {})) {
          const table = supabase.__tables.get(name);
          if (!Array.isArray(table) || !Array.isArray(rows)) throw new Error(`unknown table ${name}`);
          // 前台片库会丢掉 access 签名对不上的行（防篡改），直接 push 进去的视频在前台一条都不显示。
          // 所以补数据要按 createVideo 同一套算法把签名盖上，否则验收脚本看到的是"库是空的"。
          const stamped = [];
          for (const row of rows) {
            stamped.push(name === 'videos' && !row.access_signature
              ? { ...row, access_signature: await videoAccessSignature(DATA_KEY, row) }
              : row);
          }
          table.push(...stamped);
          counts[name] = rows.length;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, counts }));
        return;
      }
      let file = normalize(join(webRoot, path === '/' ? 'index.html' : path));
      if (!file.startsWith(webRoot + sep) && file !== join(webRoot, 'index.html')) throw new Error('path escape');
      try {
        const info = await stat(file);
        if (info.isDirectory()) throw new Error('directory');
      } catch {
        // SPA fallback: unknown non-asset routes serve index.html with status 200.
        if (extname(path)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        file = join(webRoot, 'index.html');
      }
      const bytes = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.destroyed) return;
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`local server error: ${error?.message ?? error}`);
    }
  })();
});

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const cleanup = () => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('aborted', aborted);
      req.removeListener('error', failed);
    };
    const data = chunk => chunks.push(chunk);
    const end = () => { cleanup(); resolve(chunks); };
    const failed = error => { cleanup(); chunks.length = 0; reject(error); };
    const aborted = () => failed(new Error('request aborted'));
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', aborted);
    req.once('error', failed);
  });
}

server.listen(port, '127.0.0.1', () => {
  console.log(`local preview: http://127.0.0.1:${port}/`);
  // 名单确实以 env 这份为准时，印它才有意义。自托管那台已经把名单落进数据目录了，
  // 这时候 env 只是种子，照旧印 "admin emails: 一个人" 会让人以为后台刚加的管理员没生效。
  console.log(keysFromStorage
    ? `env 里的管理员种子（不生效，实际名单在 config/runtime.keys）：${ADMIN_EMAILS}`
    : `admin emails: ${ADMIN_EMAILS}`);
  console.log(KEYS_NOTE);
  if (diskDir) {
    console.log(keysFromStorage
      ? '管理员名单以数据目录里的 config/runtime.keys 为准：后台「添加/移除管理员」改得动、存得住'
      : '管理员名单只能来自 SELFHOST_KEYS 那个文件：后台「添加/移除管理员」会报 admin_write_failed，改名单要停服务改文件');
  }
});

if (processing) {
  const shutdown = () => {
    server.close();
    void processing.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
