// hls.js 1.5.17 (Apache-2.0). Full content uses MSE + session-bound request proof.
// Preview alone may use native HLS; no full native or MP4 fallback. This is not DRM.
(() => {
  // 主列表（hls=master）和单档媒体列表（hls=m3u8）都要接管：只认后者的话，
  // 两档齐全的片在安卓上会变成"没人接手"——症状是黑屏，而不是任何报错。
  const HLS_MARK = /[?&]hls=(m3u8|master)/;
  // Map 只持有正在接管的元素；离页或换源时立即释放，停止旧实例继续拉段。
  const bound = new Map();
  let lib = null;

  const UA = navigator.userAgent ?? '';
  // 苹果设备的试看保留原生 HLS 策略；完整版仍走带请求证明的受控播放器。
  // 与 hls.js 1.5.17 的 getMediaSource()/isSupported() 默认顺序保持一致。
  // 两种接口并存时仍选 MMS，不把另一接口的探测结果用于当前实例。
  const ANDROID = /\b(Android|Adr)\b/i.test(UA) && !/iPhone|iPad|iPod/i.test(UA);
  const MediaSourceType = [window.ManagedMediaSource, window.MediaSource, window.WebKitMediaSource]
    .find(source => typeof source === 'function');
  const MSE = Boolean(MediaSourceType);
  // 有 MediaSource 对象不代表能解码本站的 H.264。部分手机壳浏览器只暴露空接口。
  // 同时检查带引号和不带引号的形式，避免只因 MIME 写法差异排除可用内核。
  const mseAvc = () => {
    const source = MediaSourceType;
    try {
      const video = ['avc1.42E01E', 'avc1.640028', 'avc1.420010'].some(codec =>
        source?.isTypeSupported?.(`video/mp4;codecs="${codec}"`)
        || source?.isTypeSupported?.(`video/mp4;codecs=${codec}`));
      const audio = source?.isTypeSupported?.('audio/mp4;codecs="mp4a.40.2"')
        || source?.isTypeSupported?.('audio/mp4;codecs=mp4a.40.2');
      return video && audio;
    } catch { return false; }
  };
  const MSE_AVC = MSE && mseAvc();
  // 地址后面带 ?hlsjs=1 就强制走 hls.js、=0 就强制只走原生。留这两个开关有两个用处：
  // 买家那边"还是不行"时，让他加 ?hlsjs=1 再试一次就能把"是原生播不了还是这条片本身坏了"分开；
  // 我这边也能在桌面浏览器上把安卓那条路真跑一遍，而不是只能等他的手机。
  const FORCED = /[?&]hlsjs=(1|0)/.exec(location.search)?.[1] ?? '';
  const APPLE_NATIVE = /iPhone|iPad|iPod/i.test(UA)
    || (/Macintosh/i.test(UA) && navigator.maxTouchPoints > 1)
    || (/Safari/i.test(UA) && !/Chrome|Chromium|Edg|OPR|Android/i.test(UA));
  // 桌面 Chromium 同样会先试原生、再报错；有 MSE 就直接接管，省掉重复列表/分段和失败等待。
  const PROACTIVE = FORCED ? (FORCED === '1' && MSE) : (MSE_AVC && !APPLE_NATIVE);

  const videoIdOf = (url) => /[?&]v=([^&]+)/.exec(url)?.[1] ?? '-';
  const stateOf = (media) => `rs${media.readyState}ns${media.networkState}d${Number.isFinite(media.duration) ? Math.round(media.duration) : 'nan'}e${media.error?.code ?? 0}`;
  // src 属性先于 currentSrc 更新；快速换片时后者还可能指向上一条片的 Blob。
  const directSources = (media) => [...media.children].filter(node => node.tagName === 'SOURCE');
  const sourceOf = (media) => {
    const explicit = media.getAttribute('src');
    if (explicit !== null) return explicit;
    const entry = bound.get(media);
    if (entry?.sourceNode?.parentElement === media && entry.sourceNode.getAttribute('src') === entry.blobUrl)
      return entry.blobUrl;
    return media.currentSrc ?? '';
  };
  // MMS attaches a source child. Own this attach's exact node and URL, without
  // trusting an arbitrary Blob or the asynchronously updated currentSrc.
  const ownsBlobSource = (media, entry) => {
    const explicit = media.getAttribute('src') || '';
    const sources = directSources(media);
    return entry.sourceNode
      ? !explicit && sources.length === 1 && sources[0] === entry.sourceNode
        && entry.sourceNode.getAttribute('src') === entry.blobUrl
      : explicit === entry.blobUrl && sources.length === 0;
  };
  function bindAttachedSource(media, entry, client, previousSources) {
    if (!owns(media, entry) || entry.givenup || entry.client !== client) return false;
    const explicit = media.getAttribute('src') || '';
    const sources = directSources(media);
    if (explicit.startsWith('blob:') && sources.length === 0) {
      entry.blobUrl = explicit; entry.sourceNode = null;
      return true;
    }
    const child = sources[0];
    if (!explicit && sources.length === 1 && !previousSources.has(child)
      && child.getAttribute('src')?.startsWith('blob:')) {
      entry.blobUrl = child.getAttribute('src'); entry.sourceNode = child;
      return true;
    }
    return false;
  }
  const sameSource = (a, b) => {
    try { return new URL(a, location.href).href === new URL(b, location.href).href; } catch { return a === b; }
  };
  const owns = (media, entry) => bound.get(media) === entry && media.isConnected;
  const matchesSource = (src, entry) => sameSource(src, entry.url) || (entry.blobUrl && src === entry.blobUrl);
  const current = (media, entry) => owns(media, entry) && !entry.givenup
    // currentSrc may retain the detached Blob until the asynchronous load algorithm runs.
    // Controlled full playback owns only its empty setup phase or exact attached source.
    && (entry.protected || entry.sourceNode ? ownsBlobSource(media, entry) : matchesSource(sourceOf(media), entry));
  // destroy 可能清空 src。只认销毁后记录的那个确切源，不能把任意 Blob 或后来重设的 URL 当成旧片。
  const fallbackCurrent = (media, entry) => owns(media, entry) && entry.givenup
    && sourceOf(media) === entry.fallbackSource;

  function dispose(media) {
    const entry = bound.get(media);
    bound.delete(media); // destroy 可能同步派发事件，先使旧回调失效。
    protectedSessions.get(media)?.controller?.abort();
    protectedSessions.delete(media);
    dropQuality(media);
    entry?.restoreCleanup?.();
    entry?.cleanup?.();
    entry?.nativeCleanup?.();
    try { entry?.client?.destroy(); } catch { /* 已销毁 */ }
    if (entry) { entry.client = null; entry.pending = false; }
  }

  function sweep() {
    for (const [media, entry] of bound) {
      if (!media.isConnected || (!current(media, entry) && !fallbackCurrent(media, entry))) dispose(media);
    }
  }

  // 服务端只往 journald 打一行、不进库；按网段限流。诊断不能把播放带下水，所以整段包在 try 里。
  function report(media, url, what, detail) {
    try {
      const q = new URLSearchParams({
        a: 'play-report',
        v: videoIdOf(url),
        what,
        native: media.canPlayType('application/vnd.apple.mpegurl') || 'empty',
        mse: MSE ? '1' : '0',
        detail: `${stateOf(media)}${detail ? ` ${detail}` : ''}`.slice(0, 120),
      });
      fetch(`/functions/v1/app?${q}`, { keepalive: true }).catch(() => {});
    } catch {
      // 报不出去就算了。
    }
  }

  function loadScript() {
    if (lib) return lib;
    lib = new Promise((fulfill, reject) => {
      const tag = document.createElement('script');
      // 升级库时必须同时改版本参数；nginx 可缓存这一份固定版本，shim 仍每次重新验证。
      tag.src = '/assets/hls.min.js?v=1.5.17';
      tag.onload = () => fulfill(window.Hls);
      tag.onerror = () => { tag.remove(); lib = null; reject(new Error('hls_lib_failed')); };
      document.head.appendChild(tag);
    });
    return lib;
  }

  // 换片时播放器会对同一个元素重设 src —— 上一条片的状态必须跟着换掉，
  // 否则第二条片会顶着第一条片"已放弃"的标记，永远不再被接管（症状：第一条能看，往后翻每一条都黑）。
  // 已经放弃的同一条地址重新 loadstart 时，也清掉标记重来。
  function entryFor(media, url) {
    const current = bound.get(media);
    if (current && current.url === url && !current.givenup) return current;
    dispose(media);
    const fresh = { url, blobUrl: '', sourceNode: null, fallbackSource: null, client: null, pending: false, givenup: false };
    delete media.dataset.playbackFailure;
    delete media.dataset.playbackStatus;
    bound.set(media, fresh);
    return fresh;
  }

  // Full playback credentials stay in JS memory, never DOM attributes or URLs.
  const protectedSessions = new WeakMap();
  function rememberProtected(media, session) {
    const url = new URL(String(session.mediaUrl || ''), location.href);
    const proof = session.playbackProof;
    if (session.mode !== 'full' || session.protectedPlayback !== true || !proof?.value
      || !Number.isFinite(Date.parse(proof.expiresAt)) || url.origin !== location.origin
      || url.pathname !== '/functions/v1/app' || url.searchParams.get('a') !== 'media'
      || !HLS_MARK.test(url.search) || !url.searchParams.get('pt')) throw Error('invalid_protected_session');
    const context = { session, token: url.searchParams.get('pt'), expires: performance.now() + Math.max(0, Math.min(300, Number(proof.expiresInSeconds) || 0)) * 1000,
      id: videoIdOf(url.href), refreshing: null, controller: null, failedUntil: 0, failure: null };
    protectedSessions.set(media, context);
    return context;
  }
  function playAddress(id, quality = '') {
    const query = new URLSearchParams({ a: 'play', v: id });
    if (quality && quality !== 'auto') query.set('q', quality);
    const as = new URLSearchParams(location.search).get('as');
    if (as !== null && as !== '' && Number.isFinite(Number(as))) query.set('as', as);
    return '/functions/v1/app?' + query;
  }
  async function protectedXhr(media, entry, xhr, source) {
    let context = protectedSessions.get(media);
    if (!current(media, entry) || !context) return;
    if (context.expires - performance.now() < 60_000) {
      if (context.failedUntil > Date.now()) throw context.failure;
      if (!context.refreshing) {
        const controller = new AbortController();
        context.controller = controller;
        const timeout = setTimeout(() => controller.abort(), 10_000);
        context.refreshing = (async () => {
          try {
            const response = await fetch(playAddress(context.id), { signal: controller.signal, cache: 'no-store' });
            const body = await response.json();
            if (!current(media, entry) || protectedSessions.get(media) !== context || controller.signal.aborted) return;
            if (!response.ok || body.mode !== 'full' || body.video?.id !== context.id) {
              const error = Error('protected_renewal_denied'); error.status = response.ok ? 403 : response.status; throw error;
            }
            const next = rememberProtected(media, body);
            next.refreshing = context.refreshing;
          } catch (error) {
            if (!current(media, entry) || protectedSessions.get(media) !== context) return;
            context.failedUntil = Date.now() + 10_000; context.failure = error;
            media.dataset.playbackFailure = error.status === 401 || error.status === 403 ? 'authorization'
              : error.status === 429 ? 'limited' : 'network';
            throw error;
          } finally {
            clearTimeout(timeout); context.controller = null; context.refreshing = null;
            const active = protectedSessions.get(media);
            if (active && active !== context) active.refreshing = null;
          }
        })();
      }
      await context.refreshing;
      if (!current(media, entry)) return;
      context = protectedSessions.get(media);
    }
    const url = new URL(source, location.href);
    if (!context || url.origin !== location.origin || url.pathname !== '/functions/v1/app'
      || url.searchParams.get('a') !== 'media' || videoIdOf(url.href) !== context.id
      || !HLS_MARK.test(url.search) && !['key', 'seg'].includes(url.searchParams.get('hls'))) {
      throw Error('protected_request_scope');
    }
    // Old playlists can remain buffered: replace only pt, keep rendition/segment/IV addressing.
    url.searchParams.set('pt', context.token);
    xhr.open('GET', url.href, true);
    xhr.setRequestHeader('x-boxvault-playback', context.session.playbackProof.value);
  }
  function protectedFailure(media, entry, kind) {
    media.dataset.playbackFailure = kind;
    setTimeout(() => { if (owns(media, entry)) media.dispatchEvent(new Event('error')); }, 0);
  }
  window.BoxvaultPlayback = Object.freeze({
    set(media, session) {
      dispose(media);
      media.removeAttribute('src');
      media.load();
      const entry = entryFor(media, session.mediaUrl);
      entry.protected = true;
      try { rememberProtected(media, session); }
      catch { protectedFailure(media, entry, session.hlsPackaged ? 'authorization' : 'processing'); return; }
      if (!MSE_AVC) { protectedFailure(media, entry, 'protected'); return; }
      watchRendition(media); watchStalls(media);
      attach(media, session.mediaUrl, entry);
    },
    release(media) { dispose(media); },
  });

  function failureFor(data) {
    const status = Number(data?.response?.code || data?.networkDetails?.status || 0);
    const kind = status === 401 || status === 403 ? 'authorization'
      : status === 429 ? 'limited'
      : status === 404 || status === 410 ? 'source'
      : /manifestIncompatibleCodecs|bufferAddCodec|incompatible/i.test(data?.details || '') ? 'unsupported'
      : data?.type === 'mediaError' ? 'decode' : 'network';
    return { kind, status };
  }

  // 原生只尝试一次，仍走原媒体地址和实时登录鉴权；不把会员链接变成无 Cookie 的通行证。
  function useNative(media, url, entry, reset = false) {
    if (!current(media, entry) || entry.nativeOnly || entry.protected) return;
    const at = Number.isFinite(media.currentTime) ? media.currentTime : 0;
    const resume = !media.paused;
    entry.nativeOnly = true;
    entry.pending = false;
    if (typeof dropQuality === 'function') dropQuality(media);
    entry.restoreCleanup?.();
    entry.cleanup?.();
    try { entry.client?.destroy(); } catch { /* 已释放 */ }
    entry.client = null;
    entry.sourceNode = null;
    let timer = null;
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const stalled = () => {
      clear();
      // 只在用户已尝试播放且尚未出画时计时，不因浏览器禁止自动播放而报错。
      if (!current(media, entry) || media.paused || media.videoWidth > 0) return;
      timer = setTimeout(() => {
        timer = null;
        if (!current(media, entry) || media.paused || media.videoWidth > 0) return;
        media.dataset.playbackFailure = 'native';
        media.dispatchEvent(new Event('error', { cancelable: true }));
      }, 12_000);
    };
    const restore = () => {
      if (!current(media, entry)) return;
      if (at > 0) media.currentTime = at;
      if (resume) void media.play().catch(() => {});
    };
    media.addEventListener('play', stalled);
    media.addEventListener('waiting', stalled);
    media.addEventListener('playing', clear);
    media.addEventListener('pause', clear);
    media.addEventListener('loadedmetadata', restore, { once: true });
    entry.nativeCleanup = () => {
      clear();
      media.removeEventListener('play', stalled);
      media.removeEventListener('waiting', stalled);
      media.removeEventListener('playing', clear);
      media.removeEventListener('pause', clear);
      media.removeEventListener('loadedmetadata', restore);
    };
    report(media, url, 'native_fallback', MSE_AVC ? 'codec_fatal' : 'no_avc_mse');
    if (reset) { media.src = url; media.load(); }
    stalled();
  }

  // 两种播法都失败之后，先问服务端要一次"只含试看窗口"的整片地址：
  // 服务端只对试看那一档放行这个退路（会员拿回来的还是分段地址），所以这一步多给不了一个字节，
  // 但"免费试看"这个卖货入口就不会因为一台设备的解码脾气而整个死掉。
  async function windowFallback(media, url, entry) {
    try {
      if (entry.protected || !fallbackCurrent(media, entry)) return false;
      const res = await fetch(playAddress(videoIdOf(url)) + '&fallback=mp4');
      const body = await res.json();
      if (!fallbackCurrent(media, entry)) return false;
      const next = String(body?.mediaUrl ?? '');
      if (body?.mode !== 'preview' || !next.includes('a=media') || HLS_MARK.test(next)) return false;
      report(media, url, 'mp4_fallback', body?.mode ?? '?');
      media.src = next;
      media.play().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // 交还给站点自己的报错路径：清掉接管痕迹，再派发一次 error，这一次 capture 里认得 givenup
  // 标记、直接放行，于是买家看到的是"这一段没取到 + 重新取一次"，不是一个不声不响的黑框。
  function giveUp(media, url, reason, detail, entry, failure = {}) {
    if (!current(media, entry)) return; // 换源后的旧 catch 不得先 destroy，再检查源。
    media.dataset.playbackFailure = failure.kind || 'network';
    media.dataset.playbackStatus = String(failure.status || 0);
    if (entry) {
      entry.givenup = true;
      protectedSessions.get(media)?.controller?.abort();
      entry.pending = false;
      dropQuality(media);
      entry.restoreCleanup?.();
      entry.cleanup?.();
      entry.nativeCleanup?.();
      try { entry.client?.destroy(); } catch { /* 同上 */ }
      entry.client = null;
    }
    if (!owns(media, entry)) return;
    const afterDestroy = sourceOf(media);
    if (afterDestroy && !matchesSource(afterDestroy, entry)) return;
    entry.fallbackSource = afterDestroy;
    report(media, url, reason, detail);
    // 明确的 HTTP 拒绝或临时网络错误不再额外申请地址；只尝试既有的试看兼容退路。
    const fallback = !entry.protected && ['unsupported', 'decode'].includes(failure.kind)
      ? windowFallback(media, url, entry) : Promise.resolve(false);
    fallback.then((ok) => {
      if (ok || !fallbackCurrent(media, entry)) return;
      setTimeout(() => {
        if (!fallbackCurrent(media, entry)) return;
        try { media.dispatchEvent(new Event('error', { cancelable: true })); } catch { /* 元素可能已经不在页面上 */ }
      }, 0);
    });
  }

  function attach(media, url, entry) {
    if (!current(media, entry) || entry.pending || entry.client) return;
    entry.pending = true; // 必须在等待库之前占位，loadstart 和原生 error 可能紧接着到。
    report(media, url, 'takeover', FORCED === '1' ? 'forced' : (PROACTIVE ? (ANDROID ? 'android' : 'mse') : 'native_failed'));
    loadScript().then((Hls) => {
      if (!current(media, entry)) return;
      if (!Hls) { giveUp(media, url, 'no_lib', 'hls.min.js 没跑到', entry); return; }
      // 不单靠 isSupported 的组合 MIME 判断；前置 H.264 探测兼顾手机内核的 MIME 差异。
      const cap = (codec) => {
        try { return MediaSourceType?.isTypeSupported?.(codec) ? '1' : '0'; } catch { return 'x'; }
      };
      report(media, url, 'attempt', `sup${Hls.isSupported?.() ? 1 : 0} q${cap('video/mp4;codecs="avc1.420010,mp4a.40.2"')} n${cap('video/mp4;codecs=avc1.420010,mp4a.40.2')} a${cap('video/mp4;codecs=avc1.420010')} w${cap('video/webm;codecs=vp8')}`);
      // 超时抬到 60 秒：段是 8 秒 / 约 2.6 MB，慢线（<130 KB/s）取完一段本来就要 20 秒以上，
      // 而 hls.js 默认 fragLoadingTimeOut 是 2e4 —— 到点掐掉**从头再取**，于是慢而稳的线路永远取不完一段。
      if (entry.protected && !Hls.isSupported?.()) { giveUp(media, url, 'protected_unsupported', '', entry, { kind: 'protected' }); return; }
      const client = new Hls({
        // Match capability detection and Hls.isSupported() to the attached API.
        preferManagedMediaSource: true,
        ...(entry.protected ? { xhrSetup: (xhr, source) => protectedXhr(media, entry, xhr, source) } : {}),
        enableWorker: true, lowLatencyMode: false, fragLoadingTimeOut: 60_000, manifestLoadingTimeOut: 30_000,
        // 30 秒是最低预取目标，旧默认 maxMaxBufferLength=600 会把低码率短片整个拉完。
        // 字节值是 hls.js 的软目标，不是浏览器 RSS 上限；时间边界可能多出一个完整分段。
        maxBufferLength: 30, maxMaxBufferLength: 48, maxBufferSize: 16 * 1024 * 1024,
        backBufferLength: 24, frontBufferFlushThreshold: 48,
      });
      entry.client = client;
      client.on(Hls.Events.MEDIA_ATTACHED, (event, data) => {
        // sourceopen may arrive after attachment; old instances cannot claim a
        // replacement player's source or clear its credentials.
        Promise.resolve().then(() => {
          if (!owns(media, entry) || entry.givenup || entry.client !== client) return;
          if (!current(media, entry)) { dispose(media); return; }
          if (data?.media !== media || !(data.mediaSource instanceof MediaSourceType))
            giveUp(media, url, 'media_attach_mismatch', '', entry, { kind: 'protected' });
        });
      });
      entry.retryLeft = 1;
      entry.pending = false;
      let pauseTimer = null;
      let retryTimer = null;
      let loadingStopped = false;
      const clearPause = () => {
        if (pauseTimer !== null) { clearTimeout(pauseTimer); pauseTimer = null; }
      };
      const pauseLoading = () => {
        clearPause();
        if (!current(media, entry) || !media.paused || media.ended) return;
        // 留 10 秒宽限，短暂停顿不会反复取消并重下正在传输的整段。
        pauseTimer = setTimeout(() => {
          pauseTimer = null;
          if (!current(media, entry) || !media.paused || media.ended) return;
          loadingStopped = true;
          client.stopLoad();
        }, 10_000);
      };
      const resumeLoading = () => {
        clearPause();
        if (!current(media, entry) || !loadingStopped) return;
        loadingStopped = false;
        // 暂停期间可以拖动；恢复按当前位置取段，不从旧的预取位置或片头重来。
        client.startLoad(Number.isFinite(media.currentTime) ? media.currentTime : -1);
      };
      media.addEventListener('pause', pauseLoading);
      media.addEventListener('play', resumeLoading);
      entry.cleanup = () => {
        clearPause();
        if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
        media.removeEventListener('pause', pauseLoading);
        media.removeEventListener('play', resumeLoading);
        entry.cleanup = null;
      };
      // "播放器实际挑了哪一档"只有设备侧知道：服务端只看得到自己发了一份主列表。
      // 这条是仪表盘里"谁被钉在低档"和"切档有没有真生效"的唯一凭据，别删。
      const levelNote = () => {
        const index = Number.isInteger(client.currentLevel) ? client.currentLevel : -1;
        const level = client.levels?.[index] ?? client.levels?.[0] ?? null;
        const q = /q=(sd|hd)/.exec(level?.url ?? '')?.[1] ?? 'hd';
        return `lv${client.levels?.length ?? 0}:${q}@${Math.round((level?.bitrate ?? 0) / 1000)}k`;
      };
      client.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!current(media, entry)) return;
        report(media, url, 'manifest_parsed', levelNote());
        rigQuality(media, entry);
        if (entry.resumeOnReady === false) pauseLoading();
        else media.play().catch(pauseLoading);
      });
      client.on(Hls.Events.LEVEL_SWITCHED, () => {
        if (current(media, entry)) report(media, url, 'level_switch', levelNote());
      });
      // v1.5.17 的 FRAG_BUFFERED 提供完整 stats；loaded 是字节，loading/parsing 是时间对象。
      // parse 是流水线墙钟时间（可与下载重叠），不是 CPU 占用，不能单凭它判定手机算不动。
      let statCount = 0;
      let statValid = 0;
      let statLoad = 0;
      let statFirst = 0;
      let statParse = 0;
      let parseValid = 0;
      let wallMs = 0;
      let wallFrags = 0;
      let wallBytes = 0;
      // 线上 14 次 frag_stats 里 hls.js 自己报的 load/first 全是 0.0s，而一段有 0.9~2.9 MB —— 公网上
      // 下不完 50 毫秒。不管是那一版没填还是时刻取错，这个数回答不了"卡是带宽还是解码"，
      // 而那正是站长天天被问的一句。所以自己掐一次表，并把字节一起报上去。
      const fragClock = new Map();
      const fragKey = (frag) => (frag ? `${frag.level}/${frag.sn}` : '');
      client.on(Hls.Events.FRAG_LOADING, (event, data) => {
        const key = fragKey(data?.frag);
        if (!key || !current(media, entry)) return;
        fragClock.set(key, performance.now());
        // 半途被取消/切档的段会留在这里，攒多了就把最旧的丢掉（这只是个秒表表，不是账本）
        if (fragClock.size > 24) {
          const oldest = fragClock.keys().next().value;
          fragClock.delete(oldest);
        }
      });
      client.on(Hls.Events.FRAG_LOADED, (event, data) => {
        const key = fragKey(data?.frag);
        const started = fragClock.get(key);
        if (started === undefined || !current(media, entry)) return;
        fragClock.delete(key);
        const spent = performance.now() - started;
        if (!(spent >= 0) || spent > 120_000) return;
        wallMs += spent;
        wallFrags += 1;
        // v1.5.17 的 FRAG_LOADED 不带 data.stats（实测 payload 只有 frag/part/payload/networkDetails），
        // 字节在这一版的 frag.stats 上：{ loaded, total, bwEstimate, loading, parsing, buffering }。
        const st = data?.frag?.stats;
        wallBytes += Math.max(0, Number(st?.total ?? st?.loaded ?? 0));
      });
      const elapsed = (timing, field = 'end') => Number.isFinite(timing?.start)
        && Number.isFinite(timing?.[field]) && timing[field] >= timing.start && timing[field] > 0
        ? timing[field] - timing.start : null;
      client.on(Hls.Events.FRAG_BUFFERED, (event, data) => {
        if (!current(media, entry)) return;
        const s = data?.stats ?? data?.frag?.stats;
        statCount += 1;
        const load = elapsed(s?.loading);
        const first = elapsed(s?.loading, 'first');
        const parse = elapsed(s?.parsing);
        if (load !== null && first !== null) {
          statValid += 1;
          statLoad += load;
          statFirst += first;
        }
        if (parse !== null) { parseValid += 1; statParse += parse; }
        // 阈值取 2：试看只有 3-4 段，取 8 的话这条判据在试看上永远不会响，等于装了个哑探针。
        if (statCount < 2) return;
        let level = 0;
        for (let i = 0; i < media.buffered.length; i += 1) {
          if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) >= media.currentTime) {
            level = media.buffered.end(i) - media.currentTime; break;
          }
        }
        const measured = statValid ? ` valid${statValid} load${(statLoad / 1000).toFixed(1)}s first${(statFirst / 1000).toFixed(1)}s` : ' nostats';
        const parsing = parseValid ? ` parse${(statParse / 1000).toFixed(1)}s p${parseValid}` : ' parse?';
        // w=自己量的秒数，k=收来的千字节，r=KB/s：r 低而 buf 高 = 线不够；r 高、buf 高还卡 = 不是带宽。
        const self = wallFrags ? ` w${(wallMs / 1000).toFixed(1)}s k${Math.round(wallBytes / 1024)} r${wallMs > 0 ? Math.round(wallBytes * 1000 / wallMs / 1024) : 0}` : ' w?';
        report(media, url, 'frag_stats', `n${statCount}${self}${measured}${parsing} buf${level.toFixed(0)}s`);
        statCount = 0; statValid = 0; statLoad = 0; statFirst = 0; statParse = 0; parseValid = 0;
        wallMs = 0; wallFrags = 0; wallBytes = 0;
      });
      client.on(Hls.Events.ERROR, (event, data) => {
        if (!data?.fatal || !current(media, entry)) return;
        const why = `${data.type}/${data.details}`;
        const failure = failureFor(data);
        if (entry.protected && media.dataset.playbackFailure) failure.kind = media.dataset.playbackFailure;
        if (!entry.protected && failure.kind === 'unsupported' && !APPLE_NATIVE && FORCED !== '1'
          && media.canPlayType('application/vnd.apple.mpegurl')) {
          useNative(media, url, entry, true);
          return;
        }
        // 部署重启的那两三秒里 nginx 会回 502：这一次确实取不到，但两秒之后就取得到。
        // 以前直接 giveUp，界面弹"这一段没取到"，站长会把每一次重启都当成片坏了。
        // 只给一次机会，而且只给"取不到东西"这一类 —— 解码那类重取也没用，照旧交还给站点界面。
        if (entry.retryLeft > 0 && failure.kind === 'network'
          && (failure.status === 0 || failure.status >= 500) && /network|LoadError|keyLoadError/i.test(why)) {
          entry.retryLeft -= 1;
          report(media, url, 'fatal_retry', why);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!current(media, entry) || loadingStopped) return;
            try { client.startLoad(Number.isFinite(media.currentTime) ? media.currentTime : -1); }
            catch { giveUp(media, url, 'hlsjs_fatal', `${why}/retry_failed`, entry); }
          }, 2500);
          return;
        }
        giveUp(media, url, 'hlsjs_fatal', why, entry, failure);
      });
      const previousSources = new Set(directSources(media));
      client.attachMedia(media);
      // v1.5.17 uses video.src for MSE and a new source child for MMS.
      // Capture this exact source while currentSrc may still contain the old Blob.
      if (!bindAttachedSource(media, entry, client, previousSources)) {
        if (owns(media, entry) && entry.client === client) dispose(media);
        return;
      }
      if (!current(media, entry)) { dispose(media); return; }
      client.loadSource(url);
      if (/^\/v\//.test(location.pathname)) {
        rigQuality(media, entry);
      }
    }).catch(() => giveUp(media, url, 'attach_failed', 'hls library or init failed', entry));
  }

  // ---- 画质这一档由观众自己点 ----
  // 服务端早就认 `?q=sd|hd`（探针逐条核过），这里补的是"屏幕上点得动的那个入口"。
  // 为什么写在这条脚本里：界面跑的是编译好的 /assets/dist/*.js，和本机源码不是同一份、
  // 现在重打会把没验收过的改动一起发出去；这一条是今天唯一发得出去的播放端代码。
  const Q_PREF = 'boxvault-quality';
  const readPref = () => { try { const value = localStorage.getItem(Q_PREF); return value === 'sd' || value === 'hd' ? value : ''; } catch { return ''; } };
  const writePref = (value) => {
    try { if (!value) localStorage.removeItem(Q_PREF); else localStorage.setItem(Q_PREF, value); } catch { /* 隐私模式：记不住就算了 */ }
  };
  const qualityStates = new Map();
  const renditionOf = (url) => {
    try { const q = new URL(url, location.href).searchParams; return q.get('hls') === 'master' ? 'auto' : q.get('q') === 'sd' ? 'sd' : 'hd'; } catch { return 'auto'; }
  };
  const qualityLabel = (value) => ({ auto: '自动', sd: '流畅', hd: '高清' })[value] ?? value;
  const qualityCurrent = (media, state) => qualityStates.get(media) === state && current(media, state.entry);
  const cancelQualityWork = (state) => {
    state.revision += 1;
    state.metadataRevision += 1;
    state.controller?.abort();
    state.metadataController?.abort();
    state.controller = null;
    state.metadataController = null;
    state.job = null;
  };
  function dropQuality(media) {
    const state = qualityStates.get(media);
    if (!state) return;
    qualityStates.delete(media);
    cancelQualityWork(state);
    state.root.remove();
  }

  const paint = (bar, rendition) => {
    for (const button of bar.querySelectorAll('button')) {
      const on = button.dataset.rendition === rendition;
      button.setAttribute('aria-pressed', String(on));
      button.style.cssText = on ? BUTTON_ON : BUTTON_OFF;
    }
  };
  const BUTTON_BASE = 'font:inherit;min-height:44px;padding:8px 14px;border-radius:10px;cursor:pointer;';
  const BUTTON_OFF = `${BUTTON_BASE}border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;`;
  const BUTTON_ON = `${BUTTON_BASE}border:1px solid currentColor;background:rgba(128,128,128,.22);color:inherit;font-weight:600;`;

  // 变体 URL 来自已授权的主列表；只按 q 匹配，不猜 sd/hd 在 levels 里的排列次序。
  function masterChoices(entry) {
    if (renditionOf(entry.url) !== 'auto' || !entry.client?.levels?.length) return null;
    const levels = new Map();
    entry.client.levels.forEach((level, index) => {
      const urls = Array.isArray(level.url) ? level.url : [level.url];
      for (const url of urls) {
        if (!url || videoIdOf(url) !== videoIdOf(entry.url)) continue;
        const rendition = renditionOf(url);
        if (rendition !== 'auto' && !levels.has(rendition)) levels.set(rendition, index);
      }
    });
    return levels.size ? levels : null;
  }

  function paintQuality(state, selected, message = '') {
    state.selected = selected;
    state.summary.textContent = `画质：${qualityLabel(selected)}`;
    paint(state.buttons, selected);
    state.note.textContent = message;
  }

  function renderChoices(media, state, options) {
    state.buttons.replaceChildren();
    const seen = new Set();
    for (const option of options) {
      if (!['auto', 'sd', 'hd'].includes(option.rendition) || seen.has(option.rendition)) continue;
      seen.add(option.rendition);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.rendition = option.rendition;
      button.textContent = option.label || qualityLabel(option.rendition);
      button.addEventListener('click', () => { void switchQuality(media, state, option.rendition); });
      state.buttons.append(button);
    }
    state.ready = true;
    paintQuality(state, state.selected);
    if (seen.size < 2) state.note.textContent = '当前视频只有一个可用档位。';
  }

  const playQuery = (entry, rendition = '') => {
    const id = videoIdOf(entry.url);
    if (!id || id === '-') throw new Error('missing_video_id');
    const as = new URLSearchParams(location.search).get('as');
    const preview = as !== null && as !== '' && Number.isFinite(Number(as)) ? `&as=${Number(as)}` : '';
    return `/functions/v1/app?a=play&v=${id}${rendition && rendition !== 'auto' ? `&q=${rendition}` : ''}${preview}`;
  };
  const validNext = (body, entry) => {
    try {
      const next = new URL(String(body?.mediaUrl ?? ''), location.href);
      return next.origin === location.origin && next.pathname === '/functions/v1/app'
        && next.searchParams.get('a') === 'media' && HLS_MARK.test(next.search)
        && videoIdOf(next.href) === videoIdOf(entry.url) ? next.href : '';
    } catch { return ''; }
  };

  function applyQualitySource(media, state, body, rendition) {
    const next = validNext(body, state.entry);
    if (!next) throw new Error('invalid_quality_source');
    // 请求期间观众还可能继续播放或暂停，以真正换源这一刻的状态为准。
    const at = media.currentTime;
    const paused = media.paused;
    const expanded = state.root.open;
    writePref(rendition === 'auto' ? '' : rendition);
    if (state.entry.protected) { window.BoxvaultPlayback.set(media, body); return; }
    dispose(media);
    const entry = entryFor(media, next);
    entry.resumeOnReady = !paused;
    entry.qualityOpen = expanded;
    // load() 重置 paused 本身不派发 pause；监听实际 play/pause，不能把新源的初始 paused 当成用户意图。
    const intent = (event) => {
      if (current(media, entry)) entry.resumeOnReady = event.type === 'play';
    };
    const restore = () => {
      const actual = media.currentSrc;
      if (!current(media, entry) || !(sameSource(actual, next) || (entry.blobUrl && actual === entry.blobUrl))) return;
      if (at > 0.5) {
        const end = Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.05) : at;
        try { media.currentTime = Math.min(at, end); } catch { /* 以新授权窗口为准 */ }
      }
      // 元数据只恢复位置，不能再覆盖加载期间观众新选择的播放／暂停状态。
      entry.restoreCleanup?.();
    };
    entry.restoreCleanup = () => {
      media.removeEventListener('loadedmetadata', restore);
      media.removeEventListener('play', intent);
      media.removeEventListener('pause', intent);
      entry.restoreCleanup = null;
    };
    media.addEventListener('loadedmetadata', restore);
    media.addEventListener('play', intent);
    media.addEventListener('pause', intent);
    media.src = next;
    if (!paused) media.play().catch(() => {});
    report(media, next, 'quality_pick', `${rendition}->${body.quality}`);
  }

  async function switchQuality(media, state, rendition) {
    if (!qualityCurrent(media, state)) return;
    const revision = ++state.revision;
    state.prefApplied = true;
    state.controller?.abort();
    state.controller = null;
    if (rendition === state.selected) { state.note.textContent = ''; return; }
    const entry = state.entry;
    const levels = masterChoices(entry);
    if (levels && (rendition === 'auto' || levels.has(rendition))) {
      // loadLevel 只改变后续加载档位，不清空缓冲，也不取消正在传输的整段。
      entry.client.loadLevel = rendition === 'auto' ? -1 : levels.get(rendition);
      writePref(rendition === 'auto' ? '' : rendition);
      paintQuality(state, rendition, `已选${qualityLabel(rendition)}，将随新加载的画面生效。`);
      report(media, entry.url, 'quality_pick', `${rendition}->${rendition}`);
      return;
    }
    const controller = new AbortController();
    state.controller = controller;
    state.note.textContent = '正在切换画质…';
    try {
      const res = await fetch(playQuery(entry, rendition), { signal: controller.signal });
      const body = await res.json();
      if (!qualityCurrent(media, state) || revision !== state.revision || controller.signal.aborted) return;
      if (!res.ok) throw new Error(`quality_http_${res.status}`);
      applyQualitySource(media, state, body, rendition);
    } catch {
      if (!qualityCurrent(media, state) || revision !== state.revision || controller.signal.aborted) return;
      state.note.textContent = '画质切换失败，请重试。';
      report(media, entry.url, 'quality_switch_failed', rendition);
    } finally {
      if (state.controller === controller) state.controller = null;
    }
  }

  function loadChoices(media, state) {
    if (!qualityCurrent(media, state)) return;
    const levels = masterChoices(state.entry);
    if (levels) {
      state.metadataRevision += 1;
      state.metadataController?.abort();
      state.metadataController = null;
      renderChoices(media, state, ['auto', ...levels.keys()].map(rendition => ({ rendition })));
      state.root.open = true;
      const want = readPref();
      if (!state.prefApplied && want && levels.has(want)) void switchQuality(media, state, want);
      return;
    }
    if (state.ready || state.job || state.entry.pending || (state.entry.client && !state.entry.client.levels?.length)) return;
    const want = state.prefApplied ? '' : readPref();
    const selected = state.selected;
    const preference = want && want !== selected ? want : '';
    const revision = ++state.metadataRevision;
    const choiceRevision = state.revision;
    const controller = new AbortController();
    state.metadataController = controller;
    state.note.textContent = '正在读取可用画质…';
    const job = Promise.resolve().then(async () => {
      try {
        // 原生路径的偏好请求同时取回选项与目标地址，不再紧接着申请一次相同档位。
        const res = await fetch(playQuery(state.entry, preference), { signal: controller.signal });
        const body = await res.json();
        if (!qualityCurrent(media, state) || revision !== state.metadataRevision || controller.signal.aborted) return;
        if (!res.ok || !Array.isArray(body?.qualities)) throw new Error('quality_options_failed');
        const options = body.qualities.filter(option => option && ['auto', 'sd', 'hd'].includes(option.rendition));
        if (options.some(option => option.rendition === 'sd') && options.some(option => option.rendition === 'hd')
          && !options.some(option => option.rendition === 'auto')) options.unshift({ rendition: 'auto', label: qualityLabel('auto') });
        renderChoices(media, state, options);
        if (preference && choiceRevision === state.revision && validNext(body, state.entry)
          && body.quality === preference) {
          state.prefApplied = true;
          applyQualitySource(media, state, body, preference);
        }
      } catch {
        if (qualityCurrent(media, state) && revision === state.metadataRevision && !controller.signal.aborted) {
          state.note.textContent = '画质选项暂未取到，请收起后重新展开。';
        }
      } finally {
        if (state.job === job) state.job = null;
        if (state.metadataController === controller) state.metadataController = null;
      }
    });
    state.job = job;
  }

  function rigQuality(media, entry) {
    if (!/^\/v\//.test(location.pathname) || !current(media, entry)) return;
    let state = qualityStates.get(media);
    if (!state || state.entry !== entry) {
      dropQuality(media);
      const root = document.createElement('details');
      root.dataset.qualityControls = '';
      root.style.cssText = 'margin:10px 0 4px;';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;min-height:44px;align-content:center;';
      const buttons = document.createElement('div');
      buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
      const note = document.createElement('p');
      note.setAttribute('aria-live', 'polite');
      note.style.cssText = 'font:inherit;font-size:.9em;margin:6px 0;';
      root.append(summary, buttons, note);
      state = { entry, root, summary, buttons, note, ready: false, job: null, revision: 0, metadataRevision: 0,
        controller: null, metadataController: null, selected: renditionOf(entry.url), prefApplied: false };
      qualityStates.set(media, state);
      paintQuality(state, state.selected);
      root.addEventListener('toggle', () => {
        if (root.open) loadChoices(media, state);
      });
      root.open = Boolean(entry.qualityOpen);
      media.insertAdjacentElement('afterend', root);
    }
    const want = readPref();
    if (masterChoices(entry) || state.root.open || (want && want !== state.selected)) loadChoices(media, state);
  }

  // 原生 HLS 那一侧（Edge / 苹果 / 微信内置）整个不经过 hls.js，
  // "观众实际在这一档上"只有画面尺寸认得出来 —— 这条上报是两边通用的唯一凭据。
  const watched = new WeakSet();
  function watchRendition(media) {
    if (watched.has(media)) return;
    watched.add(media);
    let last = '';
    const emit = () => {
      if (!media.videoWidth) return;
      const entry = bound.get(media);
      if (entry && !matchesSource(media.currentSrc || sourceOf(media), entry)) return;
      const url = entry && current(media, entry) ? entry.url : sourceOf(media);
      const size = `${media.videoWidth}x${media.videoHeight}`;
      const seen = `${videoIdOf(url)}:${size}`;
      if (seen === last) return;
      last = seen;
      report(media, url, 'rendition_seen', size);
    };
    media.addEventListener('loadedmetadata', emit);
    media.addEventListener('resize', emit);
    emit();
  }

  // 卡不卡只有设备自己认得：waiting / stalled 在原生 HLS 和 hls.js 两条路上都会发，
  // 而"取段慢但没报错"那一段服务端只看得见一串 200，浏览器时间线才知道人等了多久。
  // 攒到 3 次、或距上次上报超过 30 秒才发一行 —— 卡一次报一次等于给卡顿再添几条请求。
  // detail 全用 ASCII：服务端 clean() 会吃掉非 ASCII，给人看的那句中文在服务端那一处拼。
  const stallStates = new WeakMap();
  function watchStalls(media) {
    if (stallStates.has(media)) return;
    const state = { count: 0, ms: 0, blockedSince: 0, lastReport: 0, everPlayed: false, dfBase: 0 };
    stallStates.set(media, state);
    // 丢帧数是"卡"这件事的另一半：缓冲厚、取段快却还在掉帧 = 设备解不动，不是网不够。
    // 这一项两条路都能拿（原生 HLS 拿不到 hls.js 的任何内部数据，但元素自己认得）。
    const droppedFrames = () => {
      const q = media.getVideoPlaybackQuality?.();
      const n = Number(q?.droppedVideoFrames);
      if (Number.isFinite(n)) return n;
      const legacy = Number(media.webkitDroppedFrameCount);
      return Number.isFinite(legacy) ? legacy : 0;
    };
    const bufferedAhead = () => {
      for (let i = 0; i < media.buffered.length; i += 1) {
        if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) >= media.currentTime) {
          return media.buffered.end(i) - media.currentTime;
        }
      }
      return 0;
    };
    const urlNow = () => {
      const entry = bound.get(media);
      return entry && current(media, entry) ? entry.url : sourceOf(media);
    };
    const begin = () => {
      if (state.blockedSince || media.ended) return; // 一次阻塞只算一次：waiting 会连着发好几下
      // 只算"真的放过之后"的阻塞。开机、还没按下播放那一段也会发 waiting，
      // 把它记进来就会给人看一句假账："这一阵卡了 3 次、一共等了 7.4 秒"（实测这样虚高过）。
      if (!state.everPlayed) return;
      if (!state.count) state.dfBase = droppedFrames(); // 计数从这一阵的第一次阻塞起算
      state.blockedSince = performance.now();
      state.count += 1;
    };
    const end = () => {
      if (!state.blockedSince) return;
      state.ms += performance.now() - state.blockedSince;
      state.blockedSince = 0;
      const now = performance.now();
      if (state.count < 3 && now - state.lastReport < 30_000) return;
      state.lastReport = now;
      const size = media.videoWidth ? `${media.videoWidth}x${media.videoHeight}` : 'na';
      const dropped = Math.max(0, droppedFrames() - state.dfBase);
      report(media, urlNow(), 'stall_stats',
        `n${state.count}+${Math.round(state.ms)}ms+buf${bufferedAhead().toFixed(1)}s+df${dropped}`
        + `+v${document.visibilityState === 'hidden' ? 'hidden' : 'visible'}+${size}`);
      state.count = 0; state.ms = 0; state.dfBase = droppedFrames();
    };
    const started = () => { state.everPlayed = true; };
    media.addEventListener('timeupdate', started);
    media.addEventListener('waiting', begin);
    media.addEventListener('stalled', begin);
    media.addEventListener('playing', started);
    media.addEventListener('playing', end);
    media.addEventListener('resume', end);
  }

  document.addEventListener('loadstart', (event) => {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    const url = sourceOf(media);
    if (!HLS_MARK.test(url)) { sweep(); return; }
    const entry = entryFor(media, url);
    if (!APPLE_NATIVE && !MSE_AVC && FORCED !== '1') useNative(media, url, entry);
    if (PROACTIVE && !entry.nativeOnly && !entry.client && !entry.givenup) attach(media, url, entry);
    if (/^\/v\//.test(location.pathname)) { watchRendition(media); watchStalls(media); rigQuality(media, entry); }
  }, true);

  document.addEventListener('error', (event) => {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    if (FORCED === '0' && !bound.get(media)?.protected) return;
    const src = sourceOf(media);
    let entry = bound.get(media);
    const url = HLS_MARK.test(src) ? src : (entry?.client && entry.blobUrl === src ? entry.url : '');
    if (!url) return;
    if (!entry || !sameSource(entry.url, url)) entry = entryFor(media, url);
    if (entry?.givenup) return;
    if (entry?.protected && !entry.client) return;
    if (entry.nativeOnly) {
      if (!media.dataset.playbackFailure) media.dataset.playbackFailure = media.error?.code === 2 ? 'network' : 'unsupported';
      entry.nativeCleanup?.();
      return; // 原生也失败，交给准确的兼容性提示，不再来回切换。
    }
    if (entry?.client) {
      // hls.js 已经接手过还报错：不再重试第二次，交还给站点界面。
      event.preventDefault();
      event.stopPropagation();
      const kind = media.error?.code === 3 ? 'decode' : media.error?.code === 4 ? 'unsupported' : 'network';
      giveUp(media, url, 'hlsjs_media_error', 'after_takeover', entry, { kind });
      return;
    }
    // 原生已经吐出过画面才报错，那是断流/网络，换 hls.js 也救不回来，留给站点那套"重新取一次"。
    // 但这条判断在安卓上不成立（安卓的原生 HLS 会一边取流一边什么都不吐），所以安卓一律接管。
    const playedNatively = media.readyState >= 2 || Number.isFinite(media.duration);
    if (playedNatively && !PROACTIVE) {
      report(media, url, 'declined', 'already_played');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    attach(media, url, entryFor(media, url));
  }, true);

  new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  window.addEventListener('pagehide', (event) => {
    // 往返缓存保留媒体实例，但已发出的画质选择不能在后台回来后覆盖新选择。
    for (const state of qualityStates.values()) cancelQualityWork(state);
    // 进入浏览器往返缓存时保留实例，否则“返回”恢复的是已被 destroy 清空的播放器。
    if (!event.persisted) for (const media of bound.keys()) dispose(media);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) for (const [media, entry] of bound) rigQuality(media, entry);
  });

  // 播放页并行下载解封装库，省掉“拿到播放地址 → 原生失败 → 再下载库”的串行等待。
  // 苹果原生和 hlsjs=0 不预热；片库页面只在人点击视频链接时预热，不抢首页图片带宽。
  const canWarm = (MSE_AVC || FORCED === '1' && MSE) && FORCED !== '0' && (FORCED === '1' || !APPLE_NATIVE);
  if (canWarm && /^\/v\//.test(location.pathname)) loadScript().catch(() => {});
  document.addEventListener('pointerdown', (event) => {
    if (!canWarm) return;
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    try {
      const target = new URL(link.href, location.href);
      if (target.origin === location.origin && /^\/v\//.test(target.pathname)) loadScript().catch(() => {});
    } catch { /* 非网址 */ }
  }, { capture: true, passive: true });
})();
