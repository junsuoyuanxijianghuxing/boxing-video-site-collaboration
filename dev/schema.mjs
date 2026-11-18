// Reads the deployed column set straight out of the migration SQL. The store's
// COLUMNS strings are only the select allowlist, so they cannot tell a legal
// write from a typo — this can.
import { readFileSync, readdirSync } from 'node:fs';

const CONSTRAINT = /^(primary|unique|foreign|check|constraint|exclude)\b/i;

// Accepts one file, a directory of migrations, or an explicit list. A directory is the
// default from here on: a second migration file that nobody remembered to hand to the
// double would make local runs reject a column production has.
function readSql(source) {
  const asPath = typeof source === 'string' ? source : source.pathname;
  // A file URL's pathname keeps a leading slash before a Windows drive letter
  // ("/D:/proj/migrations/"), which no filesystem call accepts. Stripping only that form
  // leaves POSIX paths untouched.
  const file = decodeURIComponent(asPath.replace(/^file:/, '')).replace(/^\/([A-Za-z]:)/, '$1');
  let names;
  try {
    const entries = readdirSync(file, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name).sort();
  } catch {
    return readFileSync(file, 'utf8');
  }
  const joiner = file.endsWith('/') || file.endsWith('\\') ? '' : '/';
  return names.map((name) => readFileSync(file + joiner + name, 'utf8')).join('\n');
}

export function schemaFromSql(source) {
  const sql = readSql(source);
  const tables = {};
  for (const [, name, body] of sql.matchAll(/CREATE TABLE\s+(?:\w+\.)?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const columns = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--') || CONSTRAINT.test(line)) continue;
      const column = line.match(/^"?([a-z_][a-z0-9_]*)"?\s/i);
      if (column) columns.push(column[1]);
    }
    tables[name] = columns;
  }
  // Later migrations widen the set; ignoring them would leave the double rejecting a
  // column the real database already has.
  for (const [, table, column] of sql.matchAll(/ALTER TABLE\s+(?:\w+\.)?(\w+)\s+ADD COLUMN\s+"?([a-z_][a-z0-9_]*)"?\s/gi)) {
    if (Array.isArray(tables[table]) && !tables[table].includes(column)) tables[table].push(column);
  }
  return tables;
}

// The uniqueness rules the database actually enforces. A test double that ignores
// them lets a duplicate insert pass in tests and fail as 23505 in production, and
// several designs here lean on that error (a key-derived membership id, for one).
export function uniqueFromSql(source) {
  const sql = readSql(source);
  const tables = {};
  for (const [, name, body] of sql.matchAll(/CREATE TABLE\s+(?:\w+\.)?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const keys = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      const tableLevel = line.match(/^(?:PRIMARY KEY|UNIQUE)\s*\(([^)]*)\)/i);
      if (tableLevel) {
        keys.push(tableLevel[1].split(',').map((part) => part.trim().replace(/"/g, '')));
        continue;
      }
      if (CONSTRAINT.test(line)) continue;
      const columnLevel = line.match(/^"?([a-z_][a-z0-9_]*)"?\s+[^,]*\b(PRIMARY KEY|UNIQUE)\b/i);
      if (columnLevel) keys.push([columnLevel[1]]);
    }
    tables[name] = keys;
  }
  return tables;
}
