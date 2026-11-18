import { encryptFileSlice, chunkCount } from './vendor/video-crypto.mjs';
import { fromBase64Url } from './vendor/util.mjs';

export const UPLOAD_CHANNELS = 3;
const abortError = () => new DOMException('上传已取消', 'AbortError');
const assertLive = (signal) => { if (signal?.aborted) throw abortError(); };

// 通道在读文件和加密之前取得，三个通道覆盖页面上的单条与批量任务。
let occupied = 0;
const waiting = [];
function takeChannel(signal) {
  assertLive(signal);
  return new Promise((resolve, reject) => {
    const waiter = { enter: null, cancel: null };
    waiter.cancel = () => {
      const at = waiting.indexOf(waiter);
      if (at >= 0) waiting.splice(at, 1);
      reject(abortError());
    };
    waiter.enter = () => {
      signal?.removeEventListener('abort', waiter.cancel);
      if (signal?.aborted) { reject(abortError()); return false; }
      occupied++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        occupied--;
        while (occupied < UPLOAD_CHANNELS && waiting.length) waiting.shift().enter();
      });
      return true;
    };
    if (occupied < UPLOAD_CHANNELS) waiter.enter();
    else { waiting.push(waiter); signal?.addEventListener('abort', waiter.cancel, { once: true }); }
  });
}

function delay(ms, signal) {
  assertLive(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export function createChunkUpload({ file, cipher, videoId, totalChunks, post, onProgress = () => {} }) {
  const total = chunkCount(file.size, cipher.chunkSize);
  if (total !== totalChunks || !Number.isSafeInteger(total) || total < 1) throw Error('上传数据块数量不一致，请重新建档。');
  const confirmed = new Set();
  let confirmedBytes = 0;
  let keyJob = null;
  let running = false;
  const firstMissing = () => {
    for (let i = 0; i < total; i++) if (!confirmed.has(i)) return i;
    return null;
  };
  const progress = () => onProgress({ completed: confirmed.size, total, bytes: confirmedBytes, size: file.size });

  async function run({ signal, concurrency = 2 } = {}) {
    if (running) throw Error('这条视频已经在上传。');
    assertLive(signal);
    running = true;
    const runController = new AbortController();
    const cancel = () => runController.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const workSignal = runController.signal;
    const workers = Math.min(2, Math.max(1, Math.trunc(concurrency) || 1));
    let failure = null;
    try {
      keyJob ??= crypto.subtle.importKey('raw', fromBase64Url(cipher.key), { name: 'AES-GCM' }, false, ['encrypt']);
      const key = await keyJob;
      assertLive(workSignal);
      progress();
      let cursor = firstMissing();
      while (cursor !== null) {
        assertLive(workSignal);
        const issued = await post('admin-upload-parts', { videoId, from: cursor }, { signal: workSignal });
        assertLive(workSignal);
        const parts = issued.parts;
        if (!Array.isArray(parts) || !parts.length || parts.length > 100) throw Error('站点没有给出有效的数据块写入地址。');
        const seen = new Set();
        for (let offset = 0; offset < parts.length; offset++) {
          const part = parts[offset];
          if (part.index !== cursor + offset || part.index >= total || typeof part.url !== 'string' || seen.has(part.index)) throw Error('数据块地址没有按顺序推进，已停止。');
          seen.add(part.index);
        }
        const next = parts[parts.length - 1].index + 1;
        if ((issued.next ?? null) !== (next < total ? next : null)) throw Error('下一批数据块序号不一致。');
        const pending = parts.filter(part => !confirmed.has(part.index));
        let position = 0;
        async function worker() {
          while (position < pending.length && !workSignal.aborted) {
            const part = pending[position++];
            let release;
            try {
              release = await takeChannel(workSignal);
              assertLive(workSignal);
              const encrypted = await encryptFileSlice(file, cipher, part.index, key);
              assertLive(workSignal);
              let address = part.url;
              for (let attempt = 0; ; attempt++) {
                assertLive(workSignal);
                const putController = new AbortController();
                const stopPut = () => putController.abort();
                workSignal.addEventListener('abort', stopPut, { once: true });
                const timeout = setTimeout(stopPut, 120000);
                let status = 0;
                try {
                  const response = await fetch(address, { method: 'PUT', body: encrypted,
                    headers: { 'Content-Type': 'application/octet-stream' }, signal: putController.signal });
                  status = response.status;
                  if (!response.ok) throw Object.assign(Error(`第 ${part.index + 1} 数据块写入失败（HTTP ${status}）`), { status });
                  await response.arrayBuffer(); // 读完确认响应，不能把收到响应头当作已落盘。
                  assertLive(workSignal);
                  break;
                } catch (error) {
                  assertLive(workSignal);
                  if (attempt >= 2 || (status && status !== 403 && status !== 408 && status !== 429 && status < 500)) throw error;
                  if (status === 403) {
                    const fresh = await post('admin-upload-parts', { videoId, from: part.index }, { signal: workSignal });
                    address = fresh.parts?.find(item => item.index === part.index)?.url;
                    if (!address) throw Error('数据块写入地址已失效，重新领取失败。');
                  }
                  await delay([500, 1500][attempt], workSignal);
                } finally {
                  clearTimeout(timeout);
                  workSignal.removeEventListener('abort', stopPut);
                }
              }
              confirmed.add(part.index);
              confirmedBytes += Math.min(cipher.chunkSize, file.size - part.index * cipher.chunkSize);
              progress();
            } catch (error) {
              failure ??= error;
              runController.abort();
            } finally { release?.(); }
          }
        }
        await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
        if (failure) throw failure;
        assertLive(workSignal);
        cursor = next < total ? next : null;
      }
      if (confirmed.size !== total) throw Error('部分数据块尚未确认，不能登记为草稿。');
      return { completed: confirmed.size, bytes: confirmedBytes };
    } finally {
      signal?.removeEventListener('abort', cancel);
      running = false;
    }
  }
  return { run, firstMissing, get completed() { return confirmed.size; } };
}
