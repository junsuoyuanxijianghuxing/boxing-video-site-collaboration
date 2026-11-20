// In-memory stand-in for the subset of the Supabase PostgREST client the Function
// uses. It mirrors the { data, error } result shape and thenable builders so the
// real query code paths are exercised; it proves application logic only, never
// provider connectivity or row level security.
// Postgres compares timestamps as instants; the real backend also hands back `+00:00`
// suffixes while the application writes `Z`. Comparing those as strings makes a time window
// behave differently here than in production — which is how a fractional-range bug slipped
// past a fully green suite. So any value that looks like a full timestamp is compared as one.
// PostgREST renders a `timestamptz` with an explicit offset: write "…239Z" and it reads
// back "…239+00:00". Signed rows are hashed over the stored text, so a double that hands
// back the writer's own string hides a mismatch that only exists in production — which is
// exactly how every membership row came back "签名与后台不一致" while the suite stayed green.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/;
function readBack(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'string' && INSTANT.test(value) ? `${value.slice(0, -1)}+00:00` : value;
  }
  return out;
}

function asComparable(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : value;
}

// PostgREST 的 or= 表达式可以嵌套 and()，日志翻页的游标就用到了这一层。
// 替身以前只认 `col.eq.v` 和 `col.is.null`，遇到嵌套直接抛 —— 那样本地永远测不到
// 真实后端支持的写法，等于把一条只在上线后才炸的路径留给了线上。
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function compareValues(actual, operator, raw) {
  // 一律按字符串比：ISO 时间戳和 UUID 的字典序就是它们的时间序/版本序。
  // （`or=` 里传数字条件的写法本项目还没用到，真要用时再按列类型分派。）
  const a = actual === null || actual === undefined ? '' : String(actual);
  const b = String(raw);
  switch (operator) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: throw new Error(`unsupported operator in or(): ${operator}`);
  }
}

function compileOrClause(clause) {
  const contains = /^([a-z_][a-z0-9_]*)\.ilike\.\*([\p{L}\p{N}@+ -]+)\*$/u.exec(clause);
  if (contains) return row => String(row[contains[1]] ?? '').toLowerCase().includes(contains[2].toLowerCase());
  const nested = /^(and|or)\((.*)\)$/is.exec(clause);
  if (nested) {
    const tests = splitTopLevel(nested[2]).map(compileOrClause);
    return nested[1].toLowerCase() === 'and'
      ? (row) => tests.every((test) => test(row))
      : (row) => tests.some((test) => test(row));
  }
  const isNull = /^([a-z_][a-z0-9_]*)\.is\.null$/i.exec(clause);
  if (isNull) return (row) => row[isNull[1]] === null || row[isNull[1]] === undefined;
  const simple = /^([a-z_][a-z0-9_]*)\.(eq|neq|gt|gte|lt|lte)\.(.+)$/i.exec(clause);
  if (simple) return (row) => compareValues(row[simple[1]], simple[2].toLowerCase(), simple[3]);
  throw new Error(`unsupported or() clause: ${clause}`);
}

