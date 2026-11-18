export class ApiError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    // true = 平台网关拦下的 5xx，本站一行代码都没跑，所以这次操作确定没有发生。
    this.neverStarted = false;
  }
}

// 联系方式在后台可以改，文案里只留 {{QQ}}，由 boot 填。
let contactQq = '';

export function setContactQq(value) {
  contactQq = String(value ?? '').trim();
}

const channel = () => (contactQq ? `QQ ${contactQq}` : '页脚上写的联系方式');

const fill = (text) => String(text).replace(/\{\{QQ\}\}/g, () => channel());

const MESSAGES = {
  processing_unavailable: '当前服务器未启用后台处理，请先使用手选封面。',
  processing_queue_full: '处理队列已满，请稍后再补封面。',
  video_delete_pending: '这条视频正在删除，不能再生成封面。',
  poster_generation_failed: '服务器未能生成封面，可稍后重试或手选图片。',
  lesson_series_invalid:'合集名称、标签、集序或发布状态不符合要求，请检查后保存。',
  lesson_series_duplicate_video:'同一条教学影像只可归入一个合集，请先移除重复关联。',
  lesson_series_video_unavailable:'合集包含已下架或删除的教学影像，请移除不可用的引用再保存。',
  lesson_series_conflict:'合集或教学影像已被其他操作更新。草稿已保留，请核对后重新读取。',
  lesson_series_tampered:'合集资料校验未通过，暂时无法展示或修改。',
  lesson_series_limit_exceeded:'最多50个合集，每个合集最多100集。',
  lesson_series_not_found:'这个合集不存在、尚未公开，或已没有可展示的分集。',
  lesson_series_read_failed:'合集资料暂时无法读取，请稍后重试。',
  lesson_series_write_failed:'合集保存未完成，请核对服务器结果。',
  not_found: '没有找到这个内容，链接可能已经改动过。',
  blocked_client: '这个客户端被站点拒绝取视频和封面（看起来像自动程序）。请用手机或电脑上的常用浏览器重新打开页面。',
  method_not_allowed: '这个操作不接受当前的请求方式。',
  login_required: '请先登录账号。',
  admin_required: '这个操作只有管理账号可以做。',
  csrf_rejected: '请求来源校验失败，请刷新页面后重试。',
  service_not_configured: '站点后台还没有配置完成，请稍后再试。',
  email_invalid: '邮箱格式不正确，请检查后重填。',
  email_taken: '这个邮箱已经注册过，请直接登录。',
  password_missing: '请输入密码。',
  password_too_short: '密码至少 8 位。',
  password_too_long: '密码过长，请改用 8–60 位。',
  credentials_invalid: '邮箱或密码不正确。',
  login_locked: '密码错误次数过多，这一格登录暂时锁住，请 {minutes} 后再试；急着看就把登录邮箱发给站长：{{QQ}}',
  login_rate_limited: '这台网络地址上密码错误的次数太多了，请 {minutes}后再试。忘记密码就把你的登录邮箱发给站长：{{QQ}}',
  account_disabled: '这个账号已被停用，要恢复观看请联系站长：{{QQ}}',
  register_rate_limited: '本机今天的注册次数已用完，请稍后再试。',
  code_invalid: '激活码不正确。请核对 16 位字符（不含字母 I、O 和数字 0、1）。',
  code_used: '这枚激活码已经被其他账号绑定。',
  code_revoked: '这枚激活码已被作废。',
  // 和"作废"分开说：冻结是账号停用带出来的，恢复账号就能兑；说成作废会有人以为码被吞了。
  code_frozen: '这个账号目前处于停用状态，它名下未兑换的激活码暂时冻结，恢复登录后可正常兑换。',
  code_expired: '这枚激活码超过了兑换期限。',
  code_unavailable: '这枚激活码当前不可用。',
  redeem_rate_limited: '激活码尝试次数过多，请 1 小时后再试；急着绑定就把这枚码和登录邮箱发给站长：{{QQ}}',
  redeem_incomplete: '激活码已经绑定成功，但会员时长还没有写入。请把你的登录邮箱和这句话发给站长：{{QQ}}。后台按邮箱查这条核销记录补发时长。',
  plan_unavailable: '这个档位当前不可用。',
  video_not_found: '视频不存在或已下架。',
  membership_required: '这个视频需要会员才能观看完整版。',
  video_not_ready: '视频还没有上传完成，暂时不能发布。',
  video_tampered: '这条视频记录的权限信息与签名不一致，已停止播放。请联系后台核对。',
  // 迁移那一路（后台「导出迁移包」和备用站灌数）新出现的错误码，每条都要说得出下一步。
  export_table_invalid: '这个表不在导出范围内。可导的是档位、设置、账号、会员、激活码、教学影像、购买申请和观看记录；登录会话和日志不导出。',
  export_offset_invalid: '导出的行号不对，这一页没取。刷新后台再点一次导出。',
  migration_disabled: '这个站点不接受灌数：导入接口只在那一版临时构建里开着，口令也不在这里。',
  migration_token_invalid: '灌数口令不对，这次没写任何东西。口令只在那一次构建的输出里，用完就随下一版失效。',
  import_table_invalid: '这张表不在允许导入的范围内（登录会话和操作日志不跨站搬）。',
  import_rows_empty: '这一批是空的，没有可导入的行。',
  import_rows_too_many: '一次导入的行数超了，把这一批切小一点再灌。',
  import_row_id_missing: '有一行没有 id，整批没写。导出文件可能被截断，重新导一次再灌。',
  ingest_path_invalid: '这个存储路径不在灌数允许范围内：只允许写教学影像数据块（v/<视频>/序号.bin）和封面（poster/<视频>.jpg）。',
  ingest_body_empty: '这个数据块为空，未写入。',
  ingest_too_large: '这个数据块超过单次灌数的大小上限（9 MiB）。请缩小数据块后再灌入。',
  ingest_chunk_size_invalid: '数据块大小不在允许的范围内（64 KiB 到 8 MiB）。',
  ingest_plain_size_invalid: '这条教学影像的字节数不对，无法按数据块登记。',
  video_kind_invalid: '视频类别只能是「真实拳击」或「动画拳击」。',
  video_type_unsupported: '只支持 MP4、WebM 或 MOV。',
  video_size_invalid: '这个文件超过了站点允许的单个视频上限（当前 1 GB），请拆分后再传。',
  upload_not_open: '这次上传已经结束了。',
  chunk_verify_failed: '部分数据块未保存到存储中，可能是上传中途断线，因此教学影像未登记成功。请重新上传；若反复缺失数据块，请使用电脑浏览器或更稳定的网络。',
  chunk_read_failed: '教学影像数据块读取失败，请稍后重试。',
  cipher_invalid: '加密参数无效，请重新上传。',
  title_invalid: '请填写标题（不超过 120 字）。',
  duration_invalid: '时长数字无效。',
  tier_invalid: '所需会员等级无效。',
  status_invalid: '状态取值无效。',
  // 字段名不一致时服务端过去是"读不到就当没这回事"，提示照样说成功；现在整笔拒绝并说清没动过数据。
  field_unsupported: '这次提交里有一个站点不认识的字段，整笔已经拒绝，什么都没改。刷新页面重做一次；还是同样的话，把括号里的字段名记下来反馈。',
  field_contract_missing: '这个操作在站点里还没有登记可写字段，所以被直接拒绝，什么都没改（不是网络问题）。换一条入口重做一次，并把这句话和所在页面记下来反馈。',
  batch_size_invalid: '单次生成 1–1000 枚激活码。需要更多就再生成一批发码，总数不限。',
  key_batch_failed: '这一批次没有写入成功，请重试一次。',
  key_not_reversible: '这枚码已经兑换或已作废，不能撤回。',
  key_not_found: '没有这枚激活码，一条数据都没改。可能是这一批没写入成功，也可能链接抄错了——回「激活码」列表按批次重新找一次。',
  poster_size_invalid: '封面图大小无效（不超过 2 MB）。',
  poster_verify_failed: '封面图校验失败，请重新上传。',
  confirm_title_required: '请输入完全一致的标题才能删除。',
  membership_not_found: '没有找到这条会员记录。',
  // 回收站那三颗"恢复"按钮各有自己的拒绝理由：混成一句"操作失败"，
  // 站长就分不清是已经恢复过了、还是这条本来就过期了不该放回名单。
  membership_not_revoked: '这条会员记录没有被撤销过，不用恢复。',
  membership_already_expired: '这条权益本身已经过了到期时间，放回名单也只是多一行"已到期"。要给这位买家续，请在「会员名单」里给他重新出码或加减有效天数。',
  membership_restore_failed: '恢复这条会员权益没写进去。先刷新看它是不是已经在名单里，再试一次；还是不行就记下时间找平台看日志。',
  key_already_redeemed: '这枚码已经被某个账号兑换过了，不能放回未兑换——放回去等于凭空多一枚。',
  key_not_restorable: '这枚码现在的状态不是"已作废"，所以没什么可放回的。刷新一下看它到底在哪一栏。',
  key_restore_failed: '把这枚码放回未兑换没写进去。先刷新确认它现在的状态，再试一次。',
  // 改天数是站长最常用的售后动作，四种失败各有各的原因，不能都推给"稍后重试"。
  member_days_invalid: '天数要填整数，正数是延长、负数是缩短，一次最多 ±3650 天。',
  membership_permanent: '这条权益写着"永久"，没有到期日可以加减。要改成有期限，请撤销后重新发一枚对应档位的码。',
  membership_revoked_locked: '这条已经撤销过了，改天数没有意义。要恢复权益请重新发一枚激活码。',
  membership_conflict: '这条记录刚刚被别人改过了，这次没有写入。刷新名单后按最新的时间再改一次。',
  position_invalid: '观看进度数值无效。',
  body_invalid: '提交内容格式不正确。',
  body_type_invalid: '提交内容格式不正确。',
  body_too_large: '提交内容过大。',
  request_not_found: '没有找到这条购买申请。',
  plan_code_invalid: '档位代码只能用小写字母、数字和下划线。',
  plan_name_invalid: '请填写档位名称。',
  plan_rank_invalid: '等级数字需要在 1–90 之间。',
  plan_price_invalid: '价格数字无效。',
  plan_duration_invalid: '有效天数需要在 1–36500 之间，留空表示永久。',
  // 这句话是给用手机热点、地铁里、或正好赶上站点发布那一秒的人看的：
  // "检查网络"太笼统，要说清这次没成、能不能再来一次、以及实在不行换什么。
  network_error: '没连上站点（可能正好赶上发布重启的那几秒）。等十几秒再点一次；连着几次都这样，就换个网络试，比如手机热点。',
  invalid_response: '站点返回了无法识别的内容，请稍后重试。',
  // 这一条只在"平台网关回了 5xx、但本站一行代码都没跑"时用得上，见 neverStarted()。
  runtime_unavailable: '站点后台这一台没有接住这次提交（HTTP {status}）：请求在开始处理之前就断了，所以这次操作一定没有生效，也不是你的邮箱或密码被拒。等十几秒再点一次；连着几次都这样，就把这句和状态码发给站长：{{QQ}}',
  sites_gateway_origin_forbidden: '站点网关拦下了这次请求：请确认地址栏是本站网址（不是预览面板），然后刷新页面重试。',
  sites_gateway_unauthorized: '站点网关拦下了这次请求，请刷新页面后重试。',
  sites_function_not_found: '站点后台服务还没就绪，请稍后重试。',
  sites_function_unavailable: '站点后台正在启动，请稍等几秒再重试。',
  sites_function_timeout: '站点后台处理超时，请稍后重试。',
  sites_rate_limited: '请求过于频繁，请稍后再试。',
  internal_error: '站点处理这个操作时出错了，已经记录下来。请稍后重试；还是不行就把这句话、你刚才点的是哪个按钮、你的登录邮箱一起发给站长：{{QQ}}',
  password_too_weak: '这个密码太容易猜到，请换一个（混用字母和数字，避免生日和连续字符）。',
  too_many_requests: '操作太频繁，请稍后再试。',
  body_invalid_json: '提交内容不是有效的 JSON，请刷新页面后重试。',
  chunk_range_invalid: '数据块序号无效，请中止这次上传并重新选择文件。',
  field_not_editable: '这个字段不能直接改，请改用旁边的操作按钮。',
  media_failed: '这一段时间取不出来。请拖动进度条重试；反复失败就把视频标题和大概时间点发给 QQ。',
  password_write_failed: '密码没有写入成功，当前密码仍然有效。请重试一次。',
  session_not_found: '没有这台设备的登录记录了，可能已经退出去过一次。刷新「我的账号」再看一下设备列表。',
  cannot_revoke_current_session: '这台就是你正在用的设备，退掉它你自己也会立刻登出。要退的是别的设备，就点那一行右边的「退出这一台」。',
  session_revoke_failed: '这台设备没有退出去，它的登录还在。再点一次；还是不行就改一次密码，改密码会踢掉所有别的设备。',
  member_not_found: '没找到这个账号，可能已经变了。请刷新名单后再试。',
  user_write_failed: '账号信息没有写入成功，本次改动没有生效。请重试一次。',
  cannot_disable_self: '不能停用自己的账号，那样后台就进不去了。',
  admin_email_invalid: '这个邮箱格式不对，或者它本来就不在管理员名单里。',
  admin_list_full: '管理员名单已经到上限（10 个），先移除一个再加。',
  admin_last_owner: '这是名单里最后一个地址，删掉就没人能进后台了，所以不允许。',
  admin_cannot_remove_self: '不能把自己从管理员名单里移除，那样你会立刻进不去后台。',
  admin_write_failed: '管理员名单没有写入成功，本次改动没有生效。请重试一次。',
  case_key_invalid: '这一笔处理结果没有记下（认不出是哪一案）。刷新「用户行为」那一屏再点一次；界面没刷新前它仍算待处理。',
  plan_write_failed: '档位没有保存成功。请核对等级数字和价格是否为空，然后再提交一次。',
  request_write_failed: '购买申请没有记下来。请直接说明档位和登录邮箱发给站长：{{QQ}}',
  settings_write_failed: '站点设置没有保存成功，页面上显示的仍是旧值。请重试或把改动逐项分开保存。',
  video_delete_failed: '这条视频没有删干净，可能还占着存储空间。请再点一次删除；仍然失败就把标题发给后台处理。',
  video_write_failed: '教学影像记录未保存成功，目录中显示的仍是旧内容。请重试一次。',
  catalog_order_invalid: '这份排列与当前已发布目录不一致，请重新读取线上顺序后调整。',
  catalog_order_conflict: '目录或展示顺序已在其他页面更新。请先重新读取线上顺序，避免覆盖别人的修改。',
  catalog_order_limit_exceeded: '已发布目录超过当前编排上限，暂不能载入完整排序；请联系站长处理，不会保存不完整的顺序。',
  catalog_order_tampered: '已保存的展示顺序校验未通过，请联系站长处理；教学影像与会员数据没有被本次操作改写。',
  catalog_order_read_failed: '展示顺序暂时读取失败，请稍后重新读取。',
  catalog_order_write_failed: '服务器未能确认顺序写入，请先核对当前线上排列。',
};

