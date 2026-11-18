// 首页那条"弯成弧的胶片带"：一排真封面绕着圆柱内侧从右往左流，正面平视，两端朝观众弯过来。
// 几何照搬 21st.dev 的 TiltedGridHero（React 版），这里改成无构建的直接 ES 模块。
// CSS 的盒子不会弯，所以每一格切成若干竖条，每条自己转几度贴到圆柱面上，
// 整格只做一次 rotateY 沿弧走 —— 一格一条动画，竖条之间永远不会裂开或露出别的图。

import { posterObjectUrl, setPosterSrc } from './poster-cache.mjs';

const SLICES = 16;
const CAMERA = 1.6;
const MAX_WIDTH = 55;

// 帧的边缘在镜头里绕到 `bend` 弧度时，圆柱半径该是画面宽度的多少倍。
function arc(bend) {
  return (CAMERA - 1 + Math.cos(bend)) / (2 * CAMERA * Math.sin(bend));
}

function measure(width, height, tile, aspect, gap, bend) {
  const h = Math.min((tile / 100) * height, ((MAX_WIDTH / 100) * width) / aspect);
  const radius = width * arc(bend);
  if (!(h > 0) || !(radius > 0)) return { columns: 2, sweep: 0, unit: 0, limit: 0 };
  const deg = (rad) => (rad * 180) / Math.PI;
  const unit = deg(h / radius);
  const pitch = (aspect + gap / 100) * unit;
  const limit = deg(bend) + (aspect * unit) / 2;
  const columns = Math.min(60, Math.max(2, Math.ceil((2 * limit) / pitch)));
  const round = (n) => +n.toFixed(4);
  const sweep = round((columns * pitch) / 2);
  return { columns, sweep, unit: round(unit), limit: round(Math.min(sweep, limit)) };
}

let seq = 0;

