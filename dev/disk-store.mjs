// 自托管用的落盘数据层。查询语义整个沿用 dev/fake-supabase.mjs —— 那套语义是 79 条端到端断言
// 和浏览器套件打过的（时间戳回读成 +00:00、23505 撞唯一键、PGRST116、无 range 时截 50 行），
// 这里只加一件事：每次写操作之后把整份存进一个 JSON 文件。表都很小（几十行），
// 用"整份原子重写"换的是断电不丢账号和会员，代价是一次 fsync。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fakeSupabase } from './fake-supabase.mjs';

const TABLES = ['users', 'sessions', 'plans', 'keys', 'memberships', 'videos', 'requests', 'settings', 'audit', 'watch_logs'];

export async function diskSupabase(filePath, { columns, unique } = {}) {
  let saved = null;
  try {
    saved = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`读不出数据文件 ${filePath}：${error.message}`);
  }
  const stored = saved?.tables ?? saved ?? {};
  const tables = {};
  for (const name of TABLES) tables[name] = Array.isArray(stored[name]) ? stored[name] : [];
  // 迁移以后新加的表不能被上面那张清单静默丢掉。
  for (const [name, rows] of Object.entries(stored)) {
    if (!Array.isArray(rows)) continue;
    tables[name] = rows;
  }

  const inner = fakeSupabase(tables, { columns, unique });

  let queued = Promise.resolve();
  const save = () => {
    queued = queued.catch(() => {}).then(async () => {
      const snapshot = JSON.stringify({ writtenAt: new Date().toISOString(), tables: Object.fromEntries(inner.__tables) });
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { flush: true });
      await rename(tmp, filePath);
    }).catch((error) => {
      // 写盘失败必须看得见：静默的话内存是对的、文件是旧的，重启就退回去。
      console.error(`数据没能落到 ${filePath}：${error?.message ?? error}`);
      throw error;
    });
    return queued;
  };

  const from = inner.from.bind(inner);
  inner.from = (name) => {
    const builder = from(name);
    for (const mode of ['insert', 'update', 'delete', 'upsert']) {
      const original = builder[mode].bind(builder);
      builder[mode] = (...args) => {
        builder.__dirty = true;
        return original(...args);
      };
    }
    const run = builder.run.bind(builder);
    builder.run = async () => {
      const result = await run();
      if (builder.__dirty) {
        builder.__dirty = false;
        await save();
      }
      return result;
    };
    return builder;
  };
  inner.__file = filePath;
  inner.__flush = save;
  return inner;
}