export function fakeSupabase(tables = {}, { columns, unique = {} } = {}) {
  const data = new Map();
  // Rows stay in the caller's arrays so a test can forge or age rows directly.
  for (const [name, rows] of Object.entries(tables)) data.set(name, rows);

  const ensure = (name) => {
    if (!data.has(name)) data.set(name, []);
    return data.get(name);
  };

  function project(row, select) {
    if (!select || select === '*') return { ...row };
    const out = {};
    for (const col of select.split(',').map((value) => value.trim())) {
      if (col && col in row) out[col] = row[col];
    }
    return out;
  }

  class Builder {
    constructor(name) {
      this.name = name;
      this.selectCols = '*';
      this.filters = [];
      this.orders = [];
      this.patch = null;
      this.payload = null;
      this.mode = 'select';
      this.options = {};
      this.from = null;
      this.to = null;
      this.max = null;
      this.singleMode = false;
      this.mustSingle = false;
    }

    // PostgREST answers PGRST204 for a column the schema does not have, which the
    // Function surfaces as a *_failed 503. Refusing here instead of sorting by an
    // always-undefined key is what makes a renamed column fail in tests.
    // `columns` is the deployed column set, read from the migration.
    has(column, where) {
      const allowed = columns?.[this.name];
      if (!allowed || allowed.includes(column)) return this;
      throw new Error(`${this.name}.${column} (${where}) is not in the schema`);
    }

    select(cols, options = {}) {
      this.selectCols = cols ?? '*';
      this.options = { ...this.options, ...options };
      if (this.mode === 'update' || this.mode === 'delete' || this.mode === 'insert') this.returning = true;
      return this;
    }

    insert(records) {
      this.mode = 'insert';
      this.payload = records;
      const list = Array.isArray(records) ? records : [records];
      for (const record of list) for (const key of Object.keys(record ?? {})) this.has(key, 'insert');
      return this;
    }

    update(patch) {
      this.mode = 'update';
      this.patch = patch;
      for (const key of Object.keys(patch ?? {})) this.has(key, 'update');
      return this;
    }

    delete() {
      this.mode = 'delete';
      return this;
    }

    upsert(records, options = {}) {
      this.mode = 'upsert';
      this.payload = records;
      this.options = options;
      const list = Array.isArray(records) ? records : [records];
      for (const record of list) for (const key of Object.keys(record ?? {})) this.has(key, 'upsert');
      return this;
    }

    eq(column, value) {
      this.has(column, 'eq');
      this.filters.push((row) => row[column] === value);
      return this;
    }

    neq(column, value) {
      this.has(column, 'neq');
      this.filters.push((row) => row[column] !== value);
      return this;
    }

    is(column, value) {
      this.has(column, 'is');
      this.filters.push((row) => row[column] === value || (value === null && (row[column] === undefined)));
      return this;
    }

    not(column, operator, value) {
      // 真后端只有 `not(is, null)` 这一种用法在这里被用到（回收站要"只列已经停用/撤销过的行"）。
      // 假件不实现它，验收就会把"筛出来是空的"当成正确结果。
      this.has(column, 'not');
      this.filters.push((row) => {
        if (operator !== 'is') throw new Error(`fake not(${operator}) 还没实现`);
        const empty = row[column] === null || row[column] === undefined;
        return value === null ? !empty : empty;
      });
      return this;
    }

    in(column, values) {
      this.has(column, 'in');
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }

    gt(column, value) {
      this.has(column, 'gt');
      this.filters.push((row) => asComparable(row[column]) > asComparable(value));
      return this;
    }

    gte(column, value) {
      this.has(column, 'gte');
      this.filters.push((row) => asComparable(row[column]) >= asComparable(value));
      return this;
    }

    lt(column, value) {
      this.has(column, 'lt');
      this.filters.push((row) => asComparable(row[column]) < asComparable(value));
      return this;
    }

    or(expression) {
      // PostgREST's `or=` is real and the nullable `kind` column needs it: rows written
      // before migration 0002 hold NULL, so "the live tab" has to mean kind.eq.live OR
      // kind.is.null. Refusing the operator here would hide that need from every local run.
      const tests = splitTopLevel(String(expression)).map(compileOrClause);
      this.filters.push((row) => tests.some((test) => test(row)));
      return this;
    }

    order(column, options = {}) {
      this.has(column, 'order');
      this.orders.push({ column, ascending: options.ascending !== false });
      return this;
    }

    range(from, to) {
      this.from = from;
      this.to = to;
      return this;
    }

    limit(count) {
      this.max = count;
      return this;
    }

    maybeSingle() {
      this.singleMode = true;
      return this;
    }

    single() {
      this.mustSingle = true;
      return this;
    }

    match(conditions) {
      for (const [column, value] of Object.entries(conditions)) this.eq(column, value);
      return this;
    }

    applyFilters() {
      return ensure(this.name).filter((row) => this.filters.every((test) => test(row)));
    }

    sorted(rows) {
      const list = [...rows];
      for (const { column, ascending } of this.orders.reverse()) {
        list.sort((a, b) => {
          const left = asComparable(a[column] ?? '');
          const right = asComparable(b[column] ?? '');
          if (left === right) return 0;
          return (left > right ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      return list;
    }

    async run() {
      const rows = ensure(this.name);
      if (this.mode === 'insert' || this.mode === 'upsert') {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
        const written = [];
        for (const record of incoming) {
          const conflictKey = this.options.onConflict?.split(',').map((value) => value.trim());
          const existing = conflictKey
            ? rows.find((row) => conflictKey.every((column) => row[column] === record[column]))
            : rows.find((row) => row.id === record.id);
          if (existing) {
            if (this.mode === 'upsert' && !this.options.ignoreDuplicates) {
              Object.assign(existing, record);
              written.push(existing);
            } else {
              return { data: null, error: { code: '23505', message: 'duplicate key value' }, status: 409 };
            }
            continue;
          }
          // The id check above only covers the primary key. Secondary UNIQUE columns
          // (email, token_hash, plans.code, keys.fingerprint, memberships.key_id,
          // settings.config_key) are what several designs actually rely on to reject a
          // replay, so ignoring them lets a duplicate pass here and 23505 in production.
          // NULLs are distinct in Postgres, so a nullable unique column never clashes.
          for (const columns of unique[this.name] ?? []) {
            if (columns.every((column) => conflictKey?.includes(column))) continue;
            const clash = rows.some((row) => columns.every((column) =>
              record[column] !== null && record[column] !== undefined && row[column] === record[column]));
            if (clash) {
              return { data: null, error: { code: '23505', message: `duplicate key on ${columns.join(',')}` }, status: 409 };
            }
          }
          const stored = { ...record };
          rows.push(stored);
          written.push(stored);
        }
        return this.finish(written.map((row) => project(row, this.selectCols)));
      }

      if (this.mode === 'update') {
        const matched = this.applyFilters();
        for (const row of matched) Object.assign(row, this.patch);
        return this.finish(matched.map((row) => project(row, this.selectCols)));
      }

      if (this.mode === 'delete') {
        const matched = this.applyFilters();
        for (const row of matched) {
          const index = rows.indexOf(row);
          if (index >= 0) rows.splice(index, 1);
        }
        return this.finish(matched.map((row) => project(row, this.selectCols)));
      }

      let result = this.sorted(this.applyFilters());
      if (this.from !== null) result = result.slice(this.from, this.to + 1);
      else if (this.max !== null) result = result.slice(0, this.max);
      else if (this.name !== 'audit') result = result.slice(0, 50);
      return this.finish(result.map((row) => project(row, this.selectCols)));
    }

    finish(rows) {
      rows = rows.map(readBack);
      if (this.mustSingle) {
        if (rows.length !== 1) return { data: null, error: { code: rows.length === 0 ? 'PGRST116' : 'PGRST116J', message: 'not exactly one' }, status: 406 };
        return { data: rows[0], error: null, status: 200 };
      }
      if (this.singleMode) {
        // PostgREST's maybeSingle answers PGRST116 when the query matches more than
        // one row. Returning the first row silently would let a non-unique filter pass
        // every test and then fail as a 503 in production.
        if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' }, status: 406 };
        return { data: rows[0] ?? null, error: null, status: rows.length ? 200 : 406 };
      }
      return { data: rows, error: null, status: 200 };
    }

    then(resolve, reject) {
      return this.run().then(resolve, reject);
    }
  }

  return {
    from(name) {
      return new Builder(name);
    },
    __tables: data,
  };
}
