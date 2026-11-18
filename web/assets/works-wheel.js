// 封面转盘：静止时一圈封面绕着中间的字，滚一下（或拖、或用上下键）就把圈推开成竖着的鼓，
// 正面那张摊平放大到实际大小，上下两张转开消失在画面边缘。
// 一个数字 turn 决定全部状态，一帧只写一次 transform，不重建节点。

import { setPosterSrc } from './poster-cache.mjs';

const CARD_H = 0.38;
const CARD_MAX_W = 0.34;
const CARD_RATIO = 1.45;
const STEP = 40;
const DRUM = 2.22;
const LENS = 2.7;
const RING_R = 1.14;
const BOW = 1.82;
const TITLE = 0.124;
const INDEX = 0.055;
const CULL = 1.6;
const WHEEL_UNITS = 900;
const DRAG_UNITS = 420;
const SETTLE = 140;
const EASE = 0.12;
const TAP_SLOP = 8;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const lerp = (a, b, t) => a + (b - a) * t;
const rad = (deg) => (deg * Math.PI) / 180;
// 鼓不是挂在一条竖线上：整条弧的圆心偏左，正面那张正好落在最近的点上，
// 邻居除了上下还各自往左带回一点。是这一笔把"一叠卡片"变成"侧着看的轮子"。
const bowAt = (drumDeg, bow) => -bow * (1 - Math.cos(rad(drumDeg)));

function place(ringDeg, drumDeg, ringR, drumR, bow, m) {
  return `translateX(${m * bowAt(drumDeg, bow)}px)`
    + ` rotateZ(${(1 - m) * ringDeg}deg) translateY(${-(1 - m) * ringR}px)`
    + ` rotateX(${m * drumDeg}deg) translateZ(${m * drumR}px)`;
}

