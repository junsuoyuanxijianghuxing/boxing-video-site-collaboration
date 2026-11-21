import { esc, fmtDate } from './app.js';

const accountOptions = [
  ['all', '全部账号'],
  ['active', '可登录'],
  ['disabled', '已停用'],
  ['owner', '管理员'],
];
const membershipOptions = [
  ['all', '全部权益'],
  ['active', '有效会员'],
  ['expiring', '7 天内到期'],
  ['expired', '已到期'],
  ['none', '未开通'],
  ['revoked', '权益已撤销'],
  ['unverified', '待核验'],
];
const stateNames = new Map(membershipOptions);
const options = (entries, current) =>
  entries
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}"${String(value) === current ? ' selected' : ''}>${esc(label)}</option>`
    )
    .join('');

export function directoryMarkup({ accounts, filters, page, offset, openId, viewerId }) {
  const ranks = [
    ...new Set([
      ...(accounts.ranks || []),
      ...accounts.items.flatMap(row => (row.membership ? [row.membership.rank] : [])),
      ...(filters.rank ? [Number(filters.rank)] : []),
    ]),
  ].sort((a, b) => a - b);
  const filtered = filters.q || filters.account !== 'all' || filters.membership !== 'all' || filters.rank;
  return `<section class="member-directory panel stack" aria-labelledby="m-results-title">
    <header class="section-title"><h2 id="m-results-title" tabindex="-1">用户管理</h2></header>
    <form class="member-filters" id="m-search">
      <label class="field member-lookup" for="m-q">查找用户
        <input class="input" type="search" id="m-q" name="q" maxlength="254" value="${esc(filters.q)}" placeholder="邮箱、昵称、备注、QQ 或会员编号" autocomplete="off"></label>
      <label class="field">账号状态<select class="input" name="account">${options(accountOptions, filters.account)}</select></label>
      <label class="field">会员状态<select class="input" name="membership">${options(membershipOptions, filters.membership)}</select></label>
      <label class="field">生效等级<input class="input" name="rank" type="number" min="0" max="90" step="1" placeholder="全部等级" list="m-ranks" value="${esc(filters.rank)}"></label>
      <datalist id="m-ranks"><option value="0">普通用户</option>${ranks.map(n => `<option value="${n}">${n} 级</option>`).join('')}</datalist>
      <div class="member-filter-actions"><button class="btn btn-primary" type="submit">查找</button><button type="button" class="btn btn-ghost" id="m-clear"${filtered ? '' : ' disabled'}>清空筛选</button></div>
    </form>
    <p id="m-query-status" class="tiny dim" role="status">${accounts.items.length ? `第 ${page} 页 · 第 ${offset + 1}–${offset + accounts.items.length} 位用户` : '0 位符合条件的用户'}</p>
    <div class="member-list">${
      accounts.items.map(row => memberCard(row, openId, viewerId)).join('') ||
      '<p>没有找到符合条件的用户。可换一个关键词，或清空筛选。</p>'
    }</div>
    ${
      page > 1 || accounts.hasMore
        ? `<nav class="member-pager" aria-label="用户列表翻页"><button class="btn btn-sm" type="button" id="a-prev"${page === 1 ? ' disabled' : ''}>上一页</button>
      <span>第 ${page} 页</span><button class="btn btn-sm" type="button" id="a-next"${accounts.hasMore ? '' : ' disabled'}>下一页</button></nav>`
        : ''
    }
    <div id="m-reset-results" class="stack" aria-live="polite"></div><div id="m-activity"></div>
  </section>`;
}

