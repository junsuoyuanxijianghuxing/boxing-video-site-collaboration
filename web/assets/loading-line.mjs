// 骨架屏那句要说清"这一屏在等什么"。以前所有路由都印同一句"正在读取教学影像库信息…"，
// 于是手机上打开定价页、后台、播放器都显示"影像库"，人以为页面串了、或者以为自己点错了。
export const loadingLine = (path) => {
  const route = String(path ?? '');
  if (route === '/admin') return '正在读取后台数据…';
  if (route.startsWith('/v/')) return '正在准备播放器…';
  if (route.startsWith('/series')) return '正在读取教学合集…';
  if (route === '/login' || route === '/register' || route === '/account') return '正在读取你的会员状态…';
  if (route === '/pricing') return '正在读取档位与价目…';
  if (route === '/wall') return '正在铺开影像墙…';
  if (route === '/' || route === '/library') return '正在读取教学影像库信息…';
  return '正在读取这一页…';
};
