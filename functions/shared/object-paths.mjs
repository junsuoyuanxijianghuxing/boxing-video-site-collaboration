// 桶里允许存在的路径只有这两种形状。判据写在这里，是因为服务端（灌数接口）和存储实现本身
// （自托管那台落盘版）都要用同一把尺子 —— 抄两份迟早漂，漂了就等于放开"往任意路径写"。
export const SHARD_PATH = /^v\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/\d{6}\.bin$/;
export const POSTER_PATH = /^poster\/[0-9a-f-]{36}\.(?:jpg|jpeg|png|webp)$/;

export function isStorePath(path) {
  const value = String(path ?? '');
  return SHARD_PATH.test(value) || POSTER_PATH.test(value);
}