export function mountWorksWheel(host, { items = [], label = '封面墙', action = '看' } = {}) {
  if (!host || !items.length || typeof requestAnimationFrame === 'undefined') return () => {};
  host.className = 'works-wheel';
  host.innerHTML = `
    <div class="ww-stage" tabindex="0" role="group"
      aria-label="封面转盘：滚轮、上下拖动或按上下方向键展开，点正面那张进入">
      <div class="ww-wheel"></div>
    </div>
    <div class="ww-label">${esc(label)}</div>
    <div class="ww-title" aria-live="polite"></div>
    <ol class="ww-index"></ol>`;
  const stage = host.querySelector('.ww-stage');
  const wheel = host.querySelector('.ww-wheel');
  const labelEl = host.querySelector('.ww-label');
  const titleEl = host.querySelector('.ww-title');
  const indexEl = host.querySelector('.ww-index');

  wheel.innerHTML = items.map((item, i) => `<a class="ww-card"${item.href ? ` href="${esc(item.href)}" data-link` : ''}>
    <span class="ww-face"><img data-poster="${esc(item.image)}" alt="${esc(item.title)}" draggable="false" loading="lazy" decoding="async">${item.href ? `<span class="ww-action">${esc(action)}</span>` : ''}</span></a>`).join('');
  indexEl.innerHTML = items.map((item, i) => `<li><button type="button" data-go="${i + 1}"`
    + ` aria-label="第 ${i + 1} 条：${esc(item.title)}">`
    + `<span class="ww-num">${i + 1}</span><span class="ww-name">${esc(item.title)}</span></button></li>`).join('');
  // 一圈最多 12 张，哪一张会转到正面要看人停在哪，所以这里不做"看得见才取"；
  // 但取过的每一张都进本地那一份 —— 第二次打开这一屏一条封面请求都不发。
  for (const image of wheel.querySelectorAll('.ww-face img')) void setPosterSrc(image, image.dataset.poster);
  const cards = [...wheel.querySelectorAll('.ww-card')];
  const faces = cards.map((card) => card.querySelector('.ww-face'));
  const indexButtons = [...indexEl.querySelectorAll('button')];

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const count = items.length;
  const last = Math.max(count - 1, 0);
  let turnValue = 0;
  let target = 0;
  let active = -1;
  let settle = 0;
  let dragFrom = null;
  let dragTotal = 0;
  let metrics = {};

  const size = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const cardW = Math.min(h * CARD_H * CARD_RATIO, w * CARD_MAX_W);
    const cardH = cardW / CARD_RATIO;
    const drumR = cardH * DRUM;
    const ringR = cardH * RING_R;
    // 圈上的卡片要缩到"能看成一个闭合的环"，不然给了几张就飘成几颗珠子。
    const ringScale = clamp((((2 * Math.PI * ringR) / count) * 0.82) / (cardW || 1), 0.16, 1);
    metrics = {
      cardW,
      cardH,
      ringR,
      drumR,
      ringScale,
      bow: cardH * BOW,
      depth: cardH * LENS,
    };
    stage.style.perspective = `${metrics.depth}px`;
    // 字号交给 CSS 兜下限：这里只报几何算出来的理想值，窄屏才不会缩成 5px 的摸不到的小字。
    host.style.setProperty('--ww-title', `${cardH * TITLE}px`);
    host.style.setProperty('--ww-index', `${cardH * INDEX}px`);
    cards.forEach((card) => {
      card.style.width = `${metrics.cardW}px`;
      card.style.height = `${metrics.cardH}px`;
      card.style.marginLeft = `${-metrics.cardW / 2}px`;
      card.style.marginTop = `${-metrics.cardH / 2}px`;
    });
  };

  const draw = () => {
    const gap = target - turnValue;
    turnValue = Math.abs(gap) < 0.0005 ? target : turnValue + gap * (reduced ? 1 : EASE);
    const m = clamp(turnValue, 0, 1);
    const pos = Math.max(0, turnValue - 1);
    // 鼓要把正面推回画面平面上，这个后退得跟鼓同时出现，
    // 否则圈还挂在透视远处，正面看着只有实际大小的一半。
    wheel.style.transform = `translateZ(${-m * metrics.drumR}px)`;
    for (let i = 0; i < count; i += 1) {
      const d = i - pos;
      cards[i].style.transform = place(d * (360 / count), d * STEP, metrics.ringR, metrics.drumR, metrics.bow, m);
      // 鼓：按距离裁掉，不按角度 —— 转满一圈时背面会重新正对镜头。
      // 圈：背面那几张是倒着挂的，淡出成花环的收尾，比让一整排字倒挂在下面好看。
      const ringOpacity = clamp((Math.cos(rad(d * (360 / count))) + 0.55) / 1.55, 0, 1);
      const op = m > 0.5 ? (Math.abs(d) > CULL ? 0 : 1) : ringOpacity;
      cards[i].style.opacity = String(op);
      cards[i].style.pointerEvents = op < 0.25 ? 'none' : '';
      cards[i].style.zIndex = String(Math.round(100 - Math.abs(d) * 2));
      faces[i].style.transform = `scale(${lerp(metrics.ringScale, 1, m)})`;
    }
    labelEl.style.opacity = String(1 - m);
    titleEl.style.opacity = String(m);
    const near = clamp(Math.round(pos), 0, last);
    if (near !== active) {
      active = near;
      titleEl.textContent = items[active]?.title ?? '';
      indexButtons.forEach((button, i) => button.classList.toggle('is-active', i === active));
    }
  };

  let frame = requestAnimationFrame(function loop() {
    frame = requestAnimationFrame(loop);
    draw();
  });

  const setTarget = (next) => { target = clamp(next, 0, last + 1); };

  // 滚轮要能交还给页面：还有地方可去的时候才拦下滚动，到了两头就放开，
  // 不然人划到转盘这里就再也翻不动整页了。
  const onWheel = (event) => {
    const next = target + event.deltaY / WHEEL_UNITS;
    if (next > 0 && next < last + 1) event.preventDefault();
    setTarget(next);
    // 一串滚轮事件没有"结束"这个信号，停在半格上就是正面什么都没有。
    window.clearTimeout(settle);
    settle = window.setTimeout(() => setTarget(Math.round(target)), SETTLE);
  };
  const endDrag = () => {
    dragFrom = null;
    // 停下要落到整格，否则停在两张之间，正面是空的。
    if (target > 1) setTarget(Math.round(target));
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('pointerdown', (event) => {
    dragFrom = event.clientY;
    dragTotal = 0;
    stage.setPointerCapture?.(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (dragFrom === null) return;
    const step = dragFrom - event.clientY;
    dragTotal += Math.abs(step);
    setTarget(target + step / DRAG_UNITS);
    dragFrom = event.clientY;
  });
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // 拖完手就停在某张封面上，浏览器照样会发 click：拦掉，不然翻个面就误进播放页。
  stage.addEventListener('click', (event) => {
    if (dragTotal <= TAP_SLOP) return;
    dragTotal = 0;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  stage.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') setTarget(Math.round(target) + 1);
    else if (event.key === 'ArrowUp') setTarget(Math.round(target) - 1);
    else if (event.key === 'Home') setTarget(0);
    else if (event.key === 'End') setTarget(last + 1);
    else return;
    event.preventDefault();
  });
  indexEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-go]');
    if (button) setTarget(Number(button.dataset.go));
  });

  const observer = new ResizeObserver(size);
  observer.observe(stage);
  size();

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.clearTimeout(settle);
    stage.removeEventListener('wheel', onWheel);
  };
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
