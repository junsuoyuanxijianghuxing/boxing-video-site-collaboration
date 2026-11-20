import { api, requestJson } from './api.js';
import { escapeCardText as esc } from './lesson-card.mjs';
import { seriesSummaryMarkup } from './series-markup.mjs';
import { publicPublicationItems, publicationRanges, withinPublicationRange, publicationStamp, groupPublications, publicationTimeLabel } from './library-date-feed.mjs';
import { mountLiquidCoverWall } from './liquid-cover-wall.mjs';
import { mountLibraryToolbar } from './library-toolbar.mjs';
import { canResumeFrom, isWatchedToEnd } from './play-progress.mjs';

const kinds = [['all', '全部'], ['live', '真实拳击'], ['anime', '动画拳击']];
const sections = [['all', '全部教学影像'], ['latest', '最近更新'], ['series', '教学合集']];
const urlKeys = ['section', 'page', 'per', 'kind', 'tier', 'duration', 'q', 'view', 'range', 'group', 'access', 'progress', 'sort'];
let remembered = null;
const pick = (value, choices, fallback) => choices.includes(value) ? value : fallback;

// Only public UI preferences enter the URL/history, never video rows or viewer data.
export function readLibraryState(search, fallback = {}, smallScreen = false) {
  const params = new URLSearchParams(search);
  const fromUrl = urlKeys.some(key => params.has(key));
  const value = (key, prop = key) => fromUrl ? params.get(key) : fallback[prop];
  const page = Number(value('page'));
  const tier = String(value('tier') ?? 'all');
  const section = pick(value('section'), ['all', 'latest', 'series'], 'all');
  const ranges = publicationRanges.map(([key]) => key);
  return {
    access: pick(value('access'), ['all', 'full', 'preview'], 'all'),
    progress: pick(value('progress'), ['all', 'new', 'resume', 'finished'], 'all'),
    section,
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1,
    pageSize: pick(Number(value('per', 'pageSize')), [6, 12], smallScreen ? 6 : 12),
    kind: pick(value('kind'), ['all', 'live', 'anime'], 'all'),
    tier: tier === 'all' ? 'all' : /^[0-9]{1,2}$/.test(tier) ? String(Number(tier)) : 'all',
    duration: pick(value('duration'), ['all', 'short', 'medium', 'long'], 'all'),
    query: String(value('q', 'query') ?? '').slice(0, 200),
    mode: pick(value('view', 'mode'), ['grid', 'list'], 'grid'),
    range: pick(fromUrl && section !== 'latest' ? null : value('range'), ranges, '7'),
    period: pick(fromUrl && section !== 'all' ? null : value('range', 'period'), ranges, 'all'),
    sort: pick(value('sort'), ['catalog', 'newest', 'oldest', 'shortest', 'longest'], 'catalog'),
    group: pick(value('group'), ['day', 'none'], 'day'),
  };
}

export function libraryUrl(ui, base = globalThis.location.href) {
  const url = new URL(base);
  for (const key of urlKeys) url.searchParams.delete(key);
  const values = { access: ui.access && ui.access !== 'all' ? ui.access : '', progress: ui.progress && ui.progress !== 'all' ? ui.progress : '', section: ui.section, page: ui.page, per: ui.pageSize,
    kind: ui.kind === 'all' ? '' : ui.kind, tier: ui.tier === 'all' ? '' : ui.tier,
    duration: ui.duration === 'all' ? '' : ui.duration, q: ui.query, view: ui.mode === 'grid' ? '' : ui.mode,
    range: ui.section === 'latest' ? ui.range : ui.section === 'all' && ui.period !== 'all' ? ui.period : '',
    sort: ui.section === 'all' && ui.sort !== 'catalog' ? ui.sort : '', group: ui.section === 'latest' && ui.group === 'none' ? 'none' : '' };
  for (const [key, value] of Object.entries(values)) if (value != null && value !== '') url.searchParams.set(key, String(value));
  return url.pathname + url.search + url.hash;
}

export function libraryWindow(items, ui) {
  const count = Math.max(1, Math.ceil(items.length / ui.pageSize));
  const page = Math.min(Math.max(1, ui.page), count);
  const start = (page - 1) * ui.pageSize;
  return { page, pageCount: count, total: items.length, from: items.length ? start + 1 : 0,
    to: Math.min(items.length, start + ui.pageSize), items: items.slice(start, start + ui.pageSize) };
}

