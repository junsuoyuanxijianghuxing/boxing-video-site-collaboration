// 路由判据只留这一份。app.js 的 render() 原先把 `location.pathname.replace(/\/+$/, '') || '/'`
// 抄了三处，同一个判断改一处就漏两处；补"响应回来时页面已经切走"的守卫时，漏掉的那几条路径
// 会让旧请求把新页面盖掉 —— 手机上连点两个标签最容易撞见。
// 末尾斜杠不算另一屏：/account/ 与 /account 是同一页。
export const routeOf = (raw) => String(raw ?? '').replace(/\/+$/, '') || '/';
