// 站点外壳：直接可见的主要入口、页面搜索与后台面包屑。
// 全站只有一份目的地清单（WORKSPACES / ADMIN_TABS）：后台标签、面包屑、搜索、弧形菜单都从这里读，
// 免得改了后台标签，菜单里还留着旧的。

export const ADMIN_TABS = [
  ['upload', '上传视频', '传视频 加密 数据块 封面'],
  ['videos', '视频管理', '视频 上架 下架 改等级 试看秒数 删除'],
  ['keys', '激活码', '出码 作废 导出 未兑换 已兑换 已冻结'],
  ['members', '用户管理', '会员名单 昵称 买家 QQ 账号 邮箱 撤销 到期 加减天数 看过的教学影像 备注 重置密码 停用 还没绑码的'],
  ['behavior', '用户行为', '谁在看 看了哪几条 看到哪儿 画质 流畅 高清 自动 拖片 整片 下载 并发 网段 阈值 仪表盘'],
  ['requests', '购买记录', '记一笔 已报价 已成交 给这单出码'],
  ['plans', '档位设置', '月卡 季卡 年卡 价格 等级 天数'],
  ['settings', '站点设置', '站名 水印 QQ 试看秒数 设备数 管理员'],
  ['audit', '操作日志', '谁做了什么 冻结 撤销 登录失败'],
  ['trash', '回收站', '停用账号 撤销的会员 作废的码 取消的单 恢复 找回'],
];

const FRONT_PLACES = [
  ['教学影像', '/library', '教学 影像 视频 试看 真实拳击 动画拳击'],
  ['会员与购买', '/pricing', '价格 月卡 季卡 年卡 激活码 QQ'],
];

const ACCOUNT_PLACES = [
  ['我的账号', '/account', '会员 到期 设备 退出 绑码 改密码'],
];

// 保留工作区数据接口供搜索和后台面包屑使用；主要入口不依赖展开或悬停。
export function workspaces({ privileged } = {}) {
  const list = [{
    key: 'front',
    label: '前台',
    href: '/library',
    places: FRONT_PLACES.map(([label, href, keys]) => ({ label, href, keys })),
  }];
  if (privileged) {
    list.push({
      key: 'admin',
      label: '后台',
      href: '/admin',
      places: ADMIN_TABS.map(([key, label, keys]) => ({
        label, href: `/admin#${key}`, keys: `${keys} 后台`,
      })),
    });
  }
  list.push({
    key: 'account',
    label: '我的账号',
    href: '/account',
    places: ACCOUNT_PLACES.map(([label, href, keys]) => ({ label, href, keys })),
  });
  return list;
}

export function currentWorkspace(path) {
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/account') || path.startsWith('/login') || path.startsWith('/register')) return 'account';
  return 'front';
}

// 搜索用的扁平索引：标签 + 关键词 + 目的地。
export function searchIndex(spaces) {
  const rows = [];
  for (const space of spaces) {
    rows.push({ label: space.label, href: space.href, keys: `${space.key} 工作区`, space: space.label });
    for (const place of space.places) {
      rows.push({ label: place.label, href: place.href, keys: place.keys ?? '', space: space.label });
    }
  }
  return rows;
}

export function matchEntries(index, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return index
    .map((row) => {
      const haystack = `${row.label} ${row.keys} ${row.space}`.toLowerCase();
      const hit = terms.filter((term) => haystack.includes(term)).length;
      return { row, score: hit * 10 + (row.label.toLowerCase().startsWith(terms[0] ?? '') ? 6 : 0) };
    })
    .filter((item) => item.score >= 10 * terms.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.row);
}

// 每次重挂导航先清理上一份全局事件和搜索弹层。
let shellTeardown = null;

// 弧形菜单的入口也住在这份清单里：以前 app.js 另抄了一份标签名，改了后台标签那边不会跟着变。
export const ARC_ITEMS = {
  adminHere: [['上传视频', '/admin#upload'], ['激活码', '/admin#keys'], ['用户管理', '/admin#members'], ['操作日志', '/admin#audit']],
  adminElse: [['后台', '/admin'], ['教学影像', '/library'], ['会员与购买', '/pricing'], ['我的账号', '/account']],
  viewer: [['教学影像', '/library'], ['会员与购买', '/pricing'], ['我的账号', '/account']],
  guest: [['教学影像', '/library'], ['会员与购买', '/pricing'], ['注册观看账号', '/register'], ['登录', '/login']],
};

