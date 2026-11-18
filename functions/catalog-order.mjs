import { DataError } from './db.mjs';
import { signFields, verifyFields } from './shared/tokens.mjs';
import { isUuid, randomId } from './shared/util.mjs';

export const CATALOG_ORDER_KEY = 'catalog_order';
export const MAX_CATALOG_ITEMS = 1000;

function validOrder(value) {
  return value && value.version === 1 && isUuid(value.revision)
    && Array.isArray(value.videoIds) && value.videoIds.length <= MAX_CATALOG_ITEMS
    && value.videoIds.every(isUuid) && new Set(value.videoIds).size === value.videoIds.length
    && Object.keys(value).every((key) => ['version', 'revision', 'videoIds'].includes(key));
}

export function catalogOrderSignature(secret, value) {
  if (!validOrder(value)) throw new DataError('catalog_order_invalid');
  return signFields(secret, CATALOG_ORDER_KEY, [value.version, value.revision, JSON.stringify(value.videoIds)]);
}

export async function catalogOrderIsAuthentic(secret, value, signature) {
  return validOrder(value) && typeof signature === 'string'
    && await verifyFields(secret, CATALOG_ORDER_KEY, [value.version, value.revision, JSON.stringify(value.videoIds)], signature);
}

// Read every page before arranging anything: sorting each page independently loses the
// owner's order as soon as a card crosses a page or a category boundary.
async function publishedRows(ctx) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  for (;;) {
    const page = await ctx.store.listVideos({ onlyPublished: true, offset, limit: 200 });
    for (const row of page.items) {
      if (seen.has(row.id)) throw new DataError('catalog_order_conflict');
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length > MAX_CATALOG_ITEMS || (rows.length === MAX_CATALOG_ITEMS && page.hasMore)) {
      throw new DataError('catalog_order_limit_exceeded');
    }
    if (!page.hasMore) break;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new DataError('catalog_order_read_failed');
    offset = page.nextOffset;
  }
  return rows.filter((row) => row.status === 'published' && row.authentic !== false);
}

function newestFirst(a, b) {
  const stamp = (row) => Number.isFinite(Date.parse(row.published_at)) ? Date.parse(row.published_at) : 0;
  return stamp(b) - stamp(a) || String(b.id).localeCompare(String(a.id));
}

export async function catalogOrderState(ctx) {
  const [rows, stored] = await Promise.all([publishedRows(ctx), ctx.store.readCatalogOrder()]);
  rows.sort(newestFirst);
  const positions = new Map((stored.value?.videoIds ?? []).map((id, index) => [id, index]));
  const ordered = positions.size ? [...rows].sort((a, b) => {
    const pa = positions.get(a.id);
    const pb = positions.get(b.id);
    if (pa === undefined && pb === undefined) return newestFirst(a, b);
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    return pa - pb;
  }) : rows;
  // Bind the editor token to both the ordering record and the published collection.
  // A newly published/retired/deleted or edited card invalidates an older open editor.
  const collection = rows.map((row) => [row.id, row.published_at ?? null, row.updated_at ?? null, row.access_signature ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const revision = await signFields(ctx.dataKey, 'catalog-order-editor', [stored.row?.signature ?? 'none', JSON.stringify(collection)]);
  return { rows: ordered, stored, revision, manual: Boolean(stored.value) };
}

export async function saveCatalogOrder(ctx, input) {
  const ids = input.videoIds;
  if (!Array.isArray(ids) || ids.length > MAX_CATALOG_ITEMS || !ids.every(isUuid)
    || new Set(ids).size !== ids.length || typeof input.revision !== 'string' || input.revision.length > 200) {
    throw new DataError('catalog_order_invalid');
  }
  const state = await catalogOrderState(ctx);
  if (input.revision !== state.revision) throw new DataError('catalog_order_conflict');
  const available = new Set(state.rows.map((row) => row.id));
  if (ids.length !== available.size || ids.some((id) => !available.has(id))) throw new DataError('catalog_order_invalid');
  const value = { version: 1, revision: randomId(), videoIds: [...ids] };
  const saved = await ctx.store.writeCatalogOrder(value, state.stored.row?.signature ?? null);
  if (!saved) throw new DataError('catalog_order_conflict');
  await ctx.store.audit({
    actorId: ctx.viewer?.user?.id, action: 'catalog_order_save', target: 'catalog', ipPrefix: ctx.ip,
    detail: { count: ids.length, previousRevision: state.stored.value?.revision ?? null, revision: value.revision, videoIds: [...ids] },
  });
  // Return the actual current collection; a concurrent publication is placed before the
  // saved sequence, never dropped or given an invented video timestamp.
  return catalogOrderState(ctx);
}
