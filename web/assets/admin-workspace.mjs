// A DOM-only presentation layer. Existing records, controls and listeners stay alive.
const mounted = new WeakMap();
const PAGE_SIZES = [6, 12, 24];
const EXCLUDED = '#upload-form, #upload-queue-host, #batch-upload-host, #batch-upload, #processing-status-host, .upload-queue, .processing-status, .order-workspace, .series-editor';
const ALERTS = '.note-bad, .note-warn, .is-bad, [role="alert"], [data-row-state], .row-state, .pill-bad, .pill-warn, [style*="var(--warn)"], [style*="var(--bad)"]';

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  node.dataset.adminWorkspaceUi = '';
  return node;
}

function valueText(node) {
  if (!node) return '';
  const control = node.matches?.('input, select, textarea') ? node : node.querySelector?.('input, select, textarea');
  if (control) {
    if (control.type === 'checkbox') return control.checked ? '已启用' : '未启用';
    if (control.tagName === 'SELECT') return control.selectedOptions[0]?.textContent.trim() || control.value;
    return control.value.trim();
  }
  return node.textContent.replace(/\s+/g, ' ').trim();
}

export function mountAdminWorkspace(view) {
  if (!view?.querySelector) return () => {};
  if (mounted.has(view)) return mounted.get(view);
  const root = view.matches('.admin') ? view : view.querySelector('.admin');
  if (!root) return () => {};
  root.classList.add('admin-compact-workspace');
  const records = new Map();
  const pages = new Map();
  const forms = new WeakSet();
  const settings = new WeakSet();
  let disposed = false;
  let timer = null;

  const observe = () => observer.observe(root, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'data-tone', 'aria-busy'],
  });
  const ownChanges = action => {
    observer.disconnect();
    try { action(); } finally { if (!disposed) observe(); }
  };

  function enhanceRow(row, labels) {
    if (records.has(row) || row.closest(EXCLUDED)) return;
    const cells = [...row.children].filter(node => node.tagName === 'TD');
    if (cells.length < 2 || cells.some(cell => cell.colSpan > 1)) return;
    const video = Boolean(row.querySelector('[data-title]'));
    const plan = Boolean(row.querySelector('[data-f="name"]'));
    const first = cells[0];
    const contents = cells.map(cell => {
      const content = element('div', 'admin-field-content');
      content.append(...cell.childNodes);
      return content;
    });
    const summary = element('div', 'admin-record-summary');
    const copy = element('div', 'admin-record-copy');
    const title = video && contents[1]?.querySelector('[data-video-name]')
      || element('strong', 'admin-record-title');
    title.classList.add('admin-record-title');
    const meta = element('div', 'admin-record-meta');
    copy.append(title, meta);
    const copyButton = !video && !plan ? contents[0].querySelector('button[data-copy], button.code-chip') : null;
    if (copyButton) {
      const quick = element('div', 'admin-record-quick');
      // The original button remains in its original first td, outside details.
      // Its clipboard listener and closest('td') semantics are unchanged.
      quick.append(copyButton);
      copy.append(quick);
    }
    if (video) {
      const cover = element('div', 'admin-record-cover');
      const picture = contents[0].querySelector('img, .poster') || contents[0].querySelector('span');
      if (picture) cover.append(picture);
      summary.append(cover);
    }
    summary.append(copy);
    const editor = element('details', 'admin-record-editor');
    const disclosure = element('summary', '', video || plan ? '编辑设置' : '更多详情');
    const fields = element('div', 'admin-record-fields');
    editor.append(disclosure, fields);
    const alerts = element('div', 'admin-record-alerts admin-record-status');
    row.classList.add('admin-record-row');
    first.classList.add('admin-record-cell');
    first.append(summary, alerts, editor);
    const sources = [];
    contents.forEach((content, index) => {
      const cell = cells[index];
      // Some existing handlers replace button.closest('td').innerHTML. Keep that
      // original cell, and its original children, separate from the record body.
      const actions = index > 0 && content.querySelector('button, a')
        && !content.querySelector('input, select, textarea')
        && (index === cells.length - 1 || !labels[index]);
      if (actions) {
        cell.classList.add('admin-record-actions', 'admin-record-quick');
        cell.append(...content.childNodes);
        return;
      }
      if (index > 0) cell.classList.add('admin-record-placeholder');
      const field = element('div', 'admin-field');
      field.append(element('div', 'admin-field-label', labels[index] || `信息 ${index + 1}`), content);
      for (const control of content.querySelectorAll('input, select, textarea')) {
        if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')
          && !control.closest('label') && !(control.id && control.labels?.length)) {
          control.setAttribute('aria-label', labels[index] || `信息 ${index + 1}`);
        }
      }
      fields.append(field);
      sources.push({ content, label: labels[index] || '', index });
    });
    const model = { row, cells, contents, title, meta, alerts, editor, video, plan, sources, copyButton };
    records.set(row, model);
    syncRecord(model);
  }

  function syncRecord(model) {
    const { row, title, meta, contents, video, plan, alerts, editor } = model;
    if (!row.isConnected) return;
    const nextTitle = video ? row.querySelector('[data-title]')?.value.trim()
      : plan ? row.querySelector('[data-f="name"]')?.value.trim()
      : model.copyButton ? model.copyButton.dataset.copy || valueText(model.copyButton) : valueText(contents[0]);
    if (!video || !title.matches('[data-video-name]')) {
      const text = nextTitle || (video ? '名称缺失，请补充' : plan ? '未命名档位' : '记录详情');
      if (title.textContent !== text) title.textContent = text;
    }
    const indices = video ? [2, 3, 4, 6] : plan ? [0, 2, 3, 4, 7] : [1, 2, 3];
    const pieces = indices.map(index => {
      const source = model.sources.find(field => field.index === index);
      if (!source) return '';
      let value = valueText(source.content);
      if (video && index === 6 && source.content.querySelector('[data-duration]')) {
        const size = source.content.textContent.trim();
        value = `${value} 秒${size ? ` / ${size}` : ''}`;
      }
      return value ? `${source.label ? `${source.label}：` : ''}${value}` : '';
    }).filter(Boolean);
    const description = pieces.join(' · ');
    if (meta.textContent !== description) meta.textContent = description;
    // Move live status nodes, rather than copying their text, so existing writes
    // and save/error listeners still update the always-visible original node.
    for (const node of row.querySelectorAll(ALERTS)) {
      if (!editor.contains(node) || alerts.contains(node) || node.closest('.admin-record-actions') || node.closest('.admin-record-alerts')
        || node.querySelector('input, select, textarea') || node.contains(editor)) continue;
      if (node.parentElement?.closest(ALERTS)) continue;
      alerts.append(node);
    }
    alerts.hidden = !alerts.childNodes.length;
  }

  function settingGroups(form) {
    if (settings.has(form)) return;
    settings.add(form);
    const children = [...form.children];
    const groups = [
      ['基础设置', true, 'brand,contact_qq,brand_line,watermark_prefix'],
      ['前台文案', false, 'promo_line,purchase_steps'],
      ['播放与设备限制', false, 'default_preview_seconds,max_active_sessions,max_concurrent_streams'],
    ].map(([title, open, names]) => {
      const details = element('details', 'admin-settings-group');
      details.open = open;
      const heading = element('summary', 'admin-settings-summary');
      heading.append(element('strong', '', title), element('span', 'admin-settings-preview'));
      const body = element('div', 'admin-settings-fields stack');
      details.append(heading, body);
      form.append(details);
      return { details, body, names: names.split(',') };
    });
    const actions = [];
    for (const child of children) {
      if (child.matches('button[type="submit"], input[type="submit"]')
        || (!child.querySelector('input, select, textarea') && child.querySelector('[type="submit"]'))) {
        actions.push(child);
        continue;
      }
      const group = groups.find(item => item.names.some(name => child.matches(`[name="${name}"]`) || child.querySelector(`[name="${name}"]`))) || groups[0];
      group.body.append(child);
    }
    form.append(...actions);
    updateSettings(form);
  }

  function updateSettings(form) {
    for (const group of form.querySelectorAll('.admin-settings-group')) {
      const preview = group.querySelector('.admin-settings-preview');
      const values = [...group.querySelectorAll('input, select, textarea')].slice(0, 3)
        .map(control => valueText(control)).filter(Boolean);
      const text = values.map(value => value.length > 28 ? `${value.slice(0, 28)}…` : value).join(' · ');
      if (preview.textContent !== text) preview.textContent = text;
    }
  }

  function fold(node, title) {
    if (!node || forms.has(node) || node.closest('.admin-form-disclosure') || node.closest(EXCLUDED)) return;
    forms.add(node);
    const details = element('details', 'admin-form-disclosure');
    details.open = node.hasAttribute('data-prefilled');
    details.append(element('summary', '', title));
    node.before(details);
    details.append(node);
    node.classList.add('admin-form-body');
    // Validation and server warnings must remain discoverable while collapsed.
    for (const alert of node.querySelectorAll('.note-bad, .note-warn, [role="alert"]')) {
      if (!alert.parentElement?.closest('.note-bad, .note-warn, [role="alert"]')) details.before(alert);
    }
  }

  function searchText(item) {
    const values = [...item.querySelectorAll('input, select, textarea')].map(valueText);
    const text = [];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement?.closest('select, textarea, .admin-record-meta, .admin-field-label, summary')) {
        text.push(walker.currentNode.textContent);
      }
    }
    return `${text.join(' ')} ${values.join(' ')}`.toLocaleLowerCase();
  }

  function createPager(list) {
    if (pages.has(list) || list.closest(EXCLUDED)) return;
    const table = list.tagName === 'TBODY' ? list.closest('table') : null;
    const anchor = table?.closest('.table-wrap') || table || list;
    if (!anchor?.parentElement) return;
    const region = anchor.closest('.panel, section, details') || root;
    const hasSearch = [...region.querySelectorAll('input[type="search"], #m-search, #admin-video-query')]
      .some(node => !node.matches('[data-admin-list-search]'));
    const state = { list, anchor, page: 0, size: 6, query: '', items: [], bars: [], search: null };
    const name = table?.getAttribute('aria-label') || list.getAttribute('aria-label') || '当前已加载内容';
    const identity = table?.id || list.id || `${region.querySelector('h2, h3')?.textContent.trim() || name}:${[...region.querySelectorAll('table, .case-list')].indexOf(table || list)}`;
    let hash = 0;
    for (const character of identity) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    const key = `${table ? 'table' : 'cases'}-${(hash >>> 0).toString(36)}`;
    list.dataset.adminListKey = key;
    for (const position of ['top', 'bottom']) {
      const bar = element('nav', 'admin-list-pager');
      bar.dataset.adminPagerPosition = position;
      bar.dataset.adminListKey = key;
      bar.setAttribute('aria-label', `${name}${position === 'top' ? '顶部' : '底部'}分页`);
      const count = element('span', 'admin-pager-count');
      count.setAttribute('aria-live', 'polite');
      const controls = element('div', 'admin-pager-controls');
      const label = element('label', 'admin-pager-size', '每页 ');
      const size = element('select', 'input');
      size.dataset.adminPageSize = '';
      size.setAttribute('aria-label', '每页显示条数');
      for (const number of PAGE_SIZES) {
        const option = element('option', '', `${number} 条`);
        option.value = String(number);
        size.append(option);
      }
      size.value = String(state.size);
      label.append(size);
      const previous = element('button', 'btn btn-sm', '上一页');
      const next = element('button', 'btn btn-sm', '下一页');
      previous.type = next.type = 'button';
      previous.dataset.adminPage = 'previous'; next.dataset.adminPage = 'next';
      const current = element('span', 'admin-pager-current');
      controls.append(label, previous, current, next);
      if (position === 'top' && !hasSearch) {
        const searchLabel = element('label', 'admin-list-search', '查找当前已加载内容');
        const search = element('input', 'input');
        search.type = 'search'; search.maxLength = 120;
        search.dataset.adminListSearch = '';
        search.placeholder = '名称、邮箱或记录内容';
        searchLabel.append(search); bar.append(searchLabel); state.search = search;
        search.addEventListener('input', event => {
          if (event.isComposing) return;
          state.query = search.value.trim().toLocaleLowerCase(); state.page = 0;
          ownChanges(() => paintPager(state));
        });
        search.addEventListener('compositionend', () => {
          state.query = search.value.trim().toLocaleLowerCase(); state.page = 0;
          ownChanges(() => paintPager(state));
        });
      }
      bar.append(count, controls);
      if (position === 'top') anchor.before(bar); else anchor.after(bar);
      state.bars.push({ bar, count, size, previous, next, current });
      size.addEventListener('change', () => {
        state.size = PAGE_SIZES.includes(Number(size.value)) ? Number(size.value) : 6;
        state.page = 0;
        ownChanges(() => paintPager(state));
      });
      const turn = delta => {
        state.page += delta;
        ownChanges(() => paintPager(state));
        if (position === 'bottom') state.bars[0].bar.scrollIntoView({ block: 'start', behavior: 'auto' });
      };
      previous.addEventListener('click', () => turn(-1));
      next.addEventListener('click', () => turn(1));
    }
    pages.set(list, state);
    paintPager(state);
  }

  function paintPager(state) {
    state.items = [...state.list.children].filter(node => state.list.tagName === 'TBODY'
      ? node.tagName === 'TR' && ![...node.children].some(cell => cell.colSpan > 1)
      : node.tagName === 'LI');
    const available = [];
    for (const item of state.items) {
      const matches = !state.query || searchText(item).includes(state.query);
      item.classList.toggle('admin-filter-hidden', !matches);
      if (matches && !item.hidden) available.push(item);
    }
    const totalPages = Math.max(1, Math.ceil(available.length / state.size));
    state.page = Math.max(0, Math.min(state.page, totalPages - 1));
    const start = state.page * state.size;
    const visible = new Set(available.slice(start, start + state.size));
    for (const item of state.items) item.classList.toggle('admin-page-hidden', !visible.has(item));
    for (const bar of state.bars) {
      bar.count.textContent = `已加载 ${state.items.length} 条 · ${available.length ? `当前 ${start + 1}–${Math.min(start + state.size, available.length)} 条` : '当前无匹配内容'}${state.query || available.length !== state.items.length ? ` · 筛选后 ${available.length} 条` : ''}`;
      bar.current.textContent = `第 ${state.page + 1} / ${totalPages} 页`;
      bar.size.value = String(state.size);
      bar.previous.disabled = state.page === 0;
      bar.next.disabled = state.page >= totalPages - 1;
      bar.bar.hidden = !state.items.length;
    }
  }

  function enhance() {
    if (disposed || !root.isConnected || !view.isConnected) return destroy();
    ownChanges(() => {
      for (const [row] of records) if (!root.contains(row)) records.delete(row);
      for (const [list, page] of pages) if (!root.contains(list)) {
        for (const bar of page.bars) bar.bar.remove();
        pages.delete(list);
      }
      for (const table of root.querySelectorAll('table')) {
        if (table.closest(EXCLUDED)) continue;
        const labels = [...table.querySelectorAll('thead th')].map(node => node.textContent.trim());
        table.classList.add('admin-record-table');
        for (const body of table.tBodies) {
          for (const row of [...body.children]) enhanceRow(row, labels);
          createPager(body);
        }
      }
      for (const list of root.querySelectorAll('.case-list')) createPager(list);
      for (const model of records.values()) syncRecord(model);
      const form = root.querySelector('#settings');
      if (form) { settingGroups(form); updateSettings(form); }
      const admins = root.querySelector('#admin-add')?.closest('section');
      if (admins) fold(admins, '管理员与权限');
      for (const [selector, title] of [
        ['#new-plan', '新增档位'], ['#manual-request', '登记购买记录'],
        ['#gen', '生成一批激活码'], ['#admin-add', '添加管理员'],
      ]) fold(root.querySelector(selector), title);
      for (const page of pages.values()) paintPager(page);
    });
  }

  function schedule(reset = false, scope = root) {
    if (disposed) return;
    if (reset) for (const page of pages.values()) {
      if (scope === root || scope.contains(page.list)) page.page = 0;
    }
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; enhance(); }, 0);
  }

  const observer = new MutationObserver(mutations => {
    if (!root.isConnected || !view.isConnected) return destroy();
    const external = mutations.filter(mutation => {
      const node = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      if (node?.closest(EXCLUDED)) return false;
      return mutation.type !== 'characterData' || !node?.closest('[data-admin-workspace-ui]');
    });
    if (!external.length) return;
    for (const mutation of external) if (mutation.type === 'attributes' && mutation.attributeName === 'hidden'
      && !mutation.target.hasAttribute('data-admin-workspace-ui')) {
      for (const page of pages.values()) {
        if (page.items.includes(mutation.target) || mutation.target.parentElement === page.list) page.page = 0;
      }
    }
    schedule();
  });
  // Only the connection check runs outside this view; page content is never scanned.
  const removalObserver = new MutationObserver(() => { if (!view.isConnected || !root.isConnected) destroy(); });
  removalObserver.observe(document.documentElement, { childList: true, subtree: true });

  const onEdit = event => {
    const target = event.target;
    if (!(target instanceof Element) || target.matches('[data-admin-list-search], [data-admin-page-size]')
      || target.closest(EXCLUDED)) return;
    const row = target.closest('tr');
    const model = records.get(row);
    if (model) ownChanges(() => syncRecord(model));
    const form = target.closest('#settings');
    if (form) ownChanges(() => updateSettings(form));
    if (!row && !form) schedule(true, target.closest('.panel, section') || root);
  };
  const onInvalid = event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    ownChanges(() => {
      for (const page of pages.values()) {
        const item = page.items.find(node => node.contains(target));
        if (!item) continue;
        // Only this known local video filter can be cleared without drawing or
        // requesting a new page. Other owners of row.hidden retain full control;
        // native validation must never silently override an external filter.
        if (item.hidden) {
          const clear = root.querySelector('#admin-video-clear');
          if (clear && item.closest('[data-video-management]')?.contains(clear)) clear.click();
        }
        page.query = '';
        if (page.search) page.search.value = '';
        const eligible = page.items.filter(node => !node.hidden);
        page.page = Math.max(0, Math.floor(eligible.indexOf(item) / page.size));
        paintPager(page);
      }
      for (let node = target.parentElement; node && root.contains(node); node = node.parentElement) {
        if (node.tagName === 'DETAILS') node.open = true;
      }
    });
  };
  root.addEventListener('input', onEdit, true);
  root.addEventListener('change', onEdit, true);
  root.addEventListener('invalid', onInvalid, true);
  function destroy() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    observer.disconnect(); removalObserver.disconnect();
    root.removeEventListener('input', onEdit, true);
    root.removeEventListener('change', onEdit, true);
    root.removeEventListener('invalid', onInvalid, true);
    records.clear(); pages.clear(); mounted.delete(view);
  }
  mounted.set(view, destroy);
  enhance();
  return destroy;
}
