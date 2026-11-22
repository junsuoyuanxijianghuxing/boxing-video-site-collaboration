import { get, post, ApiError, messageFor, setContactQq } from './api.js';
import { mountShellNav } from './shell-nav.js';
import { lessonLibraryMarkup } from './lesson-layout.mjs';
import { mountLibraryBrowser } from './library-browser.mjs';
import { lessonCardMarkup, previewLabel } from './lesson-card.mjs';
import { isWatchedToEnd } from './play-progress.mjs';
import { setPosterSrc } from './poster-cache.mjs';
import { routeOf } from './route-state.mjs';
import { loadingLine } from './loading-line.mjs';
import { copyText } from './clipboard.mjs';
// 验收探针必须拿到"页面真在跑的那一份"模块：打包之后文档加载的是 /assets/dist/app.js，
// 再去 import 源码目录里的 /assets/app.js 会得到第二个模块实例，那边 state.boot 是空的、
// 联系方式也没设过，于是量出来的全是假失败（runbook §129）。这三行再导出就是探针的稳定入口。
export { get, post, messageFor } from './api.js';
// 播放器和后台各自要一整份模块，只在对应路由 import()：站点按天算请求额度，买家不该为此多下两份代码。

// 配色切换：只翻 CSS token，不逐条改规则。
const THEMES = [{ key: 'champagne', label: '暖黑香槟' }];
const THEME_STORAGE = 'lvs-theme';

const savedTheme = () => 'champagne';

function renderThemeSwatches() {
  const slot = document.getElementById('theme-slot');
  if (slot) slot.replaceChildren();
}

function applyTheme(key) {
  key = 'champagne';
  document.documentElement.dataset.theme = key;
  try { localStorage.setItem(THEME_STORAGE, key); } catch { /* 无痕模式记住不了，下次进来用默认色 */ }
  renderThemeSwatches();
}

export const state = { boot: null, plans: [], plansError: null, tabs: null, passwordIsWeak: false };
// 站点额度按请求条数按天算：这三屏本来都要在开屏之后再发一条 library-tabs，
// 现在由那一次 boot 用 with=tabs 一起带回（服务端内部还是那两次查询，对外少一条请求）。
export const LIBRARY_BOOT_ROUTES = new Set(['/', '/library', '/wall']);

// 取片单：优先用 boot 已经带回来的那份，没有再单独取一次（从 /pricing 之类跳进教学影像库就是这种）。
// 单独取到之后也写回 state，同一趟访问里翻页/切标签不再多花请求。
export async function libraryPages() {
  if (state.tabs) return state.tabs;
  const pages = await get('library-tabs', { limit: 60 });
  state.tabs = pages;
  return pages;
}
const main = document.getElementById('main');
const authSlot = document.getElementById('auth-slot');

// 一次渲染一个号，render() 每进一次加一。await 之后要动 DOM 的地方先对号：
// 号不对就是人已经切走了，这一份响应是陈的，不许再往屏幕上写。
// （早先这里比的是"当前地址 vs 模块里那份最新地址"，两个都是新的，永远相等——
// 真浏览器探针把这条假守卫抓出来了：账户页的响应晚到 3 秒照样盖掉了定价页。）
let renderPass = 0;
const isCurrent = (pass, root = main) => pass === renderPass && root.isConnected;

const NBSP = String.fromCharCode(0xA0);

// Kept in sync with DEFAULT_SETTINGS.purchase_steps on the server by a test: the page
// falls back to this text when the owner leaves the field blank, and the two readings
// of one instruction must not drift apart.
const DEFAULT_PURCHASE_STEPS = '加 QQ 说明要买哪一档，并留下登录邮箱；收到 16 位激活码后到「我的账号」绑定。';

// Being returned to the login page with no explanation reads as "the site lost my login".
// The server knows which of these happened, so the page says it.
const SESSION_ENDED = {
  revoked: '你之前的登录已经失效：可能是这个账号在别的设备重新登录把它顶掉了，也可能是站长刚重置过你的密码。重新登录即可；如果登不进去，按页面上的 QQ 联系站长。',
  expired: '你上次的登录已经过期（超过 45 天没有使用），重新登录即可。',
  disabled: '这个账号已被站长停用，观看和后台都会退出。需要恢复请联系站长。',
  unknown: '浏览器带回的登录信息已经不再有效，重新登录即可。若你用的是微信或 QQ 内置浏览器，它可能在关闭后清掉了登录信息。',
};
export const esc = (value) => String(value ?? '').replace(/[&<>"'`=]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;',
}[char]));

export function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
  return `${rest} 秒`;
}

// 教学影像库内容卡和后台「观看记录」说的是同一件事，措辞只写一处：这两处一旦各写一份，
// 买家看到"还剩 1 分"而站长看到"看了 2 分"这类对不上的话就迟早会回来。
// 网段没记下来时说什么。买家设备表和后台「谁在看」共用一处，别各写一份。
export function ipLabel(ip) {
  return ip ? String(ip) : '未记录';
}

export function watchedLine(at, total, cls = 'tiny dim') {
  const seen = Number(at);
  const all = Number(total) || 0;
  if (!Number.isFinite(seen) || seen <= 0 || all <= 0) return '';
  return isWatchedToEnd(seen, all)
    ? `<p class="${cls}">看到过结尾（完整教学影像 ${fmtDuration(all)}）</p>`
    : `<p class="${cls}">上次看到 ${fmtDuration(seen)}，还剩 ${fmtDuration(all - seen)}</p>`;
}

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}

