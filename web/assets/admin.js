import { api, get, post, isWriteOutcomeUnknown } from './api.js';
import { ADMIN_TABS, mountBreadcrumb } from './shell-nav.js';
import { esc, fmtBytes, fmtDate, fmtDuration, fmtMoney, toast, go, state, labelTableCells, watchedLine, ipLabel, posterSrc, hydratePosters } from './app.js';
import { CHUNK_SIZE, createCipher, chunkCount } from './vendor/video-crypto.mjs';
import { mountCatalogOrderEditor } from './catalog-order-editor.mjs';
import { createChunkUpload } from './upload-engine.mjs';
import { mountUploadQueue } from './upload-queue.mjs';
import { mountProcessingStatus } from './processing-status.mjs';
import { mountServerCoverPicker } from './cover-picker.mjs';
import { copyText } from './clipboard.mjs';
import { mountAdminWorkspace } from './admin-workspace.mjs';
import { directoryMarkup, bindEntitlementEditor } from './member-directory.mjs';

// A phone browser that lacks WebCrypto fails inside the encryptor with a JS TypeError like
// "Cannot read properties of undefined (reading 'importKey')". That string is true but
// useless to the owner, so it is translated at the places where it is shown to him.
function readableError(error, fallback = '操作没有完成') {
  const text = String(error?.message ?? error ?? '');
  if (/importKey|encrypt|decrypt|subtle|getRandomValues|Crypto/i.test(text)) {
    return '这个浏览器不支持网页加密（WebCrypto），手机上传需要它。iPhone 用 Safari、安卓用 Chrome 或 Edge 打开后台再传。';
  }
  if (/AbortError|aborted/i.test(text)) return '这次上传被中止了。';
  return text || fallback;
}

// 标签清单只有一份：后台的标签行、面包屑的同级下拉、顶部搜索和弧形菜单都读它。
const TABS = ADMIN_TABS.map(([key, label]) => [key, label]);
// 「去教学影像管理」这一步在上传结果面板和处理面板里都要能跳，跳法只留这一份。
const focusLibraryTab = () => { for (const tab of document.querySelectorAll('[data-tab="videos"]')) tab.click(); };

const MAX_POSTER_BYTES = 2 * 1024 * 1024;

// 取不到画面有四种不同的原因，以前全印同一句"取不到画面"：解不动编码、读到那一眼超时、
// 那一帧本身解不出、取到的图太大。这四种要他做的事完全不同（换导出 / 换个秒数 / 重选文件 /
// 压一下图），所以分开报，而且每条都跟着一句"下一步点哪里"。
const COVER_FAIL_COPY = {
  codec: '当前浏览器无法预览这条视频，不能据此判断文件损坏。',
  timeout: '读了 30 秒还没读到那一帧（文件大、或者 moov 写在末尾时最容易这样）。把时间条往前拖到第 2 秒左右再试一次，或者选一张图当封面。',
  frame: '这一帧没有生成预览，可以拖时间条换个位置再试。',
  large: '取到的这一帧超过 2 MB，站点不收这么大的封面。拖时间条换一帧，或者自己压一张小一点的图。',
  read: '浏览器读不到这个文件的画面（文件没选完整，或中途被系统清掉了）。重新选一次文件。',
};

function coverFailureText(reason) {
  const detail = COVER_FAIL_COPY[reason] || COVER_FAIL_COPY.frame;
  return state.boot?.processingEnabled
    ? detail + ' 可以继续上传，上传完成后可以选择服务器提取的视频画面，无需先转码重传；也可自己选图。'
    : detail + ' 当前服务器未启用后台处理，请手选一张封面；无需因预览失败重传视频。';
}

// MediaError.code：4=这种源浏览器根本不支持，3=解不出来，1/2=读的过程中断了或被取消。
function decodeFailureReason(error) {
  const code = Number(error?.code);
  if (code === 4) return 'codec';
  if (code === 3) return 'frame';
  if (code === 1 || code === 2) return 'read';
  return 'frame';
}

// 返回 { blob, reason }：有画面时 reason 是 null，没画面时 blob 是 null 且 reason 说得出为什么。
// 以前这里等的是 loadeddata（第一帧解出来才触发），而大文件、尤其 moov 在末尾的文件，
// loadeddata 可以一直不来 —— 于是浏览器明明能解这条片子，面板却说"取不到画面"。
// 改成元数据一到就 seek：seeked 触发时 Chrome 已经把目标那一帧解码好了。
function captureFrameAt(file, seconds, budgetMs, signal) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const clip = document.createElement('video');
    let settled = false;
    let budget = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(budget);
      clip.onerror = null;
      clip.onloadedmetadata = null;
      clip.onseeked = null;
      signal?.removeEventListener('abort', cancel);
      clip.pause();
      clip.removeAttribute('src');
      clip.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const cancel = () => finish({ blob: null, reason: 'read' });
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    budget = window.setTimeout(() => finish({ blob: null, reason: 'timeout' }), budgetMs);
    clip.muted = true;
    clip.playsInline = true;
    clip.preload = 'auto';
    clip.onerror = () => finish({ blob: null, reason: decodeFailureReason(clip.error) });
    clip.onloadedmetadata = () => {
      const limit = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : seconds + 1;
      clip.onseeked = () => {
        const width = clip.videoWidth;
        const height = clip.videoHeight;
        if (!width || !height) return finish({ blob: null, reason: 'frame' });
        const scale = Math.min(1, 1280 / width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d').drawImage(clip, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) return finish({ blob: null, reason: 'frame' });
          if (blob.size > MAX_POSTER_BYTES) return finish({ blob: null, reason: 'large' });
          finish({ blob, reason: null });
        }, 'image/jpeg', 0.82);
      };
      clip.currentTime = Math.min(Math.max(0.1, seconds), Math.max(0.1, limit - 0.2));
    };
    clip.src = url;
  });
}

// 长片默认取"时长 5%"那一眼（第 44 秒这种），手机上解码器要往前读到那儿才画得出来。
// 读不到就退到第 2 秒再试一次：开头那一帧几乎总是最便宜的。编码本身解不动就别白等第二轮。
// 返回里的 at 是"真正用到的是第几秒"，界面要说这个数，不能说时间条上那个。
async function captureFrame(file, seconds, signal) {
  const first = await captureFrameAt(file, seconds, 30000, signal);
  if (first.blob || first.reason === 'codec' || first.reason === 'read' || seconds <= 2) {
    return { ...first, at: seconds };
  }
  const early = Math.min(2, Math.max(0.1, seconds));
  const backup = await captureFrameAt(file, early, 20000, signal);
  return backup.blob ? { ...backup, at: early } : { ...first, at: seconds };
}

// 封面只有一个写法：现要一个写入地址 → 把字节推进桶 → 让服务端读回来核对字节数和类型。
// 上传时、传完重试刚才那一帧、片库里给已有片子补图，三条路都走这里。
// 以前上传用的是建档时一起发的那个地址，于是同一个动作有两份实现，其中一份还只活几秒。
async function uploadCover(videoId, source, signal, { retryProcessing = true } = {}) {
  if (!source) throw new Error('先选一张图（JPG/PNG/WebP）。');
  const bytes = source instanceof File
    ? source
    : new File([source], 'cover.jpg', { type: source.type || 'image/jpeg' });
  if (bytes.size > MAX_POSTER_BYTES) {
    throw new Error(`这张图 ${(bytes.size / 1048576).toFixed(2)} MB，超过 2 MB。先压缩再选，或者换一张。`);
  }
  const issued = await post('admin-poster-url', { videoId }, { signal });
  if (!issued?.uploadUrl) throw new Error('站点没有给出封面写入地址');
  const response = await fetch(issued.uploadUrl, {
    method: 'PUT', body: bytes, headers: { 'Content-Type': bytes.type || 'application/octet-stream' }, signal,
  });
  if (!response.ok) throw new Error(`封面写入失败（HTTP ${response.status}）`);
  await response.arrayBuffer();
  await post('admin-poster-done', { videoId, sizeBytes: bytes.size }, { signal });
  // 封面定下来就自动把这条重新排进处理队列：上传时读不出时长那类片子，处理会先失败，
  // 而站长下一步本来就是去选封面——再让他找一颗「重试处理」按钮就是白捡的漏拍（2026-10-17 他点名要这个）。
  // 已经有播放版本的片子，处理器会立刻回 ready，多排这一次不花钱；排不上也不影响封面已经存好。
  if (retryProcessing) post('admin-processing-retry', { videoId }).catch(() => {});
  return { sizeBytes: bytes.size, type: bytes.type || 'image/jpeg' };
}


async function probeDuration(file, signal) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    let settled = false;
    let timer;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      probe.onloadedmetadata = probe.onerror = null;
      probe.pause();
      probe.removeAttribute('src');
      probe.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const cancel = () => done(null);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    probe.preload = 'metadata';
    probe.muted = true;
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) && probe.duration > 0 ? Math.round(probe.duration) : null);
    probe.onerror = () => done(null);
    timer = window.setTimeout(() => done(null), 20000);
    probe.src = url;
  });
}

// The opening seconds of a lesson are usually a black frame or a logo, so the default
// cover sits a little into the video and never past a minute.
function defaultCoverSecond(duration) {
  if (!duration || duration <= 0) return 3;
  return Math.min(60, Math.max(3, Math.round(duration * 0.05)));
}

// A truncated preview is only watchable when the sample table is in front of the
// media data, so the upload tells the seller when a file will preview badly.
async function probeFaststart(file) {
  const window = Math.min(file.size, 8 * 1024 * 1024);
  const head = new Uint8Array(await file.slice(0, window).arrayBuffer());
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (offset) => String.fromCharCode(head[offset], head[offset + 1], head[offset + 2], head[offset + 3]);
  let offset = 0;
  while (offset + 8 <= head.length) {
    let size = view.getUint32(offset);
    const type = tag(offset + 4);
    let headerBytes = 8;
    if (size === 1) {
      if (offset + 16 > head.length) return null;
      size = Number(view.getBigUint64(offset + 8));
      headerBytes = 16;
    } else if (size === 0) {
      size = head.length - offset;
    }
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (!Number.isSafeInteger(size) || size < headerBytes) return null;
    offset += size;
  }
  return null;
}

// 片库管理里的封面格。站长就靠这一格确认"挂上去的是不是这一节片"，所以有图就得把图画出来：
// 观众那条 ?a=poster 对草稿回 404，这一格改走 ?a=admin-poster（只给管理账号，观众那边的门槛一条没动）。
// 以前草稿只给一句"图有，但要发布才显示"、不给图，站长挂完封面刷新，看见的和没挂时一模一样，
// 就把已经成功的那一下当成失败，回头重传整条视频。
// 「换封面/补封面」：取帧失败或者事后想换一张，不用再重传视频。
function coverCell(item) {
  const action = item.hasPoster ? '换封面' : '补封面';
  const picture = item.hasPoster
    ? `<img data-poster="${esc(api('admin-poster', { v: item.id, t: item.posterVersion }))}" alt="《${esc(item.title)}》的封面" decoding="async" width="84" height="48">`
      + (item.status === 'published' ? '' : '<div class="tiny dim">草稿：发布后观众才看得到这张</div>')
    : '<span class="tiny dim">没挂封面</span>';
  return `${picture}
    <button class="btn btn-sm btn-ghost" type="button" data-cover-open aria-label="给《${esc(item.title)}》${action}">${action}</button>
    ${item.status !== 'uploading' && state.boot?.processingEnabled ? '<button class="btn btn-sm" type="button" data-cover-server>服务器取候选帧</button>' : ''}
    <input class="input" type="file" data-cover-file accept="image/jpeg,image/png,image/webp" hidden>`;
}

