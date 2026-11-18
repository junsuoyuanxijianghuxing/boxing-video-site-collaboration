// 剪贴板在微信/QQ 内置浏览器里会整段不可用，或被权限策略拒绝。
// 界面拿"有没有抛错"当"复制成功了"，就会在失败那一下照样印"已复制"——所以判据收在这一个函数里，
// 只在全过程没出错时回 true；调用方必须自己处理 false 那条话。
export async function copyText(value, clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard) {
  try {
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(String(value));
    return true;
  } catch {
    return false;
  }
}