export function fmtDate(value) {
  const ms = Date.parse(value ?? '');
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtMoney(cents) {
  const value = Number(cents) || 0;
  return value % 100 === 0 ? `¥${value / 100}` : `¥${(value / 100).toFixed(2)}`;
}

// Prices live in the database, so every mention of them is built from the same
// list instead of being hard-coded into a page.
export function priceLine() {
  // 停用中的档位在这里根本不会出现：ctx.plans 走的 listPlans() 已经在查询里 eq(enabled, true)。
  // 客户端原先还 filter 了一道 plan.enabled !== false，而接口回的信封里没有这个键 ——
  // 那句判据是个永远为真的摆设，还会让字段探针一直开着"plans.*.enabled"这条口子。
  const plans = state.plans ?? [];
  if (plans.length === 0) return '档位价格见购买页';
  // NBSP keeps "365 天" from splitting across lines in the narrow phone price line,
  // where a wrapped "天" alone on its own line reads as a broken table.
  return plans.map((plan) => `${plan.name} ${plan.priceText || fmtMoney(plan.priceCents)}/${plan.durationDays ? `${plan.durationDays}${NBSP}天` : '永久'}`).join(' · ');
}

export function toast(message, kind = 'note') {
  const box = document.createElement('div');
  box.className = `reveal panel ${kind === 'bad' ? 'note-bad' : kind === 'warn' ? 'note-warn' : 'note'}`;
  box.style.padding = '0';
  box.innerHTML = `<div class="${kind === 'bad' ? 'note note-bad' : kind === 'warn' ? 'note note-warn' : 'note'}">${esc(message)}</div>`;
  document.body.append(box);
  window.setTimeout(() => box.remove(), kind === 'bad' ? 7000 : 4200);
}

export function go(path, { replace = false, entry = {} } = {}) {
  const next = { ...entry, path };
  if (replace) history.replaceState(next, '', path);
  else history.pushState(next, '', path);
  if (location.pathname.startsWith('/v/')) window.scrollTo({ top: 0, behavior: 'instant' });
  void render();
}

// Only same-origin, non-admin-link navigations are intercepted so real links keep
// behaving like links (middle click, copy address).
document.addEventListener('click', (event) => {
  const anchor = event.target.closest?.('a[data-link]');
  if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented || event.button !== 0) return;
  const url = new URL(anchor.href, location.origin);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  if (url.hash && `${url.pathname}${url.search}` === `${location.pathname}${location.search}`) {
    // 同一页换标签：只改 hash，交给 hashchange 处理，别把整页重画一遍。
    location.hash = url.hash;
    return;
  }
  const path = url.pathname + url.search + url.hash;
  const from = history.state?.fromCatalog;
  if (anchor.hasAttribute('data-catalog-return') && from?.url === path) {
    if (from.direct) history.back();
    else go(path, { entry: { librarySpot: from.spot } });
    return;
  }
  if (url.pathname.startsWith('/v/')) {
    if (anchor.matches('#kind-list .screening-card')) {
      const spot = { path: anchor.pathname, top: anchor.getBoundingClientRect().top };
      const url = location.pathname + location.search + location.hash;
      history.replaceState({ ...history.state, librarySpot: spot }, '');
      go(path, { entry: { fromCatalog: { url, spot, direct: true } } });
      return;
    }
    if (location.pathname.startsWith('/v/') && from) {
      go(path, { entry: { fromCatalog: { ...from, direct: false } } });
      return;
    }
  }
  go(path);
});

window.addEventListener('popstate', () => {
  if (routeOf(location.pathname) === '/admin' && main.querySelector('#admin-panes')) return;
  void render();
});

// 外壳导航（工作区切换器 + 菜单内搜索）和弧形快捷菜单：每次 renderNav 都会跑到这里，
// 但监听器只能挂一次，所以按"这一屏该给哪些入口"签个名，没变就不重建。
let shellSignature = '';
function mountShell(boot, path) {
  const signature = path + '|' + Boolean(boot?.privileged) + '|' + Boolean(boot?.viewer);
  if (signature === shellSignature) return;
  shellSignature = signature;
  const slot = document.getElementById('ws-slot');
  if (slot) mountShellNav(slot, { boot, path });
}

