// 站点按天算请求额度，播放期间的 heartbeat 是买家一侧最大的一笔：
// 30 秒一报 = 一小时 120 条请求。90 秒这一步现在只当**下限**用（短片一秒都不改），
// 长片按片长放大 —— 额度是按条数烧的，一条 14 分钟的片子和一条 30 秒的示范课
// 按同样节奏报，前者就是白多花六条。
export const REPORT_STEP_SECONDS = 90;
// 上限：一小时最多 12 条。放得更长就要拿"回来接不上"换额度了，不值。
export const REPORT_STEP_MAX_SECONDS = 300;

// 四分之一的片长：14 分钟 → 3 分半一跳（一次观看约 4 条），5 分钟以下的片子还是 90 秒。
// 读不到时长（0、NaN）一律回到 90 秒：宁可多报，也不能把人写成"永远不报"，
// 那会让续播彻底失效。
export function reportStepSeconds(totalSeconds) {
  const total = Number(totalSeconds);
  if (!Number.isFinite(total) || total <= 0) return REPORT_STEP_SECONDS;
  return Math.min(REPORT_STEP_MAX_SECONDS, Math.max(REPORT_STEP_SECONDS, Math.round(total / 4)));
}

export function shouldReport(currentSeconds, lastReportedSeconds, stepSeconds = REPORT_STEP_SECONDS) {
  const current = Number(currentSeconds);
  const last = Number(lastReportedSeconds);
  const step = Number(stepSeconds) > 0 ? Number(stepSeconds) : REPORT_STEP_SECONDS;
  if (!Number.isFinite(current) || current < 0) return false;
  if (!Number.isFinite(last)) return current >= step;
  // 往回拖也要报：续播取的是"最新一次"的位置，他不报上去，下次回来就会被送回三十分钟前的地方。
  return Math.abs(current - last) >= step;
}

// "看完没"和"值不值得接上"不能用绝对秒数：30 秒的示范课看到 12 秒既不是结尾，
// 也不该从头播。上限钉在旧值上，所以长片的判据一个字没变，只有短片按比例收紧。
export function endTailSeconds(totalSeconds) {
  const total = Number(totalSeconds);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(20, Math.max(3, total * 0.03));
}

export function resumeHeadSeconds(totalSeconds) {
  const total = Number(totalSeconds);
  if (!Number.isFinite(total) || total <= 0) return Infinity;
  return Math.min(15, Math.max(2, total * 0.25));
}

export function isWatchedToEnd(positionSeconds, totalSeconds) {
  const at = Number(positionSeconds);
  const total = Number(totalSeconds);
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(total) || total <= 0) return false;
  return total - at <= endTailSeconds(total);
}

export function canResumeFrom(positionSeconds, totalSeconds) {
  const at = Number(positionSeconds);
  const total = Number(totalSeconds);
  if (!Number.isFinite(at) || !Number.isFinite(total)) return false;
  return at > resumeHeadSeconds(total) && total - at > endTailSeconds(total);
}

// 关页面那一下要不要把手上的进度交出去：定时那一跳按片长攒（长片最长 5 分钟一跳），
// 直接关标签页的人不该被送回五分钟前。10 秒以下不值得多发一条请求。
export const FLUSH_STEP_SECONDS = 10;

export function shouldFlush(currentSeconds, lastReportedSeconds) {
  const current = Number(currentSeconds);
  const last = Number(lastReportedSeconds);
  if (!Number.isFinite(current)) return false;
  if (!Number.isFinite(last)) return current >= FLUSH_STEP_SECONDS;
  return Math.abs(current - last) >= FLUSH_STEP_SECONDS;
}