export function matchesLibraryItem(item, ui) {
  const needle = ui.query.trim().toLocaleLowerCase();
  if (ui.section === 'series') {
    return !needle || [item.title, item.description, ...(item.characterTags || []), ...(item.workTags || [])]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle);
  }
  const duration = Number(item.durationSeconds) || 0;
  const progress = ui.progress ?? 'all';
  const seen = Number(item.lastPosition) || 0;
  return ((ui.access ?? 'all') === 'all' || item.access === ui.access)
    && (progress === 'all' || progress === 'new' && Object.prototype.hasOwnProperty.call(item, 'lastPosition') && seen <= 0
      || progress === 'resume' && item.access === 'full' && canResumeFrom(seen, duration)
      || progress === 'finished' && isWatchedToEnd(seen, duration))
    && (ui.kind === 'all' || item.kind === ui.kind)
    && (ui.tier === 'all' || String(Number(item.tierRank) || 0) === ui.tier)
    && (ui.duration === 'all' || duration > 0 && (ui.duration === 'short' ? duration < 120
      : ui.duration === 'medium' ? duration >= 120 && duration < 300 : duration >= 300))
    && (!needle || `${item.title ?? ''} ${item.description ?? ''}`.toLocaleLowerCase().includes(needle));
}

export function sortLibraryItems(items, sort) {
  if (!['newest', 'oldest', 'shortest', 'longest'].includes(sort)) return items;
  const byDate = sort === 'newest' || sort === 'oldest';
  const direction = sort === 'newest' || sort === 'longest' ? -1 : 1;
  const metric = item => byDate ? publicationStamp(item) : Number(item.durationSeconds) > 0 ? Number(item.durationSeconds) : NaN;
  return [...items].sort((a, b) => {
    const av = metric(a), bv = metric(b);
    if (!Number.isFinite(av)) return Number.isFinite(bv) ? 1 : 0;
    if (!Number.isFinite(bv)) return -1;
    return (av - bv) * direction;
  });
}

const tierName = rank => rank === 0 ? '公开观看' : rank === 1 ? '任意档位会员' : `${rank} 级及以上会员`;