function renderNav() {
  const boot = state.boot;
  const settings = boot?.settings ?? {};
  document.getElementById('brand-name').textContent = settings.brand || '格斗影库';
  // The tab title, bookmarks and chat link previews all read document.title, so it
  // has to follow the same setting the header does. Without this the owner renames
  // the site in 后台 and the old name keeps shipping everywhere that matters most.
  if (settings.brand) {
    const line = settings.brand_line ? ` · ${settings.brand_line}` : '';
    document.title = `${settings.brand}${line}｜拳课教学与赛后复盘`;
  }
  const line = document.getElementById('brand-line');
  if (line) line.textContent = settings.brand_line || 'Boxing with Anime';
  const mark = document.querySelector('.brand-mark');
  if (mark) { mark.classList.remove('has-ring'); mark.textContent = ''; }
  const footQq = document.getElementById('foot-qq');
  if (footQq) {
    footQq.textContent = settings.contact_qq || '未配置';
    if (settings.contact_qq) footQq.href = `https://wpa.qq.com/msgrd?v=3&uin=${encodeURIComponent(settings.contact_qq)}&site=qoder&menu=yes`;
  }
  const promo = document.getElementById('foot-promo');
  if (promo && settings.promo_line) promo.textContent = settings.promo_line;
  // Prices live in the database, so the footer has to read them from there too.
  // Left as static text it would keep advertising the old price after a change in
  // 后台 — the same drift the page title had.
  // 版权那句要跟着设置走：站名和 QQ 是他在后台改的，这里写死一份就成了假话。
  const rights = document.getElementById('foot-copyright');
  if (rights && settings.brand) {
    const brand = settings.brand;
    rights.textContent = `「${brand}」全部教学与复盘视频的版权归 ${brand} 所有${settings.contact_qq ? `（联系 QQ ${settings.contact_qq}）` : ''}，也不授权任何 AI 抓取或用于训练。`;
  }
  const footPrices = document.getElementById('foot-prices');
  if (footPrices && (state.plans ?? []).length) footPrices.textContent = `试看不需要登录 · ${priceLine()}`;
  // 后台 / 我的账号 这两个入口现在由工作区切换器给（全站只有一份目的地清单），
  // 这一栏只留登录态自己的动作，否则同一个目的地在页眉上出现两次，手机上必然挤成竖排。
  authSlot.innerHTML = boot?.viewer
    ? '<button type="button" id="nav-logout" class="btn-ghost btn btn-sm">退出</button>'
    : '<a href="/login" data-link>登录</a> <a class="btn btn-primary btn-sm" href="/register" data-link>注册</a>';
  const logout = document.getElementById('nav-logout');
  logout?.addEventListener('click', async () => {
    try {
      await post('logout', {});
      await loadBoot();
      toast('已退出登录。');
      void render();
    } catch (error) {
      toast(error instanceof ApiError ? messageFor(error.code) : '退出失败，请刷新页面。', 'bad');
    }
  });
  const path = location.pathname;
  mountShell(boot, path);
  for (const link of document.querySelectorAll('.bar-nav a')) {
    const href = new URL(link.href).pathname;
    if (href === path || (href === '/library' && (path === '/' || path.startsWith('/v/')))) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// 只有站长会被"用错邮箱登录"锁在 /admin 外面，也只有他的设备见过后台入口。
// 把这个记在本地，警告就只对他响，不会在买家屏幕上印后台话。
const ADMIN_DEVICE_KEY = 'lvs-admin-device';
const markAdminDevice = () => { try { localStorage.setItem(ADMIN_DEVICE_KEY, '1'); } catch { /* 无痕模式写不进去，只能少一条提醒 */ } };
const sawAdminDevice = () => { try { return localStorage.getItem(ADMIN_DEVICE_KEY) === '1'; } catch { return false; } };

async function loadBoot() {
  // 这三屏都要片单，所以让开屏那一条 boot 顺带把它带回，省掉单独一次 library-tabs 请求；
  // 其余屏幕不要，就别为它们多带几十 KB。
  const path = routeOf(location.pathname);
  // 只有真要片单的那三屏才开口要 tabs，其余屏连这个字段都不去读。
  // 「服务端没回的东西，前端不许假装看得见」那条守卫（verify-admin-screens 的 OPTIONAL_FIELDS）
  // 靠的就是这个：放行清单里只该有 error 这类确实可能没带的键，不该为省请求而往里加名字。
  const wantTabs = LIBRARY_BOOT_ROUTES.has(path);
  const boot = await get('boot', wantTabs ? { with: 'tabs' } : {});
  state.boot = boot;
  state.tabs = wantTabs ? boot?.tabs ?? null : null;
  // 联系方式只在这一处从设置读进文案模块；错误提示里的 {{QQ}} 靠它填。
  setContactQq(boot?.settings?.contact_qq);
  if (boot?.privileged) markAdminDevice();
  if (Array.isArray(boot?.plans)) {
    // 站点额度按请求条数按天算，而页脚那一行价目每一屏都要显示 —— 档位现在跟着 boot 一起回来，
    // 一次开屏少花一条 plans 请求。
    state.plans = boot.plans;
    state.plansError = null;
  } else {
    // 服务端没有这个字段 = 页面来自新版、函数还是旧版（两站版本不一致的那几分钟）。
    // 这时退回单独取一次，而不是把价目静默清空 —— 定价屏空掉过去就是这条静默回退造成的。
    try {
      const plans = await get('plans');
      state.plans = plans.plans ?? [];
      state.plansError = null;
    } catch (error) {
      state.plans = [];
      state.plansError = error instanceof ApiError ? error.message : '档位读取失败，请刷新页面。';
      toast(state.plansError, 'bad');
    }
  }
  return boot;
}

function skeleton(path) {
  main.innerHTML = `<div class="wrap stack" style="padding:40px 0"><span class="spinner"></span><p class="dim">${esc(loadingLine(path))}</p></div>`;
}

const VIEWS = {
  '/': libraryView,
  '/library': libraryView,
  '/wall': wallView,
  '/pricing': pricingView,
  // 注册、登录、绑码、我的会员是同一个人的同一件事：以前拆成三屏，
  // 买家注册完必须换一页才找得到那个 16 位码输入框。三个地址现在都进这一屏。
  '/login': accountView,
  '/register': accountView,
  '/account': accountView,
  '/admin': adminView,
};

async function render() {
  const path = routeOf(location.pathname);
  const pass = ++renderPass;
  renderNav();
  // 换页会把整段 DOM 换掉，转盘那一圈每帧写 transform 的循环得跟着停，
  // 不然离开教学影像库之后它还一直在改已经不在页面上的节点。
  stopCoverViews();
  skeleton(path);
  if (!state.boot) {
    try {
      await loadBoot();
    } catch (error) {
      if (!isCurrent(pass)) return;
      main.innerHTML = `<div class="wrap stack"><h1>暂时无法连接后台</h1><p class="dim">${esc(error.message)}</p><button class="btn" type="button" id="retry-boot">重新加载</button></div>`;
      main.querySelector('#retry-boot')?.addEventListener('click', () => location.reload());
      return;
    }
  }
  if (!isCurrent(pass)) return;
  renderNav();
  if (path === '/series' || path.startsWith('/series/')) {
    try {
      const seriesModule = await import('./public-series.mjs');
      if (!isCurrent(pass)) return;
      if (path === '/series') await seriesModule.mountSeriesList(main);
      else await seriesModule.mountSeriesDetail(main, { id: decodeURIComponent(path.slice(8)) });
    } catch {
      if (!isCurrent(pass)) return;
      main.innerHTML = '<div class="wrap stack"><h1>教学合集暂时未能读取</h1><p class="dim">请稍后刷新页面，或先浏览教学影像库。</p><a class="btn" href="/library" data-link>回到教学影像库</a></div>';
    }
    if (!isCurrent(pass)) return;
    main.focus({ preventScroll: true });
    return;
  }
  if (path.startsWith('/v/')) {
    const { mountPlayer } = await import('./player.js');
    if (!isCurrent(pass)) return;
    await mountPlayer(main, { id: decodeURIComponent(path.slice(3)), isCurrent: () => isCurrent(pass),
      catalogUrl: history.state?.fromCatalog?.url });
    if (isCurrent(pass)) main.focus({ preventScroll: true });
    return;
  }
  const view = VIEWS[path];
  if (!view) {
    notFoundView(main, path);
    return;
  }
  try {
    await view(main);
  } catch (error) {
    if (!isCurrent(pass)) return;
    main.innerHTML = `<div class="wrap stack"><h1>这一页没有加载出来</h1><p class="dim">${esc(error?.message ?? '未知错误')}</p></div>`;
  }
  if (!isCurrent(pass)) return;
  main.focus({ preventScroll: true });
}

export async function libraryView(view) {
  const boot = state.boot;
  view.innerHTML = lessonLibraryMarkup({
    promo: esc(boot.settings.promo_line || ''),
    purchaseSteps: esc(boot.settings.purchase_steps || DEFAULT_PURCHASE_STEPS),
  });
  const root = view.querySelector('.compact-library');
  let pages;
  try { pages = await libraryPages(); }
  catch (error) {
    if (!root.isConnected) return;
    root.querySelector('#kind-list').innerHTML = '<div class="note note-bad">' + esc(error.message) + '</div>';
    root.querySelector('#library-overview').textContent = '目录暂时未能读取，请稍后刷新。';
    return;
  }
  if (!root.isConnected) return;
  disposeLibrary = mountLibraryBrowser(root, {
    pages, boot, mergeItems: mergedItems, issueNumbers,
    renderCard: (item, numbers) => cardHtml(item, boot.rank ?? 0, numbers),
    posterUrlFor: item => posterSrc(item.id, item.posterVersion), hydratePosters,
    onPages: value => { state.tabs = value; },
    onRefresh: async () => {
      state.tabs = null;
      toast('正在重新读取目录与观看进度…');
      stopCoverViews();
      await libraryView(view);
    },
    onError: message => toast(message, 'bad'),
  });
}

export async function wallView(view) {
  history.replaceState({path:'/library'}, '', '/library');
  return libraryView(view);
}

const LIBRARY_KINDS = [['live', '真实拳击'], ['anime', '动画拳击']];
// 两类合在一条时间线里：分成两个标签各看一半，是把他两种内容都做过的人硬逼着选一遍。
// 服务端每一类都按发布时间从新到旧排好了，合流后要再按同一个键排一次。
const newestFirst = (a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? ''))
  || String(b.id).localeCompare(String(a.id));
const mergedItems = (pages) => LIBRARY_KINDS
  .flatMap(([key]) => (pages?.[key]?.items ?? []).map((item) => ({ ...item, kind: key })))
  .sort((a, b) => (Number.isFinite(a.displayOrder) && Number.isFinite(b.displayOrder)
    ? a.displayOrder - b.displayOrder : 0) || newestFirst(a, b));
// 封面的地址只在这里拼一次（后台的教学影像库表格也 import 这一条）：两处各写一份的话，
// 缓存把手迟早只加在其中一处，另一处就会因为 max-age=86400 长时间显示旧封面。
// item.posterVersion 来自视频行的更新时间：换封面 → 时间变 → URL 变 → 浏览器重新取一次。
export const posterSrc = (id, version) => `/functions/v1/app?a=poster&v=${encodeURIComponent(id)}${version ? `&t=${encodeURIComponent(version)}` : ''}`;

// 额度按**请求条数**按天算，而平台把函数响应一律改成 `private, no-store` —— 浏览器一张封面都存不住，
// 于是原来打开一次教学影像库就发 15 条封面请求，其中大部分人根本没看见。`loading="lazy"` 挡不住：
// Chrome 一空闲就把下面那些全取回来了（线上实测每条页都是 15）。所以这里自己盯屏幕：
// 只有真的在屏幕上的那几张（含提前 240 像素）才去要图。
// 用"滚动时扫一遍"而不是 IntersectionObserver：内容卡会被重画，重画后新节点要重新 observe、旧的还要
// unobserve，验收量的正是"重画那一帧按时出不出图"这种时序细节 —— 扫一遍没有这类坑，老内核也不用另写一条路。
const POSTER_LOOKAHEAD_PX = 240;
let posterSweepQueued = false;

function sweepPosters() {
  posterSweepQueued = false;
  for (const image of document.querySelectorAll('img[data-poster]:not([src])')) {
    // 量的是那块 16:9 的封面格子，不是 img 自己：还没赋 src 的 img 量出来就是 0×0，
    // 用它的方框判断会把它永远当成"不在屏幕上"，内容卡于是永远不出图（这条就是这么撞出来的）。
    const box = (image.closest('.poster') ?? image).getBoundingClientRect();
    // 格子没有高度 = 这一张此刻根本不显示（藏在别的视图里），不该为它花请求，等它露面再说。
    if (box.height <= 0) continue;
    if (box.bottom < -POSTER_LOOKAHEAD_PX || box.top > window.innerHeight + POSTER_LOOKAHEAD_PX) continue;
    // 读库和取图都是异步的，setPosterSrc 里那把 dataset 闸门挡住"滚动每来一次就把同一张再要一遍"。
    void setPosterSrc(image, image.dataset.poster);
  }
}

// 重画列表之后必须再排一轮，否则新内容卡带着 data-poster 却没有 src，屏幕上就是一片空白。
// 滚动和改屏幕尺寸也各扫一轮：手机上转半屏就要看图，不能等下一次重画。
export function hydratePosters() {
  if (posterSweepQueued) return;
  posterSweepQueued = true;
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(sweepPosters);
  else sweepPosters();
}
window.addEventListener('scroll', hydratePosters, { passive: true });
window.addEventListener('resize', hydratePosters);
// 只在滚动上挂钩子会漏一种更常见的情况：列表画完那一刻带子还没撑开，内容卡其实还在屏幕下面；
// 等带子、字体、hero 把版面顶定，内容卡自己"漂"进屏幕时没有任何滚动事件 —— 那种封面就永远不来。
// 文档高度一变就重扫一遍（带子撑开、图像解码出尺寸都会触发），另外整页 load 完再兜一次。
if (typeof ResizeObserver === 'function') new ResizeObserver(hydratePosters).observe(document.documentElement);
window.addEventListener('load', hydratePosters);

let disposeLibrary = null;
export function stopCoverViews() {
  disposeLibrary?.();
  disposeLibrary = null;
}

// 大字那格要短：18 分 40 秒塞进一个数字位宽的胶囊里会换行，18:40 不会。
const fmtClock = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// 内容卡上的编号按上传顺序从 #01 开始数。只有两类都取全（没有 hasMore）、每条都有发布时间时，
// 这个顺序才算得出来；算不出来就一个编号都不印。印一个看着像编号的字符串（过去是 UUID 前
// 8 位）比不印更糟：买家会以为它是期号，而它和顺序毫无关系。
export function issueNumbers(pages) {
  const all = [];
  for (const [key] of LIBRARY_KINDS) {
    const page = pages?.[key];
    if (!page || page.hasMore) return null;
    all.push(...(page.items ?? []));
  }
  if (all.length === 0 || all.some((item) => !item.publishedAt)) return null;
  const ordered = [...all].sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt))
    || String(a.id).localeCompare(String(b.id)));
  return new Map(ordered.map((item, index) => [item.id, String(index + 1).padStart(2, '0')]));
}