export function mountFilmBand(host, {
  images = [],
  speed = 4,
  tileHeight = 26,
  aspectRatio = 16 / 9,
  gap = 6,
  axis = 56,
  curve = 80,
  fade = 12,
} = {}) {
  if (!host || typeof ResizeObserver === 'undefined') return () => {};
  const bend = (Math.min(85, Math.max(5, curve)) * Math.PI) / 180;
  const id = `fb${(seq += 1)}`;
  const orbit = `fb-o-${id}`;
  const tileClass = `fb-t-${id}`;
  const r = 100 * arc(bend);
  const radius = `${+r.toFixed(3)}cqw`;
  const turn = (deg) => `translateZ(${radius}) rotateY(${+deg.toFixed(4)}deg) translateZ(-${radius})`;
  const u = (n) => `calc(${+n.toFixed(4)} * min(${tileHeight}cqh, ${+(MAX_WIDTH / aspectRatio).toFixed(4)}cqw))`;
  const share = aspectRatio / SLICES;
  const mask = `linear-gradient(90deg,transparent,#000 ${fade}%,#000 ${100 - fade}%,transparent)`;

  host.classList.add('film-band', tileClass);
  // 首页那条是装饰，读屏跳过；封面墙那一屏每一格都能点，就不能再藏起来。
  const interactive = images.some((item) => item.href);
  if (!interactive) host.setAttribute('aria-hidden', 'true');
  else host.removeAttribute('aria-hidden');
  const styleEl = document.createElement('style');
  const layer = document.createElement('div');
  layer.className = 'film-band-stage';
  layer.style.perspective = `${+(r * CAMERA).toFixed(3)}cqw`;
  layer.style.perspectiveOrigin = `50% ${axis}%`;
  layer.style.maskImage = mask;
  layer.style.webkitMaskImage = mask;
  host.append(styleEl, layer);

  let tiles = [];
  let layout = null;
  let timer = 0;

  const build = (next) => {
    const duration = next.columns * speed;
    const hide = +(((next.sweep - next.limit) / (2 * next.sweep || 1)) * 100).toFixed(4);
    styleEl.textContent = `@keyframes ${orbit}{`
      + `from{transform:${turn(-next.sweep)}}to{transform:${turn(next.sweep)}}`
      + `0%,${hide}%,${100 - hide}%,100%{visibility:hidden}`
      + `${hide + 0.001}%,${100 - hide - 0.001}%{visibility:visible}}`;
    layer.innerHTML = '';
    tiles = [];
    for (let t = 0; t < next.columns; t += 1) {
      // 能点的那一屏，每一格本身就是链接：切片只是把它弯起来的外壳。
      const tile = document.createElement(interactive ? 'a' : 'div');
      if (interactive) tile.setAttribute('data-link', '');
      tile.className = 'film-tile';
      tile.style.left = `calc(50% - ${u(aspectRatio / 2)})`;
      tile.style.top = `calc(${axis}% - ${u(0.5)})`;
      tile.style.width = u(aspectRatio);
      tile.style.height = u(1);
      tile.style.animation = `${orbit} ${duration}s linear ${-t * speed}s infinite`;
      for (let k = 0; k < SLICES; k += 1) {
        const strip = document.createElement('div');
        strip.className = `film-slice${k === 0 ? ' film-slice-first' : ''}${k === SLICES - 1 ? ' film-slice-last' : ''}`;
        strip.style.left = u((aspectRatio - share) / 2);
        // 比它该占的那一条宽 1px：相邻两条叠一点边，弧上就不会露出细缝。最后一条没有邻居要盖。
        strip.style.width = k === SLICES - 1 ? u(share) : `calc(${u(share)} + 1px)`;
        strip.style.height = u(1);
        strip.style.transform = turn((aspectRatio / 2 - (k + 0.5) * share) * next.unit);
        // 每一条都放一整张图，只是各自往左挪自己那一条的宽度：
        // 16 条拼起来才是一张被弧弯过去的完整封面。
        const img = document.createElement('img');
        img.className = 'film-face';
        img.draggable = false;
        img.loading = 'eager';
        img.decoding = 'async';
        img.alt = '';
        img.style.left = u(-k * share);
        img.style.width = u(aspectRatio);
        img.style.height = u(1);
        strip.append(img);
        tile.append(strip);
      }
      layer.append(tile);
      tiles.push(tile);
    }
    paint(next);
  };

  // 每格显示哪一张，按"它绕回来第几圈"算：绕回时正好在屏幕外，所以换图看不出来。
  const paint = (next) => {
    if (!images.length) return;
    tiles.forEach((tile, t) => {
      const first = next.columns - 1 - t;
      const laps = Number(tile.dataset.laps || 0);
      const img = images[(laps * next.columns + first) % images.length];
      // 换图的同时换链接：点的是眼前这一张，不是它下一圈变成的那一张。
      if (interactive) {
        if (img.href) tile.href = img.href;
        else tile.removeAttribute('href');
        tile.setAttribute('aria-label', img.alt || '这一条片子');
        tile.title = img.alt || '';
      }
      // 换图走本地那一份：带子每绕一圈就重画一次，直接赋 src 的话同一批封面会被反复要。
      tile.querySelectorAll('.film-face').forEach((face) => { void setPosterSrc(face, img.src); });
    });
  };

  const onIteration = (event) => {
    const tile = event.target.closest?.('.film-tile');
    if (!tile || !layout) return;
    const t = tiles.indexOf(tile);
    if (t < 0) return;
    tile.dataset.laps = String(Math.round((event.elapsedTime || 0) / (layout.columns * speed)));
    paint(layout);
  };

  const reflow = () => {
    const box = host.getBoundingClientRect();
    const next = measure(box.width, box.height, tileHeight, aspectRatio, gap, bend);
    if (layout && layout.columns === next.columns && layout.sweep === next.sweep && layout.unit === next.unit) return;
    layout = next;
    build(next);
    layer.style.opacity = '1';
  };

  // 只先取前面那几张 —— 带子一屏就露五六张，而站点额度是按请求条数按天算的：
  // 原来这里把整个 images 数组 preload 一遍，首页一次就发掉十几条封面请求，后面那些根本轮不到。
  // 绕到正面才用到的那些由 paint() 在换图时自己取（240 秒一圈，够它下载完）。
  for (const item of images.slice(0, 5)) {
    // 预热的是本地那一份：命中就不发请求，没命中就取一次存下来，等 paint 挂上去时零请求。
    // 不再 new Image().src —— 那一行只是让浏览器自己去要，存不进本站的本地缓存。
    void posterObjectUrl(item.src).catch(() => { /* 预热失败不要紧：绕到正面那一张会自己再要一次 */ });
  }
  layer.style.opacity = '0';
  reflow();
  const observer = new ResizeObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(reflow, 120);
  });
  observer.observe(host);
  layer.addEventListener('animationiteration', onIteration);
  window.addEventListener('fb:reduced-motion', () => {
    tiles.forEach((tile) => { tile.style.animationPlayState = 'paused'; });
  });
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    tiles.forEach((tile) => { tile.style.animationPlayState = 'paused'; });
  }
  return () => {
    observer.disconnect();
    window.clearTimeout(timer);
    layer.removeEventListener('animationiteration', onIteration);
  };
}
