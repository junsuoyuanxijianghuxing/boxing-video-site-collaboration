import { escapeCardText as esc, durationClock } from './lesson-card.mjs';
import { publicPublicationItems } from './library-date-feed.mjs';
import { posterObjectUrl } from './poster-cache.mjs';

// Original native implementation. Visual references: Drift Wall's staggered depth,
// Flex Carousel's soft edges, and Video Ambient's glow; no third-party code/shaders.
export const coverWallPool = items => publicPublicationItems(items).filter(item => item.hasPoster).slice(0, 12);

export function mountLiquidCoverWall(root, { items, posterUrlFor }) {
  const grid = root.querySelector('[data-wall-grid]');
  const pause = root.querySelector('[data-wall-pause]');
  const next = root.querySelector('[data-wall-next]');
  const status = root.querySelector('[data-wall-status]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const small = matchMedia('(max-width: 600px)');
  const lifetime = new AbortController();
  const failedPosters = new Set();
  const touchPointers = new Set();
  let pool = [], signature = '', displayed = [], cursor = 0, slot = 0;
  let disposed = false, visible = false, hover = false, focused = false, paused = false, settling = false, timer = null, pending = null, hydrationFrame = null, resumeTimer = null;
  const alive = () => !disposed && root.isConnected;
  const slots = () => Math.min(small.matches ? 3 : 6, pool.length);
  // Browsing freezes replacement targets, not the surrounding atmosphere.
  // Explicit pause, reduced motion, touch and visibility still stop everything.
  const canAnimate = () => alive() && pool.length > 0 && visible && !document.hidden && !reduced.matches && !paused && !settling && !touchPointers.size;
  const canRotate = () => canAnimate() && !hover && !focused;

  function hydrate() {
    if (!alive() || !visible || document.hidden) return;
    const bounds = grid.getBoundingClientRect();
    for (const img of grid.querySelectorAll('img[data-wall-poster]:not([src])')) {
      const box = img.closest('a').getBoundingClientRect();
      if (box.right < Math.max(0, bounds.left) || box.left > Math.min(innerWidth, bounds.right)
        || box.bottom < 0 || box.top > innerHeight) continue;
      const url = img.dataset.wallPoster;
      if (failedPosters.has(url)) { img.hidden = true; continue; }
      if (img.dataset.readyPoster) { img.src = img.dataset.readyPoster; continue; }
      if (img.dataset.directPoster) { img.src = url; continue; }
      if (img.dataset.requested) continue;
      img.dataset.requested = 'true';
      void posterObjectUrl(url).then(local => {
        if (!alive() || !img.isConnected) return;
        // A shared request may finish off screen. Defer decoding/direct fallback
        // until the tile is visible again, rather than starting a second request.
        if (local) img.dataset.readyPoster = local;
        else img.dataset.directPoster = 'true';
        delete img.dataset.requested;
        hydrate();
      }).catch(() => {
        failedPosters.add(url);
        if (alive() && img.isConnected) img.hidden = true;
      });
    }
  }
  function tile(item, index) {
    return `<a class="liquid-wall-tile" href="/v/${encodeURIComponent(item.id)}" data-link data-wall-id="${esc(item.id)}" style="--wall-i:${index}"><div class="liquid-wall-image"><span class="liquid-wall-fallback">${esc(String(item.title).slice(0, 4))}</span><img data-wall-poster="${esc(posterUrlFor(item))}" alt="" width="480" height="270" decoding="async"></div><span class="liquid-wall-caption"><strong>${esc(item.title)}</strong><span>${durationClock(item.durationSeconds)} · ${item.access === 'full' ? '进入观看' : item.access === 'preview' ? '打开试看' : '查看详情'} ↗</span></span></a>`;
  }
  function queueHydrate() {
    if (!alive() || !visible || document.hidden || hydrationFrame !== null) return;
    hydrationFrame = requestAnimationFrame(() => { hydrationFrame = null; hydrate(); });
  }
  function draw() {
    const activeId = document.activeElement?.closest('[data-wall-id]')?.dataset.wallId;
    grid.innerHTML = displayed.map(tile).join('');
    root.dataset.empty = String(!pool.length);
    root.dataset.count = String(displayed.length);
    if (!pool.length) grid.innerHTML = '<div class="liquid-wall-empty"><span>BOXING WITH ANIME</span><strong>真实拳击 · 动画拳击</strong><p>教学影像发布后，封面会出现在这里。</p></div>';
    if (activeId) {
      const target = [...grid.querySelectorAll('[data-wall-id]')].find(a => a.dataset.wallId === activeId);
      (target || pause).focus({ preventScroll: true });
    }
    hydrate();
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    const running = canRotate();
    root.dataset.running = String(canAnimate());
    root.dataset.rotating = String(running && pool.length > slots());
    pause.disabled = !pool.length || reduced.matches;
    next.disabled = pool.length <= slots();
    pause.textContent = paused ? '继续流动' : '暂停流动';
    pause.setAttribute('aria-label', paused ? '继续封面墙动效' : '暂停封面墙动效');
    pause.setAttribute('aria-pressed', String(paused));
    status.textContent = !pool.length ? '封面待更新' : reduced.matches ? '系统已减少动态效果' : paused ? '流动已暂停' : settling || touchPointers.size ? '滑动时暂停' : hover || focused ? '浏览中 · 暂停换图' : pool.length <= slots() ? '精选教学影像' : '精选封面 · 流动轮换';
    if (running && pool.length > slots()) timer = setTimeout(() => { changeOne(); schedule(); }, 6000);
  }
  function pickNext(excluded) {
    for (let count = 0; count < pool.length; count++) {
      const item = pool[cursor++ % pool.length];
      if (!excluded.has(item.id)) return item;
    }
    return null;
  }
  function changeOne() {
    if (!canRotate() || pool.length <= displayed.length) return;
    const index = slot++ % displayed.length;
    const item = pickNext(new Set(displayed.map(one => one.id)));
    if (!item) return;
    displayed[index] = item;
    const old = grid.children[index];
    old.outerHTML = tile(item, index);
    grid.children[index].classList.add('is-arriving');
    hydrate();
  }
  function batch() {
    displayed = [];
    for (let i = 0; i < slots(); i++) {
      const item = pickNext(new Set(displayed.map(one => one.id)));
      if (item) displayed.push(item);
    }
    draw(); schedule();
  }
  function update(items) {
    if (!alive()) return;
    const value = coverWallPool(items);
    const key = JSON.stringify(value.map(item => [item.id, item.posterVersion, item.title, item.access]));
    if (signature === key) return;
    if (focused && document.activeElement?.closest('[data-wall-id]') && root.contains(document.activeElement)) { pending = items; return; }
    pool = value; signature = key; cursor = 0; slot = 0; batch();
  }
  function clearTouch() {
    clearTimeout(resumeTimer); resumeTimer = null;
    touchPointers.clear(); settling = false;
  }
  function settleTouch() {
    clearTimeout(resumeTimer); resumeTimer = null;
    if (!alive() || !visible || document.hidden) { clearTouch(); schedule(); return; }
    settling = true; schedule();
    if (!touchPointers.size) resumeTimer = setTimeout(() => { resumeTimer = null; settling = false; schedule(); }, 1200);
  }
  const listen = (target, name, fn, options = {}) => target.addEventListener(name, fn, { ...options, signal: lifetime.signal });
  listen(pause, 'click', () => { paused = !paused; if (paused) { clearTimeout(resumeTimer); resumeTimer = null; settling = false; } schedule(); });
  listen(next, 'click', () => { if (pool.length > slots()) batch(); });
  listen(root, 'pointerenter', event => { if (event.pointerType !== 'touch') { hover = true; schedule(); } });
  listen(root, 'pointerleave', () => { hover = false; schedule(); });
  listen(root, 'focusin', () => { focused = true; schedule(); });
  listen(root, 'focusout', event => {
    focused = root.contains(event.relatedTarget);
    if (!focused && pending) { const value = pending; pending = null; update(value); }
    schedule();
  });
  listen(document, 'visibilitychange', () => { if (document.hidden) clearTouch(); schedule(); hydrate(); });
  listen(grid, 'pointerdown', event => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') { touchPointers.add(event.pointerId); settleTouch(); }
  }, { passive: true });
  const endTouch = event => { if (touchPointers.delete(event.pointerId)) settleTouch(); };
  listen(window, 'pointerup', endTouch, { passive: true });
  listen(window, 'pointercancel', endTouch, { passive: true });
  listen(grid, 'scroll', () => { if (alive() && visible && !document.hidden) settleTouch(); queueHydrate(); }, { passive: true });
  listen(window, 'scroll', queueHydrate, { passive: true });
  listen(window, 'resize', queueHydrate, { passive: true });
  listen(grid, 'error', event => { if (event.target.tagName === 'IMG') { failedPosters.add(event.target.dataset.wallPoster); event.target.hidden = true; } }, { capture: true });
  const onMotion = () => schedule();
  const onSize = () => { batch(); hydrate(); };
  reduced.addEventListener('change', onMotion);
  small.addEventListener('change', onSize);
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting); if (!visible) clearTouch(); schedule(); hydrate();
  }, { threshold: 0.01 }) : null;
  if (observer) observer.observe(root); else visible = true;
  update(items);
  return {
    update,
    dispose() { disposed = true; clearTimeout(timer); clearTouch(); if (hydrationFrame !== null) cancelAnimationFrame(hydrationFrame); lifetime.abort(); observer?.disconnect(); reduced.removeEventListener('change', onMotion); small.removeEventListener('change', onSize); pending = null; failedPosters.clear(); root.dataset.running = 'false'; root.dataset.rotating = 'false'; },
  };
}