function cardHtml(item, rank, numbers) {
  return lessonCardMarkup(item, {
    posterUrl: posterSrc(item.id, item.posterVersion),
    number: numbers?.get(item.id),
    watched: watchedLine(Number(item.lastPosition), Number(item.durationSeconds) || 0),
  });
}

export async function pricingView(view) {
  const plans = state.plans ?? [];
  const settings = state.boot.settings ?? {};
  const rank = state.boot.rank ?? 0;
  // 续费的决定就发生在这一屏，所以把"你现在到什么时候"写在价格旁边。
  // boot 早就回了 membershipUntil，过去没有任何一处读它；过期那条要另回
  // membershipLapsedAt，否则到期次日这行会直接消失，看起来像从没买过。
  const viewer = state.boot.viewer ?? null;
  const until = viewer ? state.boot.membershipUntil ?? null : null;
  const lapsed = viewer && !until ? state.boot.membershipLapsedAt ?? null : null;
  const shownDate = until ?? lapsed;
  const expiryDate = shownDate ? fmtDate(shownDate).slice(0, 10) : '';
  const daysLeft = until ? Math.ceil((Date.parse(until) - Date.now()) / 86400000) : null;
  const membershipLine = !viewer ? ''
    : rank > 0 && until
      ? `<p class="tiny dim">你的会员到 ${esc(expiryDate)} 有效${Number.isFinite(daysLeft) ? `（还剩 ${daysLeft} 天）` : ''}。</p>`
      : rank > 0
        ? '<p class="tiny dim">你已经是永久会员，下面这些价格只在你想升级档位或换账号时才用得到。</p>'
        : lapsed
          ? `<p class="tiny dim" style="color:var(--warn)">你的会员已在 ${esc(expiryDate)} 到期。绑定一枚新的激活码就恢复观看。</p>`
          : '';
  // 日价只比较相同等级的限时档位，永久档和更高观看范围不混在一起排序。
  const perDay = (plan) => (Number(plan.durationDays) > 0 && Number(plan.priceCents) > 0
    ? plan.priceCents / plan.durationDays : null);
  const rateGroups = new Map();
  plans.forEach((plan, index) => {
    const rate = perDay(plan);
    if (rate === null) return;
    const key = Number(plan.rank);
    if (!rateGroups.has(key)) rateGroups.set(key, []);
    rateGroups.get(key).push({ index, rate });
  });
  const bestValueIndexes = new Set([...rateGroups.values()].filter(group => group.length > 1)
    .map(group => group.reduce((best, item) => item.rate < best.rate ? item : best).index));
  view.innerHTML = `
    <div class="wrap stack" style="gap:26px">
      <section class="lede" style="margin-bottom:6px">
        <span class="eyebrow"><i class="dot"></i> Pricing</span>
        <h1>会员档位与激活码</h1>
        <p>激活码从绑定那一刻开始计时。同一档位再买会在剩余天数上顺延，不浪费已买的时间。</p>
        ${membershipLine}
      </section>
      <div class="tickets">
        ${plans.map((plan, index) => {
          const hot = bestValueIndexes.has(index);
          return `
          <article class="ticket ${hot ? 'ticket-hot' : ''}">
            <div class="spread"><h2>${esc(plan.name)}</h2><span class="pill">等级 ${esc(plan.rank)}</span></div>
            <p class="price">${esc(plan.priceText || fmtMoney(plan.priceCents))}<small> ${plan.durationDays ? `${esc(plan.durationDays)} 天` : '永久'}</small></p>
            <p class="tiny dim">${hot
    ? `每天约 ${esc(fmtMoney(Math.round(plan.priceCents / plan.durationDays)))}，同等级限时档位里每天单价最低`
    : plan.durationDays ? `每天约 ${esc(fmtMoney(Math.round(plan.priceCents / plan.durationDays)))}` : '一次买断，不限时'}</p>
            <ul>
              <li>可看等级 ≤ ${esc(plan.rank)} 的完整版${Number.isFinite(plan.filmsTotal) ? `（站内已发布 ${esc(plan.filmsTotal)} 条，这一档能打开 ${esc(plan.filmsVisible)} 条）` : ''}</li>
              ${plan.description ? `<li>${esc(plan.description)}</li>` : ''}
            </ul>
            <button class="btn ${hot ? 'btn-primary' : ''}" type="button" data-pick="${esc(plan.name)}" data-plan-index="${index}" aria-pressed="false">
              ${viewer && rank === Number(plan.rank) && until ? '按这档续期' : viewer && rank >= Number(plan.rank) ? '查看这档购买说明' : rank > 0 ? '查看升级购买说明' : '选择这档'}
            </button>
          </article>`;
        }).join('')}
        ${plans.length > 0 ? '' : `<p class="dim">${esc(state.plansError ?? '后台还没有发布档位价格，请稍后再看。')}</p>`}
      </div>

      <section class="panel stack" id="purchase-selection" aria-labelledby="purchase-selection-title" hidden>
        <div class="section-title"><h2 id="purchase-selection-title">已选择的档位</h2><p id="purchase-selection-detail" class="tiny dim"></p></div>
        <p id="purchase-selection-note" class="note note-warn" role="status" aria-live="polite" hidden></p>
        <label for="purchase-message">发给站长的购买消息</label>
        <textarea class="input" id="purchase-message" rows="5" readonly></textarea>
        <div class="row"><button class="btn btn-primary" type="button" id="copy-purchase-message">复制购买消息</button><a class="btn" href="/account" data-link>我有激活码，去绑定</a></div>
        <p class="tiny dim">${viewer ? '消息已带上当前登录邮箱；复制后发给下方 QQ，确认收款并收到激活码后再到账号页绑定。' : '发送前请把消息中的邮箱提示换成你的本站登录邮箱；还没有账号可先注册。'} 选择档位不会付款，也不会自动开通会员。</p>
      </section>
      <section class="panel stack">
        <div class="section-title"><h2>怎么拿到激活码</h2></div>
        <div class="qq-card">
          <div>
            <p class="tiny dim">收款和发码都在这个号上，站点不收款</p>
            <p class="qq-number" id="qq-number">${esc(settings.contact_qq || '未配置')}</p>
          </div>
          <div class="row">
            <button class="btn" type="button" id="copy-qq">复制 QQ 号</button>
            <a class="btn btn-primary" href="https://wpa.qq.com/msgrd?v=3&amp;uin=${esc(settings.contact_qq || '')}&amp;site=qoder&amp;menu=yes"
               rel="noopener nofollow" target="_blank">在 QQ 里发起会话</a>
          </div>
        </div>
        <div class="steps">
          <div class="step"><span></span><p>${esc(settings.purchase_steps || DEFAULT_PURCHASE_STEPS)}</p></div>
          <div class="step"><span></span><p>收到码后在「我的账号」粘贴绑定，该码立即失效，一枚码只能绑一个账号。</p></div>
        </div>
        <p class="tiny dim">电脑手机登同一个账号，同时在线 ${esc(settings.max_active_sessions ?? 3)} 个会话，超出时最早那台被登出。</p>
      </section>
    </div>`;

  document.getElementById('copy-qq')?.addEventListener('click', async () => {
    const value = settings.contact_qq ?? '';
    if (!value) return toast('后台还没有填写 QQ 号。', 'warn');
    // 微信/QQ 内置浏览器里剪贴板接口常常整段没有，写剪贴板也会被策略拒掉；
    // 那种情况下说"已复制"，买家就拿着一个空剪贴板去加好友。
    if (await copyText(value)) toast(`已复制 QQ 号 ${value}`);
    else toast(`这个浏览器不让网页写剪贴板。请长按上面那串 QQ 号 ${value} 手动复制。`, 'bad');
  });
  const selection = view.querySelector('#purchase-selection');
  const messageBox = view.querySelector('#purchase-message');
  let selectedPlan = null;
  for (const button of view.querySelectorAll('[data-pick]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.planIndex);
      if (!Number.isSafeInteger(index) || index < 0 || index >= plans.length) return;
      selectedPlan = plans[index];
      const term = selectedPlan.durationDays ? `${selectedPlan.durationDays} 天` : '永久';
      const price = selectedPlan.priceText || fmtMoney(selectedPlan.priceCents);
      view.querySelector('#purchase-selection-title').textContent = `已选择：${selectedPlan.name}`;
      view.querySelector('#purchase-selection-detail').textContent = `${price} · ${term} · 等级 ${selectedPlan.rank}`
        + (Number.isFinite(selectedPlan.filmsVisible) && Number.isFinite(selectedPlan.filmsTotal) ? ` · 可完整观看 ${selectedPlan.filmsVisible}/${selectedPlan.filmsTotal} 条已发布内容` : '');
      const note = view.querySelector('#purchase-selection-note');
      note.textContent = viewer && rank >= Number(selectedPlan.rank) && !until && rank > 0
        ? '你已有不低于此档的永久会员，购买此档不会延长已有权益。先与站长确认是否用于其他账号。'
        : viewer && rank > Number(selectedPlan.rank)
          ? '这是较低等级档位，不能当作高等级会员续期。请先确认想延长哪个等级。' : '';
      note.hidden = !note.textContent;
      messageBox.value = `我想购买「${selectedPlan.name}」
价格：${price}
有效期：${term}
会员等级：${selectedPlan.rank}
登录邮箱：${viewer?.email || '（请补上你的本站登录邮箱）'}`;
      for (const other of view.querySelectorAll('[data-pick]')) other.setAttribute('aria-pressed', String(other === button));
      selection.hidden = false;
      selection.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    });
  }
  view.querySelector('#copy-purchase-message').addEventListener('click', async () => {
    if (!selectedPlan) return;
    if (await copyText(messageBox.value)) toast('购买消息已复制。请发给站长确认，付款和发码在 QQ 中完成。');
    else {
      messageBox.focus(); messageBox.select();
      toast('复制未完成。已选中购买消息，请长按手动复制。', 'bad');
    }
  });
}

