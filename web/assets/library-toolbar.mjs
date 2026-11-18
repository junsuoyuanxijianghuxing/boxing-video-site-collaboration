// Presentation only. The original browser owns filtering, pagination and history.
const mounts = new WeakMap();

export function mountLibraryToolbar(root) {
  mounts.get(root)?.();
  const advanced = root.querySelector('#library-advanced');
  const panel = advanced?.querySelector('.library-advanced-panel');
  const summary = advanced?.querySelector('summary');
  const bottom = root.querySelector('#library-page-size');
  const results = root.querySelector('#kind-list');
  const bar = root.querySelector('.library-results-bar');
  const quick = root.querySelector('#library-page-quick');
  if (!panel || !summary || !bottom || !results || !bar || !quick) return () => {};

  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  const originalChildren = [...panel.childNodes];
  const originalLabel = panel.getAttribute('aria-labelledby');
  const originalRole = panel.getAttribute('role');
  const originalDescription = summary.getAttribute('aria-describedby');
  let disposed = false, focusRepair = 0;
  const alive = () => !disposed && root.isConnected;
  const heading = document.createElement('header');
  heading.className = 'library-filter-heading';
  heading.innerHTML = '<h3 id="library-filter-title">筛选教学影像</h3><p id="library-filter-hint">选择后立即生效，完成后可收起面板。</p>';
  const fields = document.createElement('div');
  fields.className = 'library-filter-fields';
  const actions = document.createElement('footer');
  actions.className = 'library-filter-actions';
  const groups = [
    ['观看条件', ['library-tier', 'library-access']],
    ['内容条件', ['library-duration', 'library-progress']],
  ];
  const labels = [...panel.children].filter(child => child.tagName === 'LABEL');
  for (const [title, ids] of groups) {
    const matching = labels.filter(label => ids.some(id => label.querySelector('select')?.id === id));
    if (!matching.length) continue;
    const group = document.createElement('fieldset');
    group.className = 'library-filter-group';
    const legend = document.createElement('legend');
    legend.textContent = title;
    group.append(legend, ...matching);
    fields.append(group);
  }
  // Retain any future fields and actions even if their IDs are unfamiliar.
  for (const label of labels) if (label.parentNode === panel) fields.append(label);
  for (const child of [...panel.children]) actions.append(child);
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-sm';
  done.dataset.libraryDone = '';
  done.textContent = '完成筛选';
  actions.append(done);
  panel.replaceChildren(heading, fields, actions);
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'library-filter-title');
  summary.setAttribute('aria-describedby', 'library-filter-hint');

  const topLabel = document.createElement('label');
  topLabel.className = 'library-page-size library-page-size-top';
  topLabel.append(document.createTextNode('每页'));
  const top = bottom.cloneNode(true);
  top.id = 'library-page-size-top';
  top.setAttribute('aria-label', '每页显示数量（顶部）');
  topLabel.append(top);
  bar.insertBefore(topLabel, quick);
  root.classList.add('library-toolbar-ready');

  function restoreFocus() {
    if (!alive()) return;
    const target = advanced.hidden
      ? root.querySelector('.library-section[aria-current="page"]') || root.querySelector('#lib-q')
      : summary;
    target?.focus({ preventScroll: true });
  }
  function repairHiddenFocus() {
    cancelAnimationFrame(focusRepair);
    focusRepair = requestAnimationFrame(() => {
      focusRepair = 0;
      if (alive() && !advanced.open && panel.contains(document.activeElement)) restoreFocus();
    });
  }
  function close(restore = false) {
    advanced.open = false;
    if (restore) restoreFocus();
    else repairHiddenFocus();
  }
  function sync() {
    if (!alive()) return;
    top.value = bottom.value;
    top.disabled = bottom.disabled;
    topLabel.hidden = bottom.hidden || bottom.closest('label')?.hidden === true;
    if (advanced.hidden) close();
  }
  top.addEventListener('change', event => {
    event.stopPropagation();
    if (!alive() || bottom.disabled) return;
    bottom.value = top.value;
    bottom.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  }, options);
  root.addEventListener('change', sync, options);
  done.addEventListener('click', () => close(true), options);
  advanced.addEventListener('toggle', () => {
    if (!advanced.open) repairHiddenFocus();
  }, options);
  advanced.addEventListener('focusout', event => {
    if (advanced.open && event.relatedTarget && !advanced.contains(event.relatedTarget)) close();
  }, options);
  document.addEventListener('pointerdown', event => {
    if (alive() && advanced.open && event.button === 0 && !advanced.contains(event.target)) close();
  }, options);
  document.addEventListener('keydown', event => {
    if (!alive() || !advanced.open || event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }, options);

  const observer = new MutationObserver(sync);
  observer.observe(results, { childList: true });
  observer.observe(advanced, { attributes: true, attributeFilter: ['hidden'] });
  sync();
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    observer.disconnect();
    cancelAnimationFrame(focusRepair);
    topLabel.remove();
    // Restore the exact original controls, including their listeners and values.
    panel.replaceChildren(...originalChildren);
    for (const [element, key, value] of [[panel, 'aria-labelledby', originalLabel], [panel, 'role', originalRole], [summary, 'aria-describedby', originalDescription]]) {
      if (value === null) element.removeAttribute(key);
      else element.setAttribute(key, value);
    }
    root.classList.remove('library-toolbar-ready');
    if (mounts.get(root) === dispose) mounts.delete(root);
  }
  mounts.set(root, dispose);
  return dispose;
}
