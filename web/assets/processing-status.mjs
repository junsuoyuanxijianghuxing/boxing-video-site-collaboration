import { api, post, isWriteOutcomeUnknown } from './api.js';

const states = { queued: '等待生成播放版本', working: '正在生成播放版本', ready: '播放版本已就绪', failed: '处理失败，可重试', cancelled: '处理已取消' };
const weakStates = { queued: '弱网补档已排队', working: '正在生成弱网档', ready: '弱网补档已完成', failed: '弱网补档失败，原版可播放', cancelled: '弱网补档已取消' };
const posterStates = { queued: '等待提取候选帧', working: '正在提取候选帧', ready: '候选帧已就绪', failed: '候选帧生成失败', cancelled: '封面任务已取消' };
const stages = { poster: '提取封面候选帧', decrypt: '读取原片', low: '生成弱网档', sd: '生成流畅档', hd: '生成高清档', removed: '已移除' };
const errors = { weak_timeline_mismatch: '新旧分段位置未能对齐，未发布新增档位，原有版本仍可播放。', weak_timeline_unsupported: '原分段时间线过长或无法识别，未修改原有播放版本。', weak_source_missing: '请先生成原有播放版本，再补弱网档。', poster_generation_failed: '服务器未能从原片取到封面；可重试补图，或手选图片，无需重传视频。', disk_space_low: '服务器可用空间不足，请清理后重试。', source_duration_mismatch: '原片时长与登记时长不符，请先在片库那一格核对时长。', source_format_invalid: '无法识别原片的画面或时长，请检查文件。', source_incomplete: '原片缺少数据，请核对上传。', processing_queue_full: '处理队列已满，请稍后重试。' };
const MAX_RECORDS = 100;
const hasLow = job => Array.isArray(job.renditions) && job.renditions.some(item => item.rendition === 'low' && item.state === 'done');
const blocking = entry => entry && ['submitting', 'accepted', 'uncertain'].includes(entry.state);
const errorText = code => {
  const mismatch = /^source_duration_mismatch:(\d+)\/(\d+)$/.exec(String(code ?? ''));
  return mismatch ? `原片实测 ${mismatch[1]} 秒，登记的是 ${mismatch[2]} 秒，差到十倍以上。请在教学影像管理中核对时长，再重试处理。` : errors[code];
};

function isPublishedAndReady(job) {
  return job.state === 'ready' && !job.error && !job.posterError
    && ['', 'ready', 'kept'].includes(job.posterState ?? '')
    && job.hasPoster === true && job.canPublish === true && job.videoStatus === 'published';
}

export function isCompletedWeakJob(job) {
  return isPublishedAndReady(job) && job.weakOnly === true && hasLow(job)
    && job.canAddWeak === false
    && !job.renditions.some(item => ['queued', 'pending', 'working', 'failed'].includes(item.state));
}

export function isCompletedPublishedJob(job) {
  if (job.weakOnly === true) return isCompletedWeakJob(job);
  return isPublishedAndReady(job) && job.canAddWeak !== true
    && Array.isArray(job.renditions)
    && job.renditions.some(item => item.rendition === 'hd' && item.state === 'done')
    && job.renditions.every(item => item.state === 'done');
}

function completionKey(job) {
  return /^[a-f0-9-]{36}$/i.test(job.videoId ?? '') && typeof job.updatedAt === 'string'
    && job.updatedAt.length < 64 && Number.isFinite(Date.parse(job.updatedAt))
    ? `${job.videoId}|${job.updatedAt}` : null;
}