export function mountLibraryBrowser(root, { pages, boot, mergeItems, issueNumbers, renderCard, posterUrlFor,
  hydratePosters, onPages, onRefresh, onError }) {
  const lifetime = new AbortController();
  let disposed = false, loading = false, loadError = '', searchTimer;
  const alive = () => !disposed && root.isConnected;
  const node = selector => root.querySelector(selector);
  const ui = readLibraryState(location.search, remembered || {}, window.matchMedia('(max-width: 600px)').matches);
  const input = node('#lib-q');
  const results = node('#kind-list');
  const advanced = node('#library-advanced');
  if (!boot.viewer) ui.progress = 'all';
  input.value = ui.query;
  const periods = [['all', '不限日期'], ...publicationRanges.filter(([key]) => key !== 'all')];
  node('#library-period').innerHTML = periods.map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
  advanced.open = [ui.tier, ui.access, ui.progress].some(value => value !== 'all');
  const hasMore = () => ['live', 'anime'].some(key => pages[key]?.hasMore);
  const wall = mountLiquidCoverWall(node('#library-feature'), { items: publicPublicationItems(mergeItems(pages), pages.latest?.items), posterUrlFor });

  function remember(push = false) {
    remembered = { ...ui };
    const url = libraryUrl(ui);
    const entry = { ...(history.state || {}), libraryUi: { ...ui } };
    if (push && url !== location.pathname + location.search + location.hash) history.pushState(entry, '', url);
    else history.replaceState(entry, '', url);
  }
  function moveToResults() {
    node('#library-result-count').focus({ preventScroll: true });
    node('#teaching-library').scrollIntoView({ block: 'start', behavior: 'auto' });
    hydratePosters();
  }
  const pageLink = (page, text, extra = '') => `<a class="library-page-link" href="${esc(libraryUrl({ ...ui, page }))}" data-display-page="${page}" ${extra}>${text}</a>`;

  function paint({ push = false, scroll = false } = {}) {
    if (!alive()) return;
    const all = mergeItems(pages);
    const ranks = [...new Set(all.map(item => Number(item.tierRank) || 0))].sort((a, b) => a - b);
    // A deep-linked filter may have no matches in the currently loaded batch.
    // Preserve the choice instead of silently widening the user's filter.
    if (ui.tier !== 'all' && !ranks.includes(Number(ui.tier))) ranks.push(Number(ui.tier));
    const now = Date.now();
    const publications = publicPublicationItems(all, pages.latest?.items);
    const latest = publications.filter(item => withinPublicationRange(item, ui.range, now));
    const series = Array.isArray(pages.series) ? pages.series : [];
    const isSeries = ui.section === 'series';
    const isLatest = ui.section === 'latest';
    const period = isLatest ? ui.range : ui.period;
    const base = isSeries ? series : isLatest ? latest
      : period === 'all' ? all : all.filter(item => withinPublicationRange(item, period, now));
    const matching = base.filter(item => matchesLibraryItem(item, ui));
    const matched = !isLatest && !isSeries ? sortLibraryItems(matching, ui.sort) : matching;
    const windowed = libraryWindow(matched, ui);
    const filtered = Boolean(ui.query.trim() || !isSeries && (ui.kind !== 'all' || ui.tier !== 'all' || ui.duration !== 'all'
      || ui.access !== 'all' || ui.progress !== 'all' || period !== 'all'));
    const pending = !isSeries && hasMore() && (filtered || isLatest || ui.sort !== 'catalog' || ui.page > windowed.pageCount);
    if (!pending) ui.page = windowed.page;
    const name = sections.find(([key]) => key === ui.section)[1];
    const amounts = { all: all.length, latest: latest.length, series: series.length };
    node('#library-overview').textContent = `${hasMore() ? '已加载 ' : ''}${all.length} 条教学影像 · ${series.length} 个合集`;
    node('#catalog-title').textContent = name;
    node('#library-sections').innerHTML = sections.map(([key, label]) =>
      `<a class="library-section" href="${esc(libraryUrl({ ...ui, section: key, page: 1 }))}" data-library-section="${key}"${key === ui.section ? ' aria-current="page"' : ''}>${label}<span>${amounts[key]}${key !== 'series' && hasMore() ? '+' : ''}</span></a>`).join('');
    node('[data-video-controls]').hidden = isSeries;
    advanced.hidden = isSeries;
    node('#view-modes').hidden = isSeries;
    node('#library-search-label').textContent = isSeries ? '搜索教学合集' : '搜索教学影像';
    input.placeholder = isSeries ? '搜索合集名称、角色或作品' : '搜索教学影像';
    node('#library-date-tools').hidden = isSeries;
    node('#library-sort-label').hidden = isLatest;
    node('#library-group-label').hidden = !isLatest;
    node('#library-period').value = period;
    node('#library-sort').value = ui.sort;
    node('#library-date-group').value = ui.group;
    node('#kind-tabs').innerHTML = kinds.map(([key, label]) => {
      const count = key === 'all' ? base.length : base.filter(item => item.kind === key).length;
      return `<button type="button" class="chip${ui.kind === key ? ' is-on' : ''}" data-kind="${key}" aria-pressed="${ui.kind === key}">${label}<span>${count}</span></button>`;
    }).join('');
    node('#view-modes').innerHTML = ['grid', 'list'].map(mode => `<button type="button" class="btn btn-sm btn-ghost" data-library-mode="${mode}" aria-pressed="${ui.mode === mode}">${mode === 'grid' ? '网格' : '列表'}</button>`).join('');
    node('#library-tier').innerHTML = '<option value="all">全部会员要求</option>' + ranks.map(rank => `<option value="${rank}">${tierName(rank)}</option>`).join('');
    node('#library-tier').value = ui.tier;
    node('#library-duration').value = ui.duration;
    node('#library-page-size').value = String(ui.pageSize);
    node('#library-access').value = ui.access;
    node('#library-progress').value = ui.progress;
    node('#library-progress').disabled = !boot.viewer;
    node('#library-progress-label').textContent = boot.viewer ? '学习进度' : '学习进度（登录后可用）';
    const activeCount = [ui.tier, ui.access, ui.progress].filter(value => value !== 'all').length;
    const chips = [];
    if (ui.query.trim()) chips.push(['query', `搜索：${ui.query.trim().slice(0, 24)}`]);
    if (!isSeries) {
      if (period !== 'all') chips.push([isLatest ? 'range' : 'period', publicationRanges.find(([key]) => key === period)[1] + '发布']);
      if (ui.kind !== 'all') chips.push(['kind', kinds.find(([key]) => key === ui.kind)[1]]);
      if (ui.tier !== 'all') chips.push(['tier', tierName(Number(ui.tier))]);
      if (ui.duration !== 'all') chips.push(['duration', { short: '少于 2 分钟', medium: '2 至不足 5 分钟', long: '5 分钟及以上' }[ui.duration]]);
      if (ui.access !== 'all') chips.push(['access', ui.access === 'full' ? '已解锁完整版' : '仅能试看']);
      if (ui.progress !== 'all') chips.push(['progress', { new: '还没开始', resume: '可继续观看', finished: '看到过结尾' }[ui.progress]]);
    }
    const activeFilters = node('#library-active-filters');
    activeFilters.hidden = !chips.length;
    activeFilters.innerHTML = chips.map(([key, label]) => `<button type="button" class="chip" data-remove-filter="${key}" aria-label="移除筛选：${esc(label)}">${esc(label)} <span aria-hidden="true">×</span></button>`).join('');
    node('#library-filter-count').textContent = activeCount ? ` ${activeCount}` : '';
    node('#catalog-viewer-context').textContent = boot.privileged ? '管理员预览：可查看全部已发布内容'
      : boot.rank > 0 ? `当前会员 ${boot.rank} 级 · 按卡片要求观看完整内容` : '试看无需登录 · 完整观看按会员等级开放';
    node('#library-result-count').innerHTML = `${esc(isLatest ? ui.range === 'all' ? '全部更新' : publicationRanges.find(([key]) => key === ui.range)[1] + '更新' : name)} ${windowed.total ? `<strong>${windowed.from}–${windowed.to}</strong> / ${windowed.total}` : '<strong>0</strong>'} ${isSeries ? '个' : '条'}${filtered ? ' · 已筛选 <button type="button" class="linklike" data-clear-filters>清空</button>' : ''}`;
    const note = node('#library-scope-note');
    const unknownDates = publications.filter(item => !Number.isFinite(publicationStamp(item))).length;
    const progressIncomplete = !isSeries && ui.progress !== 'all' && base.some(item => !Object.prototype.hasOwnProperty.call(item, 'lastPosition'));
    note.hidden = !hasMore() && !(isLatest && unknownDates) && !progressIncomplete;
    note.textContent = (hasMore() ? '正在分批读取目录。使用筛选或排序时会自动加载其余内容。' : '')
      + (isLatest && unknownDates ? ` ${unknownDates} 条内容缺少有效发布日期，未计入日期结果。` : '')
      + (progressIncomplete ? ' 学习进度仅统计已读到观看记录的内容，可刷新目录或加载后续内容后再试。' : '');
    if (isSeries) { note.hidden = !pages.seriesError; note.textContent = '合集信息暂时未能读取，可先浏览教学影像目录。'; }
    results.setAttribute('aria-busy', String(pending && !loadError));
    if (pending) {
      node('#library-result-count').textContent = loadError ? '完整结果暂未读完' : '正在检索全部教学影像…';
      note.hidden = true;
      results.innerHTML = loadError
        ? '<div class="library-empty"><p>目录暂未读完，请重试以查看完整结果。</p><button class="btn" type="button" data-library-more>重试读取</button></div>'
        : '<p class="dim">正在读取后续目录…</p>';
      for (const id of ['#library-page-quick', '#library-pagination', '#library-load-more']) node(id).replaceChildren();
      remember(push);
      if (!loading && !loadError) void loadMore();
      return;
    }
    if (!matched.length) {
      results.innerHTML = `<div class="library-empty"><h3>${filtered ? '没有符合条件的内容' : isSeries ? '暂无已公开合集' : isLatest ? '这段时间暂无更新' : '暂无已发布教学影像'}</h3><p>${filtered ? '试试其他关键词，或清空筛选。' : isSeries ? '可以切换到全部教学影像继续浏览。' : isLatest ? '可以切换其他时间范围，或浏览全部教学影像。' : '内容发布后会显示在这里。'}</p>${filtered ? '<button type="button" class="btn btn-sm btn-ghost" data-clear-filters>清空筛选</button>' : isLatest && ui.range !== '30' && ui.range !== 'all' ? '<button type="button" class="btn btn-sm btn-ghost" data-date-range="30">查看近 30 天</button>' : ''}</div>`;
    } else if (isSeries) {
      results.innerHTML = `<div class="series-summary-grid">${windowed.items.map(item => seriesSummaryMarkup(item, { posterUrlFor })).join('')}</div>`;
    } else {
      const numbers = issueNumbers(pages);
      const card = item => {
        const html = renderCard(item, numbers);
        if (!isLatest && period === 'all' && !['newest', 'oldest'].includes(ui.sort)) return html;
        const stamp = publicationStamp(item);
        const time = Number.isFinite(stamp) ? `<time class="publication-time" datetime="${new Date(stamp).toISOString()}">发布于 ${esc(publicationTimeLabel(item))}</time>`
          : '<span class="publication-time">发布日期待补充</span>';
        return html.replace('<div class="card-text">', `<div class="card-text">${time}`);
      };
      const list = items => `<div class="grid${ui.mode === 'list' ? ' lesson-list' : ''}${isLatest ? ' is-date-feed' : ''}">${items.map(card).join('')}</div>`;
      results.innerHTML = isLatest && ui.group === 'day' ? groupPublications(windowed.items).map(group => `<section class="publication-day" aria-label="${esc(group.label)}发布"><header><h3><time datetime="${group.key}">${esc(group.label)}</time></h3><span>本页 ${group.items.length} 条</span></header>${list(group.items)}</section>`).join('') : list(windowed.items);
    }
    const { page, pageCount } = windowed;
    node('#library-page-quick').innerHTML = pageCount > 1
      ? `<span>第 ${page} / ${pageCount} 页</span>${page > 1 ? pageLink(page - 1, '上一页', 'aria-label="上一页（顶部）"') : ''}${page < pageCount ? pageLink(page + 1, '下一页', 'aria-label="下一页（顶部）"') : ''}` : '';
    const wanted = [...new Set([1, page - 1, page, page + 1, pageCount])].filter(n => n > 0 && n <= pageCount).sort((a,b) => a-b);
    let last = 0;
    node('#library-pagination').innerHTML = pageCount <= 1 ? '' : `<nav class="library-pagination" aria-label="目录分页">${page > 1 ? pageLink(page-1, '上一页') : ''}${wanted.map(n => {
      const gap = last && n > last + 1 ? '<span aria-hidden="true">…</span>' : ''; last = n;
      return gap + pageLink(n, String(n), `aria-label="第 ${n} 页"${n === page ? ' aria-current="page"' : ''}`);
    }).join('')}${page < pageCount ? pageLink(page+1, '下一页') : ''}</nav>`;
    const more = node('#library-load-more');
    more.innerHTML = !isSeries && hasMore() && page === pageCount
      ? `<div class="library-more"><p>还有尚未加载的教学影像，加载后可继续翻页和搜索。</p><button class="btn btn-ghost" type="button" data-library-more${loading ? ' disabled' : ''}>${loading ? '正在加载…' : '加载后续内容'}</button></div>` : '';
    remember(push);
    hydratePosters();
    wall.update(publications);
    if (scroll) moveToResults();
  }

  async function loadMore() {
    if (loading || !alive()) return;
    loading = true; loadError = ''; paint();
    const batch = new AbortController();
    const abort = () => batch.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 20000);
    try {
      const keys = ['live', 'anime'].filter(key => pages[key]?.hasMore);
      const responses = await Promise.all(keys.map(kind => requestJson(api('library', { kind, offset: pages[kind].nextOffset, limit: 120 }), { signal: batch.signal })));
      if (!alive()) return;
      if (batch.signal.aborted) throw new Error('读取超时');
      if (responses.some((response, index) => pages[keys[index]].orderRevision && response.orderRevision !== pages[keys[index]].orderRevision)) {
        await onRefresh(); return;
      }
      if (responses.some((response, i) => !Array.isArray(response.items) || response.hasMore
        && (!Number.isSafeInteger(response.nextOffset) || response.nextOffset <= pages[keys[i]].nextOffset))) {
        throw new Error('目录分页没有前进，请重试。');
      }
      for (const [index, key] of keys.entries()) {
        const merged = new Map([...pages[key].items, ...responses[index].items].map(item => [item.id, item]));
        pages[key] = { ...responses[index], items: [...merged.values()] };
      }
      onPages(pages);
    } catch (error) {
      const timedOut = batch.signal.aborted;
      batch.abort(); // Cancel the other kind too if either request failed.
      if (alive() && !lifetime.signal.aborted) {
        loadError = timedOut ? '加载超时，可稍后再试。' : error.message || '后续内容暂时未能加载。';
        onError(loadError);
      }
    } finally {
      clearTimeout(timeout); lifetime.signal.removeEventListener('abort', abort);
      loading = false; if (alive()) paint();
    }
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('[data-library-section],[data-kind],[data-library-mode],[data-display-page],[data-clear-filters],[data-library-more],[data-date-range],[data-wall-recent],[data-remove-filter],[data-library-refresh]');
    if (!target || !root.contains(target) || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    if (target.hasAttribute('data-library-refresh')) { void onRefresh(); return; }
    if (target.hasAttribute('data-library-more')) { void loadMore(); return; }
    clearTimeout(searchTimer); ui.query = input.value.slice(0, 200);
    let focus = '';
    if (target.dataset.librarySection) { ui.section = target.dataset.librarySection; ui.page = 1; focus = `[data-library-section="${ui.section}"]`; }
    if (target.dataset.dateRange) { ui.range = target.dataset.dateRange; ui.page = 1; focus = '#library-period'; }
    if (target.hasAttribute('data-wall-recent')) { ui.section = 'latest'; ui.range = '7'; ui.page = 1; focus = '[data-library-section="latest"]'; }
    if (target.dataset.kind) { ui.kind = target.dataset.kind; ui.page = 1; focus = `[data-kind="${ui.kind}"]`; }
    if (target.dataset.libraryMode) { ui.mode = target.dataset.libraryMode; focus = `[data-library-mode="${ui.mode}"]`; }
    if (target.dataset.removeFilter && ['query', 'kind', 'tier', 'duration', 'access', 'progress', 'period', 'range'].includes(target.dataset.removeFilter)) {
      const key = target.dataset.removeFilter; ui[key] = key === 'query' ? '' : 'all';
      ui.page = 1; input.value = ui.query; focus = '#lib-q';
    }
    if (target.hasAttribute('data-clear-filters')) { ui.query = ''; ui.kind = ui.tier = ui.duration = ui.access = ui.progress = 'all'; if (ui.section === 'latest') ui.range = 'all'; else ui.period = 'all'; ui.page = 1; input.value = ''; focus = '#lib-q'; }
    if (target.dataset.displayPage) ui.page = Number(target.dataset.displayPage);
    paint({ push: true, scroll: Boolean(target.dataset.displayPage || target.hasAttribute('data-wall-recent')) });
    if (focus) node(focus)?.focus({ preventScroll: true });
  }, { signal: lifetime.signal });
  const search = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (alive()) { ui.query = input.value.slice(0, 200); ui.page = 1; paint(); } }, 160);
  };
  input.addEventListener('input', event => { if (!event.isComposing) search(); }, { signal: lifetime.signal });
  input.addEventListener('compositionend', search, { signal: lifetime.signal });
  root.addEventListener('change', event => {
    clearTimeout(searchTimer); ui.query = input.value.slice(0, 200);
    if (event.target.id === 'library-tier') ui.tier = event.target.value;
    else if (event.target.id === 'library-access') ui.access = event.target.value;
    else if (event.target.id === 'library-progress') ui.progress = boot.viewer ? event.target.value : 'all';
    else if (event.target.id === 'library-sort') ui.sort = event.target.value;
    else if (event.target.id === 'library-period') ui[ui.section === 'latest' ? 'range' : 'period'] = event.target.value;
    else if (event.target.id === 'library-duration') ui.duration = event.target.value;
    else if (event.target.id === 'library-page-size') ui.pageSize = Number(event.target.value);
    else if (event.target.id === 'library-date-group') ui.group = event.target.value;
    else return;
    ui.page = 1; paint({ push: true });
  }, { signal: lifetime.signal });
  paint();
  const disposeToolbar = mountLibraryToolbar(root);
  return () => { disposeToolbar(); disposed = true; clearTimeout(searchTimer); lifetime.abort(); wall.dispose(); };
}