function authPanel(host, mode) {
  // A signed-in visitor who lands on an old /login link must not submit it: that opens
  // a second session, and the device cap then evicts their oldest one, which reads to
  // them as "the site kicked me out for no reason".
  if (state.boot?.viewer) {
    go('/library', { replace: true });
    return Promise.resolve();
  }
  const pass = renderPass;
  let submitting = false;
  let current = mode === 'login' ? 'login' : 'register';
  const ended = SESSION_ENDED[state.boot?.sessionEnded];
  host.innerHTML = `
    <div class="wrap">
      <form class="auth-card panel stack" id="auth-form" novalidate>
        <div class="section-title">
          <h2>注册或登录</h2>
          <p class="tiny dim">注册后可兑换会员激活码，观看记录会保存在这个账号下。</p>
        </div>
        ${ended ? `<div class="note note-warn">${esc(ended)}</div>` : ''}
        <div class="row" style="gap:6px" role="group" aria-label="注册还是登录">
          <button class="chip" type="button" id="mode-register">注册新账号</button>
          <button class="chip" type="button" id="mode-login">已有账号登录</button>
        </div>
        <div class="field">
          <label for="f-email">邮箱</label>
          <input class="input" id="f-email" name="email" type="email" autocomplete="email" required />
        </div>
        <div class="field">
          <label for="f-password">密码<span id="pw-hint"></span></label>
          <input class="input" id="f-password" name="password" type="password" required />
        </div>
        <button class="btn btn-primary" type="submit" id="auth-submit"></button>
        <p class="tiny dim" id="auth-note"></p>
        <div id="auth-error" role="alert"></div>
      </form>
    </div>`;
  const paint = () => {
    const isLogin = current === 'login';
    for (const [id, key] of [['#mode-register', 'register'], ['#mode-login', 'login']]) {
      const chip = host.querySelector(id);
      chip.classList.toggle('is-on', key === current);
      chip.setAttribute('aria-pressed', String(key === current));
    }
    host.querySelector('#pw-hint').textContent = isLogin ? '' : '（至少 8 位）';
    host.querySelector('#f-password').autocomplete = isLogin ? 'current-password' : 'new-password';
    host.querySelector('#auth-submit').textContent = isLogin ? '登录' : '注册并登录';
    host.querySelector('#auth-note').textContent = isLogin
      ? '忘记密码走 QQ 人工重置。'
      : '注册之后就在这一屏绑激活码，不用换页面。';
  };
  const modeButtons = ['#mode-register', '#mode-login'].map(selector => host.querySelector(selector));
  host.querySelector('#mode-register').addEventListener('click', () => { if (submitting) return; current = 'register'; paint(); });
  host.querySelector('#mode-login').addEventListener('click', () => { if (submitting) return; current = 'login'; paint(); });
  paint();

  host.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || !isCurrent(pass, host)) return;
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const isLogin = current === 'login';
    const fields = Object.fromEntries(new FormData(form));
    let confirmed = false;
    submitting = true;
    button.disabled = true;
    for (const modeButton of modeButtons) modeButton.disabled = true;
    button.innerHTML = '<span class="spinner"></span> 处理中';
    document.getElementById('auth-error').innerHTML = '';
    try {
      const result = await post(isLogin ? 'login' : 'register', fields);
      confirmed = true;
      // Login accepts a guessable password (refusing it would lock the owner out), so this
      // is the only place that can still tell them — the server sees the plaintext here.
      state.passwordIsWeak = Boolean(result?.passwordIsWeak);
      state.boot = null;
      await loadBoot();
      renderNav();
      if (!isCurrent(pass, host)) return;
      if (state.passwordIsWeak) {
        toast('这个密码太容易猜到。后台能出激活码，请到「我的账号 → 修改密码」换成 8 位以上、字母加数字。', 'warn');
      }
      if (isLogin && Number(result?.evicted) > 0) {
        toast(`这次登录顶掉了 ${result.evicted} 个更早的设备登录。同时在线上限 ${state.boot?.settings?.max_active_sessions ?? 3} 个，可在「站点设置 → 多设备」调整。`, 'warn');
      }
      const isAdmin = Boolean(state.boot?.privileged);
      if (isLogin && !isAdmin && sawAdminDevice()) {
        // Sending him to /library with no word is what turns "后台进不去" into a hunt
        // through the address bar. The fact belongs at the moment he chose the email.
        document.getElementById('auth-error').innerHTML = `<div class="note note-warn">
          <p>这台设备登过后台，但刚才用的 <span class="mono">${esc(String(fields.email ?? ''))}</span> 不在管理名单里，所以进不去。</p>
          <p class="dim">名单里的地址看起来像 <span class="mono">${esc(state.boot?.adminHint ?? '未公开')}</span>。换一个邮箱登录再进后台；只是想观看教学影像就回教学影像库。</p>
          <div class="row" style="gap:8px;margin-top:10px">
            <button type="button" class="btn btn-sm btn-primary" id="auth-switch">退出，换一个邮箱</button>
            <a class="btn btn-sm" href="/library" data-link>先去观看教学影像</a>
          </div></div>`;
        document.getElementById('auth-switch').addEventListener('click', async () => {
          try {
            await post('logout', {});
            state.boot = null;
            await loadBoot();
            renderNav();
            if (isCurrent(pass, host)) void render();
          } catch (error) {
            if (isCurrent(pass, host)) toast(error instanceof ApiError ? messageFor(error.code) : '退出失败，请刷新页面。', 'bad');
          }
        });
        return;
      }
      if (isAdmin) {
        go('/admin', { replace: true });
        return;
      }
      // 买家留在这一屏：下面就是「绑定激活码」那一格，刚拿到码的人不用再找路。
      history.replaceState({}, '', '/account');
      await accountView(host);
      if (isCurrent(pass, host) && host.querySelector('#redeem-form')) toast(isLogin ? '已登录。有激活码就填在下面这一格。' : '账号注册好了。有激活码就填在下面这一格。');
    } catch (error) {
      if (!isCurrent(pass, host)) return;
      document.getElementById('auth-error').innerHTML = confirmed
        ? `<div class="note note-warn">${isLogin ? '登录已完成' : '注册已完成'}，但账号信息暂时未能读取。请重新读取账号信息，先不要重复提交。<a href="/account">重新读取账号信息</a></div>`
        : `<div class="note note-bad">${esc(error.message)}</div>`;
      if (error.code === 'email_invalid') form.querySelector('#f-email')?.focus();
      if (error.code === 'password_too_short') form.querySelector('#f-password')?.focus();
    } finally {
      submitting = confirmed;
      button.disabled = confirmed;
      for (const modeButton of modeButtons) modeButton.disabled = confirmed;
      button.textContent = isLogin ? '登录' : '注册并登录';
    }
  });
  return Promise.resolve();
}

