import { get, post } from './api.js';
import { esc, fmtDuration, state, toast } from './app.js';
import { shouldReport, shouldFlush, canResumeFrom, reportStepSeconds } from './play-progress.mjs';
import { durationClock, membershipRequirement } from './lesson-card.mjs';
import { mountPlayerSeries } from './public-series.mjs';
import { mountVideoParts } from './video-parts.mjs';
import { copyText } from './clipboard.mjs';

export async function mountPlayer(view, { id, isCurrent = () => view.isConnected }) {
  let session;
  // `?as=<rank>` is an owner-only preview switch: an admin otherwise always resolves to the
  // full file, so the tier gate is invisible to the one person who configures it.
  const asRank = new URLSearchParams(self.location.search).get('as');
  const requestedSeries = new URLSearchParams(self.location.search).get('series') || '';
  const wanted = Number.isFinite(Number(asRank)) && asRank !== null && asRank !== '' ? Number(asRank) : null;
  try {
    session = await get('play', { v: id, as: wanted });
  } catch (error) {
    if (!isCurrent()) return;
    view.innerHTML = `<div class="wrap stack" style="max-width:620px">
      <h1>${error.code === 'video_not_found' ? '这条视频不存在或已下架' : '暂时打不开这条视频'}</h1>
      <p class="dim">${esc(error.message)}</p>
      <p><a class="btn" href="/library" data-link>回到教学影像库</a> ${error.code === 'login_required' ? '<a class="btn" href="/login" data-link>登录观看</a>' : ''}</p>
    </div>`;
    return;
  }

  if (!isCurrent()) return;
  const video = session.video;
  const isPreview = session.mode === 'preview';
  const previewSeconds = Number(video.previewSeconds) || 0;
  const totalSeconds = Number(video.durationSeconds) || 0;
  const lastPosition = Number(session.lastPosition) || 0;
  // 只有落在中间的位置才值得自动跳：开头几秒没有意义，快到底时跳过去反而像片子变短了。
  // 两个门限按片长算，写死 15/20 秒会让 30 秒的示范课永远接不上（见 play-progress.mjs）。
  const canResume = session.mode === 'full' && canResumeFrom(lastPosition, totalSeconds);
  const contactQq = state.boot?.settings?.contact_qq || '';
  view.innerHTML = `
    <div class="player-shell"><div class="player">
      <a class="watch-back" href="/library" data-link><span aria-hidden="true">←</span> 返回视频库</a>
      <div class="watch-screen">
      <div class="stage" id="stage">
        <video id="reel"${isPreview ? ` src="${esc(session.mediaUrl)}"` : ''}${session.posterUrl ? ` poster="${esc(session.posterUrl)}"` : ''}
               controls playsinline webkit-playsinline x5-playsinline preload="auto"
               controlsList="nodownload noremoteplayback" disablepictureinpicture
               disableremoteplayback aria-label="${esc(video.title)}"></video>
        ${isPreview ? '<div class="cut-note" id="cut-note" hidden></div>' : ''}
        <div class="wm" aria-hidden="true">
          <div class="wm-row wm-row-a"><div class="wm-track" id="wm-a"></div></div>
          <div class="wm-row wm-row-b"><div class="wm-track wm-track-rev" id="wm-b"></div></div>
        </div>
        <div class="paywall" id="paywall" hidden>
          <div>
            <h2 id="paywall-title">试看结束</h2>
            <p id="paywall-body">绑定激活码后即可观看完整内容。</p>
            <div class="row" style="justify-content:center">
              <a class="btn btn-primary" href="/pricing" data-link>看档位和价格</a>
              ${state.boot?.viewer ? '<a class="btn" href="/account" data-link>我有激活码，去绑定</a>' : '<a class="btn" href="/login" data-link>登录</a>'}
            </div>
            <p class="tiny dim" id="paywall-qq"${contactQq ? '' : ' hidden'}>购买咨询 · QQ <span class="mono">${esc(contactQq)}</span>
              <button class="btn btn-sm btn-ghost" type="button" id="paywall-copy">复制</button></p>
          </div>
        </div>
        <div class="paywall" id="stage-error" hidden>
          <div>
            <h2 id="stage-error-title">暂时无法播放</h2>
            <p id="stage-error-body">视频未能继续加载，请重新加载一次。</p>
            <div class="row" style="justify-content:center">
              <button class="btn btn-primary" type="button" id="stage-error-retry">重新加载</button>
              <button class="btn" type="button" id="stage-error-copy">复制页面链接</button>
              <a class="btn" id="stage-error-login" href="/login" data-link hidden>重新登录</a>
              <a class="btn" href="/library" data-link>返回视频库</a>
            </div>
            <p class="tiny dim"${contactQq ? '' : ' hidden'}>仍然无法播放？联系 QQ <span class="mono">${esc(contactQq)}</span>，说明教学影像名称和无法播放的位置。</p>
          </div>
        </div>
      </div>

      <div class="progress-line" aria-hidden="true"><i id="pbar" style="width:0%"></i>${isPreview && Number(video.durationSeconds) > 0
    ? `<i class="cut-tick" style="left:${Math.min(100, (previewSeconds / Number(video.durationSeconds)) * 100).toFixed(2)}%"></i>` : ''}</div>

      </div>
      <header class="watch-heading">
        <div class="watch-context"><span>${isPreview ? '试看 ' + fmtDuration(previewSeconds) : '完整版'}</span>
          <span>全片 ${durationClock(video.durationSeconds)}</span>
          ${isPreview ? `<span>${esc(membershipRequirement(video.tierRank))}可看全片</span>` : ''}</div>
        <h1>${esc(video.title)}</h1>
      </header>
      ${canResume ? `<div class="row" id="resume-note" style="gap:10px;align-items:center;margin-top:10px">
        <span class="tiny dim">上次看到 <span class="num mono">${fmtDuration(lastPosition)}</span>，已继续播放。</span>
        <button class="btn btn-sm" type="button" id="resume-restart">从头播放</button>
      </div>` : ''}

      <div id="video-parts" hidden></div>
      ${video.description ? `<div class="panel"><p class="dim">${esc(video.description)}</p></div>` : ''}
      ${state.boot?.privileged ? `<div class="panel stack">
        <div class="row" style="gap:8px;align-items:center">
          <span class="tiny dim">预览会员视角</span>
          ${[0, 1, 2, 3].map((rank) => `<a class="btn btn-sm${wanted === rank ? ' btn-primary' : ''}" href="/v/${esc(id)}?as=${rank}" data-link>等级 ${rank}</a>`).join('')}
          ${wanted === null ? '' : `<a class="btn btn-sm" href="/v/${esc(id)}" data-link>恢复管理员视图</a>`}
        </div>
        ${wanted === null ? '<p class="tiny dim">当前为管理员视角，可观看全部视频。</p>' : `<p class="tiny" style="color:var(--warn)">正在按等级 ${wanted} 模拟观看。关闭预览可返回管理员视角。</p>`}
      </div>` : ''}
    </div><aside class="series-player-sidebar" aria-label="分集导航" hidden></aside></div>`;

  const reel = document.getElementById('reel');
  const stage = document.getElementById('stage');
  const setSource = (next) => {
    if (next.mode === 'full') {
      if (window.BoxvaultPlayback) window.BoxvaultPlayback.set(reel, next);
      else { reel.dataset.playbackFailure = 'protected'; setTimeout(() => reel.dispatchEvent(new Event('error')), 0); }
    } else { reel.src = next.mediaUrl; reel.load(); }
  };
  const paywall = document.getElementById('paywall');
  const pbar = document.getElementById('pbar');
  const clearParts = mountVideoParts(document.getElementById('video-parts'), reel, {
    duration: totalSeconds, previewSeconds, isPreview,
  });

  if (canResume) {
    // currentTime 在元数据回来之前写了也不生效，所以两种就绪状态都要照顾到。
    const jump = () => { reel.currentTime = lastPosition; };
    if (reel.readyState >= 1) jump();
    else reel.addEventListener('loadedmetadata', jump, { once: true });
    document.getElementById('resume-restart').addEventListener('click', () => {
      reel.currentTime = 0;
      document.getElementById('resume-note').remove();
    });
  }

  const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `${session.watermark} · ${stamp()}`;
  for (const element of [document.getElementById('wm-a'), document.getElementById('wm-b')]) {
    element.innerHTML = Array.from({ length: 10 }, () => `<span>${esc(line)}</span>`).join('');
  }

  stage.addEventListener('contextmenu', (event) => event.preventDefault());
  document.getElementById('paywall-copy')?.addEventListener('click', async () => {
    if (contactQq === '未配置') return toast('后台还没有填写购买 QQ，请先在 站点设置 里补上。', 'bad');
    if (await copyText(contactQq)) toast(`QQ ${contactQq} 已复制。请发送教学影像名称和你的登录邮箱。`);
    else toast(`复制未完成。请长按上方的 QQ 号 ${contactQq} 手动复制，再发送教学影像名称和你的登录邮箱。`, 'bad');
  });

  let revealed = false;
  function revealPaywall(reason) {
    if (revealed) return;
    revealed = true;
    reel.pause?.();
    document.getElementById('paywall-title').textContent = reason === 'ended'
      ? `试看到 ${fmtDuration(previewSeconds)} 结束（完整教学影像 ${fmtDuration(video.durationSeconds)}）`
      : '试看部分到此为止';
    document.getElementById('paywall-body').textContent = reason === 'ended'
      ? `这条视频要求会员等级 ${video.tierRank}，你现在的等级不够，所以只能看前 ${fmtDuration(previewSeconds)}。绑定对应档位的激活码后可以看完整版本。`
      : `免费试看只发放前 ${fmtDuration(previewSeconds)}，后面 ${fmtDuration(Math.max(0, (Number(video.durationSeconds) || 0) - previewSeconds))} 的数据不会发给这个账号。继续观看需要绑定激活码。`;
    paywall.hidden = false;
  }

  reel.addEventListener('timeupdate', () => {
    const duration = Number.isFinite(reel.duration) && reel.duration > 0 ? reel.duration : video.durationSeconds;
    if (duration > 0) pbar.style.width = `${Math.min(100, (reel.currentTime / duration) * 100).toFixed(2)}%`;
    if (!isPreview || revealed) return;
    const note = document.getElementById('cut-note');
    const left = previewSeconds - reel.currentTime;
    // The player's own bar still shows the whole file, so without a countdown the cut
    // reads as a buffering stall. Say it is coming while there is time left on screen.
    if (note && left > 0 && left <= 5) {
      note.hidden = false;
      note.textContent = `试看还剩 ${Math.ceil(left)} 秒`;
    } else if (note && left <= 0) {
      note.hidden = true;
    }
    if (reel.currentTime >= previewSeconds - 0.4) revealPaywall('ended');
  });

  reel.addEventListener('ended', () => {
    if (isPreview) revealPaywall('ended');
  });

  // A truncated stream surfaces as a media error near the cut, not as a clean end.
  const showRecovery = () => {
    const box = document.getElementById('stage-error');
    // 付费墙已经说明过"到这儿为止"的时候不要再盖一层"没取到"：那是两件不同的事。
    if (!box || revealed) return;
    // 取流失败以前是"黑着转圈"，站长收到的反馈永远是"播放不了卡住了"：
    // 界面必须说清楚是没拿到数据，并给一条不用刷新整页的重试。
    const code = Number(reel.error?.code ?? 0);
    const kind = reel.dataset.playbackFailure || (code === 4 ? 'unsupported' : code === 3 ? 'decode' : 'network');
    // "换个浏览器看"这句话有四格失败要说，抄四份必漂（有一格改了、其余三格还指着旧说法）。
    const appleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent || '')
      || (/Macintosh/i.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1);
    const SWITCH_BROWSER = appleMobile
      ? '先更新 iOS/iPadOS 和浏览器后重试；若仍失败，改用电脑上的 Chrome 或 Edge 登录观看。同一台苹果手机更换浏览器，未必能补齐系统播放能力'
      : '改用电脑上的 Chrome 或 Edge，或手机上的系统自带浏览器，登录后重新打开这条页面';
    const messages = {
      protected: ['当前设备未能启用站内播放器', `完整版需要使用本站播放器。请先关闭云加速、视频增强或独立播放后重试；仍不行请${SWITCH_BROWSER}。`],
      processing: ['视频正在准备受保护版本', '完整版分段尚未准备好，请稍后再试；页面不会改用完整 MP4 下载地址。'],
      unsupported: ['当前浏览器的播放模式不兼容', `请在浏览器设置里关闭云加速或视频增强后重新打开；也可以${SWITCH_BROWSER}。`],
      native: ['当前浏览器尚未开始播放', `原生播放器暂未显示画面。请检查连接；若一直停在这里，可关闭云加速或视频增强，或${SWITCH_BROWSER}。`],
      authorization: ['播放授权未通过', '登录状态、会员权益或播放地址可能已失效。请重新登录；若已登录仍失败，请关闭浏览器的云加速或独立视频播放后再试。'],
      limited: ['播放请求暂时受限', '请关闭同一账号的其他播放窗口，稍后再试；连续重试不会解除限制。'],
      source: ['播放分段暂时不可用', '这段视频暂时无法读取，请稍后重试；若仍失败，请把视频名称和时间位置反馈给站长。'],
      decode: ['浏览器未能解码画面', `可能是当前内核与视频格式不兼容，也可能是传输数据不完整。请重试一次，仍失败请${SWITCH_BROWSER}。`],
      network: ['视频加载中断', '可能是连接中断或服务暂时不可用。请检查连接后重试，播放会尽量恢复到原位置。'],
    };
    const [title, body] = messages[kind] || messages.network;
    document.getElementById('stage-error-title').textContent = title;
    document.getElementById('stage-error-body').textContent = body;
    document.getElementById('stage-error-login').hidden = kind !== 'authorization';
    box.hidden = false;
    reel.pause?.();
  };
  reel.addEventListener('error', () => {
    if (isPreview && previewSeconds > 0 && reel.currentTime >= previewSeconds - 0.4) { revealPaywall('ended'); return; }
    showRecovery();
  });
  reel.addEventListener('stalled', () => {
    if (isPreview && previewSeconds > 0 && reel.currentTime >= previewSeconds - 0.4) revealPaywall('ended');
  });
  document.getElementById('stage-error-copy')?.addEventListener('click', async () => {
    // 只复制页面路径及合集上下文，绝不复制媒体地址、播放令牌或其他查询参数。
    const link = new URL(`/v/${encodeURIComponent(id)}`, location.origin);
    if (requestedSeries) link.searchParams.set('series', requestedSeries);
    try {
      await navigator.clipboard.writeText(link.href);
      toast('页面链接已复制；在其他浏览器打开后登录观看。');
    } catch {
      let input = document.getElementById('stage-error-link');
      if (!input) {
        input = document.createElement('input'); input.id = 'stage-error-link'; input.readOnly = true;
        input.setAttribute('aria-label', '可复制的页面链接'); input.style.width = '100%';
        document.getElementById('stage-error-body').after(input);
      }
      input.value = link.href; input.focus(); input.select();
      toast('请长按链接复制，再到其他浏览器打开。');
    }
  });
  document.getElementById('stage-error-retry')?.addEventListener('click', async () => {
    const box = document.getElementById('stage-error');
    const button = document.getElementById('stage-error-retry');
    const at = reel.currentTime;
    box.hidden = true;
    button.disabled = true;
    button.textContent = '正在重新取…';
    try {
      const next = await get('play', { v: id, as: wanted });
      if (!stage.isConnected) return;
      if (next.mode !== session.mode) { location.reload(); return; }
      session = next;
      // 换源会丢掉整个缓冲，所以先把位置记下来、装好新源再挪回去。
      reel.addEventListener('loadedmetadata', () => {
        reel.currentTime = at;
        void reel.play().catch(() => {});
      }, { once: true });
      setSource(next);
    } catch (error) {
      if (!stage.isConnected) return;
      showRecovery();
      toast(error?.message ?? '重新取还是没成功。', 'bad');
    } finally {
      button.disabled = false;
      button.textContent = '重新加载';
    }
  });

  let lastReported = Math.floor(reel.currentTime) || 0;
  // 这一步按片长算：14 分钟的复盘按 90 秒一跳要报 9 次，比取流还多；按四分之一片长（这里 210 秒）
  // 只要 4 次。五分钟以下的片子仍然 90 秒，短示范课的续播判据一个字没动（§117 的下限）。
  const reportStep = reportStepSeconds(totalSeconds);
  const report = async (force = false, init = {}) => {
    const count = Math.floor(reel.currentTime);
    // 定时那一跳只在攒够一步时才发。暂停/看完是"我看到这儿了"的时刻，值得一发，
    // 而它们按事件来，不会按秒烧请求额度。
    if (force ? count === lastReported : !shouldReport(count, lastReported, reportStep)) return;
    lastReported = count;
    try {
      await post('heartbeat', { videoId: video.id, position: count, mode: session.mode }, init);
    } catch {
      /* anonymous previews and revoked sessions simply stop reporting */
    }
  };
  const timer = window.setInterval(async () => {
    if (!reel.paused) await report();
    const age = new Date().toLocaleString('zh-CN', { hour12: false });
    for (const element of [document.getElementById('wm-a'), document.getElementById('wm-b')]) {
      element.innerHTML = Array.from({ length: 10 }, () => `<span>${esc(`${session.watermark} · ${age}`)}</span>`).join('');
    }
  }, 30000);
  reel.addEventListener('pause', () => { void report(true); });
  reel.addEventListener('ended', () => { void report(true); });

  // Short-lived media credentials are re-issued before they expire so a long
  // video keeps playing without ever exposing a durable URL.
  const renew = Math.max(60_000, (Number(session.expiresInSeconds) || 900) * 1000 - 60_000);
  const renewTimer = session.protectedPlayback ? null : window.setTimeout(async () => {
    window.clearInterval(timer);
    const at = reel.currentTime;
    const wasPlaying = !reel.paused;
    try {
      const next = await get('play', { v: id, as: wanted });
      if (!stage.isConnected) return;
      if (next.mode !== session.mode) { location.reload(); return; }
      setSource(next);
      session = next;
      reel.addEventListener('loadedmetadata', () => {
        reel.currentTime = at;
        if (wasPlaying) void reel.play().catch(() => {});
      }, { once: true });
    } catch {
      if (stage.isConnected) showRecovery();
    }
  }, renew);

  const cleanup = () => {
    if (!stage.isConnected) clearParts();
    window.clearInterval(timer);
    window.clearTimeout(renewTimer);
    window.BoxvaultPlayback?.release(reel);
    window.removeEventListener('pagehide', onPageHide);
  };
  const observer = new MutationObserver(() => {
    if (!stage.isConnected) {
      cleanup();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // 正在播着就离开（关标签页、跟别人说话去了）那一下，先把手上的进度交出去再收尾：
  // 定时那一跳按片长攒（长片最长 5 分钟一跳），直接关标签页的人不该被送回五分钟前。
  // 暂停着离开的不发 —— 暂停那一下已经发过了。keepalive 是唯一可能在页面卸载之后仍然发得出去的写法。
  function onPageHide(event) {
    if (!reel.paused && session.mode === 'full' && shouldFlush(reel.currentTime, lastReported)) {
      void report(true, { keepalive: true });
    }
    if (!event.persisted) cleanup();
  }
  window.addEventListener('pagehide', onPageHide);
  if (!isPreview) setSource(session);
  const seriesSidebar = view.querySelector('.series-player-sidebar');
  if (seriesSidebar) void mountPlayerSeries(seriesSidebar, { videoId: id, seriesId: requestedSeries, stage });
}
