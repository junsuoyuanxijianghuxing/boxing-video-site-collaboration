import { get } from './api.js';
import { hydratePosters, posterSrc } from './app.js';
import { escapeCardText as esc, durationClock, membershipRequirement, previewLabel } from './lesson-card.mjs';
import { seriesDetailMarkup, seriesSummaryMarkup, seriesHref, episodeHref } from './series-markup.mjs';

const posterUrlFor = (item) => posterSrc(item.id, item.posterVersion);
const pageFrame = (body) => `<div class="wrap series-page"><nav class="series-breadcrumb" aria-label="合集导航"><a href="/library" data-link>教学影像库</a><span aria-hidden="true">/</span><a href="/series" data-link>教学合集</a></nav>${body}</div>`;

export async function mountSeriesList(view) {
  view.innerHTML = pageFrame('<div class="section-heading"><div><p class="lesson-kicker">LESSON SERIES</p><h1>教学合集</h1></div><p>按作品、角色或教学主题整理的分集内容。</p></div><div class="series-page-content"><p class="dim" role="status">正在读取教学合集…</p></div>');
  const content = view.querySelector('.series-page-content');
  try {
    const response = await get('lesson-series');
    if (!content.isConnected) return;
    const items = Array.isArray(response.items) ? response.items : [];
    content.innerHTML = items.length
      ? `<div class="series-summary-grid">${items.map((series) => seriesSummaryMarkup(series, { posterUrlFor })).join('')}</div>`
      : '<p class="note">教学合集正在整理中，现有教学影像可在教学影像库查看。</p>';
    hydratePosters();
  } catch {
    if (!content.isConnected) return;
    content.innerHTML = '<div class="note"><p>教学合集暂时未能读取。</p><button class="btn btn-sm" type="button" data-retry-series>重新读取</button></div>';
    content.querySelector('[data-retry-series]').addEventListener('click', () => void mountSeriesList(view));
  }
}

export async function mountSeriesDetail(view, { id }) {
  view.innerHTML = pageFrame('<div class="series-page-content"><p class="dim" role="status">正在读取合集分集…</p></div>');
  const content = view.querySelector('.series-page-content');
  try {
    const response = await get('lesson-series-detail', { seriesId: id });
    if (!content.isConnected) return;
    if (!response.series || String(response.series.id) !== String(id)) {
      content.innerHTML = '<div class="stack"><h1>这个合集暂时无法查看</h1><p class="dim">合集可能已调整或暂未发布。</p><a class="btn" href="/library" data-link>回到教学影像库</a></div>';
      return;
    }
    content.innerHTML = seriesDetailMarkup(response.series, { posterUrlFor });
    document.title = `${response.series.title} · 教学合集`;
    hydratePosters();
  } catch (error) {
    if (!content.isConnected) return;
    const missing = error?.status === 404 || error?.code === 'series_not_found';
    content.innerHTML = `<div class="stack"><h1>${missing ? '这个合集暂时无法查看' : '合集分集暂时未能读取'}</h1><p class="dim">${missing ? '合集可能已调整或暂未发布。' : '请稍后重新读取；教学影像库仍可正常浏览。'}</p><div class="row">${missing ? '' : '<button class="btn" type="button" data-retry-series>重新读取</button>'}<a class="btn btn-ghost" href="/library" data-link>回到教学影像库</a></div></div>`;
    content.querySelector('[data-retry-series]')?.addEventListener('click', () => void mountSeriesDetail(view, { id }));
  }
}

// This metadata request runs after player setup; it never changes media URLs,
// membership gates, progress events or playback state.
export async function mountPlayerSeries(sidebar, { videoId, seriesId = '', stage }) {
  try {
    const response = await get('lesson-series-detail', seriesId ? { seriesId, videoId } : { videoId });
    if (!sidebar.isConnected || !stage.isConnected) return;
    const series = response.series;
    const items = Array.isArray(series?.items) ? series.items : [];
    const current = items.findIndex((item) => String(item.id) === String(videoId));
    if (!series || current < 0 || seriesId && String(series.id) !== String(seriesId)) return;
    const previous = items[current - 1];
    const next = items[current + 1];
    sidebar.innerHTML = `<div class="series-player-heading"><p class="lesson-kicker">教学合集</p><h2><a href="${seriesHref(series.id)}" data-link>${esc(series.title)}</a></h2><p>第 ${current + 1} / ${items.length} 集</p></div>
      <nav class="series-adjacent" aria-label="相邻分集">${previous ? `<a class="btn btn-sm" href="${episodeHref(previous.id, series.id)}" data-link>← 上一集</a>` : '<span class="series-adjacent-empty">已是第一集</span>'}${next ? `<a class="btn btn-sm" href="${episodeHref(next.id, series.id)}" data-link>下一集 →</a>` : '<span class="series-adjacent-empty">已是最后一集</span>'}</nav>
      <nav class="series-player-episodes" aria-label="合集全部分集"><ol>${items.map((item, index) => `<li><a class="series-player-episode${index === current ? ' is-current' : ''}" href="${episodeHref(item.id, series.id)}" data-link${index === current ? ' aria-current="page"' : ''}>
        <div class="poster">${item.hasPoster ? `<img data-poster="${esc(posterUrlFor(item))}" alt="" decoding="async" width="1280" height="720">` : `<span class="poster-code">${index + 1}</span>`}</div>
        <div><span class="series-episode-number">第 ${index + 1} 集${index === current ? ' · 当前观看' : ''}</span><strong>${esc(item.title)}</strong><span class="series-episode-meta">${durationClock(item.durationSeconds)} · ${esc(membershipRequirement(item.tierRank))}</span><span class="series-episode-access">${esc(previewLabel(item))}</span></div>
      </a></li>`).join('')}</ol></nav><a class="series-full-link" href="${seriesHref(series.id)}" data-link>查看完整合集信息 ↗</a>`;
    sidebar.hidden = false;
    sidebar.closest('.player-shell')?.classList.add('has-series');
    sidebar.querySelector('.series-player-episodes').addEventListener('scroll', hydratePosters, { passive: true });
    hydratePosters();
  } catch {
    // A missing/private/unavailable series must not interrupt an authorised video.
  }
}