// The backend forwards a database error *code* (never its message) so a write failure can
// be told apart instead of all becoming "没有保存成功". These are the ones worth naming for
// a non-engineer: each says what to change, not what the schema looks like.
const GATEWAY_HINTS = {
  42501: '数据库拒绝写入这张表，是访问策略没有放开',
  42703: '表里缺少这个字段，需要先执行数据库迁移',
  23502: '有必填字段是空的',
  23505: '已经有一条相同记录（代码重复）',
  '22P02': '某个数字字段收到了无法转换的内容',
  PGRST204: '提交里有一个字段是表里没有的',
  PGRST116: '这条记录没能唯一命中',
  no_row_returned: '数据库没有返回写入成功的记录',
  no_match: '更新没有命中这条记录（它可能已被删除，或这张表不允许修改）',
  transport: '连不上数据库',
  no_envelope: '数据库返回了无法识别的内容',
};

function gatewayHint(token) {
  const key = String(token ?? '').trim();
  if (!key) return null;
  if (GATEWAY_HINTS[key]) return GATEWAY_HINTS[key];
  if (/^[0-9A-Z]{2,12}$/.test(key)) return `数据库返回代码 ${key}`;
  // 字段契约拒绝时 detail 就是我们自己 API 的字段名（形如 tierRank）。把它显示出来，
  // 站长和开发才知道是哪一个名字不一致；带空格的原文（上游数据库报错）不会匹配上这条。
  if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) return `字段名 ${key}`;
  return null;
}

