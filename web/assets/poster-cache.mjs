// 封面本地存一份：站点的日额度按**请求条数**按天算，而平台把 /functions/** 的响应头一律改成
// `private, no-store`（2026-10-14 线上实测），所以 <img loading=lazy>、max-age 那些在这个站上
// 都不起作用 —— 回访的会员每次打开片库都要重新问服务端要同一张封面。
// 这里用 IndexedDB 自己存字节：第一次照常发请求，之后同一张封面从本地读出 blob、
// 用 blob: URL 挂上去（文档 CSP 的 img-src 里有 blob:），一条请求都不发。
//
// 键里带版本（posterSrc 的 &t=<updated_at>）：站长换封面之后地址就变了，旧的那条自然不再命中，
// 不需要"清缓存"这种他学不会的动作。存不满就按最早用过的裁掉，裁的是缓存不是内容。
const DB_NAME = 'lvs-posters';
const STORE = 'blobs';
const MAX_ENTRIES = 200;
const TRIM_TO = 150;

// 这一趟页面里已经解析出来的地址：同一张封面在列表、封面墙、播放器之间来回切时不再重复读库。
const objectUrls = new Map();
// 同一个地址的"正在取"也只有一个：首页那条片带把同一张封面挂到几十格上（列数 × 每列切片），
// 而这些格子是在同一帧里各自发调用的 —— 上面那张表要等第一次 fetch 落地才有值，
// 于是那几十格全都判定"本地没有"，一起向服务端要同一张图。2026-10-14 线上实测首页因此发掉 89 条封面请求。
const pending = new Map();
let dbPromise = null;
let broken = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB !== 'object' || typeof URL?.createObjectURL !== 'function') {
      reject(new Error('no-idb'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'url' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('idb-open-failed'));
    request.onblocked = () => reject(new Error('idb-blocked'));
  }).catch((error) => {
    // 无痕模式、被系统清过、内核太老——任何一种都退回"每次都走网络"，图照样出。
    broken = true;
    return null;
  });
  return dbPromise;
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      const out = run(store);
      if (out?.then) out.then(resolve, reject);
      else transaction.oncomplete = () => resolve(out);
      transaction.onerror = () => reject(transaction.error ?? new Error('idb-tx-failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('idb-tx-aborted'));
    } catch (error) {
      reject(error);
    }
  });
}

async function readStored(db, url) {
  return tx(db, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(url);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error('idb-get-failed'));
  }));
}

async function writeStored(db, url, blob) {
  await tx(db, 'readwrite', async (store) => {
    store.put({ url, blob, usedAt: Date.now() });
    const keys = await new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error ?? new Error('idb-keys-failed'));
    });
    if (keys.length <= MAX_ENTRIES) return;
    const rows = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error ?? new Error('idb-all-failed'));
    });
    const stale = rows.sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0)).slice(0, Math.max(0, rows.length - TRIM_TO));
    for (const row of stale) {
      store.delete(row.url);
      const held = objectUrls.get(row.url);
      if (held) {
        objectUrls.delete(row.url);
        try { URL.revokeObjectURL(held); } catch { /* 已经撤销过就当作没事 */ }
      }
    }
  });
}

async function touch(db, url) {
  // 命中一次就把时间推后，免得常用的那几张被上面那轮裁掉。
  await tx(db, 'readwrite', (store) => {
    const request = store.get(url);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, usedAt: Date.now() });
    };
  }).catch(() => { /* 记账失败不该影响出图 */ });
}

async function resolvePoster(url) {
  const db = await openDb();
  if (!db) return null;
  try {
    const stored = await readStored(db, url);
    if (stored?.blob instanceof Blob && stored.blob.size > 0) {
      const objectUrl = URL.createObjectURL(stored.blob);
      objectUrls.set(url, objectUrl);
      void touch(db, url);
      return objectUrl;
    }
  } catch {
    return null;
  }
  // 本地没有：这一次照常向服务端要，并把字节存下来给以后用。
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`poster ${response.status}`);
  const blob = await response.blob();
  if (!(blob instanceof Blob) || blob.size <= 0) return null;
  const objectUrl = URL.createObjectURL(blob);
  objectUrls.set(url, objectUrl);
  try {
    await writeStored(db, url, blob);
  } catch { /* 存不下就下次再走网络，屏幕上这张不受影响 */ }
  return objectUrl;
}

// 拿到这一张封面的可显示地址。返回 null 表示"这次给不出"，调用方自己退回直接走网络的地址。
// 同一个地址在这趟页面里只可能向服务端要一次：命中缓存走缓存，正在要就一起等那一次。
export function posterObjectUrl(url) {
  if (!url) return Promise.resolve(null);
  const cached = objectUrls.get(url);
  if (cached) return Promise.resolve(cached);
  const flying = pending.get(url);
  if (flying) return flying;
  const job = resolvePoster(url).finally(() => {
    if (pending.get(url) === job) pending.delete(url);
  });
  pending.set(url, job);
  return job;
}

// 卡片重画、列表翻页会不断产生新的 <img>；这些地址跟着页面活到下一次导航，
// 所以不需要逐个撤销——撤销反而会正在看的那张变成碎图。裁只在缓存超限时做。
export const postersHeld = () => objectUrls.size;

// 挂一张封面上去：先问本地，本地没有才走网络。dataset.posterSrc 记的是"这一格现在要哪一张"，
// 它同时是闸门 —— 滚动、重画、带子绕圈都会重复调用，没有这把闸门同一张会被要第二遍，
// 而异步回来时如果格子已经换成别的片子，就把结果丢掉（否则会把上一张挂到这一张上）。
export async function setPosterSrc(image, url) {
  if (!url || image.dataset.posterSrc === url) return;
  image.dataset.posterSrc = url;
  try {
    const local = await posterObjectUrl(url);
    if (image.dataset.posterSrc !== url) return;
    image.src = local ?? url;
  } catch {
    if (image.dataset.posterSrc === url) image.src = url;
  }
}