function memberCard(row, openId, viewerId) {
  const { user } = row;
  const id = esc(user.id),
    email = esc(user.email);
  const number = String(user.id).replace(/-/g, '').slice(0, 8).toUpperCase();
  const name = user.displayName || user.email;
  const initial = Array.from(name.trim())[0] || '人';
  const status = row.membership
    ? `${esc(row.membership.rank)} 级会员`
    : esc(stateNames.get(row.memberState) || '无有效权益');
  const expiry = row.membership
    ? row.membership.expiresAt
      ? `${fmtDate(row.membership.expiresAt)} 到期`
      : '长期有效'
    : row.expiredAt
      ? `${fmtDate(row.expiredAt)} 已到期`
      : '';
  return `<article class="member-card" data-account-id="${id}">
    <header><div class="member-identity"><span class="member-avatar" aria-hidden="true">${esc(initial.toLocaleUpperCase())}</span><div><strong>${esc(name)}</strong>
      ${row.isOwner ? '<span class="pill">管理员</span>' : ''}${user.displayName && user.displayName !== user.email ? `<div class="member-email">${email}</div>` : ''}<div class="member-number">会员编号 ${esc(number)}</div></div></div>
      <div class="member-badges"><span class="pill ${row.disabledAt ? 'pill-bad' : ''}">${row.disabledAt ? '已停用' : '可登录'}</span>
        <span class="pill${row.membership ? ' pill-good' : ''}">${status}</span>${row.expiring ? '<span class="pill pill-warn">7 天内到期</span>' : ''}</div></header>
    <p class="member-note" data-account-note="${id}">${esc(row.note || '')}${row.contactQq ? (row.note ? ' · QQ ' : 'QQ ') + esc(row.contactQq) : ''}</p>
    ${expiry ? `<p class="member-dates">${esc(expiry)}</p>` : ''}
    <div class="member-actions"><button type="button" class="btn btn-sm btn-primary" data-edit-entitlement aria-expanded="false" aria-controls="member-editor-${id}">调整等级和时长</button>
      <button type="button" class="btn btn-sm" data-copy-email="${email}">复制邮箱</button>
      <button type="button" class="btn btn-sm" data-register-sale="${email}">登记购买</button>
      <button type="button" class="btn btn-sm" data-activity="${id}" data-email="${email}" aria-controls="m-activity" aria-expanded="false">观看记录</button></div>
    <form class="member-editor" id="member-editor-${id}" data-entitlement-form data-revision="${esc(row.revision)}" hidden>
      <label class="field">会员等级<input class="input" name="rank" type="number" min="0" max="90" step="1" required value="${row.membership?.rank || 1}"></label>
      <label class="field">有效期<select class="input" name="mode">
        ${row.membership ? '<option value="keep">保留目前到期时间</option>' : ''}
        <option value="days">从现在起设置天数</option><option value="extend">在现有期限上加减天数</option>
        <option value="until">指定到期时间</option><option value="permanent">永久有效</option></select></label>
      <label class="field" data-length-days${row.membership ? ' hidden' : ''}>天数<input class="input" name="days" type="number" step="1" min="1" max="3650" value="30"></label>
      <label class="field" data-length-date hidden>到期时间（本地时间）<input class="input" name="until" type="datetime-local"></label>
      <p class="tiny dim" data-editor-tip>设为 0 级会结束会员资格。账号仍可登录。</p>
      <div class="member-actions"><button class="btn btn-sm btn-primary" type="submit">保存会员调整</button><button class="btn btn-sm" type="button" data-cancel-entitlement>取消</button></div>
      <p role="status" class="tiny" data-editor-status></p>
    </form>
    <details class="member-details"${openId === user.id ? ' open' : ''}><summary>卡片记录与账号设置</summary>
      <p class="member-dates">注册 ${fmtDate(row.registeredAt)} · ${row.lastLoginAt ? '最近登录 ' + fmtDate(row.lastLoginAt) : '从未登录'}</p>
      <div class="member-grants"><strong>原始卡片记录</strong>${row.grants.map(grant => grantMarkup(grant, email)).join('') || '<p class="tiny dim">没有卡片记录。</p>'}</div>
      ${row.revokedGrants ? `<button type="button" class="btn btn-sm btn-ghost" data-revoked-for="${email}">查看已撤销的 ${Number(row.revokedGrants)} 条权益</button>` : ''}
      ${row.unverifiedGrants ? `<p class="note note-warn">${Number(row.unverifiedGrants)} 条权益校验失败，未计入会员等级。</p>` : ''}
      <div class="member-contact"><label class="field">备注<input class="input" data-note-for="${id}" value="${esc(row.note)}" maxlength="200"></label>
        <label class="field">买家 QQ<input class="input" inputmode="numeric" data-qq-for="${id}" value="${esc(row.contactQq)}" maxlength="12"></label>
        <button type="button" class="btn btn-sm" data-save-note="${id}">保存备注</button></div>
      <div class="member-actions member-account-actions"><button type="button" class="btn btn-sm btn-ghost" data-reset="${id}" data-email="${email}">重置密码</button>
      ${!row.disabledAt && user.id === viewerId ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-user-toggle="${id}" data-email="${email}" data-disabled="${row.disabledAt ? 'yes' : 'no'}">${row.disabledAt ? '恢复账号' : '停用账号'}</button>`}</div>
    </details></article>`;
}

function grantMarkup(grant, email) {
  const id = esc(grant.id);
  const expiry = grant.expiresAt ? fmtDate(grant.expiresAt) + ' 到期' : '长期有效';
  const source = ['key', 'card-credit'].includes(grant.source) ? '激活码' : grant.source;
  return `<div class="member-grant"><div><strong>${esc(grant.plan)} · ${esc(grant.rank)} 级</strong>
    <p class="tiny dim">${grant.settled ? '已计入管理员调整' : '原卡记录'} · ${grant.source === 'card-credit' ? '兑换于 ' + fmtDate(grant.createdAt) : esc(expiry)}${source ? ' · ' + esc(source) : ''}</p></div>
    ${grant.settled ? '' : `<button class="btn btn-sm btn-ghost" type="button" data-revoke="${id}" data-label="${email} · ${esc(grant.plan)}">撤销这张卡</button>`}</div>`;
}

export function bindEntitlementEditor(card, row, { save, refresh }) {
  const form = card.querySelector('[data-entitlement-form]');
  const toggle = card.querySelector('[data-edit-entitlement]');
  const { rank, mode, days, until } = form.elements;
  const status = form.querySelector('[data-editor-status]');
  const open = show => {
    form.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    if (show) rank.focus();
    else toggle.focus();
  };
  function fields() {
    const free = rank.value !== '' && Number(rank.value) === 0;
    mode.disabled = free;
    const numeric = !free && ['days', 'extend'].includes(mode.value);
    days.disabled = !numeric;
    days.required = numeric;
    days.min = mode.value === 'extend' ? '-3650' : '1';
    until.disabled = free || mode.value !== 'until';
    until.required = !until.disabled;
    form.querySelector('[data-length-days]').hidden = !numeric;
    form.querySelector('[data-length-date]').hidden = until.disabled;
    form.querySelector('[data-editor-tip]').textContent =
      mode.value === 'extend' && !free
        ? '正数延长，负数缩短。到期时间早于现在时，会员会立即到期。'
        : '设为 0 级会结束会员资格。账号仍可登录。';
  }
  fields();
  toggle.addEventListener('click', () => {
    if (!toggle.disabled) open(form.hidden);
  });
  form.querySelector('[data-cancel-entitlement]').addEventListener('click', () => {
    form.reset();
    fields();
    status.textContent = '';
    open(false);
  });
  rank.addEventListener('input', fields);
  mode.addEventListener('change', fields);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const level = Number(rank.value),
      amount = Number(days.value);
    if (level && mode.value === 'extend' && (!amount || (row.membership && !row.membership.expiresAt))) {
      status.textContent = !amount ? '请填非零天数。' : '当前为永久会员。可选择指定到期时间或设置剩余天数。';
      return;
    }
    const expiry = !until.disabled ? new Date(until.value) : null;
    if (expiry && !(expiry.getTime() > Date.now())) {
      status.textContent = '到期时间须晚于现在。';
      return;
    }
    const label = !level
      ? '结束会员资格'
      : {
          keep: '保留现有到期时间',
          days: '从现在起 ' + amount + ' 天',
          extend: (amount > 0 ? '延长 ' : '缩短 ') + Math.abs(amount) + ' 天',
          until: '到期时间 ' + (expiry?.toLocaleString() || ''),
          permanent: '永久有效',
        }[mode.value];
    if (
      !confirm(`${row.user.email}
${level ? '设为 ' + level + ' 级会员，' : ''}${label}。确认保存？`)
    )
      return;
    button.disabled = true;
    status.textContent = '正在保存…';
    try {
      await save({
        userId: row.user.id,
        revision: row.revision,
        rank: level,
        mode: mode.value,
        days: amount,
        until: expiry?.toISOString(),
      });
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