export async function mountAdmin(view, { reloadBoot }) {
  // The tab lives in the URL hash so a refresh, a bookmark or a "看激活码页" link
  // from the owner's own notes lands back on the panel they were working in.
  const tabKeys = new Set(TABS.map(([key]) => key));
  let current = tabKeys.has(location.hash.slice(1)) ? location.hash.slice(1) : 'members';
  let keysPage = 0;
  let keysFilter = '';
  const keyExport = { filter: '', nextOffset: 0, pending: false, paint: () => {} };
  const videoPages = [0];
  let videoQuery = '', videoStatus = 'all', videoKind = 'all';
  let drawPass = 0;
  let saleDraft = null;
  let paired = false;
  const groups = [
    ['日常工作', ['members', 'upload']],
    ['内容与交易', ['videos', 'requests', 'keys', 'plans']],
    ['运营与设置', ['behavior', 'audit', 'trash', 'settings']],
  ];
  const labels = new Map(TABS);
  view.innerHTML = `
    <div class="wrap admin">
      <div class="spread">
        <div class="section-title" style="margin:0"><h1>管理后台</h1>
          <p class="tiny dim">管理账号 · <span class="mono">${esc(state.boot.viewer.email)}</span></p></div>
        <button class="btn btn-ghost btn-sm" type="button" id="refresh">重新读取</button>
      </div>
      <div id="admin-crumbs"></div>
      <nav class="admin-task-nav" aria-label="后台功能">${groups.map(([label, keys]) => `
        <div class="admin-task-group"><span>${label}</span><div>${keys.map(key => `
          <a data-tab="${key}" href="/admin#${key}"${key === current ? ' aria-current="page"' : ''}>${labels.get(key)}</a>`).join('')}</div></div>`).join('')}</nav>
      <div class="admin-pair-tools"><button class="btn btn-sm btn-ghost" type="button" id="admin-pair" aria-pressed="false" aria-controls="admin-panes">同屏管理用户和上传</button>
        <span id="admin-upload-summary" role="status" class="tiny dim"></span></div>
      <div class="admin-panes" id="admin-panes">
        <div id="tab-body" class="stack"></div>
        <section id="admin-upload-pane" aria-label="视频上传" hidden></section>
      </div>
    </div>`;

  const root = view.querySelector('.admin');
  const slot = root.querySelector('#tab-body');
  const uploadPane = root.querySelector('#admin-upload-pane');
  const pair = root.querySelector('#admin-pair');
  const crumbsHost = root.querySelector('#admin-crumbs');
  const paintCrumbs = () => mountBreadcrumb(crumbsHost, {
    trail: [{ label: '后台', href: '/admin' }, { label: labels.get(current) }],
    places: TABS.map(([key, label]) => ({ label, href: `/admin#${key}` })),
  });
  const isDesk = () => current === 'members' || current === 'upload';
  let uploadMount;
  function ensureUpload() {
    if (uploadMount) return uploadMount;
    uploadPane.setAttribute('aria-busy', 'true');
    uploadMount = uploadTab(uploadPane).catch(error => {
      if (!root.isConnected) return;
      uploadMount = null;
      uploadPane.innerHTML = `<p class="note note-bad">${esc(error.message)}</p><button type="button" class="btn btn-sm">重试读取上传面板</button>`;
      uploadPane.querySelector('button').addEventListener('click', () => void ensureUpload());
    }).finally(() => uploadPane.setAttribute('aria-busy', 'false'));
    return uploadMount;
  }
  function showPanes() {
    pair.hidden = !isDesk();
    pair.setAttribute('aria-pressed', String(paired));
    pair.textContent = paired ? '收起另一栏' : '同屏管理用户和上传';
    const both = isDesk() && paired;
    root.querySelector('#admin-panes').classList.toggle('is-paired', both);
    root.querySelector('#admin-panes').dataset.primary = current;
    slot.hidden = current === 'upload' && !both;
    const wasHidden = uploadPane.hidden;
    uploadPane.hidden = current !== 'upload' && !both;
    if (wasHidden !== uploadPane.hidden) uploadPane.dispatchEvent(new Event('upload-pane-shown'));
    if (!uploadPane.hidden) void ensureUpload();
  }
  pair.addEventListener('click', () => { paired = !paired; void draw(true); });
  const selectTab = async (key, record = true) => {
    if (!root.isConnected || !tabKeys.has(key)) return;
    current = key;
    if (record && location.hash !== `#${key}`) history.pushState(history.state, '', `#${key}`);
    if (key === 'keys') keysPage = 0;
    for (const link of root.querySelectorAll('[data-tab]')) {
      if (link.dataset.tab === key) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    paintCrumbs();
    await draw(true);
  };
  root.querySelector('.admin-task-nav').addEventListener('click', event => {
    const link = event.target.closest('[data-tab]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); void selectTab(link.dataset.tab);
  });
  const onHashChange = () => {
    if (!root.isConnected) return;
    const key = location.hash.slice(1) || 'members';
    if (tabKeys.has(key) && key !== current) void selectTab(key, false);
  };
  window.addEventListener('hashchange', onHashChange);
  const summary = root.querySelector('#admin-upload-summary');
  function syncUploadSummary() {
    const progress = uploadPane.querySelector('#u-progress');
    const file = uploadPane.querySelector('#file')?.files?.[0];
    const batch = uploadPane.querySelector('[data-batch-list]')?.childElementCount;
    const single = progress && !progress.hidden ? uploadPane.querySelector('#u-phase')?.textContent : file ? '已选文件 · ' + file.name : '';
    const text = [single, batch ? uploadPane.querySelector('[data-batch-summary]')?.textContent : ''].filter(Boolean).join(' · ');
    if (summary.textContent !== text) summary.textContent = text;
  }
  const uploadWatch = new MutationObserver(syncUploadSummary);
  uploadWatch.observe(uploadPane, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  uploadPane.addEventListener('change', syncUploadSummary);
  const removed = new MutationObserver(() => {
    if (root.isConnected) return;
    window.removeEventListener('hashchange', onHashChange);
    uploadWatch.disconnect();
    removed.disconnect();
  });
  removed.observe(view, { childList: true });
  root.querySelector('#refresh').addEventListener('click', async () => {
    await reloadBoot();
    if (root.isConnected) {
      await draw();
      if (!uploadPane.hidden) uploadPane.dispatchEvent(new Event('upload-pane-shown'));
    }
  });
  paintCrumbs();

  async function draw(reuseMembers = false) {
    if (!root.isConnected) return;
    showPanes();
    if (reuseMembers && isDesk() && slot.firstElementChild?.hasAttribute('data-member-pane')) return;
    const pass = ++drawPass;
    const box = document.createElement('div');
    box.className = 'stack';
    slot.replaceChildren(box);
    if (slot.hidden) return;
    const tab = isDesk() ? 'members' : current;
    if (tab === 'members') box.setAttribute('data-member-pane', '');
    box.setAttribute('aria-busy', 'true');
    box.innerHTML = '<p class="dim" role="status">正在读取…</p>';
    try {
      await ({ videos: videosTab, keys: keysTab, members: membersTab, behavior: behaviorTab, requests: requestsTab, plans: plansTab, settings: settingsTab, audit: auditTab, trash: trashTab })[tab](box, pass);
      if (pass === drawPass && box.isConnected) labelTableCells(box);
    } catch (error) {
      if (pass !== drawPass || !box.isConnected) return;
      box.innerHTML = `<div class="note note-bad">${esc(error.message ?? '读取失败')}</div><button type="button" class="btn btn-sm">重试读取</button>`;
      box.querySelector('button').addEventListener('click', () => void draw());
    } finally {
      if (pass === drawPass && box.isConnected) box.setAttribute('aria-busy', 'false');
    }
  }

  // ---------------------------------------------------------------- behavior
  // 「用户行为」：谁在看哪几条、看到哪儿、屏幕上实际是哪一档、有没有人像在整片拖。
  // 判据（取走多少字节算拖片、几路算并发、一天发多少）只住在服务端那一道闸上，
  // 这一栏把它原样读回来画 —— 界面上抄第二份数字，改了闸屏幕上还写着旧的，这类错站内犯过。
  const BEHAVIOR_DAYS = [7, 30, 90];
  let behaviorDays = 30;
  let behaviorOnlyDownload = false;

  async function behaviorTab(box) {
    const data = await get('admin-behavior-board', { days: behaviorDays });
    const people = data.people ?? [];
    const totals = data.totals ?? {};
    const rules = data.rules ?? {};
    const labels = data.downloadLabels ?? {};
    const anon = data.anonymousFlagged ?? [];
    const events = data.events ?? [];
    const notes = data.dataNotes ?? {};
    const films = data.videos ?? [];
    const desk = data.caseDesk ?? { open: [], own: [], closed: [], thresholds: {} };
    // 案头一行一案：谁、撞了什么、判据那句活、最近一次、怎么处理。
    // 判据文字直接取闸门写进库里的那句（behavior.mjs 原样带上来），界面上不另写一份 ——
    // 抄一份的话改了阈值这里就会印一个不生效的数。
    const caseWho = (row) => (row.email
      ? `${row.note ? `${esc(row.note)} ` : ''}<span class="mono tiny dim">${esc(row.email)}</span>`
      : `没登录，IP 前缀 ${esc(row.ipPrefix || '未知')}`);
    const casePill = (row) => `<span class="pill ${row.severity === 'high' ? 'pill-bad' : (row.severity === 'mid' ? 'pill-warn' : '')}">${esc(row.label)}</span>`;
    const caseItem = (row) => `<li data-case="${esc(row.key)}" data-severity="${esc(row.severity)}" data-state="${esc(row.state)}">
      <div class="case-who mono tiny">${caseWho(row)} ${casePill(row)}${row.count > 1 ? ` <span class="tiny dim">共 ${row.count} 次</span>` : ''}${row.admin ? ' <span class="pill pill-bad">管理员号</span>' : ''}${row.tierRank ? ` <span class="pill">等级 ${row.tierRank}</span>` : ''}${row.disabledAt ? ' <span class="pill pill-bad">已停用</span>' : ''}</div>
      <span class="case-act">${row.state === 'closed'
        ? `<span class="pill ${row.ackStatus === 'done' ? 'pill-good' : ''}">${row.ackStatus === 'done' ? '已处理' : '已看过'}</span><span class="tiny dim">${esc(fmtDate(row.ackAt) ?? '')}</span>`
        : `<button class="chip" type="button" data-ack="${esc(row.key)}" data-status="seen">已看过</button><button class="chip" type="button" data-ack="${esc(row.key)}" data-status="done">已处理</button>`}</span>
      <div class="case-why tiny dim">${esc(row.detail) || '—'} · 最近 ${esc(fmtDate(row.lastAt) ?? '')}${row.state === 'reopened' ? ' · 结过一次，之后又撞了线' : ''}
        <details class="tiny"><summary>看证据</summary><ul>
          ${(row.videos ?? []).map((v) => `<li>${esc(v.title)} — ${v.times} 次</li>`).join('')}
          ${row.ipPrefix ? `<li>IP 前缀 ${esc(row.ipPrefix)}</li>` : ''}
          ${(row.devices ?? []).map((d) => `<li>设备 ${esc(d)}</li>`).join('')}
          <li>第一次 ${esc(fmtDate(row.firstAt) ?? '')}，最近一次 ${esc(fmtDate(row.lastAt) ?? '')}</li>
          ${row.note ? `<li>账号备注：${esc(row.note)}</li>` : ''}
          ${row.userId && row.email && !row.disabledAt ? `<li><button class="chip" type="button" data-disable="${esc(row.userId)}">停用这个号</button></li>` : ''}
        </ul></details></div>
    </li>`;
    // 「停用这个号」收在「看证据」里，不占案头那一行：它是要想一想才按的那个，
    // 而案头每一行的高度决定站长能不能一眼看完今天该处理谁。确认框照旧会弹。
    const caseTable = (rows) => `<ul class="case-list">${rows.map(caseItem).join('')}</ul>`;
    // 档位的中文说法只有一份，住在服务端（QUALITY_LABELS），界面照 key 取，不另写一遍。
    const qualityLabel = (rung) => rules.qualityLabels?.[rung] ?? rung;
    const noteRows = [
      ...(notes.staleProgress ?? []).map((row) => ({ ...row, verdict: '旧位置，不用改数据',
        action: '这条进度写于本片最近一次改动之前（换过内容、切成几条都会这样）。' })),
      ...(notes.durationWrong ?? []).map((row) => ({ ...row, verdict: '库里时长写错',
        action: '要重探真实时长再回写；后台目前没有改时长的入口，得在服务器上改。' })),
    ];
    // 这两个"95%"是两件不同的事：一个说"看到片尾几成才算看完"（进度 ÷ 片长），
    // 一个说"取走多少字节算拖片"（取走 ÷ 文件大小）。各读自己那个字段 —— 以前两句都印 grabShare，
    // 谁调拖片阈值就会把「看完」的口径一起改掉，而界面上看不出来。
    // 服务端没给这个数就印 ?：印一个兜底常数等于让站长把假值当生效值。
    const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '?');
    const mib = (value) => (Number.isFinite(value) ? `${Math.round(value / 1048576)} MiB` : '?');
    const watchedPct = pct(rules.watchedShare);
    const grabPct = pct(rules.grabShare);

    const flagText = (row) => {
      const parts = Object.entries(row.flags ?? {}).map(([action, count]) => `${labels[action] ?? action} ${count} 次`);
      return parts.length ? parts.join('、') : `${row.flagEvents} 次`;
    };
    const personRow = (row) => `<tr>
      <td class="tiny">${row.note ? `${esc(row.note)}<br>` : ''}<span class="mono tiny dim">${esc(row.email)}</span>${row.disabledAt ? ' <span class="pill pill-bad">已停用</span>' : ''}${row.tierRank ? ` <span class="pill">等级 ${row.tierRank}</span>` : ''}</td>
      <td class="num">${row.videosWatched} 条</td>
      <td class="num">${row.videosFinished} 条</td>
      <td class="num">${row.minutesWatched} 分钟</td>
      <td class="tiny">${esc(fmtDate(row.lastSeenAt) ?? '')}</td>
      <td class="tiny">${(row.renditions ?? []).map((size) => `<span class="pill">${esc(size)}</span>`).join(' ') || '—'}${row.qualityPicks ? ` <span class="pill">自己点过 ${row.qualityPicks} 次</span>` : ''}</td>
      <td class="tiny">${row.stallEvents
        ? `<span class="pill pill-warn">卡了 ${row.stallEvents} 阵</span><p class="tiny dim">${esc(row.stallNote ?? '')}</p>`
        : (totals.stallReported ? '没报卡顿' : '—')}</td>
      <td>${row.downloadSuspect
        ? `<span class="pill pill-bad">下载类：${esc(flagText(row))}</span>`
        : '<span class="pill pill-good">没有</span>'}
        ${(row.videos ?? []).length ? `<details class="tiny"><summary>看了哪几条</summary>
             <ul>${(row.videos ?? []).slice(0, 12).map((v) => `<li>${esc(v.title)} — 看到 ${fmtDuration(v.positionSeconds)}${v.durationSeconds ? `／库里片长 ${fmtDuration(v.durationSeconds)}${v.staleBeforeEdit ? '（这条进度早于本片最近一次改动，见下面那张表）' : v.durationLooksWrong ? '（这个时长不对，见下面那张表）' : v.finished ? '（看完）' : ''}` : ''}</li>`).join('')}</ul>
           </details>` : ''}</td>
    </tr>`;

    box.innerHTML = `
      ${data.caseDesk ? `<section class="panel stack">
        <div class="section-title"><h2>待处理的违规</h2>
          <p class="tiny dim">这一屏只列高风险的 ${desk.open.length} 件；不太要紧的（中、低风险）折在下面那一行，点开才看。
            它不看下面那个时间范围：只要没点「已看过／已处理」，就一直留着（最长 400 天）。
            站长自己的号和测试号单列在下面的「站长自己的号与测试号」，不算买家违规；这一屏不显示密码、密钥、激活码原文。</p></div>
        ${desk.open.length ? caseTable(desk.open)
          : '<div class="note">现在没有高风险的事。这只说明那几条最要紧的线一次都没被碰到 —— 没登录的流量分不清是爬虫、乱试的还是真买家，所以这一栏空着不等于站内安全。</div>'}
        ${(desk.minor?.length ?? 0) ? `<details class="tiny"><summary>不太要紧的 ${desk.minor.length} 件（取片被拦下、输错激活码、同一 IP 反复登录不成功这类：先看高风险的，有空再翻这里）</summary>
          ${caseTable(desk.minor)}</details>` : ''}
        ${(desk.thresholds?.shareNetblocks ?? 0) ? `<p class="tiny dim">现在这几条线画在这儿：同一个账号在 ${desk.thresholds.shareNetblocks} 个不同 IP 前缀上同时在线，就算多人在用；
          ${desk.thresholds.keyProbeWindowMinutes} 分钟内输错激活码 ${desk.thresholds.keyProbeMin} 次；同一个 IP 前缀 ${desk.thresholds.loginBruteWindowMinutes} 分钟内登录不成功 ${desk.thresholds.loginBruteMin} 次。
          取片那几条线在下面的「现在这几条线画在哪儿」。</p>` : ''}
        ${desk.own.length ? `<details class="tiny"><summary>站长自己的号与测试号 ${desk.own.length} 件（都是站长这边的号，照样列出来给人看，但不算买家违规）</summary>
          ${caseTable(desk.own)}</details>` : ''}
        ${desk.closed.length ? `<details class="tiny"><summary>已经标记过的 ${desk.closed.length} 件（「已看过」与「已处理」都收在这儿；同一类行为再撞一次线，会自己回到上面）</summary>
          ${caseTable(desk.closed)}</details>` : ''}
      </section>` : ''}

      <details class="panel stack" id="board-diag">
        <summary class="section-title"><h2>播放不流畅的记录</h2>
          <p class="tiny dim">按人反查谁在看哪几条、看到哪儿、屏幕上实际是哪一档、行为流水，以及拦人的那几条线画在哪儿。
            查线路和设备问题的时候再展开，平时不占屏。</p></summary>
        <div class="stack">
        <label class="tiny dim">时间范围
          <select id="behavior-days">${BEHAVIOR_DAYS.map((d) => `<option value="${d}"${d === behaviorDays ? ' selected' : ''}>最近 ${d} 天</option>`).join('')}</select>
        </label>
        <div class="grid">
          <div class="card"><p class="card-eyeline">这段时间活跃的人</p><p class="card-text">${totals.peopleActive ?? 0} 人</p></div>
          <div class="card"><p class="card-eyeline">被标注为下载类</p><p class="card-text">${(data.people ?? []).filter((p) => p.downloadSuspect).length} 人 · 共 ${totals.downloadEvents ?? 0} 次</p></div>
          <div class="card"><p class="card-eyeline">设备报过卡顿</p><p class="card-text">${totals.stallReported
            ? `${(data.people ?? []).filter((p) => (p.stallEvents ?? 0) > 0).length} 人 · 共 ${totals.stallEvents ?? 0} 批`
            : '还没收到设备上报'}</p></div>
          <div class="card"><p class="card-eyeline">没登录也记着网段</p><p class="card-text">${anon.length} 个网段</p></div>
          <div class="card"><p class="card-eyeline">读到的行</p><p class="card-text">进度 ${totals.watchRows ?? 0} · 行为 ${totals.auditRows ?? 0}</p></div>
        </div>
        ${totals.truncatedByCap
          ? '<div class="note note-warn">这段时间的记录已经取满一次的上限，下面列出的是最近的一部分，不是全部。</div>'
          : ''}
      </section>

      <section class="panel stack">
        <div class="section-title"><h2>现在这几条线画在哪儿</h2>
          <p class="tiny dim">这就是拦人的那一套判据本身，不是界面上另写的一份。</p></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>判据</th><th>现在的线</th></tr></thead>
          <tbody>
            <tr><td class="tiny">整片拖走怎么认</td>
              <td class="tiny">同一条片<b>去重后真正到手</b>的字节 ≥ ${grabPct}（来回拖进度条把同一段取两遍只算一次），且墙上时间不到片长的 ${pct(rules.grabTimeShare)}（差不多是快过 ${rules.grabTimeShare ? Math.round(1 / rules.grabTimeShare) : '?'} 倍速）；片要大于 ${mib(rules.grabMinBytes)} 才参与</td></tr>
            <tr><td class="tiny">认出来之后停多久</td>
              <td class="tiny">${rules.grabCooldownMinutes ?? '?'} 分钟自动解除${rules.grabBlocksPlayback ? '；这期间这一条连正常播放都不给' : ''}</td></tr>
            <tr><td class="tiny">一个账号同时开几路</td>
              <td class="tiny">${rules.streamMaxPerAccount ?? '?'} 路（${rules.streamWindowSeconds ?? '?'} 秒内还有取段请求算一路）；改这一项在「站点设置 → 一个账号同时能开几路完整播放」</td></tr>
            <tr><td class="tiny">一个窗口往外发多少</td>
              <td class="tiny">${((rules.throttleBytesPerWindow ?? 0) / 1073741824).toFixed(1)} GiB / ${rules.throttleWindowSeconds ?? '?'} 秒<br>
                <span class="dim">这一本按上面那个秒数滚动：一个窗口内发超了，下一条就不给字节，过完窗口重新计 —— <b>它不是"当天的额度"</b>，改小它只会让看片的人多一次 429。账记在服务进程内存里，重启一次归零，所以也拿它当不了审计。</span></td></tr>
            <tr><td class="tiny">同一个人短时间搬走半站</td>
              <td class="tiny">${rules.sweepWindowMinutes ?? '?'} 分钟内，有 ${rules.sweepMinFilms ?? '?'} 条片各自被取走 ≥ ${pct(rules.sweepFilmShare)}（也是去重后真正到手的数）—— 记一行「用户行为」。<br>
                <span class="dim">这一条只记不掐：一口气刷完八条课的真学员也会被它数到，要不要拦由你定。</span></td></tr>
            <tr><td class="tiny">进度最多能报到哪儿</td>
              <td class="tiny">片尾之后再过 ${rules.progressSlackSeconds ?? '?'} 秒就拒收；库里那条时长越界超过这个数的，后台不判「看完」，会在下面单独列出来问一句为什么</td></tr>
          </tbody>
        </table></div>
      </section>

      <section class="panel stack">
        <div class="section-title"><h2>按人看</h2>
          <p class="tiny dim">「看完」按看到 ${watchedPct} 以上算（这一条量的是进度位置 ÷ 片长，和上面那张表里"取走多少字节算拖片"是两件事，两个数各来自服务端自己那一条判据）；进度写得比这条现在的片长还远的，先问为什么（见最下面那张表），不判看完。每一行都能点开看他具体看了哪几条。<br>
            「累计」是把每条片看得**最远**的那个位置相加，不是他在站上花的时间：同一遍重看不重复计，切条之前留下的旧位置也照当时那条的长度算 —— 这一栏只用来看谁看得深。</p></div>
        ${people.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>账号</th><th>看了</th><th>看完</th><th>累计</th><th>最后活跃</th><th>屏幕上实际画质</th><th>这段时间卡过</th><th>下载类标注</th></tr></thead>
          <tbody>${people.map(personRow).join('')}</tbody>
        </table></div>` : '<p class="dim">这段时间没有任何观看或行为记录。</p>'}
      </section>

      ${films.length ? `<section class="panel stack">
        <div class="section-title"><h2>按片看</h2>
          <p class="tiny dim">哪条片在被整片拿、哪条片有人在卡、观众屏幕上实际是哪一档。
            「只有一档」不是漏打包 —— 源本来就不到 720p 的片子再压一档只会更糊，所以那种只发高清，界面上也不给切换。</p></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>哪条片</th><th>下载类</th><th>卡顿</th><th>屏幕上出现过</th><th>能切的档</th></tr></thead>
          <tbody>${films.map((row) => `<tr>
            <td class="tiny">${esc(row.title)}</td>
            <td class="tiny">${row.flagEvents ? `<span class="pill pill-bad">${row.flagEvents} 次${row.viewersFlagged ? ` · ${row.viewersFlagged} 人` : ''}</span>` : '—'}</td>
            <td class="tiny">${row.stallEvents ? `<span class="pill pill-warn">${row.stallEvents} 批</span>` : (totals.stallReported ? '没报卡顿' : '—')}</td>
            <td class="tiny">${(row.renditions ?? []).map((r) => `<span class="pill">${esc(r.size)}${r.count > 1 ? ` ×${r.count}` : ''}</span>`).join(' ') || '—'}</td>
            <td class="tiny">${row.rungs === null ? '<span class="pill pill-warn">档位查不到</span>'
              : row.rungs.length >= 2 ? `<span class="pill pill-good">${row.rungs.map((r) => esc(qualityLabel(r))).join(' + ')}</span>`
              : '<span class="dim">只有一档（没得降）</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}

      ${anon.length ? `<section class="panel stack">
        <div class="section-title"><h2>没登录的人（按网段）</h2>
          <p class="tiny dim">手机流量是运营商级 NAT，一个前缀后面可能是一整片人，所以这一栏只用来发现异常，不能拿它掐人。</p></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>网段</th><th>撞了什么</th><th>次数</th><th>最后一次</th></tr></thead>
          <tbody>${anon.map((row) => `<tr>
            <td class="mono tiny">${esc(row.ipPrefix)}</td>
            <td class="tiny">${Object.entries(row.flags ?? {}).map(([action, count]) => `<span class="pill pill-bad">${esc(labels[action] ?? action)} ${count}</span>`).join(' ')}</td>
            <td class="num">${row.flagEvents} 次拦停${row.stallEvents ? ` · ${row.stallEvents} 批卡顿` : ''}</td>
            <td class="tiny">${esc(fmtDate(row.lastSeenAt) ?? '')}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}

      ${noteRows.length ? `<section class="panel stack">
        <div class="section-title"><h2>看到的位置比这条记的片长还长</h2>
          <p class="tiny dim">进度越界有两种原因，动作相反，所以这里分开写：进度早于本片最近一次改动的，是他看的本来就是旧版本（不用改数据，但那条不能算「看完」）；
            改动之后还越界的，才是库里那个时长写错了 —— 拖片判定和「看完」都靠这个数。</p></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>账号</th><th>哪条片</th><th>看到哪儿</th><th>库里写着</th><th>为什么</th></tr></thead>
          <tbody>${noteRows.slice(0, 10).map((row) => `<tr>
            <td class="mono tiny">${esc(row.email)}</td><td class="tiny">${esc(row.title)}</td>
            <td class="num tiny">${fmtDuration(row.positionSeconds)}</td><td class="num tiny">${fmtDuration(row.storedDurationSeconds)}</td>
            <td class="tiny"><span class="pill ${row.verdict === '库里时长写错' ? 'pill-bad' : 'pill-warn'}">${esc(row.verdict)}</span>
              <p class="tiny dim">${esc(row.action)}<br>进度写于 ${esc(fmtDate(row.progressAt) ?? '')}，这片改于 ${esc(fmtDate(row.videoEditedAt) ?? '')}</p></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}

      <section class="panel stack">
        <div class="section-title"><h2>行为明细</h2>
          <p class="tiny dim">只有被闸门拦下的动作和观众自己点的档位会进这张表；正常看片不产生这里的行为行（那些在「会员名单」的观看记录里）。这张表最多列最近 80 条。</p></div>
        ${events.length ? `<div class="row" style="gap:10px;align-items:center">
            <button class="chip" type="button" id="behavior-only-download" aria-pressed="false">只看下载类</button>
            <span class="tiny dim" id="behavior-shown-count"></span></div>
          <div class="table-wrap"><table class="table" id="behavior-events">
          <thead><tr><th>时间</th><th>类别</th><th>做了什么</th><th>详情</th><th>归属</th></tr></thead>
          <tbody>${events.map((row) => `<tr data-kind="${esc(row.kind)}">
            <td class="tiny">${esc(fmtDate(row.at) ?? '')}</td>
            <td>${row.kind === 'download' ? '<span class="pill pill-bad">下载类</span>' : (row.kind === 'stall' ? '<span class="pill pill-warn">卡顿</span>' : '<span class="pill">观看</span>')}</td>
            <td class="tiny">${esc(row.label)}</td>
            <td class="tiny">${esc(row.detail)}</td>
            <td class="tiny">${row.who === 'anon' ? `匿名 ${esc(row.ipPrefix ?? '')}` : '登录账号'}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<p class="dim">这段时间没有拦下任何动作。</p>'}
      </section>
        </div>
      </details>
    `;

    // 案头结案只记一笔处理结果（服务端写进行签名的 audit），不动权益、不改数据。
    // 两颗钮是两个意思：「已看过」=我知道了，再撞还会回来；「已处理」=我已经动作过了。
    // 库里记的就是点的那一颗（ackStatus），已处理那一栏印的也是它 —— 不能让界面写着"已处理"而库里那条其实只是"看过"。
    for (const button of box.querySelectorAll('[data-ack]')) {
      button.addEventListener('click', async () => {
        const status = button.dataset.status === 'done' ? 'done' : 'seen';
        button.disabled = true;
        try {
          await post('admin-case-ack', { key: button.dataset.ack, status });
          toast(status === 'done'
            ? '记下了：这一件标成已处理。同一类行为再撞一次，它还是会回到待处理。'
            : '记下了：这一件已看过。同一类行为再撞一次，它会自己回到待处理。');
          await behaviorTab(box);
        } catch (error) {
          toast(error.message, 'bad');
          button.disabled = false;
        }
      });
    }
    for (const button of box.querySelectorAll('[data-disable]')) {
      button.addEventListener('click', async () => {
        if (!confirm('停用这个账号？它会立刻登不出，正在播的完整版也会断。会员记录保留，恢复后继续有效。')) return;
        button.disabled = true;
        try {
          await post('admin-user-disable', { userId: button.dataset.disable });
          toast('账号已停用，它的设备会话同时作废。');
          await behaviorTab(box);
        } catch (error) {
          toast(error.message, 'bad');
          button.disabled = false;
        }
      });
    }

    box.querySelector('#behavior-days')?.addEventListener('change', (event) => {
      behaviorDays = Number(event.target.value) || 30;
      void behaviorTab(box);
    });
    // 站长要盯的是"有没有人在整片拿"，而这一栏里绝大多数行是档位点击和画质上报。
    // 过滤只在这一次读回来的行里挑，所以计数要说"这 N 条里的 M 条"，不能让人以为整张表只有这些。
    const applyEventFilter = () => {
      const rows = [...box.querySelectorAll('#behavior-events tbody tr')];
      if (!rows.length) return;
      const button = box.querySelector('#behavior-only-download');
      const note = box.querySelector('#behavior-shown-count');
      let shown = 0;
      for (const tr of rows) {
        const hide = behaviorOnlyDownload && tr.dataset.kind !== 'download';
        tr.style.display = hide ? 'none' : '';
        if (!hide) shown += 1;
      }
      if (button) {
        button.classList.toggle('is-on', behaviorOnlyDownload);
        button.setAttribute('aria-pressed', String(behaviorOnlyDownload));
      }
      if (note) note.textContent = behaviorOnlyDownload ? `${rows.length} 条里的 ${shown} 条` : `共 ${rows.length} 条`;
    };
    box.querySelector('#behavior-only-download')?.addEventListener('click', () => {
      behaviorOnlyDownload = !behaviorOnlyDownload;
      applyEventFilter();
    });
    applyEventFilter();
  }

  // ------------------------------------------------------------------ upload
  async function uploadTab(box) {
    const limits = state.boot.limits ?? { maxVideoBytes: 1024 * 1024 * 1024 };
    box.innerHTML = `
      <div id="batch-upload-host"></div>
      <div id="processing-status-host"></div>
      <div class="admin-cols">
        <section class="panel stack">
          <div class="section-title">
            <h2>上传一条视频</h2>
            <p class="tiny dim">浏览器按 ${fmtBytes(CHUNK_SIZE)} 的数据块加密后逐块上传，服务端只存密文。</p>
          </div>
          <label class="drop" id="drop">
            <input class="sr-only" id="file" type="file" accept="video/*,.mp4,.mov,.webm" style="position:absolute;left:-9999px" />
            <p id="drop-text">点击选择，或把视频拖到这里</p>
            <p class="tiny dim" id="drop-hint">支持 MP4 / WebM / MOV，单个文件不超过 ${fmtBytes(limits.maxVideoBytes)}</p>
          </label>
          <p class="note note-warn" id="env-note" hidden>你现在用的是微信或 QQ 内置浏览器：它常常读不出视频时长，也可能不让你选本地文件。请点右上角「···」→「在浏览器打开」，iPhone 用 Safari、安卓用 Chrome 或 Edge 再上传。</p>
          <p class="note note-bad" id="crypto-note" hidden></p>
          <div id="probe" class="stack"></div>
          <form class="stack" id="upload-form">
            <div class="field"><label for="u-title">教学影像名称（显示在目录和水印旁）</label>
              <input class="input" id="u-title" name="title" maxlength="120" required /></div>
            <div class="field"><label for="u-desc">一句话说明（选填）</label>
              <input class="input" id="u-desc" name="description" maxlength="200" /></div>
            <div class="row" style="gap:12px;align-items:flex-end">
              <div class="field" style="flex:1 1 150px"><label for="u-duration">时长（秒）</label>
                <input class="input num" id="u-duration" name="durationSeconds" inputmode="numeric" />
                <p class="tiny" id="u-ratio-note" style="color:var(--warn);margin-top:4px"></p></div>
              <div class="field" style="flex:1 1 150px"><label for="u-preview">免费试看（秒，0 表示不试看）</label>
                <input class="input num" id="u-preview" name="previewSeconds" inputmode="numeric" value="${esc(state.boot.settings.default_preview_seconds ?? 300)}" />
                <p class="tiny dim" style="margin-top:4px">试看提供的是教学影像前若干秒对应的字节。若试看秒数不小于总时长，站点最多提供半个文件，不会免费开放完整教学影像。</p></div>
              <div class="field" style="flex:1 1 170px"><label for="u-tier">需要的会员等级</label>
                <select class="input" id="u-tier" name="tierRank"></select>
                <p class="tiny dim" id="u-tier-legend" style="margin-top:4px"></p></div>
              <div class="field" style="flex:1 1 150px"><label for="u-kind">这是哪一类</label>
                <select class="input" id="u-kind" name="kind">
                  <option value="live">真实拳击</option>
                  <option value="anime">动画拳击</option>
                </select></div>
            </div>
            <div class="field">
              <label for="u-poster-at">从视频画面选封面（拖动时间条预览）</label>
              <div class="cover-row">
                <div class="poster cover-thumb" id="u-cover"><span class="poster-code">封面</span></div>
                <div class="stack" style="gap:8px">
                  <input id="u-poster-at" aria-label="选择封面画面秒数" type="range" min="0" max="120" step="1" value="3" disabled />
                  <p class="tiny dim" id="u-cover-note">选好视频后自动取第 3 秒的一帧，拖时间条换一帧。</p>
                  <label class="tiny dim" for="u-poster">不满意可以自己传一张（JPG/PNG/WebP，不超过 2 MB）</label>
                  <input class="input" id="u-poster" type="file" accept="image/jpeg,image/png,image/webp" />
                </div>
              </div>
            </div>
            <div class="row">
              <button class="btn btn-primary" type="submit" id="u-go" disabled>开始加密并上传</button>
              <button class="btn btn-ghost" type="button" id="u-abort" hidden>中止这次上传</button>
            </div>
          </form>
          <div id="u-progress" class="stack" hidden>
            <ol class="flow" id="u-steps" aria-label="上传走到哪一步">
              <li data-step="start">建档</li>
              <li data-step="parts">传数据块</li>
              <li data-step="seal">校验登记</li>
            </ol>
            <div class="spread tiny dim"><span id="u-phase">准备中</span><span class="num" id="u-count">0 / 0 数据块</span></div>
            <div class="progress-line"><i id="u-bar" style="width:0%"></i></div>
          </div>
          <div id="u-result"></div>
        </section>
        <aside class="panel stack">
          <div class="section-title"><h2>上传检查</h2></div>
          <p class="tiny dim">时长能读就自动填；读不出（如 HEVC 的 MOV）要手工填秒数，否则算不出试看位置。</p>
          <p class="tiny dim">faststart 决定未登录试看能否稳定起播，检测不到会提示重新导出。</p>
          <p class="tiny dim">上传后保存为草稿，在教学影像管理中点击发布后，观众才能查看。</p>
        </aside>
      </div>`;

    const serverPicker = document.createElement('section'); serverPicker.hidden = true;
    box.querySelector('#processing-status-host').after(serverPicker);
    mountProcessingStatus(box.querySelector('#processing-status-host'), { confirmationScope: state.boot.viewer.id, onGoLibrary: () => focusLibraryTab(), onPickCover: videoId => {
      serverPicker.hidden = false;
      mountServerCoverPicker(serverPicker, { videoId, uploadCover, onSelected: reloadBoot });
      serverPicker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } });
    const tierSelect = document.getElementById('u-tier');
    const intendedForm = box.querySelector('#upload-form');
    const plans = (await get('admin-plans')).plans ?? [];
    if (!intendedForm.isConnected || !box.contains(intendedForm)) return;
    tierSelect.innerHTML = tierOptions(plans, 1);
    document.getElementById('u-tier-legend').textContent = tierLegend(plans);
    if (!box.isConnected) return;
    mountUploadQueue(box.querySelector('#batch-upload-host'), {
      post, plans, defaultPreview: state.boot.settings.default_preview_seconds ?? 300,
      maxBytes: limits.maxVideoBytes, probeDuration, probeFaststart,
      captureCover: (file, duration, signal) => captureFrameAt(file, Math.min(2, Math.max(.1, duration - .2)), 8000, signal),
      uploadCover: (videoId, source, signal) => uploadCover(videoId, source, signal, { retryProcessing: false }),
      serverCovers: Boolean(state.boot?.processingEnabled), isWriteOutcomeUnknown, onChanged: reloadBoot,
      // 批量那一行传完之后要能做的两件事，都用单条那一路已有的同一份实现：
      // 候选帧面板是 cover-picker，两档进度只有「视频与封面处理」那一处来源，这里只给入口。
      onPickCover: (videoId, panel) => mountServerCoverPicker(panel, { videoId, uploadCover, onSelected: reloadBoot }),
      onWatchProgress: (videoId) => {
        const line = document.querySelector(`[data-video-id="${videoId}"]`);
        (line ?? document.getElementById('processing-status-host'))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    });

    let file = null;
    let selectionVersion = 0;
    let uploadBusy = false;
    let poster = null;
    // 取帧这件事在手机上会比"选好文件"慢十几秒（大文件要一路读到第 44 秒才画得出那一帧）。
    // 上传按钮在时长读出来那一刻就解锁了，所以站长完全可能按下去的时候帧还在解 ——
    // 那一趟视频传完了、封面没挂上，而他看到的是同一个面板上根本没有这句话。
    // 这两个变量就是为了让提交那一步能等它解完。
    let coverBusy = false;
    let coverUserSelected = false;
    let coverController = null;
    let coverJob = Promise.resolve();
    let coverSeq = 0;
    let coverUrl = null;
    let probedFaststart = null;
    const dropText = document.getElementById('drop-text');
    const probeBox = document.getElementById('probe');

    function coverNote(text, bad) {
      const note = document.getElementById('u-cover-note');
      note.textContent = text;
      note.classList.toggle('is-bad', Boolean(bad));
    }

    function showCover(blobOrFile, caption) {
      const box = document.getElementById('u-cover');
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      coverUrl = URL.createObjectURL(blobOrFile);
      box.innerHTML = '';
      const img = document.createElement('img');
      img.src = coverUrl;
      img.alt = '';
      box.append(img);
      coverNote(caption, false);
    }

    async function pickCover() {
      if (!file) return;
      coverController?.abort();
      coverController = new AbortController();
      const mine = ++coverSeq;
      coverBusy = true;
      try {
        const slider = document.getElementById('u-poster-at');
        const seconds = Number(slider.value) || 0;
        const box = document.getElementById('u-cover');
        box.innerHTML = '<span class="poster-code"><span class="spinner"></span></span>';
        coverNote(`正在取第 ${seconds} 秒的一帧…`, false);
        const shot = { ...await captureFrameAt(file, seconds, 30000, coverController.signal), at: seconds };
        // Two things have to both still be true before painting: the owner has not dragged
        // to another second, and nothing has cancelled this job (choosing his own picture
        // does that). Painting a late frame over the file he just picked would silently
        // throw away what he decided.
        if (mine !== coverSeq || Number(slider.value) !== seconds) return;
        if (!shot.blob) {
          poster = null;
          box.innerHTML = '<span class="poster-code">没拿到画面</span>';
          coverNote(coverFailureText(shot.reason), !state.boot?.processingEnabled);
          return;
        }
        poster = new File([shot.blob], 'cover.jpg', { type: 'image/jpeg' });
        // 退到开头那一眼取成功时必须说出来：不然时间条停在第 44 秒、图上却是第 2 秒的画面，
        // 他下一次拖回去会以为这个控件坏了。
        showCover(poster, `封面：第 ${shot.at} 秒的一帧，${fmtBytes(shot.blob.size)}。拖时间条换一帧。`
          + (shot.at === seconds ? '' : `（第 ${seconds} 秒那一帧没读到，先用了开头这帧。）`));
      } finally {
        // 只有最新那一次解帧才算"还在解"：拖过时间条会有旧的那次还在收尾，
        // 让它把标记清掉的话，提交时就又不再等了。
        if (mine === coverSeq) coverBusy = false;
      }
    }

    // 这一条上传的封面走到哪一步：attached=桶里有了，blob=手上还捏着取到的那一帧，
    // reason=给站长看的那句话。上传结果面板和重试按钮都读这一个对象。
    let coverState = { attached: false, reason: '', blob: null };
    let coverTimer = null;
    document.getElementById('u-poster-at').addEventListener('input', () => {
      window.clearTimeout(coverTimer);
      coverSeq++; coverController?.abort(); poster = null; coverUserSelected = true;
      coverTimer = window.setTimeout(() => { coverTimer = null; coverJob = pickCover(); }, 260);
    });

    const syncGo = () => {
      // The button used to unlock only from a successful probe. Phone browsers (and WeChat's
      // webview especially) often cannot read a local video's duration, and the page then told
      // the owner to type it — with no listener on that field, so it never unlocked.
      const typed = Number(document.getElementById('u-duration').value);
      document.getElementById('u-go').disabled = !(file && Number.isFinite(typed) && typed > 0);
      const preview = Number(document.getElementById('u-preview').value) || 0;
      const ratio = document.getElementById('u-ratio-note');
      ratio.textContent = file && typed > 0 && preview > 0 && preview / typed > 0.5
        ? `注意：试看 ${preview} 秒占教学影像时长 ${Math.round((preview / typed) * 100)}%。时长填小会免费开放过多内容，请核对教学影像的实际秒数。`
        : '';
      const note = document.getElementById('env-note');
      if (note && file) note.hidden = !/MicroMessenger|QQ\/|wechat/i.test(navigator.userAgent);
    };

    async function adopt(next) {
      if (uploadBusy || session) return toast('请先继续或中止当前上传，再切换文件。', 'warn');
      const version = ++selectionVersion;
      window.clearTimeout(coverTimer); coverTimer = null; coverUserSelected = false;
      coverSeq += 1;
      coverController?.abort();
      coverBusy = false;
      file = next;
      poster = null;
      coverState = { attached: false, reason: '', blob: null };
      probedFaststart = null;
      // A different file invalidates any half-finished upload: its chunks, its data key and
      // its draft row all belong to the file that was chosen before.
      session = null;
      cipher = null;
      resumeFrom = null;
      chunkTask = null;
      const slider = document.getElementById('u-poster-at');
      if (!file) {
        slider.disabled = true;
        document.getElementById('u-cover').innerHTML = '<span class="poster-code">封面</span>';
        coverNote('选好视频后自动取第 3 秒的一帧，拖时间条换一帧。', false);
        return;
      }
      dropText.textContent = file.name;
      // Show the embedded-browser warning immediately: the probe below can take up to 20
      // seconds, and a phone owner should not sit watching a spinner first.
      syncGo();
      document.getElementById('drop-hint').textContent = `${fmtBytes(file.size)} · ${file.type || '未知类型'} · 共 ${chunkCount(file.size)} 个数据块`;
      probeBox.innerHTML = '<p class="tiny dim"><span class="spinner"></span> 正在读取时长和 MP4 结构…</p>';
      const duration = await probeDuration(file);
      if (version !== selectionVersion || !box.isConnected) return;
      const faststart = /mp4|mov|quicktime/i.test(file.type) ? await probeFaststart(file) : null;
      if (version !== selectionVersion || !box.isConnected) return;
      probedFaststart = faststart;
      document.getElementById('u-duration').value = duration ?? '';
      probeBox.innerHTML = `<div class="note ${duration ? '' : 'note-warn'}">时长：${duration ? fmtDuration(duration) : '浏览器读不出来。直接在下面「时长（秒）」里填数字，填好就能上传。'}</div>`
        + (faststart === null ? '' : `<div class="note ${faststart ? '' : 'note-warn'}">faststart：${faststart ? 'moov 在 mdat 之前，试看和拖动都正常' : 'moov 在文件末尾，未登录试看可能无法起播。建议在导出时勾选「Web 优化 / faststart」后重新上传。'}</div>`);
      syncGo();
      if (!document.getElementById('u-title').value) {
        document.getElementById('u-title').value = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120);
      }
      slider.max = String(Math.max(1, (duration ?? 120) - 1));
      slider.value = String(defaultCoverSecond(duration));
      slider.disabled = false;
      // 不 await：长片解一帧要十几秒，上传按钮不该因此一直灰着（时长读出来了就该能传）。
      // 真按下的时候提交那一步会等它，见 upload-form 的 submit。
      coverJob = pickCover();
    }

    document.getElementById('file').addEventListener('change', (event) => void adopt(event.target.files[0] ?? null));
    document.getElementById('u-duration').addEventListener('input', syncGo);
    document.getElementById('u-preview').addEventListener('input', syncGo);

    // Chunk encryption needs WebCrypto, which the browser withholds whenever the page is not
    // a secure context — some in-app browsers proxy the page in a way that loses it. Saying so
    // when the panel opens beats a submit button that appears to do nothing.
    const cryptoProblem = !window.isSecureContext
      ? '这个页面不是安全上下文（不是 https，或被内嵌浏览器代理改写了），浏览器因此不提供网页加密能力。请用系统浏览器打开后台再上传。'
      : (!crypto?.subtle
        ? '这个浏览器缺少 WebCrypto（crypto.subtle），无法在手机上加密数据块。iPhone 用 Safari、安卓用 Chrome 或 Edge 打开后台再上传。'
        : null);
    if (cryptoProblem) {
      const note = document.getElementById('crypto-note');
      note.textContent = cryptoProblem;
      note.hidden = false;
    }
    document.getElementById('u-poster').addEventListener('change', (event) => {
      const picked = event.target.files[0] ?? null;
      if (!picked) return;
      if (picked.size > MAX_POSTER_BYTES) {
        poster = null;
        toast('这张封面超过 2 MB，请先压缩再选。', 'warn');
        return;
      }
      // 他既然自己选了图，正在解的那一帧就必须作废：晚到的画面会把刚选的这张盖掉，
      // 而屏幕上只会闪过一句"用的是你自己传的那张"，看不出被换了。
      window.clearTimeout(coverTimer); coverTimer = null; coverUserSelected = true;
      coverSeq += 1;
      coverBusy = false;
      coverController?.abort();
      poster = picked;
      showCover(picked, `封面：用的是你自己传的那张，${fmtBytes(picked.size)}。想换回视频截图就拖时间条。`);
    });
    const drop = document.getElementById('drop');
    drop.addEventListener('dragover', (event) => event.preventDefault());
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      void adopt(event.dataTransfer.files[0] ?? null);
    });

    let session = null;
    let cancelled = false;
    let cipher = null;
    let totalChunks = 0;
    // Where a failed write stopped, so a film that dies at chunk 237 does not have to
    // encrypt and re-send the first 236 MiB.
    let resumeFrom = null;
    let chunkTask = null;
    let uploadController = null;
    let activeUpload = Promise.resolve();
    const uploadForm = box.querySelector('#upload-form');
    const leaveUpload = () => {
      if (uploadForm.isConnected) return;
      cancelled = true;
      coverSeq += 1;
      uploadController?.abort();
      coverController?.abort();
      window.clearTimeout(coverTimer); coverTimer = null;
      uploadObserver.disconnect();
      window.removeEventListener('pagehide', hideUpload);
      void activeUpload.then(async () => {
        if (session?.videoId) await post('admin-upload-abort', { videoId: session.videoId });
      }).catch(() => {});
    };
    const hideUpload = () => { cancelled = true; uploadController?.abort(); coverController?.abort(); };
    const uploadObserver = new MutationObserver(leaveUpload);
    uploadObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('pagehide', hideUpload, { once: true });

    // 光看"第 3 / 14 分片"说不清整件事还剩几步，所以把阶段摆出来：走完的打勾、
    // 正在做的亮着、卡住的那颗标红。
    const STEP_ORDER = ['start', 'parts', 'seal'];
    let stepNow = null;
    function setStep(key) {
      stepNow = key;
      const list = document.getElementById('u-steps');
      if (!list) return;
      const at = key === null ? STEP_ORDER.length : STEP_ORDER.indexOf(key);
      for (const li of list.children) {
        const i = STEP_ORDER.indexOf(li.dataset.step);
        li.classList.toggle('is-done', i < at);
        li.classList.toggle('is-now', i === at);
        li.classList.remove('is-bad');
        if (i === at) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      }
    }
    function failStep() {
      const li = document.querySelector(`#u-steps [data-step="${stepNow ?? 'none'}"]`);
      if (!li) return;
      li.classList.remove('is-now');
      li.classList.add('is-bad');
    }

    // The server hands out a batch of write addresses and names the next chunk itself.
    // Walking by that `next` is the fix for the client stepping by 50 while the server
    // returned 100: most chunks were requested and written a second time.
    async function streamChunks(videoId, from) {
      const bar = document.getElementById('u-bar');
      const phase = document.getElementById('u-phase');
      const count = document.getElementById('u-count');
      setStep('parts');
      if (cancelled) throw new DOMException('已取消', 'AbortError');
      chunkTask ??= createChunkUpload({ file, cipher, videoId, totalChunks, post, onProgress: value => {
        if (cancelled || !uploadForm.isConnected) return;
        phase.textContent = '并行加密并上传数据块';
        bar.style.width = `${Math.round(value.bytes / value.size * 95)}%`;
        count.textContent = `${value.completed} / ${value.total} 数据块 · ${fmtBytes(value.bytes)} / ${fmtBytes(value.size)}`;
      } });
      try { await chunkTask.run({ signal: uploadController.signal, concurrency: 2 }); }
      finally { resumeFrom = chunkTask.firstMissing(); }
    }

    async function finishUpload(videoId, form) {
      // 结果面板要说的是"这一条的封面走到哪一步"，不是"刚才有没有抛过错"：
      // 压根没取到画面（没有图可传）和图没写进去（有图但失败了）是两件事，
      // 以前只有后者会被说出来，于是传完发现片库是空的，人却不知道是哪一步没做。
      const cover = coverState;
      const bar = document.getElementById('u-bar');
      const phase = document.getElementById('u-phase');
      setStep('seal');
      phase.textContent = '校验密文并登记';
      document.getElementById('u-abort').disabled = true;
      // The probe result, not the MIME type: every MP4 would otherwise be
      // recorded as faststart and the 片库 "尾部 moov" warning could never fire.
      const done = await post('admin-upload-complete', { videoId, cipher, faststart: probedFaststart === true });
      document.dispatchEvent(new Event('boxvault-uploaded'));
      bar.style.width = '100%';
      phase.textContent = '完成';
      setStep(null);
      // 登记成功后整块退役：一条停在 100% 的进度条看起来像"这次还没完"，
      // 而下面紧接着就是封面候选帧和处理状态，两块都在说这件事（站长 2026-10-17 要点名收掉）。
      document.getElementById('u-progress').hidden = true;
      document.getElementById('u-abort').hidden = true;
      document.getElementById('u-result').innerHTML = `
          <div class="note">已登记为草稿（密文 ${fmtBytes(done.encSize)}）。
            <a href="/admin" data-link id="go-videos" style="color:var(--accent)">去教学影像管理发布</a></div>
          ${cover.attached ? '' : `<div class="note note-warn">封面还没挂上：${esc(cover.reason)}
            ${cover.blob ? '<button class="btn btn-sm" type="button" id="u-cover-retry">重试刚才那一帧</button>' : ''}
            教学影像管理这一行的封面格里有「补封面」，选一张图就行，不用重传这条教学影像。</div>`}`;
      document.getElementById('u-cover-retry')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        if (!cover.blob) {
          button.disabled = false;
          return;
        }
        try {
          await uploadCover(videoId, cover.blob);
          coverState = { attached: true, reason: '', blob: cover.blob };
          button.replaceWith(document.createTextNode(' 封面已挂上。'));
        } catch (error) {
          button.disabled = false;
          toast(error.message ?? '封面还是没挂上，可以稍后再试。', 'bad');
        }
      });
      document.getElementById('go-videos')?.addEventListener('click', (event) => {
        event.preventDefault();
        focusLibraryTab();
      });
      if (state.boot?.processingEnabled) {
        const candidates = document.createElement('section');
        document.getElementById('u-result').append(candidates);
        mountServerCoverPicker(candidates, { videoId, uploadCover, onSelected: reloadBoot });
      }
      form.reset();
      document.getElementById('u-preview').value = String(state.boot.settings.default_preview_seconds ?? 300);
      document.getElementById('drop-text').textContent = '点击选择，或把视频拖到这里';
      document.getElementById('probe').innerHTML = '';
      file = null;
      poster = null;
      session = null;
      cipher = null;
      await reloadBoot();
      chunkTask = null;
    }

    async function attachSelectedCover(videoId) {
      if (coverTimer !== null) { window.clearTimeout(coverTimer); coverTimer = null; coverJob = pickCover(); }
      if (coverBusy && state.boot?.processingEnabled && !coverUserSelected) {
        coverSeq++; coverController?.abort(); coverBusy = false;
      } else if (coverBusy) await coverJob;
      if (cancelled || !uploadForm.isConnected) throw new DOMException('已取消', 'AbortError');
      if (coverState.attached && coverState.blob === poster) return;
      coverState = { attached: false, reason: state.boot?.processingEnabled ? '上传完成后可在下方选择服务器提取的视频画面' : '浏览器未生成预览，请手选封面', blob: null };
      if (!poster) return;
      coverState = { attached: false, reason: '封面没写进去', blob: poster };
      try {
        await uploadCover(videoId, poster, uploadController.signal, { retryProcessing: false });
        coverState = { attached: true, reason: '', blob: poster };
      } catch (error) {
        if (cancelled) throw error;
        coverState = { attached: false, reason: error.message ?? '封面没写进去', blob: poster };
      }
    }

    document.getElementById('u-abort').addEventListener('click', async () => {
      cancelled = true;
      uploadController?.abort();
      coverController?.abort();
      await activeUpload;
      if (session) {
        try {
          await post('admin-upload-abort', { videoId: session.videoId });
          toast('这次上传已中止，数据块已清理。');
        } catch (error) {
          toast(error.message, 'bad');
          return;
        }
      }
      document.getElementById('u-abort').hidden = true;
      document.getElementById('u-go').disabled = false;
      session = null; cipher = null; chunkTask = null; resumeFrom = null;
      uploadBusy = false;
    });

    document.getElementById('upload-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (uploadBusy || session) return toast('当前上传已有会话，请先继续、中止，或到教学影像管理核对结果。', 'warn');
      if (!file) return toast('请先选择视频文件。', 'warn');
      // `currentTarget` is nulled as soon as this handler yields, so the node has to
      // be held here — the reset at the end of a multi-minute upload runs long after.
      const form = event.currentTarget;
      const fields = Object.fromEntries(new FormData(form));
      const duration = Number(fields.durationSeconds);
      if (!Number.isSafeInteger(duration) || duration <= 0) return toast('请填写有效时长（秒）。', 'bad');
      const button = document.getElementById('u-go');
      button.disabled = true;
      uploadBusy = true;
      uploadController = new AbortController();
      // 上一次中止留下的标记必须在这里清掉，否则按过一次「中止」之后，
      // 这个页面上每一次重新提交都会在第一个分片前就报"已取消"。
      cancelled = false;
      document.getElementById('u-progress').hidden = false;
      document.getElementById('u-abort').hidden = false;
      document.getElementById('u-abort').disabled = false;
      const phase = document.getElementById('u-phase');
      activeUpload = (async () => {
      try {
        // Inside the try on purpose: anything thrown here used to leave the button disabled
        // with no message, which reads as "手机上传点了没反应".
        // 手机上这一刻那一帧很可能还在解（419 MB 的片子要一路读到第 44 秒才画得出来）。
        // 不等它，视频传完封面就没了 —— 这是"上传完取不到封面"最常见的一条路，
        // 而且屏幕上一句提示都没有，人只能到片库才发现那一格是空的。
        cipher = createCipher(CHUNK_SIZE);
        setStep('start');
        phase.textContent = '申请上传会话';
        const started = await post('admin-upload-start', {
          title: fields.title, description: fields.description ?? '', contentType: file.type,
          plainSize: file.size, durationSeconds: duration,
          previewSeconds: Number(fields.previewSeconds ?? 0), tierRank: Number(fields.tierRank),
          // The category is chosen at upload because it is what the buyer is picking between;
          // guessing it from the title would put anime drills in the live box and vice versa.
          kind: fields.kind === 'anime' ? 'anime' : 'live',
        });
        session = { videoId: started.videoId };
        if (cancelled || !uploadForm.isConnected) throw new DOMException('已取消', 'AbortError');
        // The server counts the chunks; the client only displays that number.
        totalChunks = Number(started.chunkTotal) || chunkCount(file.size);
        await streamChunks(started.videoId, 0);
        phase.textContent = '数据已传完，确认封面';
        await attachSelectedCover(started.videoId);
        await finishUpload(started.videoId, form);
      } catch (error) {
        if (cancelled || !uploadForm.isConnected) return;
        failStep();
        phase.textContent = '这次上传没有完成';
        const restartAt = resumeFrom;
        let note = `<div class="note note-bad">${esc(readableError(error, '上传失败'))}`;
        if (session) {
          note += '<br>这条草稿还没有发布，观众看不到它。';
          note += restartAt === null
            ? '可以直接重新提交一次上传。'
            : `前 ${restartAt} 个数据块已经写好，不用从头再来。`;
        }
        note += '</div>';
        if (session && restartAt !== null) {
          note += `<button class="btn btn-sm" type="button" id="u-resume">从第 ${restartAt + 1} 数据块继续</button>`;
        }
        document.getElementById('u-result').innerHTML = note;
        document.getElementById('u-resume')?.addEventListener('click', async (event) => {
          const retry = event.currentTarget;
          const target = session?.videoId ?? null;
          if (!target || file === null || cipher === null) {
            retry.disabled = true;
            return toast('文件已经换过了，请重新选文件整次上传。', 'warn');
          }
          retry.disabled = true;
          cancelled = false;
          uploadBusy = true;
          uploadController = new AbortController();
          document.getElementById('u-progress').hidden = false;
          document.getElementById('u-abort').hidden = false;
          document.getElementById('u-abort').disabled = false;
          activeUpload = (async () => {
          try {
            // resumeFrom is read live: if this attempt fails later, the next press has to
            // continue from the new spot rather than the one captured above.
            await streamChunks(target, resumeFrom);
            await attachSelectedCover(target);
            await finishUpload(target, form);
          } catch (again) {
            if (cancelled || !uploadForm.isConnected) return;
            retry.disabled = false;
            document.getElementById('u-result').innerHTML = `<div class="note note-bad">${esc(readableError(again, '还是没传上去'))}
              <br>再按一次「继续」可以接着传；想丢掉这条草稿就点「中止这次上传」。</div>`;
            toast(readableError(again, '续传没有完成'), 'bad');
          }
          finally { uploadBusy = false; if (uploadForm.isConnected) document.getElementById('u-abort').disabled = false; }
          })();
          await activeUpload;
        });
        if (session && isWriteOutcomeUnknown(error)) {
          toast('上传结果不确定：请先在教学影像管理里核对这条草稿，再决定是否重传。', 'warn');
        }
      } finally {
        uploadBusy = false;
        if (button.isConnected) {
          button.disabled = false;
          document.getElementById('u-abort').disabled = false;
        }
      }
      })();
      await activeUpload;
    });
  }

  // ------------------------------------------------------------------ videos
  async function videosTab(box, pass = drawPass) {
    const offset = videoPages[videoPages.length - 1];
    const data = await get('admin-videos', { limit: 60, offset });
    if (!box.isConnected || pass !== drawPass) return;
    const plans = (await get('admin-plans')).plans ?? [];
    if (!box.isConnected || pass !== drawPass) return;
    const validNext = Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset;
    box.innerHTML = `
      <section class="panel" data-video-management>
        <div class="section-title"><h2>教学影像库 · 第 ${videoPages.length} 页</h2>
          <p class="tiny dim">${esc(tierLegend(plans))} 试看 0 表示不开放试看。</p></div>
        <div class="catalog-context"><div><strong>编排目录中的卡片顺序</strong><p class="dim">可拖动、上移、下移，并查看保存前的桌面与手机排列。</p></div><button class="btn btn-primary" type="button" data-open-order>调整展示顺序</button><button class="btn" type="button" data-open-series>管理合集</button></div>
        <div class="row" style="gap:12px;align-items:end;flex-wrap:wrap">
          <label class="field" style="flex:1 1 240px">搜索本页<input class="input" type="search" id="admin-video-query" value="${esc(videoQuery)}" placeholder="标题或一句话说明" maxlength="120" /></label>
          <label class="field">状态<select class="input" id="admin-video-status"><option value="all">全部状态</option>${['uploading','aborting','draft','published','retired'].map(status => `<option value="${status}"${videoStatus === status ? ' selected' : ''}>${statusLabel(status)}</option>`).join('')}</select></label>
          <label class="field">类别<select class="input" id="admin-video-kind"><option value="all">全部类别</option><option value="live"${videoKind === 'live' ? ' selected' : ''}>真实拳击</option><option value="anime"${videoKind === 'anime' ? ' selected' : ''}>动画拳击</option></select></label>
          <button class="btn btn-ghost" type="button" id="admin-video-clear">清空本页筛选</button>
        </div>
        <p class="tiny dim" id="admin-video-result" role="status" aria-live="polite"></p>
        <p class="tiny dim">搜索和筛选仅作用于本页；每页最多 60 条，较早内容可用下方翻页查看。修改仍按原来的规则自动保存。</p>
        ${data.items.length === 0 ? `<p class="dim">${offset ? '本页暂无内容，可返回上一页或重新读取。' : '还没有视频。'}</p>` : `
        <div class="table-wrap"><table class="table admin-video-table">
          <thead><tr><th>封面</th><th>标题</th><th>状态</th><th>需要等级</th><th>类别</th><th>试看</th><th>时长 / 体积</th><th>结构</th><th>操作</th></tr></thead>
          <tbody>${data.items.map((item) => `<tr data-id="${esc(item.id)}" data-published="${item.publishedAt ? '1' : ''}" data-status="${esc(item.status)}">
            <td class="cover">${coverCell(item)}</td>
            <td class="video-name-cell"><div class="video-name-editor">
              <strong class="video-name-heading" data-video-name>${esc(item.title?.trim() || '名称缺失，请核对并补充')}</strong>
              <label class="field"><span class="tiny dim">编辑教学影像名称</span><textarea class="input" data-title rows="3" maxlength="120" aria-label="教学影像名称（显示在目录和水印旁）">${esc(item.title ?? '')}</textarea></label>
              <label class="field"><span class="tiny dim">一句话说明（选填）</span><input class="input" data-desc maxlength="200" value="${esc(item.description ?? '')}" placeholder="可补充本节内容" aria-label="一句话说明" /></label>
            </div></td>
            <td><span class="pill ${item.status === 'published' ? 'pill-good' : item.status === 'uploading' ? 'pill-bad' : ''}">${statusLabel(item.status)}</span></td>
            <td>${selectTier(item, plans)}</td>
            <td>${selectKind(item)}</td>
            <td><input class="input num" data-preview type="number" min="0" max="3600" step="10" value="${esc(item.previewSeconds)}" style="width:88px;padding:6px 8px" />
              ${item.previewSeconds > 0 && item.durationSeconds > 0 && item.previewSeconds / item.durationSeconds > 0.5
    ? `<div class="tiny" style="color:var(--warn);margin-top:4px">试看占教学影像时长 ${Math.round((item.previewSeconds / item.durationSeconds) * 100)}%（记录时长 ${fmtDuration(item.durationSeconds)}）：可能是「时长」填小了。时长决定免费窗口大小，填小会免费开放过多内容。请核对总时长，或缩短试看时间。</div>`
    : (item.previewSeconds >= item.durationSeconds && item.durationSeconds > 0
      ? '<div class="tiny" style="color:var(--warn);margin-top:4px">试看不短于时长：站点已按半个文件封顶，观众看不到全部内容。</div>'
      : '')}</td>
            <td class="num tiny"><input class="input num" data-duration type="number" min="1" max="86400" step="1" value="${esc(Math.round(item.durationSeconds ?? 0))}" style="width:78px;padding:6px 8px" aria-label="这条教学影像多长（秒）" title="秒数。处理成功后站点按原片实测自动改正；这一格是你核对与手动改正的地方。" /><br>${fmtBytes(item.sizeBytes)}</td>
            <td>${item.faststart ? '<span class="pill pill-good">faststart</span>' : '<span class="pill pill-bad">尾部 moov</span>'}</td>
            <td><div class="row" style="gap:6px">
              ${item.status !== 'published'
    ? `<button class="btn btn-sm btn-primary" data-act="publish" ${item.ready ? '' : 'disabled'}>发布</button>`
    : '<button class="btn btn-sm" data-act="retire">下架</button>'}
              <button class="btn btn-sm" data-act="save">保存</button>
              <span class="row-state tiny dim" data-row-state>改完自动保存</span>
              <button class="btn btn-sm btn-ghost" data-act="watchers">观众</button>
              <a class="btn btn-sm btn-ghost" href="/v/${encodeURIComponent(item.id)}" data-link>试播</a>
              <button class="btn btn-sm btn-danger" data-act="delete">删除</button>
            </div></td>
          </tr>`).join('')}</tbody>
        </table></div>`}
        <nav class="row" aria-label="教学影像管理分页" style="margin-top:16px;gap:12px">
          <button class="btn" type="button" data-video-page="previous"${videoPages.length < 2 ? ' disabled' : ''}>上一页</button>
          <span class="tiny dim">第 ${videoPages.length} 页${data.hasMore ? ' · 后面还有内容' : ' · 已到末页'}</span>
          <button class="btn" type="button" data-video-page="next"${!data.hasMore || !validNext ? ' disabled' : ''}>下一页</button>
        </nav>
        ${data.hasMore && !validNext ? '<p class="note note-warn">下一页位置暂时未能读取，请重新读取后再翻页。</p>' : ''}
        <div id="watchers" class="stack" hidden></div>
      </section>`;

    const query = box.querySelector('#admin-video-query');
    const status = box.querySelector('#admin-video-status');
    const kind = box.querySelector('#admin-video-kind');
    function filterRows() {
      if (!box.isConnected || pass !== drawPass) return;
      videoQuery = query.value.slice(0, 120); videoStatus = status.value; videoKind = kind.value;
      const needle = videoQuery.trim().toLocaleLowerCase();
      let count = 0;
      for (const row of box.querySelectorAll('tr[data-id]')) {
        const title = row.querySelector('[data-title]').value;
        const description = row.querySelector('[data-desc]').value;
        row.hidden = !(`${title} ${description}`.toLocaleLowerCase().includes(needle)
          && (videoStatus === 'all' || row.dataset.status === videoStatus)
          && (videoKind === 'all' || row.querySelector('[data-kind]').value === videoKind));
        if (!row.hidden) count++;
      }
      box.querySelector('#admin-video-result').textContent = `本页显示 ${count}/${data.items.length} 条${offset ? ` · 从第 ${offset + 1} 条开始` : ''}`;
      hydratePosters();
    }
    query.addEventListener('input', event => { if (!event.isComposing) filterRows(); });
    query.addEventListener('compositionend', filterRows);
    status.addEventListener('change', filterRows); kind.addEventListener('change', filterRows);
    box.querySelector('#admin-video-clear').addEventListener('click', () => {
      query.value = ''; status.value = kind.value = 'all'; filterRows(); query.focus();
    });
    filterRows();
    for (const button of box.querySelectorAll('[data-video-page]')) button.addEventListener('click', async () => {
      if (button.disabled || !box.isConnected || pass !== drawPass) return;
      if (box.querySelector('[data-tone="busy"]')) return toast('正在保存本页修改，请保存完成后再翻页。', 'warn');
      if (button.dataset.videoPage === 'previous') videoPages.pop();
      else videoPages.push(data.nextOffset);
      await draw();
    });
    const management = box.querySelector('[data-video-management]');
    const editor = document.createElement('div');
    editor.hidden = true;
    box.prepend(editor);
    box.querySelector('[data-open-series]').addEventListener('click', async () => {
      management.hidden=true; editor.hidden=false;
      try {
        const {mountSeriesEditor}=await import('./series-editor.mjs');
        await mountSeriesEditor(editor,{get,post,posterSrc,hydratePosters,isWriteOutcomeUnknown,
          onSaved:()=>{state.tabs=null;},
          onClose:()=>{editor.replaceChildren();editor.hidden=true;management.hidden=false;box.querySelector('[data-open-series]')?.focus();}});
      } catch(error) {editor.hidden=true;management.hidden=false;toast(error.message||'合集暂时无法读取。','bad');}
    });
    box.querySelector('[data-open-order]').addEventListener('click', async () => {
      management.hidden = true;
      editor.hidden = false;
      try {
        await mountCatalogOrderEditor(editor, {
          get, post, posterSrc, hydratePosters, isWriteOutcomeUnknown,
          onSaved: () => { state.tabs = null; },
          onClose: () => { editor.replaceChildren(); editor.hidden = true; management.hidden = false; box.querySelector('[data-open-order]')?.focus(); },
        });
      } catch (error) {
        editor.hidden = true;
        management.hidden = false;
        toast(error.message || '顺序编辑器暂时无法读取，请稍后重试。', 'bad');
      }
    });

    // 这一屏他一天要开很多次（确认挂没挂封面、改标题），而平台把封面的响应改成 no-store，
    // 浏览器一张都存不住 —— 以前每开一次就重新向服务端要 15 张。现在交给买家侧那一只眼睛：
    // hydratePosters 是全站唯一的一处"看得见才取图 + 取到就本地存一份"，这里不再自己扫一遍
    //（自己扫等于把"只取屏幕上那几张"这条又抄了一份，而且抄漏了可见性判断）。
    // 换完封面 draw() 会重画，这一轮跟着再排一次。
    hydratePosters();

    // 选完封面之后 draw() 会重画整张表，旧行连同候选画面面板一起被换掉：站长刚点完那一下，
    // 面板就消失，看上去就是"刷新过后什么都没发生"。所以重画完在新行上接着把面板开下去，
    // 并且不再发 admin-poster-generate —— 帧已经在盘上，那一跳等于白排一次队。
    const mountRowPicker = (rowEl) => {
      let picker = rowEl.querySelector('[data-cover-picker]');
      if (!picker) { picker = document.createElement('section'); picker.dataset.coverPicker = ''; rowEl.querySelector('td.cover')?.append(picker); }
      const opener = rowEl.querySelector('[data-cover-server]');
      if (opener) opener.textContent = '重新打开候选画面';
      return mountServerCoverPicker(picker, { videoId: rowEl.dataset.id, uploadCover, onSelected: async () => {
        await reloadBoot();
        await draw();
        const fresh = box.querySelector(`tr[data-id="${rowEl.dataset.id}"]`);
        if (fresh) mountRowPicker(fresh);
      } });
    };

    for (const row of box.querySelectorAll('tr[data-id]')) {
      const id = row.dataset.id;
      const state = row.querySelector('[data-row-state]');
      const markState = (text, tone) => {
        if (!state) return;
        state.textContent = text;
        state.dataset.tone = tone ?? '';
      };
      row.querySelector('[data-title]').addEventListener('input', event => {
        row.querySelector('[data-video-name]').textContent = event.currentTarget.value.trim() || '名称缺失，请核对并补充';
      });
      // 改完就生效：这一栏一天要动几十次，每次都要摸一下「保存」是纯粹的摩擦。
      // 绑的是 change（离开输入框或换下拉选项才触发），所以不会把半截数字存进去。
      async function saveRow() {
        const title = row.querySelector('[data-title]').value.trim();
        if (!title) {
          markState('标题不能空着', 'bad');
          toast('教学影像名称不能为空：目录和播放器水印旁都会显示它。', 'bad');
          return;
        }
        const seconds = Number(row.querySelector('[data-duration]').value);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) {
          markState('时长要填整秒数', 'bad');
          toast('时长那一格要填 1 到 86400 之间的整秒数：它决定免费试看窗口和「看完」判定，空着或填小数存不进去。', 'warn');
          return;
        }
        markState('正在保存…', 'busy');
        try {
          await post('admin-video-update', {
            videoId: id,
            title,
            description: row.querySelector('[data-desc]').value.trim(),
            // The update endpoint reads tier_rank; the upload endpoint reads tierRank.
            // Sending the wrong one used to change nothing while still reporting success.
            tier_rank: Number(row.querySelector('[data-tier]').value),
            kind: row.querySelector('[data-kind]').value,
            preview_seconds: Number(row.querySelector('[data-preview]').value),
            duration_seconds: Number(row.querySelector('[data-duration]').value),
          });
          markState(`已保存 ${new Date().toTimeString().slice(0, 5)}`, 'ok');
          toast('已保存，正在生效。');
        } catch (error) {
          markState('没保存：再点一次保存', 'bad');
          toast(error.message, 'bad');
        }
      }
      for (const field of row.querySelectorAll('[data-title],[data-desc],[data-tier],[data-kind],[data-preview],[data-duration]')) {
        field.addEventListener('change', () => saveRow());
      }
      row.querySelector('[data-cover-server]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget; button.disabled = true;
        try {
          await post('admin-poster-generate', { videoId: id });
          if (!row.isConnected) return;
          button.disabled = false;
          mountRowPicker(row);
        } catch (error) { if (row.isConnected) { button.disabled = false; toast(readableError(error), 'bad'); } }
      });
      const coverOpen = row.querySelector('[data-cover-open]');
      const coverInput = row.querySelector('[data-cover-file]');
      // 两个控件一起绑：只绑一个的话，另一个缺失时里面那句 coverOpen.disabled 会当场抛
      // TypeError，把这一行其余按钮一起打死（做变异验证时真撞到过一次）。
      if (coverOpen && coverInput) {
        const coverLabel = coverOpen.textContent.trim();
        coverOpen.addEventListener('click', () => coverInput.click());
        coverInput.addEventListener('change', async () => {
          const picked = coverInput.files?.[0] ?? null;
          if (!picked) return;
          coverOpen.disabled = true;
          coverOpen.textContent = '正在挂…';
          try {
            await uploadCover(id, picked);
            // 传完必须重取一次这一格：封面的版本把手取自行上的更新时间，不重取就还拿旧地址，
            // 屏幕上看着像没换成功。
            toast(row.dataset.published === '1'
              ? '封面已经换上，买家下一次打开教学影像库就是这张图。'
              : '封面已经挂上。这条还是草稿，发布之后才会对外显示。');
            await draw();
          } catch (error) {
            coverOpen.disabled = false;
            coverOpen.textContent = coverLabel;
            toast(readableError(error, '封面没挂上'), 'bad');
          } finally {
            // 不清掉的话，他想再选同一个文件时 input 不发 change，按钮按第二下就没反应了。
            coverInput.value = '';
          }
        });
      }
      for (const button of row.querySelectorAll('[data-act]')) {
        button.addEventListener('click', async () => {
          const act = button.dataset.act;
          button.disabled = true;
          try {
            if (act === 'save') {
              await saveRow();
            } else if (act === 'publish') {
              await post('admin-video-update', { videoId: id, status: 'published' });
              toast('已发布，观众现在能看到试看入口。');
            } else if (act === 'retire') {
              await post('admin-video-update', { videoId: id, status: 'retired' });
              toast('已下架，新的观看请求会被拒绝。');
            } else if (act === 'delete') {
              // Never-published rows (failed uploads, abandoned drafts) delete in one tap;
              // retyping the title there is friction with nothing to protect.
              if (row.dataset.published === '1') {
                const title = prompt('这条教学影像已经发布过，观众可能看过。删除会同时清除存储里的全部密文数据块。请输入完全一致的教学影像名称确认：');
                if (title === null) return;
                await post('admin-video-delete', { videoId: id, confirm: title });
              } else {
                const sure = window.confirm('删除这条未发布的教学影像？它会连同已上传的密文数据块一起清除，观众从未见过它。');
                if (!sure) return;
                await post('admin-video-delete', { videoId: id });
              }
              toast('教学影像和密文数据块已删除。');
            } else if (act === 'watchers') {
              const box2 = document.getElementById('watchers');
              const list = await get('admin-watchers', { videoId: id });
              box2.hidden = false;
              box2.innerHTML = `<h3>观看记录</h3>` + (list.items.length === 0 ? '<p class="dim tiny">还没有人观看。</p>' : `
                <div class="table-wrap"><table class="table"><thead><tr><th>账号</th><th>方式</th><th>看到</th><th>哪台设备</th><th>时间</th></tr></thead>
                <tbody>${list.items.map((w) => `<tr><td class="mono tiny">${esc(w.email)}</td>
                  <td>${w.access === 'full' ? '完整版' : '试看'}</td><td class="num">${fmtDuration(w.position)}</td>
                  <td class="tiny">${esc(w.device ?? '认不出这台设备')}${w.ip ? ` <span class="dim mono">${esc(w.ip)}</span>` : ''}</td>
                  <td class="num tiny">${fmtDate(w.updatedAt)}</td></tr>`).join('')}</tbody></table></div>`)
                + (list.truncated
                  ? '<p class="tiny dim" style="margin-top:8px">这一栏只列最近 200 条，更早的还没取过来。要按账号查阅观看过的教学影像和设备，请用会员名单中的「观看记录」，那里可以逐页查询。</p>'
                  : '');
              labelTableCells(box2);
              // This branch only reads. Redrawing the tab would rebuild the table and
              // wipe the panel that was just filled, so the button would look dead.
              button.disabled = false;
              return;
            }
            await draw();
          } catch (error) {
            toast(error.message, 'bad');
          } finally {
            // A cancelled prompt or a refused empty title used to leave this button grey
            // until he switched tabs — the tap looks like it did nothing.
            button.disabled = false;
          }
        });
      }
    }
  }

  function statusLabel(status) {
    return { uploading: '上传中', aborting: '正在清理', draft: '草稿', published: '已发布', retired: '已下架' }[status] ?? status;
  }

  // 权限是"等级"不是"档位"：同一个等级可以放两个档位，用档位名选权限会有两个
  // 值相同的选项。两个选择器都列 0..N 等级，图例说明每级住着哪些档位。
  function tierLevels(plans) {
    const highest = plans.reduce((max, plan) => Math.max(max, Number(plan.tier_rank) || 0), 0);
    return [...Array(Math.max(3, highest) + 1).keys()];
  }

  function tierOptions(plans, selected) {
    return tierLevels(plans).map((level) => `<option value="${level}"${Number(selected) === level ? ' selected' : ''}>${level === 0 ? '公开（0，不用登录）' : `等级 ${level}`}</option>`).join('');
  }

  function tierLegend(plans) {
    const byLevel = new Map();
    for (const plan of plans) {
      const level = Number(plan.tier_rank) || 0;
      byLevel.set(level, [...(byLevel.get(level) ?? []), plan.name || plan.code]);
    }
    const parts = [...byLevel.entries()].sort((a, b) => a[0] - b[0])
      .map(([level, names]) => `等级 ${level} = ${names.join('、')}`);
    return parts.length ? `档位对应的等级：${parts.join('；')}。同一等级可以有多个档位，视频只认等级数字。` : '还没有档位，视频可以先设为公开（0）或任意等级数字。';
  }

  function selectTier(item, plans) {
    return `<select class="input" data-tier style="width:150px;padding:6px 8px">${tierOptions(plans, item.tierRank)}</select>`;
  }

  const KIND_LABELS = { live: '真实拳击', anime: '动画拳击' };

  function selectKind(item) {
    const current = item.kind === 'anime' ? 'anime' : 'live';
    return `<select class="input" data-kind style="width:120px;padding:6px 8px">${Object.entries(KIND_LABELS)
      .map(([key, label]) => `<option value="${key}"${key === current ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  }

  // -------------------------------------------------------------------- keys
  async function keysTab(box, pass = drawPass) {
    const plans = (await get('admin-plans')).plans ?? [];
    if (!box.isConnected || pass !== drawPass) return;
    const keys = await get('admin-keys', { limit: 100, offset: keysPage, ...(keysFilter ? { status: keysFilter } : {}) });
    if (!box.isConnected || pass !== drawPass) return;
    const filters = [['', '全部'], ['unused', '未兑换'], ['frozen', '已冻结'], ['redeemed', '已兑换'], ['revoked', '已作废']];
    box.innerHTML = `
      <div class="admin-cols">
        <section class="panel stack">
          <div class="section-title"><h2>${keys.items.length ? `激活码（第 ${keysPage + 1}–${keysPage + keys.items.length} 枚）` : '激活码（这一类暂时没有）'}</h2>
            <p class="tiny dim">点任意一枚即可复制。列表里的码就是发给买家的原文，可以随时重看；生成总数不限。</p>
            <div class="row" style="gap:8px;margin-top:8px">${filters.map(([value, label]) => `<button class="btn btn-sm ${keysFilter === value ? 'btn-primary' : ''}" type="button" data-key-filter="${esc(value)}">${esc(label)}</button>`).join('')}</div>
          </div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>码</th><th>档位</th><th>状态</th><th>绑定对象</th><th>备注</th><th></th></tr></thead>
            <tbody>${keys.items.length === 0 ? '<tr><td colspan="6" class="tiny dim" style="padding:18px 0">这一类下还没有激活码。换个筛选条件，或在右边生成一批。</td></tr>' : keys.items.map((row) => `<tr>
              <td><button class="code-chip" data-copy="${esc(row.code)}">${esc(row.code ?? `····${esc(row.tail)}`)}</button></td>
              <td>${esc(row.plan?.name ?? '—')}</td>
              <td><span class="pill ${row.status === 'unused' ? 'pill-acid' : row.status === 'redeemed' ? 'pill-good' : 'pill-bad'}">${keyStatus(row.status)}</span></td>
              <td class="tiny">${esc(row.redeemedUser ?? '')}${row.redeemedEmail ? `<br><span class="mono tiny dim">${esc(row.redeemedEmail)}</span>` : ''}${row.redeemedQq ? ` <span class="tiny dim">QQ ${esc(row.redeemedQq)}</span>` : ''}</td>
              <td class="tiny dim">${esc(row.note ?? '')}<br><span class="mono">${esc(row.batchId?.slice(0, 8) ?? '')}</span></td>
              <td>${row.status === 'unused' || row.status === 'frozen' ? `<button class="btn btn-sm btn-danger" data-revoke="${esc(row.id)}">作废</button>` : ''}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          <div class="row" style="gap:10px;margin-top:10px">
            ${keys.hasMore ? `<button class="btn btn-sm" type="button" id="keys-more">再加载 100 枚（已显示 ${keysPage + keys.items.length} 枚）</button>` : `<span class="tiny dim">已显示到第 ${keysPage + keys.items.length} 枚，没有更多。</span>`}
            <button class="btn btn-sm btn-ghost" type="button" id="keys-export"${keyExport.pending ? ' disabled' : ''}>${keyExport.filter === keysFilter && keyExport.nextOffset ? `继续导出（从第 ${keyExport.nextOffset + 1} 枚起）` : '导出当前筛选（CSV）'}</button>
            <button class="btn btn-sm btn-ghost" type="button" id="keys-export-reset"${keyExport.filter === keysFilter && keyExport.nextOffset ? '' : ' hidden'}>从头重新导出</button>
            <p class="tiny dim">每份最多 5000 枚；还有记录时可继续导出下一份。期间若有新增、兑换或改变筛选，位置可能变化，对账时请按完整激活码去重并核对。离开本次后台访问会丢失续接位置。</p>
          </div>
        </section>
        <aside class="panel stack">
          <div class="section-title"><h2>生成一批</h2><p class="tiny dim">按档位出码，单次最多 1000 枚，可以连续生成多批，总数不限。</p></div>
          ${plans.length === 0 ? '<div class="note note-warn">还没有任何档位，所以无法出码。先到「档位设置」点"按 ¥30/¥80/¥200 建月卡、季卡、年卡"，再回来生成。</div>' : `
          <form class="stack" id="gen">
            <div class="field"><label for="g-plan">档位</label>
              <select class="input" id="g-plan" name="planCode">${plans.map((plan) => `<option value="${esc(plan.code)}">${esc(plan.name)} · ${esc(plan.price_text || fmtMoney(plan.price_cents))}${plan.duration_days ? `/${plan.duration_days} 天` : '/永久'}</option>`).join('')}</select></div>
            <div class="row" style="gap:12px">
              <div class="field" style="flex:1"><label for="g-count">数量</label>
                <input class="input num" id="g-count" name="count" type="number" min="1" max="1000" value="20" /></div>
              <div class="field" style="flex:1"><label for="g-days">未兑换有效期（天，选填）</label>
                <input class="input num" id="g-days" name="validDays" type="number" min="1" max="365" /></div>
            </div>
            <div class="field"><label for="g-note">备注（买家的 QQ、日期等）</label>
              <input class="input" id="g-note" name="note" maxlength="60" /></div>
            <button class="btn btn-primary" type="submit">生成并复制</button>
          </form>`}
          <div id="gen-result" class="stack"></div>
        </aside>
      </div>`;

    for (const chip of box.querySelectorAll('[data-copy]')) {
      chip.addEventListener('click', async () => {
        // 复制这一路在微信/QQ 内置浏览器里会整段不可用；那句"已复制"必须只在全程没抛错时才说。
        if (await copyText(chip.dataset.copy)) toast(`已复制 ${chip.dataset.copy}`);
        else toast('这个浏览器不让网页写剪贴板，请长按上面那串码手动复制。', 'bad');
      });
    }
    for (const button of box.querySelectorAll('[data-revoke]')) {
      button.addEventListener('click', async () => {
        if (!confirm('作废后这枚码立即失效，已经兑换的会员不受影响。')) return;
        try {
          await post('admin-key-revoke', { id: button.dataset.revoke });
          toast('这枚码已作废。');
          await draw();
        } catch (error) {
          toast(error.message, 'bad');
        }
      });
    }
    document.getElementById('keys-more')?.addEventListener('click', () => {
      keysPage += 100;
      void draw();
    });
    for (const button of box.querySelectorAll('[data-key-filter]')) {
      button.addEventListener('click', () => {
        keysFilter = button.dataset.keyFilter;
        keyExport.filter = keysFilter; keyExport.nextOffset = 0;
        keysPage = 0;
        void draw();
      });
    }
    keyExport.paint = () => {
      if (!box.isConnected || pass !== drawPass) return;
      const button = box.querySelector('#keys-export'), reset = box.querySelector('#keys-export-reset');
      const cursor = keyExport.filter === keysFilter ? keyExport.nextOffset : 0;
      button.disabled = keyExport.pending;
      button.textContent = keyExport.pending ? '正在导出…' : cursor ? `继续导出（从第 ${cursor + 1} 枚起）` : '导出当前筛选（CSV）';
      reset.hidden = !cursor; reset.disabled = keyExport.pending;
    };
    keyExport.paint();
    document.getElementById('keys-export-reset')?.addEventListener('click', () => {
      if (!box.isConnected || pass !== drawPass || keyExport.pending) return;
      keyExport.nextOffset = 0; void draw();
    });
    document.getElementById('keys-export')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      if (button.disabled || keyExport.pending || !box.isConnected || pass !== drawPass) return;
      const filter = keysFilter, label = button.textContent;
      const startOffset = keyExport.filter === filter ? keyExport.nextOffset : 0;
      let continuation = 0;
      keyExport.pending = true;
      button.disabled = true; button.textContent = '正在导出…';
      try {
        const items = [];
        let cursor = startOffset, truncated = '';
        for (let pageIndex = 0; pageIndex < 25; pageIndex++) {
          const remaining = 5000 - items.length;
          const page = await get('admin-keys', { limit: Math.min(200, remaining), offset: cursor, ...(filter ? { status: filter } : {}) });
          if (!box.isConnected || pass !== drawPass) return;
          if (!Array.isArray(page?.items)) throw new Error('激活码列表格式不完整，本次没有导出文件。');
          items.push(...page.items.slice(0, remaining));
          if (page.items.length > remaining) { truncated = '达到 5000 枚上限，仍有内容未导出；响应超量，无法安全续接，请先核对接口'; break; }
          if (!page.hasMore) break;
          if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= cursor) throw new Error('下一页位置没有推进，本次没有导出文件，请重新读取后再试。');
          cursor = page.nextOffset;
          if (items.length >= 5000 || pageIndex === 24) {
            continuation = cursor;
            truncated = items.length >= 5000 ? '达到 5000 枚上限，仍有内容未导出' : '已读取 25 页，仍有内容未导出';
            break;
          }
        }
        // A note like "=1+1" becomes a formula when the CSV is opened in Excel, so
        // leading operators are neutralised before quoting.
        const cell = (value) => `"${String(value ?? '').replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
        const rows = [['码', '档位', '状态', '绑定对象', '备注', '批次', '生成时间', '兑换时间']
          .map(cell).join(',')];
        for (const row of items) {
          rows.push([row.code, row.plan?.name ?? '', row.status, row.redeemedUser ?? '', row.note ?? '', row.batchId ?? '', row.createdAt ?? '', row.redeemedAt ?? '']
            .map(cell).join(','));
        }
        const url = URL.createObjectURL(new Blob([`${rows.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `激活码-${filter || '全部'}-${new Date().toISOString().slice(0, 10)}-从${startOffset + 1}.csv`;
        link.click();
        URL.revokeObjectURL(url);
        if (keysFilter === filter) { keyExport.filter = filter; keyExport.nextOffset = continuation; }
        toast(`已导出 ${items.length} 枚${truncated ? `（${truncated}）` : ''}。CSV 含完整激活码，请当作现金保管。`);
      } catch (error) {
        if (box.isConnected && pass === drawPass) toast(error.message, 'bad');
      } finally {
        keyExport.pending = false; keyExport.paint();
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = keysFilter === filter && keyExport.nextOffset ? `继续导出（从第 ${keyExport.nextOffset + 1} 枚起）` : startOffset ? '导出当前筛选（CSV）' : label;
        }
      }
    });
    document.getElementById('gen')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      try {
        const result = await post('admin-keys-create', fields);
        const text = result.keys.map((row) => row.code).join('\n');
        const copied = await copyText(text);
        document.getElementById('gen-result').innerHTML = `
          <div class="note">${result.keys.length} 枚 ${esc(result.plan.name)} 码已生成${copied
            ? '并复制到剪贴板。'
            : '。这个浏览器不让网页写剪贴板：请在下面框里全选复制，别凭"已经复制了"就发出去。'}</div>
          <textarea class="input mono" readonly style="min-height:150px">${esc(text)}</textarea>`;
        await draw();
      } catch (error) {
        toast(error.message, 'bad');
        button.disabled = false;
      }
    });
  }

  function keyStatus(status) {
    return {
      unused: '未兑换', redeemed: '已兑换', revoked: '已作废', reserved: '预留',
      frozen: '已冻结（账号停用中）',
    }[status] ?? status;
  }

  // ----------------------------------------------------------------- members

  // Passwords are stored as salted hashes sealed under the site key, so nobody can read them
  // back — the answer to "买家忘了密码" is a replacement, which also clears the lock that
  // five wrong guesses leaves behind.
  function suggestedPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  }
  // 回收站：作废的东西不再混在主表里靠红 pill 区分。四类各一区，默认折叠，
  // 顶部一颗类型下拉 + 一个搜索框 + 每页 20 条；恢复动作只有这里能按。
  const TRASH_KINDS = [
    ['accounts', '停用账号'],
    ['memberships', '撤销的会员权益'],
    ['keys', '作废或冻结的激活码'],
    ['requests', '取消的购买记录'],
  ];
  let trashKind = 'accounts';
  let trashSearch = '';
  const trashPage = { accounts: 0, memberships: 0, keys: 0, requests: 0 };

  async function trashTab(box, pass = drawPass) {
    const [counts, accounts, members, keys, requests] = await Promise.all([
      get('admin-trash-counts'),
      trashKind === 'accounts' ? get('admin-accounts', { disabled: 1, offset: trashPage.accounts * 20, limit: 20, ...(trashSearch ? { q: trashSearch } : {}) }) : null,
      trashKind === 'memberships' ? get('admin-members', { revokedOnly: 1, offset: trashPage.memberships * 20, limit: 20, ...(trashSearch ? { q: trashSearch } : {}) }) : null,
      trashKind === 'keys' ? get('admin-keys', { statuses: 'revoked,frozen', offset: trashPage.keys * 20, limit: 20, ...(trashSearch ? { q: trashSearch } : {}) }) : null,
      trashKind === 'requests' ? get('admin-requests', { status: 'cancelled', offset: trashPage.requests * 20, limit: 20 }) : null,
    ]);
    if (!box.isConnected || pass !== drawPass) return;
    const badge = (bucket) => (bucket ? `${bucket.more ? `${bucket.count}+` : bucket.count}` : '—');
    const pages = {
      accounts: (accounts?.items ?? []).map((row) => ({
        id: row.user.id,
        title: row.user.email,
        when: row.disabledAt ? fmtDate(row.disabledAt) : '—',
        detail: `${row.note ? `备注 ${row.note} · ` : ''}${row.contactQq ? `QQ ${row.contactQq} · ` : ''}注册 ${row.registeredAt ? fmtDate(row.registeredAt) : '—'}`,
        action: '恢复账号',
        act: 'user-enable',
      })),
      memberships: (members?.items ?? []).map((row) => ({
        id: row.id,
        title: `${row.user.email} · 「${row.plan}」等级 ${row.rank}`,
        when: fmtDate(row.revokedAt),
        detail: row.expiresAt ? `${fmtDate(row.expiresAt)} 到期 · ${row.source === 'key' ? '激活码' : row.source}` : '不过期 · 续期时签名会重算',
        action: '重新生效',
        act: 'member-restore',
      })),
      keys: (keys?.items ?? []).map((row) => ({
        id: row.id,
        title: row.code ?? `码尾 ${row.tail}`,
        when: fmtDate(row.createdAt),
        detail: `${row.status === 'frozen' ? '随账号停用冻住' : '已作废'} · ${row.plan?.name ?? '未知档位'} · ${row.note || '没有备注'}${row.redeemedAt ? ` · 已在 ${fmtDate(row.redeemedAt)} 被 ${row.redeemedUser ?? '某账号'} 兑换` : ''}`,
        action: '放回未兑换',
        act: 'key-restore',
      })),
      requests: (requests?.items ?? []).map((row) => ({
        id: row.id,
        title: row.email,
        when: fmtDate(row.updatedAt ?? row.createdAt),
        detail: `${row.plan?.name ?? '未知档位'} · ${row.note || '没有备注'}`,
        action: '改回待处理',
        act: 'request-reopen',
      })),
    };
    const rows = pages[trashKind];
    const thisMore = { accounts: accounts?.hasMore, memberships: members?.hasMore, keys: keys?.hasMore, requests: requests?.hasMore }[trashKind];
    const page = trashPage[trashKind];
    box.innerHTML = `
      <section class="panel stack">
        <div class="section-title"><h2>回收站</h2>
          <p class="tiny dim">停用的账号、撤销的会员权益、作废或冻结的激活码、取消的购买记录都在这里。
            这里只做两件事：核对有没有误撤，以及把它放回原位。<strong>站点不提供彻底删除</strong>——要删除教学影像请在「教学影像管理」里操作。</p></div>
        <div class="trash-bar">
          <div class="field"><label for="t-kind">类型</label>
            <select class="input" id="t-kind">${TRASH_KINDS.map(([key, label]) => `<option value="${key}"${key === trashKind ? ' selected' : ''}>${label}（${badge(counts[key])}）</option>`).join('')}</select></div>
          ${trashKind === 'requests' ? '' : `<div class="field" style="flex:1 1 240px"><label for="t-q">搜索</label>
            <input class="input mono" id="t-q" maxlength="120" placeholder="${trashKind === 'keys' ? '整码、码尾或批次备注' : trashKind === 'memberships' ? '完整邮箱' : '邮箱、备注或买家 QQ 的一部分'}" value="${esc(trashSearch)}" /></div>`}
        </div>
        <div class="trash-cards">${TRASH_KINDS.map(([key, label]) => `<button class="chip${key === trashKind ? ' is-on' : ''}" type="button" data-kind="${key}" aria-pressed="${key === trashKind}">${label} ${badge(counts[key])}</button>`).join('')}</div>
        ${rows.length === 0 ? `<p class="dim">${trashSearch ? `"${esc(trashSearch)}" 在这一页里没匹配到。${trashKind === 'memberships' ? '会员记录只认完整邮箱。' : ''}` : '这一类回收站里是空的。'}</p>` : `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>对象</th><th>什么时候进的</th><th>说明</th><th></th></tr></thead>
          <tbody>${rows.map((row) => `<tr>
            <td class="mono tiny">${esc(row.title)}</td>
            <td class="num tiny">${esc(row.when)}</td>
            <td class="tiny">${esc(row.detail)}</td>
            <td style="white-space:nowrap"><button class="btn btn-sm btn-ghost" data-restore="${esc(row.act)}" data-id="${esc(row.id)}" data-label="${esc(row.title)}">${row.action}</button></td>
          </tr>`).join('')}</tbody></table></div>
        <div class="row trash-pager" style="gap:10px;align-items:center">
          <button class="btn btn-sm" type="button" id="t-prev" ${page === 0 ? 'disabled' : ''}>上一页</button>
          <span class="tiny dim">第 ${page * 20 + 1}–${page * 20 + rows.length} 条${thisMore ? '，后面还有' : '，这就是最后'}</span>
          <button class="btn btn-sm" type="button" id="t-next" ${thisMore ? '' : 'disabled'}>下一页</button>
        </div>`}
      </section>`;
    const search = box.querySelector('#t-q');
    const ownsControl = control => box.isConnected && control?.isConnected && box.contains(control);
    box.querySelector('#t-kind').addEventListener('change', (event) => {
      if (!ownsControl(event.target)) return;
      trashKind = event.target.value;
      trashPage[trashKind] = 0;
      void draw();
    });
    search?.addEventListener('input', () => {
      if (!ownsControl(search)) return;
      trashSearch = search.value.trim();
      // Invalidate armed restore buttons as soon as the query changes, before debounce.
      const searchPass = ++drawPass;
      box.setAttribute('aria-busy', 'true');
      for (const button of box.querySelectorAll('[data-restore]')) button.disabled = true;
      trashPage[trashKind] = 0;
      // 每敲一个字就发一次请求会把当天的请求额度吃掉，所以等 500ms 没人再敲才查。
      clearTimeout(search.timer);
      search.timer = setTimeout(() => {
        if (searchPass === drawPass && ownsControl(search)) void draw();
      }, 500);
    });
    for (const chip of box.querySelectorAll('[data-kind]')) {
      chip.addEventListener('click', () => {
        if (!ownsControl(chip)) return;
        trashKind = chip.dataset.kind;
        trashPage[trashKind] = 0;
        void draw();
      });
    }
    const previous = box.querySelector('#t-prev'), next = box.querySelector('#t-next');
    previous?.addEventListener('click', () => {
      if (!ownsControl(previous)) return;
      trashPage[trashKind] = Math.max(0, trashPage[trashKind] - 1);
      void draw();
    });
    next?.addEventListener('click', () => {
      if (!ownsControl(next)) return;
      trashPage[trashKind] += 1;
      void draw();
    });
    for (const button of box.querySelectorAll('[data-restore]')) {
      button.addEventListener('click', async () => {
        if (!box.isConnected || pass !== drawPass || button.disabled) return;
        const act = button.dataset.restore;
        if (button.dataset.armed !== 'yes') {
          for (const other of box.querySelectorAll('[data-restore]')) delete other.dataset.armed;
          button.dataset.armed = 'yes';
          button.textContent = '再点一次确认放回';
          toast(`要把「${button.dataset.label}」放回原来的名单。`, 'warn');
          return;
        }
        button.disabled = true;
        try {
          if (act === 'user-enable') await post('admin-user-enable', { userId: button.dataset.id });
          else if (act === 'member-restore') await post('admin-member-restore', { id: button.dataset.id });
          else if (act === 'key-restore') await post('admin-key-restore', { id: button.dataset.id });
          else await post('admin-request-update', { id: button.dataset.id, status: 'new' });
          toast('已放回原来的名单。');
          if (pass === drawPass && box.isConnected) await draw();
        } catch (error) {
          toast(error.message, 'bad');
          button.disabled = false;
          delete button.dataset.armed;
          button.textContent = '放回';
        }
      });
    }
  }


  const emptyFilters = { q: '', account: 'all', membership: 'all', rank: '' };
  let memberFilters = { ...emptyFilters };
  const accountPages = [{ offset: 0, cursor: null }];
  let openMemberId = '';
  const passwordResets = new Map();
  let paintPasswordResets = () => {};
  const memberWrites = { note: new Set(), toggle: new Set() };
  let paintMemberWrites = () => {};
  async function membersTab(box, pass = drawPass) {
    const { offset, cursor } = accountPages[accountPages.length - 1];
    const accounts = await get('admin-accounts', { ...memberFilters, offset, ...(cursor == null ? {} : { cursor }), limit: 20 });
    if (!box.isConnected || pass !== drawPass) return;
    box.innerHTML = directoryMarkup({ accounts, filters: memberFilters, page: accountPages.length, offset,
      openId: openMemberId, viewerId: state.boot.viewer.id });
    for (const details of box.querySelectorAll('.member-details')) {
      details.addEventListener('toggle', () => {
        if (!owns()) return;
        const id = details.closest('[data-account-id]').dataset.accountId;
        if (details.open) openMemberId = id;
        else if (openMemberId === id) openMemberId = '';
      });
    }
    const owns = () => box.isConnected && pass === drawPass;
    function paintWrites() {
      if (!owns()) return;
      for (const [attribute, pending] of [['data-save-note', memberWrites.note], ['data-user-toggle', memberWrites.toggle]]) {
        for (const button of box.querySelectorAll(`[${attribute}]`)) {
          button.disabled = pending.has(button.getAttribute(attribute));
        }
      }
    }
    paintMemberWrites = paintWrites;
    paintWrites();
    const searchForm = box.querySelector('#m-search');
    async function readMembers() {
      if (!box.isConnected || !box.contains(searchForm)) return;
      const nextPass = ++drawPass;
      box.setAttribute('aria-busy', 'true');
      box.querySelector('#m-query-status').textContent = '正在查找用户…';
      for (const el of box.querySelectorAll('.member-card button, .member-pager button')) el.disabled = true;
      try {
        await membersTab(box, nextPass);
        if (nextPass === drawPass && box.isConnected) box.querySelector('#m-results-title')?.focus({ preventScroll: true });
      } catch (error) {
        if (nextPass !== drawPass || !box.isConnected) return;
        box.querySelector('#m-query-status').innerHTML = `${esc(error.message)} <button class="btn btn-sm" type="button" id="m-read-retry">重试读取</button>`;
        box.querySelector('#m-read-retry').addEventListener('click', readMembers);
      } finally { if (nextPass === drawPass && box.isConnected) box.setAttribute('aria-busy', 'false'); }
    }
    function applyFilters() {
      const values = new FormData(searchForm);
      memberFilters = Object.fromEntries(Object.keys(emptyFilters).map(key => [key, String(values.get(key) ?? '').trim()]));
      accountPages.splice(0, accountPages.length, { offset: 0, cursor: null });
      openMemberId = ''; void readMembers();
    }
    searchForm.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
    searchForm.addEventListener('change', event => { if (event.target.tagName === 'SELECT') applyFilters(); });
    box.querySelector('#m-clear').addEventListener('click', () => {
      for (const [key, value] of Object.entries(emptyFilters)) searchForm.elements.namedItem(key).value = value;
      applyFilters();
    });
    box.querySelector('#a-prev')?.addEventListener('click', () => {
      if (!owns() || accountPages.length < 2) return;
      accountPages.pop(); void readMembers();
    });
    box.querySelector('#a-next')?.addEventListener('click', () => {
      if (!owns() || !accounts.hasMore || !(accounts.nextOffset > offset)) return;
      accountPages.push({ offset: accounts.nextOffset, cursor: accounts.nextCursor }); void readMembers();
    });
    for (const button of box.querySelectorAll('[data-copy-email]')) {
      button.addEventListener('click', async () => { if (owns()) toast(await copyText(button.dataset.copyEmail) ? '已复制邮箱。' : '可选中卡片上的邮箱手动复制。'); });
    }
    for (const button of box.querySelectorAll('[data-register-sale]')) {
      button.addEventListener('click', () => { if (owns()) { saleDraft = button.dataset.registerSale; void selectTab('requests'); } });
    }
    for (const button of box.querySelectorAll('[data-revoked-for]')) {
      button.addEventListener('click', () => {
        if (!owns()) return;
        trashKind = 'memberships'; trashSearch = button.dataset.revokedFor; trashPage.memberships = 0;
        void selectTab('trash');
      });
    }
    const resetHost = box.querySelector('#m-reset-results');
    function paintResets() {
      if (!owns()) return;
      resetHost.innerHTML = [...passwordResets].map(([id, entry]) => `<section class="note${entry.status === 'uncertain' ? ' note-warn' : ''}" data-reset-result="${esc(id)}">
        <p><strong>${esc(entry.email)}</strong>：${esc(entry.note)}</p>
        <label class="tiny">本次生成的新密码（仅在本次后台访问中保留）<input class="input mono" type="password" readonly autocomplete="off" data-reset-password value="${esc(entry.password)}" /></label>
        <div class="row" style="gap:8px"><button class="btn btn-sm" type="button" data-reset-show="${esc(id)}" aria-pressed="false">显示密码</button>
        <button class="btn btn-sm" type="button" data-reset-copy="${esc(id)}"${entry.status === 'pending' || entry.status === 'rejected' ? ' disabled' : ''}>${entry.status === 'confirmed' ? '复制给买家' : '复制用于核对'}</button>
        ${entry.status === 'uncertain' ? `<button class="btn btn-sm btn-ghost" type="button" data-reset-ack="${esc(id)}">已核对，允许再次重置</button>` : ''}</div>
        <p class="tiny dim">先确认重置结果再交给本人；让买家登录后到「我的账号 → 修改密码」换掉。刷新或关闭页面会失去本框，网页不会把密码写进本地存储。</p></section>`).join('');
      for (const button of box.querySelectorAll('[data-reset]')) {
        const entry = passwordResets.get(button.dataset.reset);
        button.disabled = entry?.status === 'pending' || entry?.status === 'uncertain';
      }
    }
    resetHost.addEventListener('click', async event => {
      const button = event.target.closest('[data-reset-show],[data-reset-copy],[data-reset-ack]');
      if (!button || !resetHost.contains(button) || !owns() || button.disabled) return;
      const id = button.dataset.resetShow ?? button.dataset.resetCopy ?? button.dataset.resetAck;
      const entry = passwordResets.get(id);
      if (!entry) return;
      if (button.hasAttribute('data-reset-show')) {
        const input = button.closest('[data-reset-result]').querySelector('[data-reset-password]');
        input.type = input.type === 'password' ? 'text' : 'password';
        button.textContent = input.type === 'password' ? '显示密码' : '隐藏密码';
        button.setAttribute('aria-pressed', String(input.type === 'text'));
      } else if (button.hasAttribute('data-reset-ack')) {
        if (entry.status !== 'uncertain') return;
        entry.status = 'reviewed'; entry.note = '已人工核对上次结果；需要时可再次点名单里的重置密码。'; paintResets();
      } else {
        if (!['confirmed', 'uncertain', 'reviewed'].includes(entry.status)) return;
        button.disabled = true;
        try {
          const copied = await copyText(entry.password);
          if (owns()) toast(copied ? '本次生成的密码已复制。' : '复制未成功，请点显示密码后手动选中复制。', copied ? '' : 'warn');
        } finally { if (owns()) button.disabled = false; }
      }
    });
    paintPasswordResets = paintResets; paintResets();
    for (const button of box.querySelectorAll('[data-reset]')) {
      button.addEventListener('click', async () => {
        if (!owns() || button.disabled) return;
        const id = button.dataset.reset;
        if (['pending', 'uncertain'].includes(passwordResets.get(id)?.status)) return;
        if (button.dataset.armed !== 'yes') {
          for (const other of box.querySelectorAll('[data-reset]')) delete other.dataset.armed;
          button.dataset.armed = 'yes'; button.textContent = '再点一次确认';
          toast(`会给 ${button.dataset.email} 生成一个新密码，他所有设备会被登出。`, 'warn');
          return;
        }
        const entry = { email: button.dataset.email, password: suggestedPassword(), status: 'pending', note: '正在提交；请先不要把这个密码发给买家。' };
        passwordResets.set(id, entry); paintResets();
        resetHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        try {
          await post('admin-user-reset-password', { userId: id, newPassword: entry.password });
          entry.status = 'confirmed'; entry.note = '已确认重置成功，所有设备需要重新登录。';
        } catch (error) {
          entry.status = isWriteOutcomeUnknown(error) ? 'uncertain' : 'rejected';
          entry.note = entry.status === 'uncertain'
            ? `结果待核对：${error.message} 本次密码仍保留在这里；不要再次生成。请先核对账号状态和本次重置结果。`
            : `本次重置未获确认：${error.message}`;
        } finally {
          paintPasswordResets(); delete button.dataset.armed; button.textContent = '重置密码';
        }
      });
    }
    // 「谁在看」是按片反查的，纠纷要的是另一个方向：这个账号看过哪些片、在哪台设备上看。
    // 一次只读一个买家，不预先给整份名单拉观看记录。每次取 200 行，取满了要给"看更早的"。
    const activityBox = box.querySelector('#m-activity');
    let activity = null;
    const activityRows = (target) => `<div class="table-wrap"><table class="table"><thead><tr><th>教学影像名称</th><th>看到哪儿</th><th>方式</th><th>哪台设备</th><th>最近</th></tr></thead>
      <tbody>${target.items.map((row) => `<tr>
        <td>${esc(row.title)}</td>
        <td class="tiny">${watchedLine(row.position, row.duration) || '这节只打开过，进度还没报上来。'}</td>
        <td>${row.access === 'full' ? '完整版' : '试看'}</td>
        <td class="tiny">${esc(row.devices.map((device) => device.label || '认不出这台设备').join('、'))}</td>
        <td class="num tiny">${fmtDate(row.updatedAt)}</td></tr>`).join('')}</tbody></table></div>`;
    const markActivityButtons = (userId) => {
      for (const button of box.querySelectorAll('[data-activity]')) {
        const open = button.dataset.activity === userId;
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        button.classList.toggle('is-open', open);
      }
    };
    const closeActivity = () => {
      activity = null;
      activityBox.innerHTML = '';
      markActivityButtons('');
    };
    const drawActivity = (target) => {
      const oldest = target.items.length > 0 ? target.items[target.items.length - 1].updatedAt : null;
      activityBox.innerHTML = `<div class="act-head"><h3>${esc(target.email)} 的观看记录</h3>
        <button class="btn btn-sm btn-ghost" id="m-activity-close" type="button">收起</button></div>`
        + (target.items.length === 0 ? '<p class="dim tiny">这个账号还没有报过观看进度。</p>' : activityRows(target))
        + (target.hasMore
          ? `<div class="row" style="gap:10px;align-items:center;margin-top:10px">
              <button class="btn btn-sm btn-ghost" id="m-activity-more" type="button">看更早的 200 条</button>
              <span class="tiny dim">已列出 ${target.items.length} 节，最早到 ${oldest ? fmtDate(oldest) : '—'}；更早的还没取过来。</span></div>`
          : `<p class="tiny dim">已列到最早一条，共 ${target.items.length} 节。</p>`);
      labelTableCells(activityBox);
      activityBox.querySelector('#m-activity-close')?.addEventListener('click', closeActivity);
      const more = activityBox.querySelector('#m-activity-more');
      more?.addEventListener('click', async () => {
        more.disabled = true;
        more.textContent = '正在取…';
        try {
          await fetchActivity(target, target.cursor ?? {});
          if (activity !== target) return;
          drawActivity(target);
        } catch (error) {
          if (activity !== target) return;
          more.disabled = false;
          more.textContent = '看更早的 200 条';
          toast(error.message, 'bad');
        }
      });
    };
    async function fetchActivity(target, extra = {}) {
      const list = await get('admin-member-activity', { userId: target.userId, ...extra });
      // 上一页已经把这一节片的最新位置报过了，重复出现只保留先到的那条。
      const known = new Set(target.items.map((item) => item.videoId));
      target.items.push(...list.items.filter((item) => !known.has(item.videoId)));
      target.hasMore = list.hasMore;
      target.cursor = list.nextCursor;
    }
    for (const button of box.querySelectorAll('[data-activity]')) {
      button.addEventListener('click', async () => {
        // 再点一次同一列 = 收回去，不然名单越长越要滚：展开的那块在表格底下。
        if (activity && activity.userId === button.dataset.activity) {
          closeActivity();
          return;
        }
        const email = button.dataset.email;
        const target = { userId: button.dataset.activity, email, items: [], hasMore: false, cursor: null };
        button.disabled = true;
        activity = target;
        markActivityButtons(target.userId);
        activityBox.innerHTML = `<p class="tiny dim">正在读 ${esc(email)} 的观看记录…</p>`;
        try {
          await fetchActivity(target);
          if (activity !== target) return;
          drawActivity(target);
          // 结果整块在表格下面，手机上一屏装不下，不滚过来等于没显示。
          activityBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (error) {
          if (activity !== target) return;
          closeActivity();
          activityBox.innerHTML = `<div class="note note-bad">${esc(error.message)}</div>`;
        } finally {
          button.disabled = false;
        }
      });
    }
    for (const button of box.querySelectorAll('[data-user-toggle]')) {
      button.addEventListener('click', async () => {
        if (!owns() || button.disabled) return;
        const userId = button.dataset.userToggle;
        if (memberWrites.toggle.has(userId)) return;
        const disable = button.dataset.disabled === 'no';
        if (!confirm(disable
          ? `停用 ${button.dataset.email}？它会立即无法登录，正在播放的完整版也会中断。会员记录保留，恢复后继续有效。\n从「购买记录」里给它出过、还没兑换的激活码会一起冻结（恢复账号自动解冻）。`
          : `恢复 ${button.dataset.email} 的登录和观看？被这次停用冻住的激活码会一起解冻。`)) return;
        memberWrites.toggle.add(userId);
        paintWrites();
        try {
          const result = await post(disable ? 'admin-user-disable' : 'admin-user-enable', { userId });
          const codes = disable ? Number(result.frozenCodes ?? 0) : Number(result.thawedCodes ?? 0);
          if (owns()) {
            toast(disable
              ? `账号已停用，它的设备会话同时作废。${codes ? `一起冻住了 ${codes} 枚没兑换的码。` : '没有待冻结的码（只有从「购买记录」里绑单出的码才会被冻）。'}`
              : `账号已恢复。${codes ? `解冻了 ${codes} 枚码。` : ''}`);
            await draw();
          }
        } catch (error) {
          if (owns()) toast(error.message, 'bad');
        } finally {
          memberWrites.toggle.delete(userId);
          paintMemberWrites();
        }
      });
    }
    for (const button of box.querySelectorAll('[data-save-note]')) {
      button.addEventListener('click', async () => {
        if (!owns() || button.disabled) return;
        const id = button.dataset.saveNote;
        if (memberWrites.note.has(id)) return;
        const row = button.closest('[data-account-id]');
        const note = row.querySelector(`[data-note-for="${id}"]`)?.value ?? '';
        const contactQq = row.querySelector(`[data-qq-for="${id}"]`)?.value ?? '';
        // No redraw: the owner may be mid-edit on another row, and these two inputs
        // already hold exactly what was saved.
        memberWrites.note.add(id);
        paintWrites();
        try {
          const saved = await post('admin-user-note', {
            userId: id,
            note, contactQq,
          });
          if (owns()) {
            for (const [key, value, submitted] of [['data-note-for', saved.note, note], ['data-qq-for', saved.contactQq, contactQq]]) {
              for (const input of box.querySelectorAll(`[${key}="${id}"]`)) {
                if (input.value === input.defaultValue || input.value === submitted) input.value = value;
                input.defaultValue = value;
              }
            }
            for (const label of box.querySelectorAll(`[data-account-note="${id}"]`)) label.textContent = `${saved.note || '暂无备注'}${saved.contactQq ? ` · QQ ${saved.contactQq}` : ''}`;
            toast('已保存这位用户的备注和 QQ。');
          }
        } catch (error) {
          if (owns()) toast(error.message, 'bad');
        } finally {
          memberWrites.note.delete(id);
          paintMemberWrites();
        }
      });
    }
    for (const button of box.querySelectorAll('[data-revoke]')) {
      button.addEventListener('click', async () => {
        if (!owns() || button.disabled) return;
        const which = button.dataset.label ?? '这条会员';
        if (!confirm(`撤销${which}？只撤销这一条权益；账号其它未到期且未撤销的权益继续按原规则生效。本页不一定包含这个账号的全部记录。`)) return;
        button.disabled = true;
        try {
          await post('admin-member-revoke', { id: button.dataset.revoke });
          toast('已撤销这一条权益。该账号还能看什么，以其余有效权益为准。');
          if (owns()) await draw();
        } catch (error) {
          toast(error.message, 'bad');
          button.disabled = false;
        }
      });
    }
    for (const row of accounts.items) {
      const card = box.querySelector(`[data-account-id="${row.user.id}"]`);
      bindEntitlementEditor(card, row, {
        save: values => post('admin-account-entitlement', values),
        refresh: async () => { toast('已更新会员等级和有效期'); if (owns()) await readMembers(); },
      });
    }
  }

  // ---------------------------------------------------------------- requests
  async function requestsTab(box) {
    const [data, planRows] = await Promise.all([get('admin-requests', { limit: 100 }), get('admin-plans')]);
    if (!box.isConnected) return;
    const plans = planRows.plans ?? [];
    const email = saleDraft || '';
    saleDraft = null;
    box.innerHTML = `
      <section class="panel stack">
        <div class="section-title"><h2>购买记录</h2>
          <p class="tiny dim">前台已经不让买家填表了。在 QQ 谈好后在这里记一笔，出码后点「已成交」。</p></div>
        <form class="row" id="manual-request"${email ? ' data-prefilled' : ''} style="gap:10px;align-items:flex-end">
          <div class="field" style="flex:1 1 220px"><label for="mr-email">买家邮箱</label>
            <input class="input" id="mr-email" value="${esc(email)}" type="email" inputmode="email" autocomplete="off" placeholder="对方要用来注册的那个邮箱" /></div>
          <div class="field" style="flex:1 1 150px"><label for="mr-plan">档位</label>
            <select class="input" id="mr-plan">${plans.map((plan) => `<option value="${esc(plan.code)}">${esc(plan.name)}</option>`).join('')}</select></div>
          <div class="field" style="flex:1 1 200px"><label for="mr-note">备注（选填）</label>
            <input class="input" id="mr-note" maxlength="300" placeholder="例如：B站评论区来的" /></div>
          <div class="field" style="flex:0 0 auto"><button class="btn btn-primary" type="submit">记一笔</button></div>
        </form>
        ${data.items.length === 0 ? '<p class="dim">还没有记录。谈成一单就在这里记一条。</p>' : `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>编号</th><th>邮箱</th><th>档位</th><th>QQ</th><th>留言</th><th>时间</th><th>状态</th><th></th></tr></thead>
          <tbody>${data.items.map((row) => `<tr>
            <td class="mono tiny">${esc(row.reference)}</td>
            <td class="mono tiny">${esc(row.email)}</td><td>${esc(row.plan?.name ?? '—')}</td>
            <td class="mono tiny">${esc(row.contactQq ?? '')}</td>
            <td class="tiny" style="max-width:260px">${esc(row.note ?? '')}</td>
            <td class="num tiny">${fmtDate(row.createdAt)}</td>
            <td><span class="pill ${row.status === 'new' ? 'pill-acid' : row.status === 'done' ? 'pill-good' : ''}">${requestStatus(row.status)}</span>
              ${row.codes ? `<div class="tiny dim" style="margin-top:4px">这单的码：${row.codes.total} 枚 · 未兑换 ${row.codes.unused} · 已兑换 ${row.codes.redeemed}${row.codes.revoked ? ` · 已作废 ${row.codes.revoked}` : ''}${row.codes.frozen ? ` · 已冻结 ${row.codes.frozen}` : ''}（码尾 ${esc(row.codes.tails.join('、'))}）</div>` : '<div class="tiny dim" style="margin-top:4px">还没给这单出过码</div>'}</td>
            <td><div class="row" style="gap:6px">
              <button class="btn btn-sm" data-status="quoted" data-id="${esc(row.id)}">已报价</button>
              <button class="btn btn-sm btn-primary" data-status="done" data-id="${esc(row.id)}">已成交</button>
              <button class="btn btn-sm btn-ghost" data-issue="${esc(row.id)}" data-plan="${esc(row.plan?.code ?? '')}" data-email="${esc(row.email ?? '')}" data-ref="${esc(row.reference ?? '')}"${row.plan?.code ? '' : ' disabled'} type="button">给这单出码</button>
              <button class="btn btn-sm btn-ghost" data-status="cancelled" data-id="${esc(row.id)}">作废</button>
            </div></td>
          </tr>`).join('')}</tbody></table></div>`}
      </section>`;
    document.getElementById('manual-request')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type=submit]');
      const payload = {
        email: form.querySelector('#mr-email').value,
        planCode: form.querySelector('#mr-plan').value,
        note: form.querySelector('#mr-note').value,
      };
      button.disabled = true;
      try {
        const created = await post('admin-request-create', payload);
        toast(`已记下 ${created.email}（${created.plan.name}），编号 ${created.reference}。出码后点「已成交」。`);
        await draw();
      } catch (error) {
        toast(error.message, 'bad');
        button.disabled = false;
      }
    });
    for (const button of box.querySelectorAll('[data-status]')) {
      button.addEventListener('click', async () => {
        try {
          await post('admin-request-update', { id: button.dataset.id, status: button.dataset.status });
          await draw();
        } catch (error) {
          toast(error.message, 'bad');
        }
      });
    }
    // 从这一单出码，码就和单绑上：只有绑了，停用买家时才知道该冻哪几枚码。
    for (const button of box.querySelectorAll('[data-issue]')) {
      button.addEventListener('click', async () => {
        if (!confirm(`给 ${button.dataset.email} 出一枚「${button.dataset.plan}」？\n这一枚码会和该单绑定：以后停用这个账号时，没兑换的码一起冻结。`)) return;
        button.disabled = true;
        try {
          const issued = await post('admin-keys-create', {
            planCode: button.dataset.plan, count: 1, requestId: button.dataset.issue,
            note: `单 ${button.dataset.ref}`,
          });
          const code = issued.keys?.[0]?.code ?? '';
          const cell = button.closest('td');
          cell.innerHTML = `<div class="row" style="gap:6px;align-items:center">
            <code class="mono">${esc(code)}</code>
            <button class="btn btn-sm btn-ghost" data-copy-code type="button">复制</button></div>
            <p class="tiny dim">已和这一单绑定。停用这个买家时，这枚没兑换的码会一起冻结。</p>`;
          cell.querySelector('[data-copy-code]')?.addEventListener('click', async () => {
            if (await copyText(code)) toast('码已复制，直接发给买家。');
            else toast('这个浏览器不让网页写剪贴板，请长按上面那串码手动复制。', 'bad');
          });
        } catch (error) {
          toast(error.message, 'bad');
          button.disabled = false;
        }
      });
    }
  }

  function requestStatus(status) {
    return { new: '待处理', quoted: '已报价', done: '已成交', cancelled: '已作废' }[status] ?? status;
  }

  // ------------------------------------------------------------------- plans
  async function plansTab(box) {
    const data = await get('admin-plans');
    const plans = data.plans ?? [];
    box.innerHTML = `
      <section class="panel stack">
        <div class="section-title"><h2>档位定义</h2>
          <p class="tiny dim">等级数字决定谁能看完整版：视频要求「等级 ≤ 你的等级」。同一个等级可以放多个档位（例如月卡和季卡内容相同、只是天数不同）。改完档位要重新生成对应档位的码。</p></div>
        ${data.settingsTampered ? '<div class="note note-bad">站点设置与签名不一致，前台已退回默认文案。</div>' : ''}
        ${plans.length === 0 ? `<div class="note note-warn">还没有档位。前台购买页会显示「档位价格见购买页」，也还不能出码。
          <button class="btn btn-sm btn-primary" type="button" id="seed" style="margin-left:8px">按默认档位建月卡、季卡、年卡</button></div>` : ''}
        ${plans.some((plan) => plan.authentic === false) ? `<div class="note note-bad">有 ${plans.filter((plan) => plan.authentic === false).length} 档的签名与内容不一致：
          前台购买页会把这几档直接不显示（不是显示旧价），在这一格改回任意值再保存一次即可重签。</div>` : ''}
        <div class="table-wrap"><table class="table">
          <thead><tr><th>代码</th><th>名称</th><th>等级</th><th>价格（元）</th><th>天数</th><th>排序</th><th>说明</th><th>启用</th><th></th></tr></thead>
          <tbody>${plans.map((plan) => `<tr data-code="${esc(plan.code)}">
            <td class="mono tiny">${esc(plan.code)}${plan.authentic === false ? ' <span class="pill pill-bad">签名不对</span>' : ''}</td>
            <td><input class="input" data-f="name" value="${esc(plan.name)}" style="width:110px;padding:6px 8px" /></td>
            <td><input class="input num" data-f="rank" type="number" min="1" max="90" value="${esc(plan.tier_rank)}" style="width:64px;padding:6px 8px" /></td>
            <td><input class="input num" data-f="priceYuan" type="number" min="0" step="0.01" value="${((Number(plan.price_cents) || 0) / 100).toFixed(2)}" style="width:96px;padding:6px 8px" /></td>
            <td><input class="input num" data-f="durationDays" type="number" min="1" value="${plan.duration_days ?? ''}" placeholder="留空=永久" style="width:96px;padding:6px 8px" /></td>
            <td><input class="input num" data-f="sortOrder" type="number" value="${esc(plan.sort_order ?? plan.rank * 10)}" style="width:66px;padding:6px 8px" /></td>
            <td><input class="input" data-f="description" value="${esc(plan.description ?? '')}" style="width:180px;padding:6px 8px" /></td>
            <td><input type="checkbox" data-f="enabled" ${plan.enabled !== false ? 'checked' : ''} /></td>
            <td><button class="btn btn-sm btn-primary" data-save>保存</button></td>
          </tr>`).join('')}</tbody></table></div>
        <form class="row" id="new-plan" style="gap:8px">
          <div class="field" style="flex:1 1 120px"><label for="np-code">新档位代码</label><input class="input mono" id="np-code" name="code" placeholder="halfyear" /></div>
          <div class="field" style="flex:1 1 120px"><label for="np-name">名称</label><input class="input" id="np-name" name="name" placeholder="半年卡" /></div>
          <div class="field" style="flex:0 1 90px"><label for="np-rank">等级</label><input class="input num" id="np-rank" name="rank" type="number" value="2" /></div>
          <div class="field" style="flex:0 1 110px"><label for="np-days">天数</label><input class="input num" id="np-days" name="durationDays" type="number" value="180" /></div>
          <div class="field" style="flex:0 1 110px"><label for="np-price">价格（元）</label><input class="input num" id="np-price" name="priceYuan" type="number" step="0.01" value="159" /></div>
          <button class="btn" type="submit" style="align-self:end">新增档位</button>
        </form>
      </section>`;

    for (const row of box.querySelectorAll('tr[data-code]')) {
      row.querySelector('[data-save]').addEventListener('click', async () => {
        const value = (field) => row.querySelector(`[data-f="${field}"]`)?.value ?? '';
        const body = {
          code: row.dataset.code,
          name: value('name'),
          rank: Number(value('rank')),
          priceCents: Math.round(Number(value('priceYuan')) * 100),
          durationDays: value('durationDays') === '' ? null : Number(value('durationDays')),
          sortOrder: Number(value('sortOrder')),
          description: value('description'),
          enabled: row.querySelector('[data-f="enabled"]').checked,
        };
        try {
          await post('admin-plan-save', body);
          toast(`${body.name} 已保存。改档位后请重新生成对应码。`);
          await reloadBoot();
          await draw();
        } catch (error) {
          toast(error.message, 'bad');
        }
      });
    }
    document.getElementById('seed')?.addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        const result = await post('admin-plans-seed', {});
        toast(result.created.length ? `已建立：${result.created.join('、')}` : '三档都已存在，没有重复创建。');
        await reloadBoot();
        await draw();
      } catch (error) {
        toast(error.message, 'bad');
        event.target.disabled = false;
      }
    });
    document.getElementById('new-plan').addEventListener('submit', async (event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      try {
        await post('admin-plan-save', {
          code: fields.code, name: fields.name, rank: Number(fields.rank),
          durationDays: Number(fields.durationDays), priceCents: Math.round(Number(fields.priceYuan) * 100),
          enabled: true, description: '', sortOrder: Number(fields.rank) * 10,
        });
        toast('档位已新增。');
        await draw();
      } catch (error) {
        toast(error.message, 'bad');
      }
    });
  }

  // ---------------------------------------------------------------- settings
  async function settingsTab(box) {
    const data = await get('admin-settings');
    const values = data.values ?? {};
    box.innerHTML = `
      <section class="panel stack" style="max-width:760px">
        <div class="section-title"><h2>站点设置</h2>
          <p class="tiny dim">这些文字会出现在前台的站名、首页、页脚、购买说明和播放器水印上，改完立即生效。</p></div>
        ${data.tampered ? '<div class="note note-bad">已有设置与签名不一致，保存一次即可恢复。</div>' : ''}
        <form class="stack" id="settings">
          <div class="row" style="gap:12px">
            <div class="field" style="flex:1 1 200px"><label for="s-brand">站名</label><input class="input" id="s-brand" name="brand" maxlength="40" value="${esc(values.brand)}" /></div>
            <div class="field" style="flex:1 1 160px"><label for="s-qq">购买 QQ 号（前台所有「请联系站长」的话都用它）</label><input class="input mono" id="s-qq" name="contact_qq" inputmode="numeric" maxlength="12" value="${esc(values.contact_qq)}" /></div>
          </div>
          <div class="field"><label for="s-brand-line">副标题（站名下面那行英文，浏览器标签页标题也用它）</label>
            <input class="input" id="s-brand-line" name="brand_line" maxlength="40" value="${esc(values.brand_line)}" /></div>
          <div class="field"><label for="s-wm">水印前缀（出现在画面上，账号邮箱会自动接在后面）</label>
            <input class="input" id="s-wm" name="watermark_prefix" maxlength="60" value="${esc(values.watermark_prefix)}" />
            <p class="tiny dim">换 QQ 时这里要一起改：上面那个号是给买家看的联系方式，这个号烧在每一条画面上。只改一处，被人转走的录屏里就还留着旧号。</p></div>
          <div class="field"><label for="s-promo">宣传语（首页那行大字下面、以及页脚第一句）</label>
            <textarea class="input" id="s-promo" name="promo_line" maxlength="200">${esc(values.promo_line)}</textarea></div>
          <div class="field"><label for="s-steps">购买说明</label>
            <textarea class="input" id="s-steps" name="purchase_steps" maxlength="600">${esc(values.purchase_steps)}</textarea></div>
          <div class="row" style="gap:12px">
            <div class="field" style="flex:1"><label for="s-preview">新视频默认试看（秒）</label>
              <input class="input num" id="s-preview" name="default_preview_seconds" type="number" min="0" max="3600" step="10" value="${esc(values.default_preview_seconds)}" /></div>
            <div class="field" style="flex:1"><label for="s-sessions">一个账号最多几个设备同时在线</label>
              <input class="input num" id="s-sessions" name="max_active_sessions" type="number" min="1" max="20" value="${esc(values.max_active_sessions)}" /></div>
            <div class="field" style="flex:1"><label for="s-streams">一个账号同时能开几路完整播放</label>
              <input class="input num" id="s-streams" name="max_concurrent_streams" type="number" min="1" max="8" value="${esc(values.max_concurrent_streams)}" />
              <p class="tiny dim">端口一共 20 Mbps，一条高清约 2.8 Mbps。写大于 7 并不会更顺，只会让更多人不卡谁 —— 用户那边一起变成"几秒卡一次"。</p></div>
          </div>
          <button class="btn btn-primary" type="submit">保存设置</button>
        </form>
      </section>`;
    document.getElementById('settings').addEventListener('submit', async (event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      fields.default_preview_seconds = Number(fields.default_preview_seconds);
      fields.max_active_sessions = Number(fields.max_active_sessions);
      fields.max_concurrent_streams = Number(fields.max_concurrent_streams);
      try {
        await post('admin-settings-save', fields);
        toast('设置已保存。');
        await reloadBoot();
      } catch (error) {
        toast(error.message, 'bad');
      }
    });

    const admins = await get('admin-admins');
    // 名单上只有邮箱的时候，"移除哪一条"要靠站长自己回忆——临时账号就是这么漏下的。
    // 逐个按邮箱精确查账号（不是翻一页账号列表）：列表分页时后面的账号会被漏掉，
    // 那时候"没有这个账号"就成了假话。
    const looked = await Promise.all(admins.emails.map((email) => get('admin-accounts', { q: email, limit: 5 })
      .then((data) => (data.items ?? []).find((row) => String(row.user?.email).toLowerCase() === String(email).toLowerCase()) ?? null)
      .catch(() => null)));
    const byEmail = new Map(admins.emails.map((email, index) => [String(email).toLowerCase(), looked[index]]));
    box.insertAdjacentHTML('beforeend', `
      <section class="panel stack" style="max-width:760px">
        <div class="section-title"><h2>管理员名单（${admins.emails.length} / ${admins.max}）</h2>
          <p class="tiny dim">名单里的邮箱都能进后台、发激活码、改设置。地址存在站点的私有配置里，不在数据库表里，所以直接改数据库提不了权。</p></div>
        <ul style="list-style:none;padding:0;margin:0;display:grid;gap:6px">${admins.emails.map((email) => {
          const account = byEmail.get(String(email).toLowerCase());
          const note = account
            ? (account.disabledAt ? ' <span class="pill pill-bad">账号已停用</span>' : ` <span class="pill">已注册 ${esc(fmtDate(account.registeredAt) ?? '')}</span>`)
            : ' <span class="pill pill-warn">没有这个账号</span>';
          return `<li class="spread">
          <span class="mono tiny">${esc(email)}${String(email).toLowerCase() === String(state.boot.viewer?.email).toLowerCase() ? ' <span class="pill pill-good">你</span>' : ''}${note}</span>
          <button class="btn btn-sm btn-ghost" data-revoke-admin="${esc(email)}">移除</button></li>`;
        }).join('')}</ul>
        <p class="tiny dim">「移除」只是取消后台权限，那个账号还能正常观看教学影像，它已登录的设备会在下一分钟内失效；要同时取消观看权限，去「注册账号」里停用它。名单至少保留一个地址，也不能移除你自己。用完的临时账号请尽早移掉。</p>
        <form class="row" id="admin-add" style="align-items:flex-end;gap:10px">
          <div class="field" style="flex:1 1 260px"><label for="admin-email">再加一个管理邮箱</label>
            <input class="input mono" id="admin-email" name="email" type="email" maxlength="120" placeholder="user@example.com" /></div>
          <button class="btn" type="submit">加入名单</button>
        </form>
      </section>`);

    const addForm = box.querySelector('#admin-add');
    addForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = new FormData(addForm).get('email')?.toString() ?? '';
      // 打错一个字母的邮箱会安静地躺在名单里，而"能不能进后台"取决于它有没有对应的账号。
      // 所以先查一次：查不到账号就要他当面确认一遍再提交。
      const found = await get('admin-accounts', { q: email, limit: 5 }).catch(() => null);
      const wanted = email.trim().toLowerCase();
      const known = (found?.items ?? []).some((row) => String(row.user?.email).toLowerCase() === wanted);
      if (!known && !window.confirm(`${wanted} 还没有注册过账号。他必须先注册并登录一次才进得了后台；名单里留一个不存在的邮箱，等于给自己留一个谁都进不去的位置。确定现在就加吗？`)) return;
      try {
        await post('admin-admin-grant', { email });
        toast(`${email} 已加入管理员名单。`);
        await draw();
      } catch (error) {
        toast(error.message, 'bad');
      }
    });
    for (const button of box.querySelectorAll('[data-revoke-admin]')) {
      button.addEventListener('click', async () => {
        const email = button.dataset.revokeAdmin;
        if (!confirm(`把 ${email} 移出管理员名单？它会立刻进不了后台。`)) return;
        button.disabled = true;
        try {
          await post('admin-admin-revoke', { email });
          toast(`${email} 已移出管理员名单。`);
          await draw();
        } catch (error) {
          toast(error.message, 'bad');
          button.disabled = false;
        }
      });
    }
  }

  // ------------------------------------------------------------------- audit
  // 日志里的动作码是给开发看的，站长要读的是"谁在什么时候动了哪条"。
  const AUDIT_LABELS = {
    register: '注册了新账号',
    login_fail: '登录没成功（密码错或被锁）',
    redeem: '兑换了激活码',
    redeem_fail: '激活码没兑换成功',
    redeem_incomplete: '兑换成功但权益没写入，需要人工补',
    upload_start: '开始上传一条新教学影像',
    upload_complete: '一次上传完成并登记',
    export_rows: '导出了一张表的行（迁移用）',
    import_rows: '往这个站灌入了一批行（迁移用）',
    import_object: '灌入了一个存储对象（数据块或封面）',
    import_video_row: '登记了一条教学影像记录（迁移用）',
    upload_abort: '中止了一次上传',
    video_update: '改了视频设置',
    video_delete: '删了一条视频',
    keys_generate: '生成了激活码',
    key_revoke: '作废了一枚激活码',
    key_restore: '把一枚作废的激活码放回未兑换',
    purchase_request: '记下一笔成交',
    request_update: '改了成交状态',
    membership_revoke: '撤销了一条会员权益',
    membership_restore: '把一条撤销的会员权益重新生效',
    membership_adjust: '改了会员的有效天数',
    account_entitlement: '调整了用户等级和有效期',
    user_disable: '停用了某个账号',
    user_enable: '恢复了某个账号',
    user_note: '保存了买家备注',
    user_password_reset: '重置了某个账号的密码',
    session_revoke: '退出了一台登录设备',
    admin_case_ack: '在「待处理的违规」上记了一笔处理结果',
    admin_grant: '加了管理员邮箱',
    admin_revoke: '移除了管理员邮箱',
    settings_save: '保存了站点设置',
    lesson_series_save: '保存了合集与分集顺序',
    catalog_order_save: '保存了教学影像展示顺序',
    plan_save: '改了档位',
    plans_seed: '生成了默认档位',
    // 播放闸门和观众设备报上来的这几类：不加中文，日志里就直接印 `viewer_stall` 这种英文串，
    // 站长认不出来等于没记（详细解读在「用户行为」那一栏，这里只保证这一行读得出是什么）。
    media_bulk_grab: '有人被"整片拖走"判定掐住',
    media_bulk_partial: '有人比正常看快得多地取走大半（只记录，没掐）',
    media_partial_cut: '同一个人同一条片 24 小时内第二次取走大半，这一回已经掐断',
    media_library_sweep: '有人短时间内把半站的片各取走一大半（只记录，没掐）',
    media_preview_overrun: '有人试看时把地址里的段号往后加，被拒',
    media_wholefile_denied: '有人想去掉档位参数整片拿，被拒',
    media_stream_cap: '有人同时开的播放路数超了上限',
    media_byte_budget: '有人这一分钟往外发的量到顶了（不是当天上限，过完窗口就重新计）',
    viewer_quality_pick: '观众自己切了画质档位',
    viewer_quality_failed: '观众点了画质档位但没换成',
    viewer_auto_boost: '播放器按实测网速替他抬了一档（他自己没点）',
    viewer_auto_release: '抬上去之后缓冲跟不上，播放器自己退回了自动（他自己没点）',
    viewer_rendition: '观众屏幕上实际在跑的画质',
    viewer_stall: '观众设备报来的一阵卡顿',
    viewer_frag_rate: '观众那台设备实测的取段速度',
  };
  const AUDIT_FIELDS = {
    title: '标题',
    description: '说明',
    tier_rank: '需要等级',
    preview_seconds: '试看秒数',
    duration_seconds: '时长',
    kind: '类别',
    status: '状态',
    published_at: '发布时间',
    poster_path: '封面',
  };
  const auditDetail = (row) => (row.detail && typeof row.detail === 'object' ? row.detail : {});
  const auditWhat = (row) => {
    const detail = auditDetail(row);
    if (row.action === 'settings_save') return '站点设置';
    if (row.action === 'catalog_order_save') return '教学影像目录';
    if (row.action === 'plans_seed') return '档位设置';
    if (detail.title) return `《${detail.title}》`;
    if (row.targetTitle) return `《${row.targetTitle}》`;
    if (detail.email) return detail.email;
    if (/@/.test(String(row.target))) return row.target;
    // 记下成交 / 改成交状态：站长要认的是"这一单是谁"，档位是次要信息，写在括号里。
    if (row.targetEmail && (row.action === 'purchase_request' || row.action === 'request_update')) {
      const plan = row.planName || detail.plan || detail.code;
      return plan ? `${row.targetEmail}（${plan}）` : row.targetEmail;
    }
    if (row.targetEmail) return row.targetEmail;
    // 买家自己踢掉一台设备：站长要看的是哪一台，不是一串会话编号。
    if (row.action === 'session_revoke') return detail.device ? `设备「${detail.device}」` : '一台登录设备';
    // 注册、登录失败这类动作，"对象"就是操作者自己：再给一串编号只是噪音。
    if (row.target && row.target === row.actorId) return '本人';
    if (row.planName) return `档位 ${row.planName}`;
    if (detail.plan) return `档位 ${detail.plan}`;
    if (detail.code) return `档位 ${detail.code}`;
    if (row.targetTail) return `激活码尾号 ${row.targetTail}`;
    if (row.target) return `编号 ${String(row.target).slice(0, 8)}`;
    return '—';
  };
  const auditAction = (row) => {
    const label = AUDIT_LABELS[row.action] ?? row.action;
    const detail = auditDetail(row);
    if (row.action === 'account_entitlement') {
      const term = (rank, end) => rank ? rank + ' 级 · ' + (end ? fmtDate(end) : '永久') : '普通用户';
      return label + '，' + term(detail.fromRank, detail.from) + ' → ' + term(detail.rank, detail.to);
    }
    if (row.action === 'membership_adjust' && Number.isFinite(Number(detail.days))) {
      const days = Number(detail.days);
      return `${label}：${days > 0 ? '+' : ''}${days} 天${detail.to ? `，到 ${fmtDate(detail.to)}` : ''}`;
    }
    if (row.action === 'video_update') {
      const keys = Object.keys(detail);
      return keys.length > 0 ? `${label}：${keys.map((key) => AUDIT_FIELDS[key] ?? key).join('、')}` : label;
    }
    if (row.action === 'catalog_order_save') return `${label}：${Number(detail.count) || 0} 条教学影像`;
    if (row.action === 'request_update' && detail.status) {
      // 状态说法复用购买记录那一处，不另写一份映射表。
      return `${label}：${requestStatus(detail.status)}`;
    }
    if ((row.action === 'user_disable' || row.action === 'user_enable') && Number(detail.codes) > 0) {
      return `${label}，一起${row.action === 'user_disable' ? '冻住' : '解冻'}了 ${Number(detail.codes)} 枚未兑换的码`;
    }
    if (row.action === 'keys_generate' && detail.request) {
      return `${label}：绑给单 ${detail.request}`;
    }
    // 出码一次几十枚，站长要数的不是"生成了一批"，是这批有几枚。
    if (row.action === 'keys_generate' && Number.isFinite(Number(detail.count))) {
      return `${label}：${Number(detail.count)} 枚`;
    }
    if (row.action === 'plans_seed' && Array.isArray(detail.created)) {
      return `${label}：${detail.created.length} 档`;
    }
    return label;
  };

  async function auditTab(box, cursor = null, loaded = []) {
    const data = await get('admin-audit', cursor ?? {});
    const items = [...loaded, ...data.items];
    const oldest = items.length > 0 ? items[items.length - 1] : null;
    box.innerHTML = `
      <section class="panel stack">
        <div class="section-title"><h2>最近操作</h2>
          <p class="tiny dim">这里记的是动作、对象（买家邮箱、教学影像名称、档位名或编号）和网段前缀。密码、密钥和激活码原文不会写进来，激活码只留尾号。</p></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>时间</th><th>做了什么</th><th>对象</th><th>操作者</th><th>网段</th></tr></thead>
          <tbody>${items.map((row) => `<tr>
            <td class="num tiny">${fmtDate(row.createdAt)}</td><td class="tiny">${esc(auditAction(row))}</td>
            <td class="mono tiny">${esc(auditWhat(row))}</td><td class="mono tiny">${esc(row.actor)}</td>
            <td class="mono tiny">${esc(ipLabel(row.ip))}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="row" style="align-items:center">
          ${data.hasMore ? '<button class="btn btn-sm btn-ghost" id="audit-more" type="button">看更早的 100 条</button>' : ''}
          <p class="tiny dim">${oldest
    ? `已经列出 ${items.length} 条，最早到 ${fmtDate(oldest.createdAt)}${data.hasMore ? '；更早的还没取过来。' : '，到这里就是全部了。'}`
    : '还没有任何操作记录。'}</p>
        </div>
      </section>`;
    const more = box.querySelector('#audit-more');
    if (more) {
      more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          await auditTab(box, data.nextCursor, items);
        } catch (error) {
          // 翻页失败时这一批已经画在屏幕上，按钮必须还能再按一次。
          toast(error.message, 'bad');
          more.disabled = false;
        }
      });
    }
  }

  await draw();
  mountAdminWorkspace(view);
}
