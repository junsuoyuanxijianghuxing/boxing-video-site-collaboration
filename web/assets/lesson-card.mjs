// Shared by the public collection and the administrator's unsaved layout preview.
export const escapeCardText = (value) => String(value ?? '').replace(/[&<>"'`=]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;',
}[char]));

export function durationClock(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '—';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export const membershipRequirement = (rank) => Number(rank) === 0 ? '公开观看'
  : Number(rank) === 1 ? '任意档位会员' : `${Number(rank) || 1} 级及以上会员`;

export function previewLabel(item) {
  if (item.access === 'full') return '观看完整教学影像';
  if (item.access !== 'preview' || !(Number(item.previewSeconds) > 0)) return '查看会员要求';
  const seconds = Math.round(Number(item.previewSeconds));
  return `可试看约 ${seconds >= 60 ? `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : '钟'}` : `${seconds} 秒`}`;
}

export function lessonCardMarkup(item, { posterUrl = '', number = null, watched = '', interactive = true, href = '', contextLabel = '' } = {}) {
  const e = escapeCardText;
  const tag = interactive ? 'a' : 'article';
  const destination = href || `/v/${encodeURIComponent(item.id)}`;
  const target = interactive ? ` href="${e(destination)}" data-link` : '';
  const full = item.access === 'full';
  const access = full ? '完整内容已解锁' : item.access === 'preview' ? '先试看，再选择会员' : '按会员等级解锁';
  return `<${tag} class="card lesson-card"${target}>
    <div class="poster">${item.hasPoster && posterUrl
    ? `<img data-poster="${e(posterUrl)}" alt="" decoding="async" width="1280" height="720">`
    : `<span class="poster-code">${e(String(item.title ?? '').slice(0, 4))}</span>`}
      ${number ? `<span class="issue mono">#${e(number)}</span>` : ''}
      <span class="card-play" aria-hidden="true"></span>
    </div>
    <div class="card-text">
      ${contextLabel ? `<p class="card-series-context">${e(contextLabel)}</p>` : ''}
      <div class="card-eyeline"><span>${item.kind === 'anime' ? '动画拳击' : '真实拳击'}</span><span class="card-access${full ? ' is-unlocked' : ''}">${access}</span></div>
      <h3>${e(item.title)}</h3>
      <div class="card-facts">
        <div class="card-fact-duration"><span class="card-fact-label">${contextLabel ? '本集时长' : '教学影像时长'}</span><strong class="card-clock">${durationClock(item.durationSeconds)}</strong></div>
        <div class="card-fact-tier"><span class="card-fact-label">完整观看</span><strong class="card-tier">${membershipRequirement(item.tierRank)}</strong></div>
      </div>
      ${watched}
      ${item.description ? `<p class="desc">${e(item.description)}</p>` : ''}
      <div class="card-footer"><span class="card-preview-copy">${previewLabel(item)}</span><span class="card-open" aria-hidden="true">${full ? '进入观看' : item.access === 'preview' ? '打开试看' : '查看详情'} ↗</span></div>
    </div>
  </${tag}>`;
}