// 站点回了非 2xx 但没带自己的错误码时，客户端会合成 `http_<状态码>`。
// 这一族过去没有文案，一律退成"操作没有完成，请稍后重试"——正是站长报过的那句没说清任何事的话。
const HTTP_MESSAGES = {
  400: '站点不接受这次提交',
  401: '登录状态已经失效',
  403: '站点不让这个操作通过',
  404: '站点后台说这条路不存在（多半是刚发布还没就绪）',
  409: '这条记录已经被改过',
  429: '这台网络上的请求太频繁',
  500: '站点后台处理这个操作时出错了',
  502: '站点后台没有回话（可能正在发布或重启）',
  503: '站点后台正在启动',
  504: '站点后台处理超时',
};

export function messageFor(code, status = 0, extra = null) {
  const explicit = /^http_(\d{3})$/.exec(String(code ?? ''))?.[1];
  if (explicit) {
    const note = HTTP_MESSAGES[Number(explicit)];
    // 状态码必须出现在句子里：截图发过来就能直接定位是哪一层没通，不用猜。
    return note
      ? fill(`${note}（HTTP ${explicit}）。等十几秒再点一次；连着几次都这样，就把这句话和括号里的状态码发给站长：{{QQ}}`)
      : fill(`站点回了 HTTP ${explicit}，没有带原因。等十几秒再点一次；连着几次都这样，就把这个状态码发给站长：{{QQ}}`);
  }
  const minutes = Number(extra?.retryMinutes);
  return fill(String(MESSAGES[code] ?? '操作没有完成，请稍后重试。')
    .replaceAll('{status}', String(status || '5xx'))
    // 分钟数只有服务端知道（它算的锁）。没带回来就说"几分钟"，不许在这里留一个写死的数字。
    .replaceAll('{minutes}', Number.isFinite(minutes) && minutes > 0 ? `${Math.round(minutes)} 分钟` : '几分钟'));
}