// 手机宽度下表格竖排成内容卡，字段名必须来自这一列的表头本身：在渲染代码里再手写一份，
// 改了表头忘改标签就成了两份互相矛盾的文案。
export function labelTableCells(scope) {
  for (const table of scope.querySelectorAll('table')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (heads.length === 0) continue;
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = [...row.querySelectorAll('td')];
      // 行数对不上（空列表用 colspan 占一行）时不猜位置，宁可少标一个字段名。
      if (cells.length !== heads.length) continue;
      cells.forEach((td, index) => {
        if (!td.dataset.label && heads[index]) td.dataset.label = heads[index];
      });
    }
  }
}

export async function accountView(view, notice = '') {
  const pass = renderPass;
  if (!state.boot?.viewer) {
    // 没登录时这一屏就是注册/登录本身：以前 go('/login') 把人弹到另一页，
    // 于是"注册 → 绑码"这条必经之路中间多一次换页，而绑码框就在下一页。
    await authPanel(view, location.pathname === '/login' ? 'login' : 'register');
    return;
  }
  let data;
  try {
    data = await get('account');
  } catch (error) {
    if (!isCurrent(pass, view)) return;
    view.innerHTML = `<div class="wrap stack">${notice}<div class="note ${notice ? 'note-warn' : 'note-bad'}">${notice ? '绑定已完成，但会员信息刷新失败。请刷新页面查看最新会员。' : esc(error.message)}</div></div>`;
    return;
  }
  if (!isCurrent(pass, view)) return;
  const membership = data.membership;
  view.innerHTML = `
    <div class="wrap stack" style="gap:20px">
      <div class="spread">
        <div>
          <span class="eyebrow"><i class="dot"></i> Account</span>
          <h1 style="margin-top:8px">${esc(data.user.displayName || data.user.email)}</h1>
          <p class="tiny dim mono">${esc(data.user.email)}</p>
        </div>
        <span class="pill ${data.rank > 0 ? 'pill-good' : 'pill'}" id="account-rank">
          ${data.rank > 0 ? `会员等级 ${esc(data.rank)}` : '普通用户'}
        </span>
      </div>

      <section class="panel stack">
        <div class="section-title">
          <h2>绑定激活码</h2>
          <p class="tiny dim">粘贴 16 位码，立即生效；同一枚码不能再用。</p>
        </div>
        <form class="row" id="redeem-form" style="align-items:flex-end">
          <div class="field" style="flex:1 1 260px">
            <label for="redeem-code">激活码</label>
            <input class="input mono" id="redeem-code" name="code" maxlength="24" autocomplete="one-time-code"
                   placeholder="ABCD-EFGH-JKLM-NPQR" spellcheck="false" />
          </div>
          <button class="btn btn-primary" type="submit">绑定</button>
        </form>
        <div id="redeem-result" role="status" aria-live="polite">${notice}</div>
      </section>

      <section class="panel">
        <div class="section-title"><h2>我的会员</h2></div>
        ${membership?.rank ? `<p><strong>${esc(membership.rank)} 级会员</strong> · ${membership.until ? fmtDate(membership.until) + ' 到期' : '永久有效'}</p>`
          : `<p class="dim">${membership?.lapsedAt ? fmtDate(membership.lapsedAt) + ' 已到期' : '尚未开通会员'}</p>`}
        <p class="tiny dim">多张有效卡合并为一份会员权益。续卡累加时长，按其中的最高等级观看。</p>
      </section>

      <section class="panel">
        <div class="section-title">
          <h2>登录设备</h2>
          <p class="tiny dim">最多 ${esc(data.limits.maxActiveSessions)} 个会话同时在线，超出时最早的被登出。下面的时间是<strong>这次登录的有效期（自登录起 45 天）</strong>，到期只是要重新输一次密码，跟上面的会员到期无关。</p>
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>设备</th><th>最近活跃</th><th>登录有效期</th><th>网络</th><th>操作</th></tr></thead>
          <tbody>${data.sessions.map((row) => `<tr>
            <td>${esc(row.device)}${row.current ? ' <span class="pill pill-good">这台设备</span>' : ''}</td>
            <td class="num">${fmtDate(row.lastSeen)}</td>
            <td class="num">${fmtDate(row.expiresAt)}</td><td class="mono tiny">${esc(ipLabel(row.ip))}</td>
            <td>${row.current ? '<span class="tiny dim">正在使用</span>'
    : `<button class="btn btn-sm" type="button" data-revoke-session="${esc(row.id)}" data-device="${esc(row.device)}">退出这一台</button>`}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${data.sessions.length > 1
    ? '<p class="tiny dim" style="margin-top:8px">把号借给别人之后，可以在这里把那台设备踢掉：它下一次打开站点就要重新输密码。</p>'
    : ''}
      </section>

      <section class="panel stack">
        <div class="section-title"><h2>修改密码</h2><p class="tiny dim">改完密码后，其它设备需要重新登录。</p></div>
        ${state.passwordIsWeak
    ? '<div class="note note-warn">本次登录的密码太容易猜到。后台能直接出激活码，建议换成 8 位以上、字母与数字混用，避免生日和连续字符。</div>'
    : ''}
        <form class="stack" id="pw-form">
          <div class="row" style="gap:12px">
            <div class="field" style="flex:1 1 200px"><label for="pw-current">当前密码</label>
              <input class="input" id="pw-current" name="currentPassword" type="password" autocomplete="current-password" /></div>
            <div class="field" style="flex:1 1 200px"><label for="pw-new">新密码</label>
              <input class="input" id="pw-new" name="newPassword" type="password" autocomplete="new-password" minlength="8" /></div>
          </div>
          <div><button class="btn" type="submit">更新密码</button></div>
        </form>
      </section>
    </div>`;
  // 手机宽度下表会竖排成内容卡，字段名由表头按位置补进去（不写第二份表头文字）。
  labelTableCells(view);

  const codeInput = document.getElementById('redeem-code');
  const resultBox = view.querySelector('#redeem-result');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, '').replace(/(.{4})(?=.)/g, '$1-');
  });
  document.getElementById('redeem-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    if (button.disabled || !isCurrent(pass, view)) return;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> 核对中';
    try {
      const result = await post('redeem', { code: codeInput.value });
      state.boot = null;
      if (!isCurrent(pass, view)) return;
      const confirmation =
        `<div class="note">已绑定 <strong>${esc(result.plan.name)}</strong>，会员等级 ${esc(result.rank)}。${result.until ? `到期时间 ${fmtDate(result.until)}。` : '永久有效。'}</div>`;
      codeInput.value = '';
      resultBox.innerHTML = confirmation;
      try {
        await loadBoot();
        if (!isCurrent(pass, view)) return;
        await accountView(view, confirmation);
      } catch {
        if (!isCurrent(pass, view)) return;
        // 顶部那颗等级标记是绑码之前画出来的；不改它，这一屏就会同时写着"未绑定激活码"和"已绑定 月卡"，
        // 而看到这两句矛盾话的人最容易再把同一枚码兑一次。
        const rank = view.querySelector('#account-rank');
        if (rank) { rank.textContent = '会员状态待刷新'; rank.className = 'pill pill-warn'; }
        resultBox.innerHTML = confirmation + '<div class="note note-warn">绑定已完成，但会员信息刷新失败。请刷新页面查看最新会员，不要重复绑定这枚码。</div>';
      }
    } catch (error) {
      if (!isCurrent(pass, view)) return;
      resultBox.innerHTML = `<div class="note note-bad">${esc(error.message)}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = '绑定';
    }
  });

  for (const button of document.querySelectorAll('[data-revoke-session]')) {
    button.addEventListener('click', async (event) => {
      // currentTarget 在第一次异步等待之后就被浏览器置空，所以先把节点拿住。
      const target = event.currentTarget;
      const device = target.dataset.device || '那台设备';
      target.disabled = true;
      try {
        await post('session-revoke', { id: target.dataset.revokeSession });
        toast(`${device} 已经退出。它下一次打开站点要重新输密码。`);
        void render();
      } catch (error) {
        toast(error.message, 'bad');
        target.disabled = false;
      }
    });
  }

  document.getElementById('pw-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    // `currentTarget` is nulled the moment this handler yields, so hold the node.
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled || !isCurrent(pass, view)) return;
    const fields = Object.fromEntries(new FormData(form));
    button.disabled = true;
    button.textContent = '更新中…';
    try {
      await post('password-change', fields);
      state.passwordIsWeak = false;
      if (!isCurrent(pass, view)) return;
      toast('密码已更新，其它设备需要重新登录。');
      // The other devices were just revoked, so the device table above this form is stale.
      void render();
    } catch (error) {
      if (isCurrent(pass, view)) toast(error.message, 'bad');
    } finally {
      button.disabled = false;
      button.textContent = '更新密码';
    }
  });
}

