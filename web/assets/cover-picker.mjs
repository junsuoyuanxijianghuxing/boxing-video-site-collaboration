import { api, post } from './api.js';

// Own one candidate panel. Candidates are private JPEGs; picking one uses the normal cover writer.
export function mountServerCoverPicker(host, { videoId, uploadCover, onSelected = () => {} }) {
  host.__coverPickerDispose?.();
  host.className = 'panel stack';
  const title = document.createElement('h3'); title.textContent = '从视频画面选封面';
  // 挂上去的那一张必须看得见。以前草稿的封面在站长屏幕上画不出来（观众那条路对草稿回 404），
  // "已经选好了"和"还没选"长得一模一样，他只能一遍遍重开这个面板。
  const current = document.createElement('div'); current.className = 'row'; current.hidden = true;
  const currentLabel = document.createElement('span'); currentLabel.className = 'tiny';
  const currentImg = document.createElement('img');
  currentImg.alt = '当前封面'; currentImg.decoding = 'async'; currentImg.width = 160; currentImg.height = 90;
  currentImg.style.cssText = 'width:160px;height:auto;aspect-ratio:16/9;object-fit:contain';
  current.append(currentLabel, currentImg);
  const note = document.createElement('p'); note.className = 'tiny dim';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px';
  const actions = document.createElement('div'); actions.className = 'row';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'btn btn-sm'; refresh.textContent = '刷新候选画面';
  const generate = document.createElement('button'); generate.type = 'button'; generate.className = 'btn btn-sm'; generate.textContent = '生成候选画面'; generate.hidden = true;
  actions.append(refresh, generate); host.replaceChildren(title, current, note, grid, actions);
  let dead = false, poll = null, reading = null, writing = null, sequence = 0, rendered = '', saving = false;
  const born = Date.now(), live = () => !dead && host.isConnected;
  const frameUrl = index => api('admin-poster-frame', { v: videoId, n: index });
  // 带一次性把手：连着换两张图时地址不变，no-store 之外再保证浏览器真的重取一次新那张。
  const showCurrent = () => {
    currentLabel.textContent = '当前封面：';
    currentImg.src = api('admin-poster', { v: videoId, t: Date.now() });
    current.hidden = false;
  };
  function stopRead() { clearTimeout(poll); reading?.abort(); ++sequence; }
  async function load() {
    if (!live() || saving || document.visibilityState === 'hidden') return;
    stopRead(); const version = sequence;
    const controller = new AbortController(); reading = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(api('admin-poster-frames', { v: videoId }), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw Error('候选画面暂时未取到，请刷新重试。');
      const result = await response.json();
      if (!live() || version !== sequence) return;
      const frames = (result.frames || []).filter(f => Number.isInteger(f.index) && f.index >= 0 && f.index < 6 && Number.isFinite(f.at));
      const key = JSON.stringify(frames);
      if (rendered !== key) {
        rendered = key; grid.replaceChildren();
        for (const frame of frames) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px';
          const image = document.createElement('img'); image.src = frameUrl(frame.index); image.alt = `视频第 ${frame.at} 秒画面`; image.decoding = 'async'; image.loading = 'lazy'; image.style.cssText = 'width:100%;height:auto;aspect-ratio:16/9;object-fit:contain';
          const label = document.createElement('span'); label.textContent = `使用第 ${frame.at} 秒这帧`;
          button.append(image, label); button.addEventListener('click', () => void choose(frame, button)); grid.append(button);
        }
      }
      generate.hidden = !['failed', 'missing'].includes(result.state);
      if (result.hasPoster) showCurrent(); else current.hidden = true;
      note.textContent = frames.length
        ? result.hasPoster
          ? `已有 ${frames.length} 张视频画面，上面那张就是当前封面。点别的画面会换成那一张。`
          : `已有 ${frames.length} 张视频画面。点击想用的那张才会设置封面，也可以保留之前选择的图片。`
        : result.state === 'failed' ? '服务器未取到候选画面，可重试生成；也可以手选图片，不用重传视频。'
        : '正在等待服务器提取视频画面，完成后会显示在这里；可以离开页面，稍后从处理状态打开。';
      if (!['ready', 'failed'].includes(result.state) && Date.now() - born < 180000) poll = setTimeout(() => void load(), 5000);
      else if (!frames.length && result.state !== 'failed') note.textContent = '后台仍在处理，稍后点击刷新候选画面。';
    } catch (error) { if (live() && version === sequence && error.name !== 'AbortError') note.textContent = error.message; }
    finally { clearTimeout(timeout); }
  }
  async function choose(frame, button) {
    if (saving || !live()) return;
    saving = true; stopRead(); const version = sequence;
    writing = new AbortController(); const controller = writing;
    const timeout = setTimeout(() => controller.abort(), 45000);
    for (const el of host.querySelectorAll('button')) el.disabled = true;
    note.textContent = '正在保存你选择的这一帧…';
    try {
      const response = await fetch(frameUrl(frame.index), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw Error('这帧暂时未取到，请重试。');
      const blob = await response.blob();
      if (blob.type !== 'image/jpeg' || !blob.size || blob.size > 512 * 1024) throw Error('候选图片不符合大小或格式要求。');
      if (!live() || version !== sequence || controller.signal.aborted) return;
      await uploadCover(videoId, new File([blob], 'cover.jpg', { type: 'image/jpeg' }), controller.signal);
      if (!live() || version !== sequence || controller.signal.aborted) return;
      for (const el of grid.querySelectorAll('button')) el.setAttribute('aria-pressed', String(el === button));
      showCurrent();
      note.textContent = `已将第 ${frame.at} 秒画面设为封面。视频无需重新上传。`;
      await onSelected();
    } catch (error) { if (live() && version === sequence) note.textContent = error.name === 'AbortError' ? '保存请求已中止，是否已生效请刷新管理列表核对。' : error.message; }
    finally {
      clearTimeout(timeout); saving = false;
      if (live()) for (const el of host.querySelectorAll('button')) el.disabled = false;
    }
  }
  refresh.addEventListener('click', () => void load());
  generate.addEventListener('click', async () => {
    if (!live() || saving) return;
    generate.disabled = true; writing = new AbortController();
    const controller = writing, timeout = setTimeout(() => controller.abort(), 12000);
    try { await post('admin-poster-generate', { videoId }, { signal: controller.signal }); if (live()) void load(); }
    catch (error) { if (live()) note.textContent = error.message; }
    finally { clearTimeout(timeout); if (live()) generate.disabled = false; }
  });
  const visible = () => {
    if (document.visibilityState === 'hidden') { stopRead(); writing?.abort(); if (saving) note.textContent = '保存请求已中止，是否已生效请刷新管理列表核对。'; }
    else void load();
  };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', dispose, { once: true });
  const observer = new MutationObserver(() => { if (!host.isConnected) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true });
  function dispose() { if (dead) return; dead = true; stopRead(); writing?.abort(); observer.disconnect(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', dispose); }
  host.__coverPickerDispose = dispose;
  void load(); return dispose;
}