// 只认已观测到的 bundle 文件缺失；普通网关超时或执行失败不能证明写入尚未开始。
function neverStarted(status, body) {
  return status >= 500 && typeof body?.error !== 'string' && typeof body?.msg === 'string'
    && /Function execution failed:\s*NotFound:[\s\S]*(?:No such file|readfile)[\s\S]*bundle\.eszip/i.test(body.msg);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 撞上"这一台没起来"时允许自动重发的动作：读请求，以及登录/注册。判据是重复发这一次不会多
// 出任何东西 —— 网关没让应用跑起来就不可能建成会话，而真建成了也就不会回这种 500。
// 出码、台账那类写动作不在这里面：它们的重发可能真的多生一批码，那句话只能让人自己点。
const GATEWAY_RETRY = new Set(['login', 'register']);
const actionOf = (path) => /[?&]a=([\w-]+)/.exec(String(path))?.[1] ?? '';

export async function requestJson(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const token = readCsrf();
  if (token && init.body !== undefined) headers.set('x-csrf-token', token);

  const isRead = init.method === undefined || init.method === 'GET';
  const retryable = isRead || GATEWAY_RETRY.has(actionOf(path));
  const send = () => fetch(path, { ...init, headers, credentials: 'same-origin' });
  let response;
  let retryBody;
  try {
    response = await send();
    // 退避两次再重发：平台那种失败是一台边缘实例找不到这一版的文件，换一台就通。
    for (const backoff of retryable ? [1200, 2400] : []) {
      if (response.status < 500) break;
      if (!isRead) {
        if (!(response.headers.get('content-type') ?? '').includes('application/json')) break;
        try { retryBody = await response.json(); } catch { break; }
        // 应用自己的 5xx 可能发生在写入后；只有未启动的网关回复才允许重发登录/注册。
        if (!neverStarted(response.status, retryBody)) break;
      }
      await wait(backoff);
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      response = await send();
      retryBody = undefined;
    }
  } catch {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    throw new ApiError(MESSAGES.network_error, 'network_error');
  }
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ApiError(MESSAGES.invalid_response, 'invalid_response', response.status);
  }
  let data = retryBody;
  try {
    if (data === undefined) data = await response.json();
  } catch {
    throw new ApiError(MESSAGES.invalid_response, 'invalid_response', response.status);
  }
  const body = data && typeof data === 'object' ? data : null;
  const down = neverStarted(response.status, body);
  let code = null;
  if (typeof body?.error === 'string') code = body.error;
  else if (down) code = 'runtime_unavailable';
  else if (!response.ok && typeof body?.code === 'string') code = body.code;
  else if (!response.ok) code = `http_${response.status}`;
  if (code) {
    // 网关那串英文（Function execution failed: NotFound …）不进句子：太长，买家读不出下一步。
    const hint = down ? null : gatewayHint(body?.message ?? body?.msg);
    const base = messageFor(code, response.status, body);
    const message = hint ? `${base}（${hint}）` : base;
    const error = new ApiError(message, code, response.status);
    // The server says so explicitly when a write was refused rather than unanswered; only
    // the latter is an unknown outcome that deserves "go check first".
    error.rejected = body?.outcome === 'rejected';
    error.neverStarted = down;
    throw error;
  }
  return data;
}

