import { createCipher, CHUNK_SIZE, chunkCount } from './vendor/video-crypto.mjs';
import { createChunkUpload } from './upload-engine.mjs';

const text = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bytes = n => `${(Number(n) / 1048576).toFixed(1)} MiB`;
const mimeOf = file => file.type || ({ mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' })[file.name.split('.').pop().toLowerCase()] || '';

export function mountUploadQueue(host, { post, plans, defaultPreview, maxBytes, probeDuration, probeFaststart, captureCover,
  uploadCover, serverCovers = false, isWriteOutcomeUnknown, onChanged = () => {}, onPickCover = () => {}, onWatchProgress = () => {} }) {
  const jobs = [];
  let active = 0;
  let paused = false;
  let disposed = false;
  let preparing = 0;
  let batchSettings = null;
  const tiers = [...new Set([0, 1, ...plans.map(plan => Number(plan.tier_rank))])]
    .filter(rank => Number.isSafeInteger(rank) && rank >= 0 && rank <= 99).sort((a,b) => a-b);
  host.innerHTML = `<details class="panel stack" id="batch-upload" open><summary>批量上传多个视频</summary>
    <p class="tiny dim">可一次选择最多 20 个文件，同时处理两条视频，合计最多三路数据块上传。每条视频独立加密并保存为草稿。</p>
    <p class="tiny dim">某条失败时点它自己的「重试这一条」，会从断掉的那一块接着传，不用重传整片。别刷新页面：刷新后这一批就没了，重新选同一个文件会另起一条草稿，旧的那条要到教学影像管理里删。</p>
    <label class="field">选择视频<input class="input" type="file" data-batch-files multiple accept="video/mp4,video/webm,video/quicktime,.mp4,.mov,.webm"></label>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <label class="field">分类<select class="input" data-batch-kind><option value="live">真实拳击</option><option value="anime">动画拳击</option></select></label>
      <label class="field">会员等级<select class="input" data-batch-tier>${tiers.map(rank => `<option value="${rank}" ${rank === 1 ? 'selected' : ''}>${rank === 0 ? '公开观看' : `等级 ${rank}`}</option>`).join('')}</select></label>
      <label class="field">试看秒数<input class="input" type="number" min="0" max="3600" data-batch-preview value="${Number(defaultPreview) || 0}"></label>
    </div>
    <div data-batch-list class="stack"></div>
    <p data-batch-summary aria-live="polite">尚未选择文件。</p>
    <div class="row"><button class="btn btn-primary" type="button" data-batch-start disabled>开始批量上传</button>
    <button class="btn" type="button" data-batch-pause aria-pressed="false" disabled>暂停排队</button>
    <button class="btn btn-ghost" type="button" data-batch-clear disabled>清空已结束的任务</button></div>
    <p class="tiny dim">暂停排队只停止启动下一条，正在上传的条目会继续完成；继续排队后再启动剩余条目。</p>
    <p class="tiny dim">${serverCovers
      ? '每条可选一张封面图片；不选时尝试自动取帧。传完后也可从服务器提取的画面中选择，不用重传。'
      : '每条可选一张封面图片；不选时尝试自动取帧。没取到可在教学影像管理补图，不用重传。'}</p>
  </details>`;
  const list = host.querySelector('[data-batch-list]');
  const summary = host.querySelector('[data-batch-summary]');
  const start = host.querySelector('[data-batch-start]');
  const clear = host.querySelector('[data-batch-clear]');
  const pause = host.querySelector('[data-batch-pause]');
  const picker = host.querySelector('[data-batch-files]');
  const live = () => !disposed && host.isConnected;
  const labels = { probing: '读取文件信息', ready: '等待上传', queued: '排队中', starting: '正在建档', uploading: '加密并上传', sealing: '校验登记', done: '已保存草稿', failed: '上传未完成', cancelling: '正在中止', cancelled: '已中止', uncertain: '结果待核对' };
  const busy = job => ['queued', 'starting', 'uploading', 'sealing', 'cancelling'].includes(job.state);
  function render(job) {
    if (!live() || !job.row.isConnected) return;
    job.row.querySelector('[data-status]').textContent = labels[job.state];
    job.row.querySelector('[data-note]').textContent = job.note || '';
    job.row.querySelector('[data-progress]').value = job.percent || 0;
    job.row.querySelector('[data-meter]').textContent = job.meter || '';
    // 传完的这一行不再挂着一条 100% 的进度条（单条那一路同一个道理）。两档清晰度的真实进度
    // 只由「视频与封面处理」那一栏报数，这一行给入口，不在这里抄第二份进度。
    const finished = job.state === 'done';
    if (finished || job.state === 'cancelled') job.row.querySelector('[data-cover-file]').value = '';
    job.row.querySelector('[data-progress]').hidden = finished;
    job.row.querySelector('[data-meter]').hidden = finished;
    const after = job.row.querySelector('[data-after]');
    after.hidden = !(finished && serverCovers);
    if (finished && serverCovers && !after.dataset.built) {
      const videoId = job.session?.videoId ?? '';
      const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'btn btn-sm';
      pick.textContent = '从视频画面选封面';
      const watch = document.createElement('button'); watch.type = 'button'; watch.className = 'btn btn-ghost btn-sm';
      watch.textContent = '看这一条的处理进度';
      const panel = document.createElement('section'); panel.hidden = true;
      pick.addEventListener('click', () => { panel.hidden = false; pick.hidden = true; onPickCover(videoId, panel); });
      watch.addEventListener('click', () => onWatchProgress(videoId));
      after.append(pick, watch, panel);
      after.dataset.built = '1';
    }
    job.title.disabled = job.duration.disabled = Boolean(job.enqueueWhenReady || job.session) || busy(job) || ['done', 'uncertain', 'cancelled'].includes(job.state);
    job.row.querySelector('[data-cover-file]').disabled = Boolean(job.enqueueWhenReady || job.session) || busy(job) || ['done', 'uncertain', 'cancelled'].includes(job.state);
    const retry = job.row.querySelector('[data-retry]');
    retry.hidden = job.state !== 'failed';
    const cancel = job.row.querySelector('[data-cancel]');
    cancel.hidden = ['done', 'cancelled', 'uncertain'].includes(job.state);
    cancel.disabled = job.state === 'sealing' || job.state === 'cancelling';
    cancel.textContent = job.session ? '中止并清理这条' : '移除这条';
    updateControls();
  }
  function updateControls() {
    const queued = jobs.filter(job => job.state === 'queued').length;
    summary.textContent = jobs.length ? `${jobs.length} 条 · ${jobs.filter(j => j.state === 'done').length} 条已保存草稿 · ${active} 条处理中 · ${queued} 条排队${paused ? ' · 排队已暂停' : ''}` : '尚未选择文件。';
    pause.disabled = !paused && !jobs.some(job => busy(job) || job.enqueueWhenReady);
    pause.textContent = paused ? '继续排队' : '暂停排队';
    pause.setAttribute('aria-pressed', String(paused));
    start.textContent = paused ? '加入等待队列' : '开始批量上传';
    start.disabled = !jobs.some(j => j.state === 'ready' || (j.state === 'probing' && !j.enqueueWhenReady));
    clear.disabled = !jobs.some(j => ['done', 'cancelled'].includes(j.state));
    for (const input of host.querySelectorAll('[data-batch-kind],[data-batch-tier],[data-batch-preview]')) input.disabled = active > 0;
  }
  const message = error => String(error?.message || '上传没有完成，请稍后重试。');
  async function removeDraft(job) {
    if (job.session) await post('admin-upload-abort', { videoId: job.session.videoId });
    job.session = null; job.engine = null; job.cipher = null; job.file = null; job.coverFile = null;
  }
  async function runJob(job) {
    active++;
    job.controller = new AbortController();
    const signal = job.controller.signal;
    let coverJob = Promise.resolve();
    const coverController = new AbortController();
    const cancelCover = () => coverController.abort();
    signal.addEventListener('abort', cancelCover, { once: true });
    try {
      job.state = 'starting'; job.note = ''; render(job);
      if (!job.session) {
        // 建档和登记是不可盲重发的写操作。保留响应，取消后拿到 videoId 才能清理。
        const session = await post('admin-upload-start', { ...job.settings, title: job.title.value.trim(),
          durationSeconds: Number(job.duration.value), plainSize: job.file.size, contentType: mimeOf(job.file) });
        job.session = session;
        job.cipher = createCipher(session.chunkSize || CHUNK_SIZE);
        job.engine = createChunkUpload({ file: job.file, cipher: job.cipher, videoId: session.videoId,
          totalChunks: session.chunkTotal, post, onProgress: value => {
            if (job.baseBytes === null) job.baseBytes = value.bytes;
            const elapsed = Math.max(0.25, (performance.now() - job.startedAt) / 1000);
            const rate = Math.max(0, value.bytes - job.baseBytes) / elapsed;
            job.percent = Math.round(value.bytes / value.size * 95);
            job.meter = `${value.completed}/${value.total} 块 · ${bytes(value.bytes)}/${bytes(value.size)} · ${bytes(rate)}/秒`;
            render(job);
          } });
      }
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      job.state = 'uploading'; job.startedAt = performance.now(); job.baseBytes = null; render(job);
      if (!job.coverState || job.coverState === 'failed') {
        job.coverState = 'pending';
        coverJob = (async () => {
          const deadline = setTimeout(() => coverController.abort(), 45000);
          let writing = false;
          try {
            const shot = job.coverFile ? { blob: job.coverFile } : await captureCover(job.file, Number(job.duration.value), coverController.signal);
            if (signal.aborted) return;
            if (shot.blob) { writing = true; await uploadCover(job.session.videoId, shot.blob, coverController.signal); job.coverState = 'confirmed'; job.coverNote = ''; }
            else { job.coverState = 'failed'; job.coverNote = serverCovers ? '浏览器未生成预览，服务器将提取候选帧，可从上传页处理状态中选封面。' : '未取到封面，请在教学影像管理补图。'; }
          } catch (error) {
            const status = Number(error?.status || /HTTP (\d{3})/.exec(String(error?.message))?.[1] || 0);
            const rejected = status >= 400 && status < 500 && status !== 408 && status !== 429 && !isWriteOutcomeUnknown(error);
            const uncertain = coverController.signal.aborted || isWriteOutcomeUnknown(error) || (writing && !rejected);
            job.coverState = uncertain ? 'uncertain' : 'failed';
            job.coverNote = uncertain
              ? '封面保存结果未确认，请到教学影像管理核对。'
              : `封面未确认：${message(error)}。${serverCovers ? '稍后可从服务器候选画面中选择。' : '请在教学影像管理补图。'}`;
          } finally { clearTimeout(deadline); }
        })();
      }
      await job.engine.run({ signal, concurrency: 2 });
      await coverJob;
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      job.state = 'sealing'; render(job);
      await post('admin-upload-complete', { videoId: job.session.videoId, cipher: job.cipher, faststart: job.faststart === true });
      document.dispatchEvent(new Event('boxvault-uploaded'));
      job.state = 'done'; job.percent = 100;
      job.note = `${job.coverNote ? `${job.coverNote} ` : ''}已保存草稿。${serverCovers ? '播放版本由服务器排队生成，点「看这一条的处理进度」核对；' : ''}发布后观众才能查看。`;
      job.engine = null; job.cipher = null; job.file = null; job.coverFile = null;
      if (live()) Promise.resolve(onChanged()).catch(() => {});
    } catch (error) {
      await coverJob;
      if (signal.aborted && job.state !== 'sealing') {
        job.state = 'cancelling'; render(job);
        try { await removeDraft(job); job.state = 'cancelled'; job.note = '任务已停止，未完成的草稿已清理。'; }
        catch (cleanup) { job.state = 'failed'; job.cancelPending = true; job.note = `已停止传输，清理未确认：${message(cleanup)}`; }
      } else {
        job.state = isWriteOutcomeUnknown(error) ? 'uncertain' : 'failed';
        job.note = message(error) + (job.state === 'uncertain' ? ' 请先到教学影像管理核对，避免重复建档。' : ' 其他视频会继续上传。别刷新页面，直接点「重试这一条」就从断掉的那一块接着传；刷新后重新选文件会另起一条草稿，这一条要到教学影像管理里删。');
      }
    } finally {
      coverController.abort(); signal.removeEventListener('abort', cancelCover);
      job.controller = null; active--; render(job); schedule();
    }
  }
  function schedule() {
    if (!live() || paused) return;
    for (const job of jobs) {
      if (active >= 2) break;
      if (job.state === 'queued') void runJob(job);
    }
  }
  const settings = () => ({ kind: host.querySelector('[data-batch-kind]').value,
    tierRank: Number(host.querySelector('[data-batch-tier]').value), previewSeconds: Number(host.querySelector('[data-batch-preview]').value) });
  function enqueue(job) {
    const seconds = Number(job.duration.value);
    if (!job.title.value.trim() || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400) { job.pendingSettings = null; job.note = '请填写标题和有效时长（1–86400 秒），再点开始。'; render(job); return; }
    job.settings = { ...(job.pendingSettings || batchSettings || settings()) }; job.pendingSettings = null; job.enqueueWhenReady = false; job.state = 'queued'; render(job);
  }
  function probeNext() {
    if (!live()) return;
    while (preparing < 2) {
      const job = jobs.find(j => j.state === 'probing' && !j.probing);
      if (!job) break;
      preparing++; job.probing = true;
      void (async () => {
        try {
          const seconds = await probeDuration(job.file, job.probeController.signal);
          if (job.state !== 'probing' || !live()) return;
          if (!job.duration.value && seconds) job.duration.value = seconds;
          job.faststart = await probeFaststart(job.file);
          if (job.state !== 'probing' || !live()) return;
          job.note = job.faststart === false ? 'moov 在文件末尾，建议导出 faststart 后上传。' : '';
          if (!seconds) job.note += ' 浏览器未读出时长，请手工填写秒数。';
          job.state = 'ready';
        } catch (error) { if (job.state === 'probing') { job.state = 'ready'; job.note = message(error); } }
        finally {
          preparing--;
          if (job.state === 'ready' && job.enqueueWhenReady) { job.enqueueWhenReady = false; enqueue(job); schedule(); }
          render(job); probeNext();
        }
      })();
    }
  }
  picker.addEventListener('change', () => {
    host.querySelector('details').open = true;
    for (const file of picker.files) {
      if (jobs.length >= 20) { summary.textContent = '一批最多保留 20 条，请先清空已结束的任务。'; break; }
      const job = { file, state: 'probing', probeController: new AbortController(), session: null, engine: null, note: '', percent: 0 };
      const row = document.createElement('article'); row.className = 'panel stack';
      row.innerHTML = `<strong>${text(file.name)} · ${bytes(file.size)}</strong>
        <label class="field">标题<input class="input" data-title maxlength="120" value="${text(file.name.replace(/\.[^.]+$/, '').slice(0,120))}"></label>
        <label class="field">时长（秒）<input class="input" data-duration type="number" min="1" max="86400"></label>
        <label class="field">封面（选填，JPG / PNG / WebP，最多 2 MB）<input class="input" type="file" data-cover-file accept="image/jpeg,image/png,image/webp"></label>
        <p data-status aria-live="polite"></p><progress data-progress max="100" value="0" style="width:100%"></progress>
        <p data-meter class="tiny dim"></p><p data-note class="tiny"></p>
        <div class="row" data-after style="gap:6px" hidden></div>
        <div class="row"><button type="button" class="btn btn-sm" data-retry hidden>重试这一条</button><button type="button" class="btn btn-ghost btn-sm" data-cancel>移除这条</button></div>`;
      job.row = row; job.title = row.querySelector('[data-title]'); job.duration = row.querySelector('[data-duration]');
      const coverInput = row.querySelector('[data-cover-file]');
      coverInput.addEventListener('change', () => {
        const selected = coverInput.files?.[0] || null;
        if (selected && (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || !selected.size || selected.size > 2 * 1024 * 1024)) {
          coverInput.value = ''; job.coverFile = null; job.note = '请选择不超过 2 MB 的 JPG、PNG 或 WebP 图片。';
        } else { job.coverFile = selected; job.note = selected ? '已选择封面，将随这条视频保存。' : ''; }
        render(job);
      });
      list.append(row); jobs.push(job);
      if (!file.size || file.size > maxBytes || !['video/mp4','video/webm','video/quicktime'].includes(mimeOf(file))) {
        job.state = 'cancelled'; job.file = null; job.note = '文件类型不支持，或超过单个文件大小限制。';
      }
      row.querySelector('[data-retry]').addEventListener('click', async () => {
        if (job.state !== 'failed') return;
        if (job.cancelPending) {
          job.state = 'cancelling'; render(job);
          try { await removeDraft(job); job.state = 'cancelled'; job.cancelPending = false; job.note = '未完成的草稿已清理。'; }
          catch (error) { job.state = 'failed'; job.note = message(error); } render(job); return;
        }
        batchSettings = settings(); enqueue(job); schedule();
      });
      row.querySelector('[data-cancel]').addEventListener('click', async () => {
        job.probeController.abort();
        if (job.controller) { job.controller.abort(); job.state = 'cancelling'; render(job); return; }
        if (job.session) {
          job.state = 'cancelling'; render(job);
          try { await removeDraft(job); job.state = 'cancelled'; }
          catch (error) { job.state = 'failed'; job.cancelPending = true; job.note = message(error); }
        } else { job.state = 'cancelled'; job.file = null; job.coverFile = null; }
        render(job);
      });
      render(job);
    }
    picker.value = ''; probeNext();
  });
  start.addEventListener('click', () => {
    batchSettings = settings();
    if (!Number.isSafeInteger(batchSettings.previewSeconds) || batchSettings.previewSeconds < 0 || batchSettings.previewSeconds > 3600) { summary.textContent = '试看秒数须在 0–3600 之间。'; return; }
    for (const job of jobs) {
      if (job.state === 'ready') enqueue(job);
      else if (job.state === 'probing' && !job.enqueueWhenReady) { job.enqueueWhenReady = true; job.pendingSettings = { ...batchSettings }; render(job); }
    }
    updateControls();
    schedule();
  });
  pause.addEventListener('click', () => {
    if (!live() || pause.disabled) return;
    paused = !paused; updateControls();
    if (!paused) schedule();
  });
  clear.addEventListener('click', () => {
    for (let i = jobs.length - 1; i >= 0; i--) if (['done','cancelled'].includes(jobs[i].state)) { jobs[i].row.remove(); jobs.splice(i,1); }
    if (jobs[0]) render(jobs[0]); else { paused = false; updateControls(); }
  });
  function dispose() {
    if (disposed) return;
    disposed = true; observer.disconnect(); window.removeEventListener('pagehide', dispose);
    for (const job of jobs) { job.probeController.abort(); job.controller?.abort(); if (!job.controller) { job.file = null; job.coverFile = null; } }
  }
  const observer = new MutationObserver(() => { if (!host.isConnected) dispose(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
