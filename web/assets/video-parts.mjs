// P 共享同一条视频、完整时间轴和观看进度。切 P 只 seek，让 HLS 按需取附近分段。
const PART_SECONDS = 240;
const time = n => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;

export function mountVideoParts(host, media, { duration, previewSeconds = 0, isPreview = false } = {}) {
  const total = Math.min(86400, Math.max(0, Number(duration) || 0));
  if (total <= PART_SECONDS) { host.hidden = true; return () => {}; }
  const count = Math.ceil(total / PART_SECONDS);
  host.hidden = false;
  host.className = 'panel stack';
  const title = document.createElement('strong');
  const note = document.createElement('p'); note.className = 'tiny dim';
  note.textContent = '每 P 最长 4 分钟，顺序连续播放；切换只加载附近的小段，完整进度会保留。';
  const list = document.createElement('nav'); list.setAttribute('aria-label', '视频分 P');
  list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;max-height:180px;overflow:auto';
  const buttons = [];
  for (let index = 0; index < count; index++) {
    const start = index * PART_SECONDS, end = Math.min(total, start + PART_SECONDS);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm';
    button.textContent = `P${index + 1} · ${time(start)}–${time(end)}`;
    button.disabled = isPreview && start >= previewSeconds;
    if (button.disabled) button.title = '这部分超出当前试看范围';
    button.addEventListener('click', () => {
      if (button.disabled || !host.isConnected) return;
      pending = start;
      seek();
    });
    buttons.push(button); list.append(button);
  }
  host.replaceChildren(title, list, note);
  let pending = null;
  function seek() {
    if (pending === null || media.readyState < 1) return;
    const position = pending; pending = null;
    media.currentTime = position;
    void media.play().catch(() => {});
    paint();
  }
  function paint() {
    const active = Math.min(count - 1, Math.max(0, Math.floor((media.currentTime || 0) / PART_SECONDS)));
    title.textContent = `分 P 播放 · P${active + 1} / ${count} · 完整时长 ${time(total)}`;
    buttons.forEach((button, index) => {
      button.classList.toggle('btn-primary', index === active);
      if (index === active) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  }
  media.addEventListener('timeupdate', paint);
  media.addEventListener('seeked', paint);
  media.addEventListener('loadedmetadata', seek);
  paint();
  return () => {
    pending = null;
    media.removeEventListener('timeupdate', paint);
    media.removeEventListener('seeked', paint);
    media.removeEventListener('loadedmetadata', seek);
  };
}
