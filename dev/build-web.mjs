// 把 web/assets 的模块图打成一屏只下一次的产物。站点额度按请求条数按天算，
// 而平台会把 /assets/** 的响应头改成 no-cache + 校验器：浏览器每次打开页面都要
// 逐条回源问一次（304 只省字节，不省条数）。模块图里 app.js 静态依赖 api.js、
// shell-nav.js、play-progress.mjs，一次片库访问因此多花三条请求 —— 合并成一个文件就是省三条。
//
// 用法：node dev/build-web.mjs [--root web]   （发布前、跑门禁前都要先跑它）
// 产物写在 web/assets/dist/，源码那几个文件不动：测试仍然直接 import 单个模块，
// 门禁扫的仍然是源码，浏览器加载的是打好的那一份。
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// esbuild 在这台机器上不是顶层依赖（只有 vite 的传递依赖），node_modules/esbuild 这个软链根本不存在。
// 先按正常解析试一次，再退到 pnpm 的仓库目录里挑版本号最大的那一份 —— 找不到就明确报错，
// 不要静默跳过打包：那样 index.html 引用的 /assets/dist/app.js 会 404，整站白屏。
const loadEsbuild = () => {
  try {
    return require('esbuild');
  } catch { /* 走下面的仓库目录 */ }
  const { readdirSync } = require('node:fs');
  const store = join(root, 'node_modules', '.pnpm');
  const found = readdirSync(store)
    .filter((name) => name.startsWith('esbuild@'))
    .map((name) => [Number(name.slice('esbuild@'.length).split('_')[0].split('.').map((n) => n.padStart(3, '0')).join('')), name])
    .sort((a, b) => b[0] - a[0]);
  for (const [, name] of found) {
    try {
      return require(join(store, name, 'node_modules', 'esbuild'));
    } catch { /* 换下一个版本 */ }
  }
  console.error('这台机器上没有可用的 esbuild —— 打包这一省额度的步骤做不了，别把 index.html 发到线上');
  process.exit(1);
};
const esbuild = loadEsbuild();

const args = process.argv.slice(2);
const at = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? resolve(args[i + 1]) : fallback;
};
// 备用站那一棵树走同一套打包，不然两站的请求账单对不上。
const siteRoot = at('root', root);
const webDir = join(siteRoot, 'web');
const assetsDir = join(webDir, 'assets');
const distDir = join(assetsDir, 'dist');
const entry = 'app.js';

if (!existsSync(join(assetsDir, entry))) {
  console.error(`找不到 ${join(assetsDir, entry)} —— 先跑 node dev/sync-web.mjs`);
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });

const result = await esbuild.build({
  absWorkingDir: siteRoot,
  entryPoints: [join(assetsDir, entry)],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2020'],
  outdir: join(webDir, 'assets', 'dist'),
  entryNames: '[name]',
  // 分片名要同时带源文件名和 hash：只写 [name] 时 admin.js、player.js 这些动态入口会撞成
  // 同一个 chunk.js，esbuild 直接报"两个产物同路径不同内容"；带源文件名是为了在门禁输出里
  // 一眼看出哪一片是后台，带 hash 是为了不同内容不会互相覆盖。
  chunkNames: '[name]-[hash]',
  assetNames: '[name]',
  // 界面文案全是中文，默认转义会把每个汉字变成六个字符，白白多下几十 KB。
  charset: 'utf8',
  // 不要开 keepNames：它会为保留函数名额外切出一整片 __name 助手文件（实测 95 字节），
  // 而站点额度按请求条数算 —— 95 字节也要一条对外请求，浏览器每次打开页面都得回源问一次。
  minify: true,
  metafile: true,
  write: true,
});

const slash = (path) => String(path).split('\\').join('/');
const outputs = Object.entries(result.metafile.outputs)
  .filter(([path]) => path.endsWith('.js'))
  .map(([path, info]) => [slash(path), info]);
