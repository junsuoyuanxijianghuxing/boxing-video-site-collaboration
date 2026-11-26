// Publication time is independent of the administrator's directory order.
export const publicationRanges = [['1', '近 1 天'], ['3', '近 3 天'], ['7', '近 7 天'], ['30', '近 30 天'], ['all', '全部日期']];
const dayMs = 86400000;
const dateParts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export const publicationStamp = item => typeof item?.publishedAt === 'string' ? Date.parse(item.publishedAt) : NaN;
export const isPublicLesson = item => Boolean(item?.id) && item.status === 'published' && item.authentic !== false && item.access !== 'hidden';
export const publicationNewestFirst = (a, b) => (Number.isFinite(publicationStamp(b)) ? publicationStamp(b) : 0)
  - (Number.isFinite(publicationStamp(a)) ? publicationStamp(a) : 0) || String(b.id).localeCompare(String(a.id));

export function publicPublicationItems(all, latest = []) {
  const unique = new Map();
  for (const item of [...latest, ...all]) {
    // A current directory row overrides a stale latest-feed row, including its visibility.
    if (item?.id) unique.set(item.id, item);
  }
  return [...unique.values()].filter(isPublicLesson).sort(publicationNewestFirst);
}

export function withinPublicationRange(item, range, now = Date.now()) {
  const stamp = publicationStamp(item);
  if (!Number.isFinite(stamp) || stamp > now) return false;
  return range === 'all' || stamp >= now - Number(range) * dayMs;
}

export function publicationDay(item) {
  const stamp = publicationStamp(item);
  if (!Number.isFinite(stamp)) return null;
  const parts = Object.fromEntries(dateParts.formatToParts(stamp).map(part => [part.type, part.value]));
  return { key: `${parts.year}-${parts.month}-${parts.day}`, label: `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日` };
}

export function groupPublications(items) {
  const groups = [];
  for (const item of items) {
    const day = publicationDay(item);
    if (!day) continue;
    let group = groups[groups.length - 1];
    if (!group || group.key !== day.key) { group = { ...day, items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups;
}

export function publicationTimeLabel(item) {
  const stamp = publicationStamp(item);
  return Number.isFinite(stamp) ? dateTime.format(stamp) : '发布日期待补充';
}
