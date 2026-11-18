export class DataError extends Error {
  constructor(code, detail = null, extra = null) {
    super(code);
    this.name = 'DataError';
    this.code = code;
    // A short, safe reason slot: the backend's error *code*, never its message. The raw
    // PostgREST text can name columns and policies, which no browser needs to see.
    this.detail = detail;
    // 只有几个数（比如"还要等几分钟"）走这里，随错误一起回给浏览器。
    // 判据不许写死在客户端文案里：服务端改一个常量，客户端那句话就变成假话。
    this.extra = extra;
  }
}

function fail(code, detail = null) {
  throw new DataError(code, detail);
}

function backendCode(error) {
  const value = String(error?.code ?? '').trim();
  return /^[0-9A-Za-z]{2,12}$/.test(value) ? value : null;
}

// PostgREST returns { data, error }. A transport throw and a rejected query are
// both failures, but a successful query with data === null means "no row", which
// callers must be able to tell apart.
export async function one(query, code = 'record_read_failed') {
  let result;
  try {
    result = await query;
  } catch {
    fail(code, 'transport');
  }
  if (result.error) fail(code, backendCode(result.error));
  if (result.data === undefined) fail(code, 'no_envelope');
  return result.data;
}

export async function many(query, code = 'records_read_failed') {
  let result;
  try {
    result = await query;
  } catch {
    fail(code, 'transport');
  }
  if (result.error) fail(code, backendCode(result.error));
  if (!Array.isArray(result.data)) fail(code, 'no_envelope');
  return result.data;
}

export async function create(table, record, select, code = 'record_write_failed') {
  const result = await one(table.insert(record).select(select).maybeSingle(), code);
  if (!result) fail(code, 'no_row_returned');
  return result;
}

// A null result from a filtered update or delete means the guard did not match,
// so the write must not be reported as a success.
export async function mutate(builder, select, code = 'record_write_failed') {
  const result = await one(builder.select(select).maybeSingle(), code);
  return result ?? null;
}

// The total comes from the SDK count; `.limit(1)` bounds returned rows, not the
// total. Platform rules forbid HEAD/head:true reads, so this stays a bounded GET.
export async function exactCount(table, applyFilters, code = 'count_unavailable') {
  let result;
  try {
    result = await applyFilters(table.select('id', { count: 'exact' })).limit(1);
  } catch {
    fail(code);
  }
  if (result.error || !Number.isSafeInteger(result.count) || result.count < 0) fail(code);
  return result.count;
}

export function rangeParams(offset, limit) {
  // Fractions have to be removed, not just bounded: measured against the live backend,
  // `?limit=2.7` returned HTTP 200 with an EMPTY item list — no error at all, so the
  // owner reads it as "I have not uploaded anything yet".
  const wanted = Math.trunc(Number(limit));
  const page = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, 200) : 20;
  const asked = Math.trunc(Number(offset));
  const from = Number.isFinite(asked) && asked > 0 ? asked : 0;
  return { first: from, last: from + page, pageSize: page };
}

export function paginate(rows, { first, pageSize }) {
  const hasMore = rows.length > pageSize;
  return { items: hasMore ? rows.slice(0, pageSize) : rows, hasMore, nextOffset: hasMore ? first + pageSize : null };
}
