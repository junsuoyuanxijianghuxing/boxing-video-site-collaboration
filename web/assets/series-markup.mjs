import { escapeCardText as esc, durationClock, lessonCardMarkup } from './lesson-card.mjs';

export const seriesHref = (id) => `/series/${encodeURIComponent(id)}`;
export const episodeHref = (videoId, seriesId) => `/v/${encodeURIComponent(videoId)}?series=${encodeURIComponent(seriesId)}`;

export function seriesDurationLabel(series) {
  const seconds = Number(series.totalDurationSeconds);
  if (!(seconds > 0)) return '时长待补充';
  return `${series.durationIncomplete ? '已知分集时长 ' : '已发布总时长 '}${durationClock(seconds)}${series.durationIncomplete ? ' · 部分待补充' : ''}`;
}

function tagsMarkup(series) {
  const groups = [
    ['角色', Array.isArray(series.characterTags) ? series.characterTags : []],
    ['作品', Array.isArray(series.workTags) ? series.workTags : []],
  ];
  return groups.filter(([, tags]) => tags.length).map(([label, tags]) => `<div class="series-tag-group"><span class="series-tag-label">${label}</span>${tags.map((tag) => `<span class="series-tag">${esc(tag)}</span>`).join('')}</div>`).join('');
}

function coverMarkup(series, posterUrlFor) {
  const cover = series.cover;
  const posterUrl = cover?.hasPoster && typeof posterUrlFor === 'function' ? posterUrlFor(cover) : '';
  return `<div class="poster series-cover">${posterUrl
    ? `<img data-poster="${esc(posterUrl)}" alt="" decoding="async" width="1280" height="720">`
    : `<span class="poster-code">${esc(String(series.title ?? '').slice(0, 4))}</span>`}<span class="series-cover-label">教学合集</span></div>`;
}

export function seriesSummaryMarkup(series, { posterUrlFor, interactive = true } = {}) {
  const tag = interactive ? 'a' : 'article';
  const target = interactive ? ` href="${seriesHref(series.id)}" data-link` : '';
  return `<${tag} class="series-summary"${target}>
    ${coverMarkup(series, posterUrlFor)}
    <div class="series-summary-copy"><p class="series-eyebrow">${Number(series.episodeCount) || 0} 集教学影像</p><h3>${esc(series.title)}</h3>
      ${series.description ? `<p class="series-summary-description">${esc(series.description)}</p>` : ''}
      <div class="series-tags">${tagsMarkup(series)}</div>
      <div class="series-summary-footer"><span>${esc(seriesDurationLabel(series))}</span><span aria-hidden="true">查看分集 ↗</span></div>
    </div>
  </${tag}>`;
}

// Public detail and the administrator's anonymous preview share this exact markup.
// Preview never contains links, buttons or media elements.
export function seriesDetailMarkup(series, { posterUrlFor, interactive = true } = {}) {
  const items = Array.isArray(series.items) ? series.items : [];
  const first = items[0];
  return `<div class="series-detail">
    <header class="series-detail-hero">
      ${coverMarkup(series, posterUrlFor)}
      <div class="series-detail-copy"><p class="lesson-kicker">LESSON SERIES</p><h1>${esc(series.title)}</h1>
        ${series.description ? `<p class="series-description">${esc(series.description)}</p>` : ''}
        <div class="series-tags">${tagsMarkup(series)}</div>
        <div class="series-detail-facts"><strong>${Number(series.episodeCount) || 0} 集</strong><span>${esc(seriesDurationLabel(series))}</span></div>
        ${first && interactive ? `<a class="btn btn-primary" href="${episodeHref(first.id, series.id)}" data-link>从第 1 集开始 ↗</a>` : ''}
      </div>
    </header>
    <section class="series-episodes" aria-label="合集分集"><div class="series-section-heading"><h2>分集目录</h2><p>每集的时长、试看内容和会员要求在下方显示。</p></div>
      ${items.length ? `<div class="series-lesson-grid">${items.map((item, index) => lessonCardMarkup(item, {
        posterUrl: typeof posterUrlFor === 'function' ? posterUrlFor(item) : '',
        interactive,
        href: episodeHref(item.id, series.id),
        contextLabel: `第 ${Number(item.episodeNumber) || index + 1} 集`,
      })).join('')}</div>` : '<p class="note">这个合集暂时没有可查看的教学影像。</p>'}
    </section>
  </div>`;
}
