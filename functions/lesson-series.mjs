import { DataError } from './db.mjs';
import { signFields, verifyFields } from './shared/tokens.mjs';
import { isUuid, randomId } from './shared/util.mjs';

export const LESSON_SERIES_KEY = 'lesson_series';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new DataError('lesson_series_invalid');
  return value.trim();
};
function tags(value) {
  if (!Array.isArray(value) || value.length > 8) throw new DataError('lesson_series_invalid');
  const clean = value.map(tag => text(tag, 30, true));
  if (new Set(clean).size !== clean.length) throw new DataError('lesson_series_invalid');
  return clean;
}
export function normalizeSeries(series) {
  if (!Array.isArray(series) || series.length > 50) throw new DataError('lesson_series_limit_exceeded');
  const seriesIds = new Set(); const videoIds = new Set();
  return series.map(item => {
    if (!exact(item, ['id','title','description','characterTags','workTags','published','videoIds'])
      || !isUuid(item.id) || seriesIds.has(item.id) || typeof item.published !== 'boolean'
      || !Array.isArray(item.videoIds) || item.videoIds.length > 100 || (item.published && !item.videoIds.length)) throw new DataError('lesson_series_invalid');
    seriesIds.add(item.id);
    for (const id of item.videoIds) {
      if (!isUuid(id) || videoIds.has(id)) throw new DataError('lesson_series_duplicate_video');
      videoIds.add(id);
    }
    return { id:item.id, title:text(item.title,120,true), description:text(item.description,1000),
      characterTags:tags(item.characterTags), workTags:tags(item.workTags), published:item.published, videoIds:[...item.videoIds] };
  });
}
function canonical(value) {
  if (!exact(value,['version','revision','series']) || value.version !== 1 || !isUuid(value.revision)) throw new DataError('lesson_series_invalid');
  const series = normalizeSeries(value.series);
  return [value.version, value.revision, JSON.stringify(series.map(item => [item.id,item.title,item.description,item.characterTags,item.workTags,item.published,item.videoIds]))];
}
export function lessonSeriesSignature(secret,value) { return signFields(secret,LESSON_SERIES_KEY,canonical(value)); }
export async function lessonSeriesIsAuthentic(secret,value,signature) {
  try { return typeof signature === 'string' && await verifyFields(secret,LESSON_SERIES_KEY,canonical(value),signature); }
  catch { return false; }
}
export async function readSeriesState(ctx,rows) {
  const stored = await ctx.store.readLessonSeries();
  const fingerprint = rows.map(row => [row.id,row.status,row.updated_at??null,row.access_signature??null]).sort((a,b)=>a[0].localeCompare(b[0]));
  const revision = await signFields(ctx.dataKey,'lesson-series-editor',[stored.row?.signature??'none',JSON.stringify(fingerprint)]);
  return { series:stored.value?.series??[], revision, stored };
}
export async function saveSeries(ctx,input,rows) {
  if (typeof input.revision !== 'string' || input.revision.length > 200) throw new DataError('lesson_series_invalid');
  const series = normalizeSeries(input.series);
  const state = await readSeriesState(ctx,rows);
  if (input.revision !== state.revision) throw new DataError('lesson_series_conflict');
  const available = new Set(rows.map(row=>row.id));
  if (series.some(item=>item.videoIds.some(id=>!available.has(id)))) throw new DataError('lesson_series_video_unavailable');
  const value = { version:1, revision:randomId(), series };
  if (!await ctx.store.writeLessonSeries(value,state.stored.row?.signature??null)) throw new DataError('lesson_series_conflict');
  await ctx.store.audit({actorId:ctx.viewer?.user?.id,action:'lesson_series_save',target:'lesson_series',ipPrefix:ctx.ip,
    detail:{count:series.length,published:series.filter(item=>item.published).length,previousRevision:state.stored.value?.revision??null,revision:value.revision}});
}