export function mountProcessingStatus(host, { onPickCover, onGoLibrary, confirmationScope } = {}) {
  host.className = 'panel stack';
  const element = (tag, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const button = (text, action, className = 'btn btn-sm') => {
    const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const title = element('h2', '', '视频与封面处理');
  const note = element('p', 'tiny dim');
  const counts = element('p', 'tiny dim'); counts.setAttribute('aria-live', 'polite');
  const notice = element('div', 'note note-good'); notice.setAttribute('role', 'status'); notice.hidden = true;
  const noticeText = element('p');
  const confirmDone = button('确认完成并收起', confirmCompletions, 'btn btn-sm btn-primary');
  notice.append(noticeText, confirmDone);
  const list = element('div', 'stack'); list.dataset.processingList = 'active';
  const history = element('details'); history.hidden = true;
  const summary = element('summary', 'btn btn-sm btn-ghost');
  const completedList = element('div', 'stack'); completedList.dataset.processingList = 'completed';
  history.append(summary, completedList);
  const storageNote = element('p', 'tiny dim'); storageNote.hidden = true;
  const refresh = button('刷新处理状态', () => void load());
  host.replaceChildren(title, note, counts, notice, list, history, storageNote, refresh);

  let controller = null, timeout = null, poll = null, dead = false, sequence = 0;
  let snapshot = { enabled: false, items: [] }, readError = '';
  const requests = new Map();
  const storageKey = /^[a-f0-9-]{36}$/i.test(confirmationScope ?? '')
    ? `boxvault.weak-completed.v1.${confirmationScope}` : null;
  const confirmed = new Set();
  try {
    const saved = storageKey && JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) for (const key of saved.slice(-MAX_RECORDS)) {
      if (typeof key === 'string' && /^[a-f0-9-]{36}\|.{1,63}$/i.test(key) && Number.isFinite(Date.parse(key.slice(37)))) confirmed.add(key);
    }
  } catch { /* 浏览器不允许持久保存时，本次访问仍可确认。 */ }
  const live = () => !dead && host.isConnected;
  const complete = job => isCompletedPublishedJob(job) && !blocking(requests.get(job.videoId));
  // 只隐藏已取消的展示记录，不删除服务端任务；尚待核对的提交仍保留反馈。
  const cancelled = job => job.state === 'cancelled' && !blocking(requests.get(job.videoId));

  function confirmCompletions() {
    if (!live()) return;
    for (const job of snapshot.items.filter(complete)) {
      const key = completionKey(job);
      if (key) { confirmed.delete(key); confirmed.add(key); }
    }
    while (confirmed.size > MAX_RECORDS) confirmed.delete(confirmed.values().next().value);
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify([...confirmed])); }
      catch { storageNote.hidden = false; storageNote.textContent = '本次已确认；浏览器未允许记住，重新打开页面后可能再次提示。'; }
    }
    history.open = false;
    render();
    summary.focus();
  }

  function render() {
    if (!live()) return;
    const done = snapshot.items.filter(complete), active = snapshot.items.filter(job => !cancelled(job) && !complete(job));
    const fresh = done.filter(job => { const key = completionKey(job); return key && !confirmed.has(key); });
    counts.textContent = `本次列表：待关注 ${active.length} 条 · 已完成并收起 ${done.length} 条`;
    notice.hidden = fresh.length === 0;
    noticeText.textContent = `${fresh.length} 条处理已完成并自动收起，已发布的教学影像无需再次发布。可展开下方记录核对。`;
    confirmDone.textContent = `确认完成并收起（${fresh.length} 条）`;
    list.replaceChildren(...active.map(renderJob));
    if (!active.length) list.append(element('p', 'tiny dim', '当前列表没有需要处理的任务。'));
    // 保留 details 节点本身，轮询不改变管理员当前的展开状态。
    completedList.replaceChildren(...done.map(renderJob));
    history.hidden = done.length === 0; summary.textContent = `查看已完成记录（${done.length} 条）`;
    note.textContent = readError || (snapshot.enabled
      ? '补档会在服务器排队生成，无需重传原视频。已完成并发布的任务自动收起，已取消的任务不再显示。'
      : '当前服务器未启用自动处理。上传已保存并加密，但不会自动生成多清晰度。');
  }

  function renderJob(job) {
    const row = element('div', 'row'); row.dataset.videoId = job.videoId;
    row.style.flexWrap = 'wrap';
    const label = job.weakOnly ? weakStates[job.state] : job.posterOnly ? posterStates[job.state] : states[job.state];
    const stage = job.stage ? ` · ${String(job.stage).split('+').map(name => stages[name] || name).join('、')}` : '';
    row.append(element('span', '', `${job.title || job.videoId} · ${label || job.state}${stage}`));
    const renditionName = { low: '弱网档', sd: '流畅档', hd: '高清档' };
    for (const item of job.renditions ?? []) {
      const line = element('div', 'row'); line.style.flexWrap = 'wrap';
      const bar = element('progress'); bar.max = 100; bar.value = Math.max(0, Math.min(100, Number(item.percent) || 0));
      bar.setAttribute('aria-label', `${renditionName[item.rendition] || item.rendition}处理进度`);
      bar.hidden = item.state === 'absent' || job.state === 'cancelled';
      const description = item.state === 'done'
        ? `已生成 ${item.segments} 段${item.bytes ? ` · ${Math.round(item.bytes / 104857.6) / 10} MB` : ''}`
        : job.state === 'cancelled' ? '处理已取消'
          : item.state === 'working' ? (item.of ? `已编 ${item.segments}/${item.of} 段（约 ${item.percent}%）` : '正在生成这一档')
            : item.state === 'failed' ? '这一档失败，可重试'
              : job.state === 'queued' ? '已排队，等待生成' : item.state === 'absent' ? '尚未生成这一档' : '等待处理';
      line.append(element('span', 'tiny', renditionName[item.rendition] || item.rendition), bar, element('span', 'tiny dim', description));
      row.append(line);
    }
    if (job.canPublish && !job.error && job.videoStatus === 'draft') {
      const go = button(job.hasPoster ? '播放版本已就绪，去发布' : '播放版本已就绪，去挂封面并发布', () => onGoLibrary?.(job.videoId), 'btn btn-sm btn-primary');
      go.disabled = !onGoLibrary; row.append(go);
    }
    if (job.posterState === 'ready' || job.posterState === 'kept') row.append(element('span', 'tiny dim',
      job.posterState === 'kept' ? '已保留原封面' : job.hasPoster ? '封面已经挂上' : '候选帧已生成，待你选择'));
    if (onPickCover && (job.frames?.length || job.posterState === 'failed')) row.append(button('从视频帧选封面', () => onPickCover(job.videoId)));
    if (job.posterError && !job.error) row.append(element('span', 'tiny', errors[job.posterError] || '封面暂未生成'));
    if (job.error) row.append(element('span', 'tiny', errorText(job.error) || '原片已保留。请核对处理状态后重试。'));
    if (job.durationNote) row.append(element('span', 'tiny dim', job.durationNote));
    const entry = requests.get(job.videoId);
    const writeButton = (text, action) => {
      const control = button(entry?.state === 'submitting' ? '正在提交…' : text, () => void submit(action, job));
      control.disabled = Boolean(blocking(entry)); row.append(control);
    };
    if (job.canAddWeak) writeButton(entry?.state === 'rejected' ? '重试补弱网档' : '补弱网档', 'admin-processing-weak');
    if (job.state === 'failed' && !job.weakOnly || job.state === 'ready' && job.posterState === 'failed') writeButton(
      job.posterOnly || job.state === 'ready' ? '重试补封面' : '重试处理', job.posterOnly || job.state === 'ready' ? 'admin-poster-generate' : 'admin-processing-retry');
    if (entry) {
      const feedback = element('div', `note ${entry.state === 'rejected' ? 'note-bad' : entry.state === 'uncertain' ? 'note-warn' : ''}`);
      feedback.setAttribute('role', 'status'); feedback.dataset.processingFeedback = entry.state;
      feedback.append(element('p', '', entry.note));
      if (entry.state !== 'submitting') feedback.append(button('重新读取状态', () => void load()));
      if (entry.state === 'uncertain') {
        const retry = button('已核对，允许重试', () => {
          if (live() && requests.get(job.videoId) === entry && entry.checked) { requests.delete(job.videoId); render(); }
        });
        retry.disabled = !entry.checked; feedback.append(retry);
      }
      row.append(feedback);
    }
    return row;
  }

  async function submit(action, job) {
    if (!live() || blocking(requests.get(job.videoId))) return;
    if (!requests.has(job.videoId) && requests.size >= MAX_RECORDS) {
      readError = '待核对请求较多，请先刷新处理状态后再提交。'; render(); return;
    }
    const writeController = new AbortController();
    const entry = { action, job, controller: writeController, state: 'submitting', checked: false, note: action === 'admin-processing-weak' ? '正在提交弱网补档，请稍候…' : '正在提交处理请求，请稍候…' };
    requests.set(job.videoId, entry); render();
    const deadline = setTimeout(() => writeController.abort(), 12000);
    try {
      const result = await post(action, { videoId: job.videoId }, { signal: writeController.signal });
      if (!live() || requests.get(job.videoId) !== entry) return;
      const accepted = result?.videoId === job.videoId && ['queued', 'working', 'ready'].includes(result.state)
        && (action !== 'admin-processing-weak' || (result.state === 'ready' ? hasLow(result) : result.weakOnly === true));
      if (!accepted) {
        entry.state = 'uncertain'; entry.note = '服务器未返回可确认的处理状态。请先重新读取核对，避免重复提交。'; render(); return;
      }
      entry.state = 'accepted'; entry.note = '已提交，正在读取处理状态。'; render();
      // 读失败由 load 单独处理；成功提交不会因此变成“提交失败”。
      void load();
    } catch (error) {
      if (!live() || requests.get(job.videoId) !== entry) return;
      entry.state = error.name === 'AbortError' || isWriteOutcomeUnknown(error) ? 'uncertain' : 'rejected';
      entry.note = entry.state === 'uncertain'
        ? `提交结果待核对：${error.name === 'AbortError' ? '等待超时。' : error.message} 请重新读取状态，不要连续提交。`
        : `未能提交：${error.message}`;
      render();
    } finally { clearTimeout(deadline); entry.controller = null; }
  }

  function reconcileRequests() {
    for (const [id, entry] of requests) {
      if (entry.state === 'submitting') continue;
      const job = snapshot.items.find(item => item.videoId === id);
      if (!job) continue;
      const observed = entry.action === 'admin-processing-weak'
        ? hasLow(job) || job.weakOnly === true && ['queued', 'working'].includes(job.state)
        : ['queued', 'working'].includes(job.state) || job.state === 'ready' && !job.error && !job.posterError;
      if (observed || ['failed', 'cancelled'].includes(job.state) && entry.state === 'accepted') requests.delete(id);
      else {
        entry.checked = true;
        if (entry.state === 'accepted') {
          entry.state = 'uncertain'; entry.note = '已提交过请求，但当前尚未看到对应处理任务。请核对后再决定是否重试。';
        }
      }
    }
  }

  const pane = host.closest('#admin-upload-pane');
  const paused = () => document.visibilityState === 'hidden' || Boolean(pane?.hidden);
  async function load() {
    if (!live() || paused()) return;
    const version = ++sequence;
    clearTimeout(poll); clearTimeout(timeout); controller?.abort();
    const readController = new AbortController(); controller = readController;
    timeout = setTimeout(() => readController.abort(), 12000);
    let again = 15000;
    try {
      const response = await fetch(api('admin-processing'), { credentials: 'same-origin', cache: 'no-store', signal: readController.signal });
      if (!response.ok) throw new Error('处理状态暂时未取到，请稍后刷新。');
      const result = await response.json();
      if (!live() || version !== sequence) return;
      if (!Array.isArray(result?.items)) throw new Error('处理状态不完整，请重新读取。');
      snapshot = { enabled: Boolean(result.enabled), items: result.items.slice(0, MAX_RECORDS) };
      readError = ''; reconcileRequests(); render();
      if (snapshot.items.some(job => ['queued', 'working'].includes(job.state))) again = 5000;
      if (!snapshot.enabled) again = 60000;
    } catch (error) {
      if (live() && version === sequence && error.name !== 'AbortError') {
        readError = error.message;
        for (const entry of requests.values()) if (entry.state === 'accepted') entry.note = '提交已成功，处理状态暂未取到。请重新读取，不要重复提交。';
        render();
      }
    } finally {
      if (version === sequence) {
        clearTimeout(timeout);
        if (live()) poll = setTimeout(() => void load(), again);
      }
    }
  }

  const visible = () => {
    if (paused()) { ++sequence; clearTimeout(poll); clearTimeout(timeout); controller?.abort(); }
    else void load();
  };
  const changed = () => { if (live()) void load(); };
  document.addEventListener('boxvault-uploaded', changed);
  document.addEventListener('visibilitychange', visible);
  pane?.addEventListener('upload-pane-shown', visible);
  const observer = new MutationObserver(() => { if (!host.isConnected) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true });
  function dispose() {
    if (dead) return;
    dead = true; ++sequence; controller?.abort(); clearTimeout(poll); clearTimeout(timeout); observer.disconnect();
    for (const entry of requests.values()) entry.controller?.abort();
    requests.clear();
    pane?.removeEventListener('upload-pane-shown', visible);
    document.removeEventListener('boxvault-uploaded', changed); document.removeEventListener('visibilitychange', visible);
  }
  void load(); return dispose;
}