const entryOut = `web/assets/dist/${entry}`;
const bundle = outputs.find(([path]) => path === entryOut);
if (!bundle) {
  console.error(`产物里没有 ${entryOut} —— 入口没被打出来，浏览器会 404`);
  process.exit(1);
}
const others = outputs.filter(([path]) => path !== entryOut);

// 文档要引的是打好的那一份；hash 会变，所以每次都改写这一处引用，而不是让源码去猜产物名。
const htmlPath = join(webDir, 'index.html');
const html = await readFile(htmlPath, 'utf8');
const wanted = `/${entryOut.replace(/^web\//, '')}`;
const rebuilt = html.replace(/<script type="module" src="\/assets\/dist\/[^"]+"><\/script>/, `<script type="module" src="${wanted}"></script>`);
if (rebuilt === html && !html.includes(`src="${wanted}"`)) {
  console.error(`web/index.html 里没有 <script type="module" src="/assets/dist/…"> 这一行 —— 入口脚本还指着源码模块，打包白做`);
  process.exit(1);
}
if (rebuilt !== html) await writeFile(htmlPath, rebuilt);

console.log(`打包完成：入口 ${wanted} ${(Number(bundle[1].bytes) / 1024).toFixed(1)} KB`);
for (const [path, info] of others) {
  console.log(`  按需分片 ${path.split('/').pop()} ${(Number(info.bytes) / 1024).toFixed(1)} KB ← ${Object.keys(info.inputs).map((p) => slash(p).split('/').pop()).join(', ')}`);
}
const total = outputs.reduce((sum, [, info]) => sum + Number(info.bytes), 0);
console.log(`共 ${outputs.length} 个文件，合计 ${(total / 1024).toFixed(1)} KB`);

// 打进去的文件必须还在：漏了入口或把后台模块静态并进来，这两条就是在守这次改动。
const inputFiles = new Set(outputs.flatMap(([, info]) => Object.keys(info.inputs).map(slash)));
for (const name of ['api.js', 'shell-nav.js', 'play-progress.mjs']) {
  if (!inputFiles.has(`web/assets/${name}`)) {
    console.error(`产物里没有 web/assets/${name} —— 打包入口断了，浏览器会多发一条请求`);
    process.exit(1);
  }
}

// 买家冷启动真的会下哪几个文件：入口 + 入口里静态 import 的那些分片。
// 动态 import() 出来的（后台、播放器、带子）不算，那正是"买家不下后台代码"这条口径要守的边界。
const buyerFiles = new Set([entryOut]);
const queue = [entryOut];
while (queue.length) {
  const text = await readFile(join(siteRoot, queue.shift()), 'utf8');
  for (const match of text.matchAll(/from\s*"(\.\/[^"]+\.js)"/g)) {
    const next = slash(join('web/assets/dist', match[1].slice(2)));
    if (!buyerFiles.has(next)) {
      buyerFiles.add(next);
      queue.push(next);
    }
  }
}
// 判"买家不许下后台代码"靠的是产物各自吃了哪些源文件，不是搜字符串：
// shell-nav.js 里那些导出名本来就在买家这一侧，按名字判会一直误报。
const forbiddenInputs = ['web/assets/admin.js', 'web/assets/vendor/video-crypto.mjs'];
for (const [path, info] of outputs.filter(([path]) => buyerFiles.has(path))) {
  const inputs = new Set(Object.keys(info.inputs).map(slash));
  const leaked = forbiddenInputs.filter((name) => inputs.has(name));
  if (leaked.length) {
    console.error(`买家冷启动那一份（${path}）打进了 ${leaked.join('、')} —— 买家会多下一整份后台代码`);
    process.exit(1);
  }
}
console.log(`买家冷启动要下的文件：${[...buyerFiles].map((p) => p.split('/').pop()).join(', ')}（${buyerFiles.size} 个）`);