async function adminView(view) {
  if (!state.boot.viewer) return go('/login');
  if (!state.boot.privileged) {
    // Naming the address he is actually logged in as turns "没权限" into something he can
    // check himself, and does not reveal the owner slot to anyone else.
    view.innerHTML = `<div class="wrap stack"><h1>这里只有管理账号能进</h1>
      <p class="dim">当前登录的是 <span class="mono">${esc(state.boot.viewer.email)}</span>，这个邮箱不在管理名单里。</p>
      ${state.boot.adminHint
    ? `<p class="dim">管理名单只有一个地址，看起来像 <span class="mono">${esc(state.boot.adminHint)}</span>。如果你还有别的登录邮箱，先退出再用那个登一次。</p>`
    : ''}
      <p class="dim">观看视频请回到 <a href="/library" data-link style="color:var(--accent)">教学影像库</a>。</p></div>`;
    return Promise.resolve();
  }
  const { mountAdmin } = await import('./admin.js');
  return mountAdmin(view, { go, toast, reloadBoot: async () => { state.boot = null; await loadBoot(); renderNav(); } });
}

function notFoundView(view, path) {
  view.innerHTML = `
    <div class="wrap stack" style="max-width:560px">
      <h1>这个地址没有对应页面</h1>
      <p class="dim mono tiny">${esc(path)}</p>
      <p class="dim">从这两个入口回去：<a href="/library" data-link style="color:var(--accent)">教学影像库</a> ·
        <a href="/pricing" data-link style="color:var(--accent)">会员与购买</a></p>
    </div>`;
}

void (async () => {
  applyTheme(savedTheme());
  // 开屏先给一句"这一屏在等什么"：以前 boot 请求回来之前 #main 是纯白的，
  // 慢网里买家对着白屏点两下，就以为站点挂了。
  skeleton(routeOf(location.pathname));
  try {
    await loadBoot();
  } catch {
    /* render() shows the failure */
  }
  await render();
})();

export { loadBoot, renderNav, render };
