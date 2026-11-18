import { lessonCardMarkup, escapeCardText as esc } from './lesson-card.mjs';

const sameOrder = (a, b) => a.length === b.length && a.every((item, i) => item.id === b[i]?.id);
const sameIds = (items, ids) => Array.isArray(ids) && items.length === ids.length && items.every((item, i) => item.id === ids[i]);
const sameMembers = (items, ids) => {
  if (!Array.isArray(ids) || items.length !== ids.length || new Set(ids).size !== ids.length) return false;
  const current = new Set(items.map(item => item.id));
  return ids.every(id => current.has(id));
};
// A route change keeps this tab's public-card draft in memory; it never publishes it.
let pendingDraft = null;
let activeOwner = null;
// Only this request's finally releases the write lock, even if its view was replaced.
let inFlight = null;

export async function mountCatalogOrderEditor(host, { get, post, posterSrc, hydratePosters, isWriteOutcomeUnknown, onSaved, onClose }) {
  if (!host?.isConnected) return;
  const owner = Symbol('catalog-order-owner');
  activeOwner = owner;
  let destroyed = false;
  const ready = () => !destroyed && activeOwner === owner && host.isConnected;
  host.innerHTML = '<p class="dim" role="status">正在读取全部已发布教学影像…</p>';
  let data;
  try { data = await get('admin-catalog-order'); }
  catch (error) { if (!ready()) return; throw error; }
  if (!ready()) return;
  let baseline = [...data.items];
  let draft = [...baseline];
  let revision = data.revision;
  let history = [];
  let future = [];
  let device = window.matchMedia('(max-width: 860px)').matches ? 'mobile' : 'desktop';
  let editPage = 0;
  let pageSize = 6;
  let previewPage = 0;
  const previewPageSize = () => device === 'mobile' ? 2 : 8;
  const positionDrafts = new Map();
  const boundRows = new WeakSet();
  let saving = false;
  let uncertain = false;
  let conflict = false;
  let submittedIds = null;
  let submittedRevision = null;
  let notice = '';
  let tone = 'saved';
  let dragging = null;
  const dirty = () => !sameOrder(draft, baseline);
  const hasChanges = () => dirty() || positionDrafts.size > 0 || uncertain || conflict || Boolean(inFlight);
  const locked = () => !ready() || saving || uncertain || conflict || Boolean(inFlight);
  if (pendingDraft) {
    const saved = pendingDraft;
    const latestItems = [...data.items];
    const baselineIds = saved.baselineIds ?? latestItems.map(item => item.id);
    const byId = new Map([...(saved.items ?? []), ...latestItems].map(item => [item.id, item]));
    const recover = id => byId.get(id) ?? { id, title: '目录中已移除的教学影像', hasPoster: false, tierRank: 0, previewSeconds: 0 };
    baseline = baselineIds.map(recover);
    draft = saved.ids.map(recover);
    revision = saved.revision ?? saved.submittedRevision ?? data.revision;
    submittedIds = saved.submittedIds ? [...saved.submittedIds] : null;
    submittedRevision = saved.submittedRevision ?? null;
    for (const [id, value] of saved.positions ?? []) {
      if (saved.ids.includes(id)) positionDrafts.set(id, value);
    }
    uncertain = saved.status === 'submitting' || saved.status === 'uncertain';
    conflict = saved.status === 'conflict' || !sameMembers(latestItems, saved.ids) || !sameMembers(latestItems, baselineIds);
    if (!uncertain && !conflict && !sameIds(latestItems, baselineIds)) conflict = true;
    if (conflict) {
      uncertain = false;
      notice = '线上顺序或目录已有其他修改，原草稿已保留并锁定。请明确重新读取线上顺序后再编排。';
      tone = 'error';
    } else if (uncertain) {
      notice = inFlight ? '上次保存仍在等待响应，暂不能再次保存或重新读取。' : '上次保存的结果尚未确认，草稿已保留。请先核对保存结果。';
      tone = 'error';
    } else {
      revision = data.revision;
      notice = '已恢复这次访问中尚未保存的排列。';
      tone = 'dirty';
    }
  }

  host.innerHTML = `<section class="order-workspace" data-order-pane="edit" aria-labelledby="order-title">
    <div class="order-editor-header"><div><p class="lesson-kicker">COLLECTION EDITOR</p><h2 id="order-title">调整展示顺序</h2><p class="dim">这里只编排公开目录；首页“最近更新”仍按发布时间排列。新上传并发布的内容会先放在目录前面。</p></div><button class="btn btn-ghost" type="button" data-order-close>返回教学影像管理</button></div>
    <div class="order-toolbar"><div class="row"><button class="btn" type="button" data-order-undo>撤销一步</button><button class="btn" type="button" data-order-redo>重做</button><button class="btn btn-ghost" type="button" data-order-reset>放弃本次修改</button><button class="btn btn-ghost" type="button" data-order-reload>重新读取线上顺序</button></div></div>
    <div class="order-status" role="status" aria-live="polite"></div>
    <div class="order-actions"><p class="dim">预览仅在当前页面变化，点击保存后才会对观众生效。</p><div class="row"><button class="btn" type="button" data-order-reconcile hidden>核对保存结果</button><button class="btn btn-primary" type="button" data-order-save>保存顺序</button></div></div>
    <div class="order-pane-switch row" role="group" aria-label="排序工作区"><button class="btn btn-primary" type="button" data-order-pane-target="edit" aria-pressed="true">编排</button><button class="btn" type="button" data-order-pane-target="preview" aria-pressed="false">预览</button></div>
    <div class="order-layout">
      <div class="order-controls" data-order-panel="edit">
        <nav class="admin-list-pager order-pager" aria-label="编排列表分页"><label class="order-page-size">每页 <select class="input" data-order-page-size aria-label="每页编排条数"><option value="6">6 条</option><option value="12">12 条</option><option value="24">24 条</option></select></label><button class="btn btn-sm" type="button" data-order-page="previous">上一页</button><span class="tiny dim" data-order-page-label role="status" aria-live="polite"></span><button class="btn btn-sm" type="button" data-order-page="next">下一页</button></nav>
        <p class="dim">拖动调整本页顺序；上移、下移可以越过页边界，“移到”可填写整个目录中的任意位置。这里只显示已发布内容。</p><ol class="order-items" aria-label="教学影像展示顺序"></ol>
      </div>
      <div class="order-preview" data-order-panel="preview">
        <div class="row" role="group" aria-label="排序预览尺寸"><button class="btn" type="button" data-order-device="desktop">桌面预览</button><button class="btn" type="button" data-order-device="mobile">手机预览</button></div>
        <nav class="admin-list-pager order-preview-pager" aria-label="排列效果预览分页"><button class="btn btn-sm" type="button" data-preview-page="previous">上一页</button><span class="tiny dim" data-preview-page-label role="status" aria-live="polite"></span><button class="btn btn-sm" type="button" data-preview-page="next">下一页</button></nav>
        <p class="dim" data-preview-note></p><div class="order-preview-device" data-device="desktop"><div class="order-preview-grid"></div></div>
      </div>
    </div>
  </section>`;
  const q = (selector) => host.querySelector(selector);
  let observedWrite = null;
  const beforeUnload = (event) => {
    if (ready() && (hasChanges() || saving)) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  const observer = new MutationObserver(() => { if (!ready()) destroy(); });
  observer.observe(host.closest('main') ?? host.parentElement, { childList: true, subtree: true });
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    window.removeEventListener('beforeunload', beforeUnload);
    observedWrite?.listeners.delete(onWriteSettled);
    if (activeOwner === owner) activeOwner = null;
  }
  const remember = () => {
    if (!ready()) return;
    pendingDraft = hasChanges() ? {
      status: inFlight ? 'submitting' : conflict ? 'conflict' : uncertain ? 'uncertain' : 'dirty',
      revision, ids: draft.map(item => item.id), positions: [...positionDrafts],
      baselineIds: baseline.map(item => item.id),
      submittedIds: submittedIds ? [...submittedIds] : null, submittedRevision,
      items: [...new Map([...baseline, ...draft].map(item => [item.id, item])).values()],
    } : null;
  };
  function onWriteSettled() {
    if (!ready()) return;
    if (conflict) notice = '线上目录已有变化，原草稿仍已锁定。请重新读取线上顺序后再编排。';
    else {
      uncertain = true;
      notice = '上次保存请求已结束，结果尚未核对。草稿已保留，请先核对保存结果。';
    }
    tone = 'error';
    remember();
    paint();
  }
  const pageCount = (size) => Math.max(1, Math.ceil(draft.length / size));
  const rangeLabel = (page, size) => draft.length
    ? `第 ${page + 1} / ${pageCount(size)} 页 · 第 ${page * size + 1}–${Math.min((page + 1) * size, draft.length)} 位，共 ${draft.length} 条`
    : '暂无已发布教学影像';
  function paintStatus() {
    if (!ready()) return;
    const changed = draft.reduce((count, item, i) => count + Number(item.id !== baseline[i]?.id), 0);
    q('.order-status').dataset.state = saving || inFlight ? 'saving' : conflict || uncertain ? 'error' : notice ? tone : hasChanges() ? 'dirty' : 'saved';
    q('.order-status').textContent = inFlight ? '保存请求仍在等待响应，暂不能再次保存、核对或重新读取；可以翻页查看预览。' : saving ? '正在读取线上顺序，请稍候…' : notice || (hasChanges() ? `尚未保存 · ${changed} 个位置已调整${positionDrafts.size ? `，${positionDrafts.size} 个位置输入待确认` : ''}。可切换“预览”查看当前排列。` : `当前线上顺序 · 共 ${draft.length} 条已发布教学影像。`);
    q('[data-order-save]').disabled = locked() || !hasChanges();
    q('[data-order-undo]').disabled = locked() || history.length === 0;
    q('[data-order-redo]').disabled = locked() || future.length === 0;
    q('[data-order-reset]').disabled = locked() || !hasChanges();
    q('[data-order-close]').disabled = saving || uncertain || Boolean(inFlight);
    q('[data-order-reload]').disabled = saving || Boolean(inFlight);
    q('[data-order-reconcile]').hidden = !uncertain || conflict;
    q('[data-order-reconcile]').disabled = saving || Boolean(inFlight);
  }
  function paintPreview() {
    if (!ready()) return;
    const size = previewPageSize();
    previewPage = Math.max(0, Math.min(previewPage, pageCount(size) - 1));
    for (const button of host.querySelectorAll('[data-order-device]')) {
      button.setAttribute('aria-pressed', String(button.dataset.orderDevice === device));
      button.classList.toggle('btn-primary', button.dataset.orderDevice === device);
    }
    const shown = draft.slice(previewPage * size, (previewPage + 1) * size);
    q('.order-preview-device').dataset.device = device;
    q('[data-preview-note]').textContent = device === 'desktop'
      ? window.matchMedia('(max-width: 860px)').matches
        ? '桌面四列缩略预览：手机上缩小显示，用于核对排列；修改保存后才公开。'
        : '桌面四列排列预览，每页显示 8 条；修改保存后才公开。'
      : '手机单列排列预览，每页显示 2 条；修改保存后才公开。';
    q('[data-preview-page-label]').textContent = rangeLabel(previewPage, size);
    for (const button of host.querySelectorAll('[data-preview-page]')) {
      button.disabled = button.dataset.previewPage === 'previous' ? previewPage === 0 : previewPage >= pageCount(size) - 1;
    }
    q('.order-preview-grid').innerHTML = shown.map((item) => lessonCardMarkup({ ...item, access: item.tierRank === 0 ? 'full' : item.previewSeconds > 0 ? 'preview' : 'locked' }, { posterUrl: posterSrc(item.id, item.posterVersion), interactive: false })).join('') || '<p class="dim">发布教学影像后，即可在这里编排。</p>';
  }
  function paintRows(focusId = null, focusAction = null) {
    if (!ready()) return;
    editPage = Math.max(0, Math.min(editPage, pageCount(pageSize) - 1));
    const start = editPage * pageSize;
    const shown = draft.slice(start, start + pageSize);
    q('[data-order-page-size]').value = String(pageSize);
    q('[data-order-page-size]').disabled = false;
    q('[data-order-page-label]').textContent = rangeLabel(editPage, pageSize);
    for (const button of host.querySelectorAll('[data-order-page]')) {
      button.disabled = button.dataset.orderPage === 'previous' ? editPage === 0 : editPage >= pageCount(pageSize) - 1;
    }
    const list = q('.order-items');
    const oldRows = new Map([...list.querySelectorAll('[data-order-row]')].map((row) => [row.dataset.orderRow, row]));
    list.start = start + 1;
    const rows = shown.map((item, offset) => {
      const i = start + offset;
      const value = positionDrafts.get(item.id) ?? String(i + 1);
      let row = oldRows.get(item.id);
      if (!row) {
        const template = document.createElement('template');
        template.innerHTML = `<li class="order-item" data-order-row="${esc(item.id)}">
      <div class="order-item-thumb poster">${item.hasPoster ? `<img data-poster="${esc(posterSrc(item.id, item.posterVersion))}" width="128" height="72" alt="" decoding="async">` : '<span class="poster-code">封面</span>'}</div>
      <div class="order-item-copy"><strong>${esc(item.title)}</strong><span class="dim">展示位置 ${i + 1}</span></div>
      <div class="order-item-actions"><button class="btn btn-sm" type="button" data-move="up" aria-label="上移《${esc(item.title)}》">↑ 上移</button><button class="btn btn-sm" type="button" data-move="down" aria-label="下移《${esc(item.title)}》">↓ 下移</button><label>移到<input class="input" data-position type="number" min="1" max="${draft.length}" step="1" value="${esc(value)}" aria-label="《${esc(item.title)}》的展示位置"></label></div>
    </li>`;
        row = template.content.firstElementChild;
      }
      row.draggable = !locked();
      row.setAttribute('aria-label', `第 ${i + 1} 位，${item.title}`);
      row.querySelector('.order-item-copy span').textContent = `展示位置 ${i + 1}`;
      row.querySelector('[data-move="up"]').disabled = locked() || i === 0;
      row.querySelector('[data-move="down"]').disabled = locked() || i === draft.length - 1;
      const input = row.querySelector('[data-position]');
      input.max = String(draft.length);
      input.disabled = locked();
      if (input.value !== value) input.value = value;
      return row;
    });
    list.replaceChildren(...rows);
    if (!rows.length) {
      const empty = document.createElement('li'); empty.className = 'dim'; empty.textContent = '还没有已发布教学影像。';
      list.append(empty);
    }
    bindRows();
    if (focusId) {
      showPane('edit');
      const row = [...host.querySelectorAll('[data-order-row]')].find((el) => el.dataset.orderRow === focusId);
      const control = row?.querySelector(focusAction === 'position' ? '[data-position]' : `[data-move="${focusAction}"]:not(:disabled)`)
        ?? row?.querySelector('[data-position]');
      control?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  function paint(focusId = null, focusAction = null) {
    if (!ready()) return;
    paintStatus();
    paintRows(focusId, focusAction);
    paintPreview();
    hydratePosters();
  }
  function showPane(pane) {
    if (!ready() || !['edit', 'preview'].includes(pane)) return;
    q('.order-workspace').dataset.orderPane = pane;
    for (const target of host.querySelectorAll('[data-order-pane-target]')) {
      const selected = target.dataset.orderPaneTarget === pane;
      target.setAttribute('aria-pressed', String(selected));
      target.classList.toggle('btn-primary', selected);
    }
  }
  function move(id, target, action) {
    if (locked()) return;
    const from = draft.findIndex((item) => item.id === id);
    if (from < 0 || !Number.isInteger(target) || target < 0 || target >= draft.length || from === target) return;
    history.push([...draft]);
    future = [];
    if (history.length > 30) history.shift();
    const [item] = draft.splice(from, 1);
    draft.splice(target, 0, item);
    positionDrafts.delete(id);
    editPage = Math.floor(target / pageSize);
    notice = '';
    remember();
    paint(id, action);
  }
  function commitPosition(id, value, focus = true) {
    if (locked()) return false;
    const next = Number(value);
    if (!String(value).trim() || !Number.isInteger(next) || next < 1 || next > draft.length) {
      notice = `位置需要填写 1 至 ${draft.length} 的整数。`;
      tone = 'error';
      editPage = Math.floor(draft.findIndex((item) => item.id === id) / pageSize);
      if (focus) paintRows(id, 'position');
      paintStatus();
      hydratePosters();
      return false;
    }
    positionDrafts.delete(id);
    const from = draft.findIndex((item) => item.id === id);
    if (from === next - 1) { notice = ''; remember(); paintStatus(); return true; }
    move(id, next - 1, focus ? 'position' : null);
    return true;
  }
  function bindRows() {
    for (const row of host.querySelectorAll('[data-order-row]')) {
      if (boundRows.has(row)) continue;
      boundRows.add(row);
      const id = row.dataset.orderRow;
      for (const button of row.querySelectorAll('[data-move]')) button.addEventListener('click', () => move(id, draft.findIndex((item) => item.id === id) + (button.dataset.move === 'up' ? -1 : 1), button.dataset.move));
      const position = row.querySelector('[data-position]');
      position.addEventListener('input', () => {
        if (locked()) return;
        const currentPosition = draft.findIndex((item) => item.id === id) + 1;
        if (position.value === String(currentPosition)) positionDrafts.delete(id);
        else positionDrafts.set(id, position.value);
        remember();
        paintStatus();
      });
      position.addEventListener('change', () => commitPosition(id, position.value));
      position.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); commitPosition(id, position.value); } });
      row.addEventListener('dragstart', (event) => {
        if (locked() || event.target.closest('button,input') || !event.dataTransfer) return event.preventDefault();
        dragging = { id, page: editPage };
        event.dataTransfer.setData('text/plain', id);
        event.dataTransfer.effectAllowed = 'move';
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragover', (event) => { if (dragging?.page === editPage && !locked()) { event.preventDefault(); row.classList.add('is-drop-target'); } });
      row.addEventListener('dragleave', () => { if (ready()) row.classList.remove('is-drop-target'); });
      row.addEventListener('dragend', () => { if (ready()) { dragging = null; for (const el of host.querySelectorAll('.is-drop-target,.is-dragging')) el.classList.remove('is-drop-target', 'is-dragging'); } });
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        if (locked() || dragging?.page !== editPage || dragging?.id !== event.dataTransfer?.getData('text/plain')) return;
        const moving = dragging.id;
        dragging = null;
        move(moving, draft.findIndex((item) => item.id === id), 'up');
      });
    }
  }
  const adopt = (latest) => {
    if (!ready()) return false;
    data = latest;
    baseline = [...latest.items];
    draft = [...baseline];
    revision = latest.revision;
    history = [];
    future = [];
    uncertain = false;
    conflict = false;
    submittedIds = null;
    submittedRevision = null;
    positionDrafts.clear();
    pendingDraft = null;
    // A fresh server snapshot may also change titles or poster versions.
    q('.order-items')?.replaceChildren();
    return true;
  };
  q('[data-order-undo]').addEventListener('click', () => { if (!locked() && history.length) { future.push([...draft]); draft = history.pop(); notice = ''; remember(); paint(); } });
  q('[data-order-redo]').addEventListener('click', () => { if (!locked() && future.length) { history.push([...draft]); draft = future.pop(); notice = ''; remember(); paint(); } });
  q('[data-order-reset]').addEventListener('click', () => { if (!locked()) { draft = [...baseline]; history = []; future = []; positionDrafts.clear(); notice = ''; remember(); paint(); } });
  for (const button of host.querySelectorAll('[data-order-page]')) button.addEventListener('click', () => {
    if (button.disabled || !ready()) return;
    editPage += button.dataset.orderPage === 'previous' ? -1 : 1;
    dragging = null;
    paintRows(); hydratePosters();
  });
  q('[data-order-page-size]').addEventListener('change', (event) => {
    const size = Number(event.target.value);
    if (!ready() || ![6, 12, 24].includes(size)) return;
    const first = editPage * pageSize;
    pageSize = size; editPage = Math.floor(first / size); dragging = null;
    paintRows(); hydratePosters();
  });
  // Preview navigation never replaces the editing rows or their pending input.
  for (const button of host.querySelectorAll('[data-order-device]')) button.addEventListener('click', () => {
    if (!ready()) return;
    const first = previewPage * previewPageSize();
    device = button.dataset.orderDevice;
    previewPage = Math.floor(first / previewPageSize());
    paintPreview(); hydratePosters();
  });
  for (const button of host.querySelectorAll('[data-preview-page]')) button.addEventListener('click', () => {
    if (button.disabled || !ready()) return;
    previewPage += button.dataset.previewPage === 'previous' ? -1 : 1;
    paintPreview(); hydratePosters();
  });
  for (const button of host.querySelectorAll('[data-order-pane-target]')) button.addEventListener('click', () => {
    if (!ready()) return;
    showPane(button.dataset.orderPaneTarget);
    hydratePosters();
  });
  q('[data-order-reload]').addEventListener('click', async () => {
    if (!ready() || saving || inFlight) return;
    if (hasChanges() && !window.confirm('放弃当前草稿，重新读取线上顺序？')) return;
    saving = true;
    paint();
    try {
      const latest = await get('admin-catalog-order');
      if (!ready()) return;
      if (adopt(latest)) { notice = '已读取当前线上顺序。'; tone = 'saved'; }
    } catch (error) { if (ready()) { notice = error.message; tone = 'error'; } }
    finally { if (ready()) { saving = false; remember(); paint(); } }
  });
  q('[data-order-reconcile]').addEventListener('click', async () => {
    if (!ready() || saving || inFlight || !uncertain || conflict) return;
    if (!submittedIds) {
      uncertain = false; conflict = true; notice = '没有可核对的提交快照，原草稿已锁定。请重新读取线上顺序后再编排。'; tone = 'error';
      remember(); paint(); return;
    }
    saving = true;
    paint();
    try {
      const latest = await get('admin-catalog-order');
      if (!ready()) return;
      if (sameIds(latest.items, submittedIds)) {
        if (adopt(latest)) {
          notice = '已确认：当前线上顺序与上次提交一致。'; tone = 'saved';
          if (ready()) onSaved?.();
        }
      } else if (!inFlight && sameOrder(latest.items, baseline)) {
        baseline = [...latest.items];
        const byId = new Map(latest.items.map(item => [item.id, item]));
        draft = draft.map(item => byId.get(item.id) ?? item);
        revision = latest.revision; uncertain = false; submittedIds = null; submittedRevision = null;
        q('.order-items').replaceChildren();
        notice = '线上仍是修改前的顺序，草稿已保留，可以再次保存。'; tone = 'dirty'; remember();
      } else {
        uncertain = false; conflict = true; notice = '线上顺序或目录已有其他修改。草稿已保留并锁定，请重新读取线上顺序后再编排。'; tone = 'error';
      }
    } catch (error) { if (ready()) { notice = `暂时无法确认保存结果：${error.message}`; tone = 'error'; } }
    finally { if (ready()) { saving = false; remember(); paint(); } }
  });
  q('[data-order-save]').addEventListener('click', async () => {
    if (locked()) return;
    for (const [id, value] of [...positionDrafts]) if (!commitPosition(id, value)) return;
    if (!dirty()) return;
    saving = true;
    uncertain = true;
    submittedIds = draft.map(item => item.id);
    submittedRevision = revision;
    const request = { token: Symbol('catalog-order-write'), listeners: new Set() };
    inFlight = request;
    // Persist the submission before the first await; changing tabs cannot unlock it.
    remember();
    paint();
    try {
      const latest = await post('admin-catalog-order-save', { videoIds: [...submittedIds], revision: submittedRevision });
      if (!ready()) return;
      if (adopt(latest)) {
        notice = '顺序已保存。观众重新打开目录后即可看到新排列。';
        tone = 'saved';
        if (ready()) onSaved?.();
      }
    } catch (error) {
      if (!ready()) return;
      uncertain = isWriteOutcomeUnknown(error);
      conflict = error.code === 'catalog_order_conflict';
      notice = uncertain ? '这次提交的结果还不能确认。草稿已保留，请先核对保存结果，不要重复提交。' : `${error.message} 当前草稿已保留。`;
      if (!uncertain && !conflict) { submittedIds = null; submittedRevision = null; }
      tone = 'error';
    } finally {
      if (inFlight === request) {
        inFlight = null;
        // Subscribers may belong to a newer owner. They only enter reconciliation.
        for (const listener of [...request.listeners]) listener();
        request.listeners.clear();
      }
      if (ready()) { saving = false; remember(); paint(); }
    }
  });
  q('[data-order-close]').addEventListener('click', () => {
    if (!ready() || saving || uncertain || inFlight) return;
    if (hasChanges() && !window.confirm('离开编排预览？当前草稿会暂留在本次访问中，还没有对观众生效。')) return;
    destroy();
    onClose?.();
  });
  if (inFlight) {
    observedWrite = inFlight;
    observedWrite.listeners.add(onWriteSettled);
  }
  remember();
  paint();
  return { destroy, hasChanges };
}