export function mountShellNav(host, { boot, path }) {
  if (!host) return;
  shellTeardown?.();
  document.getElementById('ws-fly')?.remove();
  const controller = new AbortController();
  const signal = controller.signal;
  const spaces = workspaces({ privileged: boot?.privileged });
  // 同一目的地保留具体页面的名称和关键词，避免“前台”覆盖“教学影像”。
  const index = [...new Map(searchIndex(spaces).map((row) => [row.href, row])).values()];
  const destinations = [...FRONT_PLACES, ...ACCOUNT_PLACES];
  if (boot?.privileged) destinations.push(['后台', '/admin']);
  const currentPath = String(path ?? '/library').split(/[?#]/)[0];
  const isCurrent = (href) => href === '/library'
    ? currentPath === '/' || currentPath === '/library' || currentPath === '/wall' || currentPath.startsWith('/v/')
    : href === '/account'
      ? ['/account', '/login', '/register'].includes(currentPath)
      : href === '/admin' ? currentPath.startsWith('/admin') : currentPath === href;
  host.innerHTML = `
    <button class="btn btn-ghost site-menu-toggle" id="site-menu-toggle" type="button" aria-expanded="false" aria-controls="site-primary-links" aria-label="打开主导航">菜单</button>
    <nav class="primary-links" id="site-primary-links" aria-label="主要导航">
      ${destinations.map(([label, href]) => `<a class="primary-link${isCurrent(href) ? ' is-active' : ''}" href="${href}" data-link${isCurrent(href) ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}
    </nav>
    <button class="btn btn-ghost ws-search primary-search" type="button" id="ws-search" aria-label="搜索站内页面">搜索页面</button>`;

  const toggle = host.querySelector('#site-menu-toggle');
  const links = host.querySelector('#site-primary-links');
  const desktop = window.matchMedia('(min-width: 861px)');
  let desktopMode = desktop.matches;
  let menuOpen = false;
  let palette = null;
  const setMenuOpen = (open, returnFocus = false) => {
    menuOpen = Boolean(open);
    links.classList.toggle('is-open', menuOpen);
    toggle.setAttribute('aria-expanded', String(menuOpen));
    toggle.setAttribute('aria-label', menuOpen ? '关闭主导航' : '打开主导航');
    toggle.textContent = menuOpen ? '收起菜单' : '菜单';
    if (returnFocus && !desktop.matches) toggle.focus();
  };
  toggle.addEventListener('click', () => setMenuOpen(!menuOpen), { signal });
  links.addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenuOpen(false);
  }, { signal });
  const onAway = (event) => {
    if (menuOpen && !host.contains(event.target)) setMenuOpen(false);
  };
  document.addEventListener('pointerdown', onAway, { capture: true, signal });
  document.addEventListener('click', onAway, { capture: true, signal });
  window.addEventListener('resize', () => {
    if (desktop.matches !== desktopMode) {
      desktopMode = desktop.matches;
      const focusInLinks = links.contains(document.activeElement);
      setMenuOpen(false, focusInLinks);
    }
  }, { signal });

  function openPalette() {
    if (palette) { palette.input.focus(); return; }
    const previousFocus = document.activeElement;
    setMenuOpen(false);
    const sheet = document.createElement('div');
    const sheetController = new AbortController();
    const sheetSignal = sheetController.signal;
    sheet.className = 'palette';
    sheet.innerHTML = `
      <div class="palette-box" role="dialog" aria-modal="true" aria-labelledby="palette-title">
        <div class="palette-head"><label id="palette-title" for="palette-q">搜索站内页面</label><button class="btn btn-sm btn-ghost palette-close" type="button" aria-label="关闭页面搜索">关闭</button></div>
        <input class="input" id="palette-q" type="search" placeholder="输入页面或动作，例如「会员」「激活码」" autocomplete="off" aria-describedby="palette-help" />
        <div class="palette-list" id="palette-list"></div>
        <p class="tiny dim" id="palette-help">↑↓ 选择，Enter 打开，Esc 关闭。</p>
      </div>`;
    document.body.append(sheet);
    const input = sheet.querySelector('#palette-q');
    const list = sheet.querySelector('#palette-list');
    let rows = index.slice(0, 8);
    let picked = 0;
    let closed = false;
    const close = (returnFocus = true) => {
      if (closed) return;
      closed = true;
      sheetController.abort();
      sheet.remove();
      palette = null;
      if (returnFocus && previousFocus?.isConnected) previousFocus.focus();
    };
    palette = { input, close };
    const paint = () => {
      list.innerHTML = rows.length === 0
        ? '<p class="tiny dim" role="status">没有匹配的页面。</p>'
        : rows.map((row, i) => `<a class="palette-row${i === picked ? ' is-picked' : ''}" href="${esc(row.href)}" data-link>`
          + `<strong>${esc(row.label)}</strong><span class="tiny dim">${esc(row.space)}</span></a>`).join('');
    };
    const onPaletteKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.target === input && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const count = Math.max(rows.length, 1);
        picked = (picked + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        paint();
        list.children[picked]?.scrollIntoView({ block: 'nearest' });
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' && event.target === input) {
        event.preventDefault();
        // 链接仍在文档内时派发点击，外壳的 data-link 路由监听才能收到。
        list.querySelectorAll('a')[picked]?.click();
        if (rows.length) close(false);
        return;
      }
      if (event.key === 'Tab') {
        const focusable = [...sheet.querySelectorAll('button, input, a[href]')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    sheet.addEventListener('keydown', onPaletteKey, { signal: sheetSignal });
    input.addEventListener('input', () => {
      picked = 0;
      rows = input.value.trim() ? matchEntries(index, input.value) : index.slice(0, 8);
      paint();
    }, { signal: sheetSignal });
    list.addEventListener('click', (event) => {
      if (event.target.closest('a')) close(false);
    }, { signal: sheetSignal });
    sheet.querySelector('.palette-close').addEventListener('click', () => close(), { signal: sheetSignal });
    sheet.addEventListener('click', (event) => { if (event.target === sheet) close(); }, { signal: sheetSignal });
    document.addEventListener('focusin', (event) => {
      if (!sheet.contains(event.target)) input.focus();
    }, { signal: sheetSignal });
    paint();
    input.focus();
  }

  host.querySelector('#ws-search').addEventListener('click', openPalette, { signal });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
    } else if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      setMenuOpen(false, true);
    }
  }, { signal });
  shellTeardown = () => {
    controller.abort();
    palette?.close(false);
    shellTeardown = null;
  };
  return { openPalette };
}

// 面包屑：后台 › 会员名单 ▾。▾ 打开的是同一工作区的同级列表，不用先跳回上一页再选。
export function mountBreadcrumb(host, { trail, places }) {
  if (!host) return;
  host.innerHTML = `
    <nav class="crumbs" aria-label="所在位置">
      ${trail.map((part, i) => (i === trail.length - 1
        ? `<span class="crumb-here">${esc(part.label)}</span>`
        : `<a href="${part.href}" data-link>${esc(part.label)}</a><span class="crumb-sep" aria-hidden="true">›</span>`)).join('')}
      ${places.length > 1 ? `<button class="btn btn-sm btn-ghost crumb-caret has-caret" type="button" aria-expanded="false" aria-label="切换到同级页面">同级 ${places.length} 项</button>` : ''}
    </nav>
    ${places.length > 1 ? `<div class="crumbs-panel" hidden>${places.map((place) => `<a href="${place.href}" data-link>${esc(place.label)}</a>`).join('')}</div>` : ''}`;
  const caret = host.querySelector('.crumb-caret');
  const panel = host.querySelector('.crumbs-panel');
  caret?.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    caret.setAttribute('aria-expanded', String(open));
  });
  // 面板里的链接是普通 a[data-link]：外壳的全局点击处理器负责换标签或换页，
  // 这里再写一份跳转逻辑就会有两套说法。
  panel?.addEventListener('click', () => {
    panel.hidden = true;
    caret?.setAttribute('aria-expanded', 'false');
  });
}

// 弧形快捷菜单：手机上把最常用的几项沿一段弧扇开，拇指不用够到屏幕另一头。
export function mountArcMenu(host, { items, onSearch }) {
  if (!host || !items.length) return;
  const RADIUS = 108;
  const START = 96;
  const STEP = items.length > 1 ? (78 / (items.length - 1)) : 0;
  host.innerHTML = `
    <div class="arc" id="arc">
      <div class="arc-items">
        ${items.map((item, i) => {
    const deg = START + STEP * i;
    const x = Math.cos((deg * Math.PI) / 180) * RADIUS;
    const y = -Math.sin((deg * Math.PI) / 180) * RADIUS;
    const style = `--x:${x.toFixed(1)}px;--y:${y.toFixed(1)}px`;
    return item.search
      ? `<button type="button" class="arc-item" style="${style}" data-arc-search aria-label="${esc(item.label)}">${esc(item.label)}</button>`
      : `<a href="${item.href}" data-link class="arc-item" style="${style}" aria-label="${esc(item.label)}">${esc(item.label)}</a>`;
  }).join('')}
      </div>
      <button class="arc-fab" type="button" id="arc-fab" aria-expanded="false" aria-controls="arc" aria-label="快捷入口">＋</button>
    </div>`;
  const arc = host.querySelector('#arc');
  const fab = host.querySelector('#arc-fab');
  const setOpen = (open) => {
    arc.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', String(open));
    fab.textContent = open ? '×' : '＋';
  };
  fab.addEventListener('click', () => setOpen(!arc.classList.contains('is-open')));
  arc.addEventListener('click', (event) => {
    if (event.target.closest('[data-arc-search]')) {
      setOpen(false);
      onSearch?.();
      return;
    }
    if (event.target.closest('.arc-item')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
