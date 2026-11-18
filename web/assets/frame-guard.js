// nginx 这一层已经用响应头发了 frame-ancestors 'none'；<meta> CSP 表达不了这条指令
// （浏览器会直接忽略并报警），所以这里留一层自己的兜底：被别的页面套进框架时抢回顶层窗口，
// 顺带挡住"用透明 iframe 盖住真按钮偷点击"。父页面若沙箱掉脚本，这段就不跑，
// 但它也什么都拿不到。
if (window.top !== window.self) {
  const escape = () => {
    try {
      window.top.location = window.self.location;
      return true;
    } catch (error) {
      return false;
    }
  };
  if (!escape()) {
    // Hiding the root element beats rewriting the document: it cannot race the parser,
    // and it still holds if the app bundle renders later. `style-src` already allows
    // inline styles, so this rule is not blocked by the page CSP.
    const hide = document.createElement('style');
    hide.textContent = 'html{display:none!important}';
    document.documentElement.append(hide);
  }
}