export function api(action, params = {}) {
  const url = new URL('/functions/v1/app', self.location.origin);
  url.searchParams.set('a', action);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

// 写操作没等到回复，不等于没生效。说"失败了，再点一次"会让人重复已经做成的动作
// （第二批码、重复的台账行就是这么来的），所以危险动作各有"先去核对"这一句。
const UNCERTAIN_DEFAULT = '站点没有回话，这次改动不确定有没有生效。先刷新页面核对，再决定要不要重做。';
const UNCERTAIN = {
  'admin-keys-create': '这一批激活码可能已经生成了。先到「激活码」刷新看一下，确认没有再点一次生成。',
  'admin-request-create': '这笔购买记录可能已经记上了。先到「购买记录」刷新核对，重复提交会留下两条。',
  'admin-video-delete': '这条教学影像可能已经删除。请刷新教学影像库确认；若仍存在，再删除一次。',
  'admin-plan-save': '档位可能已经保存了。刷新「档位设置」核对数字，再决定要不要重填。',
  'admin-plans-seed': '三个档位可能已经建好了。刷新「档位设置」核对，重复点不会产生第二套。',
  'admin-settings-save': '设置可能已经生效了。刷新页面看显示的是新值还是旧值，再决定重发哪一项。',
  'admin-member-revoke': '这条会员记录可能已经撤销了。刷新名单核对，别连续点撤销。',
  'admin-user-disable': '这个账号可能已经停用了。刷新名单看它的状态标记。',
  'admin-user-enable': '这个账号可能已经恢复了。刷新名单看它的状态标记。',
  'admin-user-note': '备注可能已经存下了。刷新名单看输入框里的内容。',
  'admin-user-reset-password': '密码可能已经改过了。请保留本次生成的密码，先核对重置结果再交给本人；不要立即生成第二个密码。',
  'admin-admin-grant': '这个邮箱可能已经加进名单了。刷新「站点设置」底部的管理员名单核对。',
  'admin-admin-revoke': '这个邮箱可能已经移出了名单。刷新管理员名单核对。',
  'admin-poster-done': '封面可能已经保存。请刷新教学影像库，确认这条教学影像是否显示封面。',
  'admin-poster-url': '封面写入地址可能已经发出去了。先刷新看封面有没有挂上。',
  'redeem': '这枚激活码可能已经核销成功了。刷新「我的账号」看会员有没有到；没有就把这枚码和登录邮箱发给站长：{{QQ}}',
  'password-change': '密码可能已经改好了。先用新密码登录一次试试，别急着再改一遍。',
  'session-revoke': '那台设备可能已经退出了。刷新「我的账号」看设备列表里还有没有它；还在再点一次，别连着点。',
  'admin-video-update': '这条修改可能已经保存。请刷新教学影像库，核对显示的档位、试看和状态。',
  'admin-request-update': '这笔记录的状态可能已经改了。刷新「购买记录」核对。',
  'admin-key-revoke': '这枚码可能已经作废了。刷新激活码列表核对它的状态。',
};
const OUTCOME_ALWAYS_CLEAR = new Set(['login', 'register', 'logout']);

export function post(action, body, init = {}) {
  // init 是给"页面正在关掉"那一下用的（keepalive），其余请求一律走默认。
  return requestJson(api(action), { method: 'POST', body: JSON.stringify(body ?? {}), ...init }).catch((error) => {
    if (OUTCOME_ALWAYS_CLEAR.has(action) || error.rejected || !isWriteOutcomeUnknown(error)) throw error;
    throw new ApiError(fill(UNCERTAIN[action] ?? UNCERTAIN_DEFAULT), error.code, error.status);
  });
}

export function get(action, params) {
  return requestJson(api(action, params));
}

function readCsrf() {
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === 'lvs_csrf') return decodeURIComponent(part.slice(index + 1));
  }
  return null;
}

export function isWriteOutcomeUnknown(error) {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401 || error.status === 403) return false;
  if (error.code === 'write_rejected') return false;
  // 网关那类"函数没起来"的 5xx 一定没开始处理，所以结果不是未知，而是确定没发生 ——
  // 这时候说"可能已经生效了，先去核对"会把人支到后台去查一件不存在的事。
  if (error.neverStarted) return false;
  return ['network_error', 'invalid_response', 'write_result_unknown'].includes(error.code)
    || (error.status >= 500 && error.status < 600);
}
