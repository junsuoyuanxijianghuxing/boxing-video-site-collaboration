const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { setTimeout: wait } = require('node:timers/promises');
const { chromium } = require('playwright');

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'boxing-browser-'));
  const sock = createServer();
  await new Promise(resolve => sock.listen(0, '127.0.0.1', resolve));
  const port = sock.address().port;
  await new Promise(resolve => sock.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const adminEmail = 'qa-owner@example.test',
    buyerEmail = 'qa-buyer@example.test';
  const password = 'Qa9-' + randomBytes(15).toString('hex');
  // Isolated in-memory server; never inherits a deployment data directory or credentials.
  const dataKey = randomBytes(32).toString('base64url');
  const server = spawn(process.execPath, [join(__dirname, 'local-server.mjs'), String(port)], {
    env: {
      PATH: process.env.PATH,
      LOCAL_DATA_KEY: dataKey,
      LOCAL_SESSION_SECRET: randomBytes(32).toString('base64url'),
      LOCAL_ADMIN_EMAILS: adminEmail,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    let ready = false;
    for (let n = 0; n < 80 && !ready; n++) {
      try {
        ready = (await fetch(origin + '/dev-info')).ok;
      } catch {
        await wait(75);
      }
    }
    assert.ok(ready, 'local server');
    const file = join(tmp, 'sample.mp4');
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24',
      '-t',
      '10',
      '-threads',
      '1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      file,
    ]);
    const day = 86400000;
    const videos = Array.from({ length: 140 }, (_, i) => {
      const stamp = new Date(Date.now() - (i + 1) * 3600000).toISOString();
      return {
        id: randomUUID(),
        title: i === 139 ? '跨页目标' : '教学测试 ' + i,
        kind: i % 2 ? 'anime' : 'live',
        status: 'published',
        created_at: stamp,
        updated_at: stamp,
        published_at: stamp,
        duration_seconds: i === 139 ? 310 : 55 + (i % 50),
        tier_rank: 2,
        preview_seconds: 10,
        plain_size: 5000,
        chunk_size: 1024 * 1024,
        content_type: 'video/mp4',
        object_prefix: randomUUID(),
      };
    });
    const seed = async tables =>
      assert.equal(
        (await fetch(origin + '/dev-seed', { method: 'POST', body: JSON.stringify({ tables }) })).status,
        200
      );
    await seed({ videos });
    const binary =
      process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath: binary, headless: true, args: ['--no-sandbox'] });
    const [admin, buyer] = await Promise.all([
      browser.newPage({ viewport: { width: 1300, height: 850 } }),
      browser.newPage({ viewport: { width: 390, height: 844 } }),
    ]);
    const errors = [];
    for (const p of [admin, buyer]) {
      p.setDefaultTimeout(10000);
      p.on('pageerror', e => errors.push(e.message));
    }
    const signUp = async (p, email) => {
      await p.goto(origin + '/register');
      await p.locator('#f-email').fill(email);
      await p.locator('#f-password').fill(password);
      await p.locator('#auth-submit').click();
      await p.waitForURL(email === adminEmail ? '**/admin' : '**/account');
    };
    await Promise.all([signUp(admin, adminEmail), signUp(buyer, buyerEmail)]);
    const visitor = await browser.newPage();
    try {
      await visitor.goto(origin + '/library');
      const firstTitle = visitor.locator('#kind-list .screening-card h3').first();
      await firstTitle.waitFor();
      for (const width of [360, 390, 1300]) {
        await visitor.setViewportSize({ width, height: 844 });
        assert.ok(await firstTitle.evaluate(el => {
          const box = el.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight
            && document.documentElement.scrollWidth <= innerWidth + 1
            && getComputedStyle(document.documentElement).colorScheme === 'light';
        }), 'public video title visible on the first screen at ' + width);
      }
      await visitor.setViewportSize({ width: 390, height: 844 });
      await visitor.locator('#site-menu-toggle').click();
      await visitor.locator('#ws-search:visible').click();
      await visitor.keyboard.press('Escape');
    } finally {
      await visitor.close();
    }
    const get = async (p, action, params = {}) => {
      const url = new URL('/functions/v1/app', origin);
      url.search = new URLSearchParams({ a: action, ...params });
      const response = await p.request.get(url.href);
      assert.equal(response.status(), 200);
      return response.json();
    };
    const buyerId = (await get(buyer, 'account')).user.id;
    const { membershipSignature } = await import('../functions/domain.mjs');
    const epoch = Date.now();
    const grants = [];
    for (const [rank, days] of [
      [1, 10],
      [2, 5],
    ]) {
      const row = {
        id: randomUUID(),
        user_id: buyerId,
        plan_id: randomUUID(),
        tier_rank: rank,
        source: 'key',
        key_id: randomUUID(),
        starts_at: new Date(epoch - day).toISOString(),
        expires_at: new Date(epoch + days * day).toISOString(),
        created_at: new Date(epoch - day).toISOString(),
        revoked_at: null,
      };
      row.signature = await membershipSignature(dataKey, row);
      grants.push(row);
    }
    await seed({ memberships: grants });
    await buyer.reload();
    await buyer.locator('#account-rank').filter({ hasText: '2' }).waitFor();
    const balance = (await get(buyer, 'account')).membership;
    assert.ok(Math.abs(Date.parse(balance.until) - (epoch + 15 * day)) < 15000);
    const playback = () =>
      buyer.evaluate(async id => {
        const response = await fetch('/functions/v1/app?a=play&v=' + id);
        return (await response.json()).mode;
      }, videos[0].id);
    assert.equal(await playback(), 'full');
    const search = async text => {
      await admin.locator('#m-q').fill(text);
      await admin.locator('#m-search button[type=submit]').click();
      await admin.waitForFunction(
        email =>
          document.querySelectorAll('.member-card').length === 1 &&
          document.querySelector('.member-card .member-email')?.textContent === email,
        buyerEmail
      );
    };
    const accountFilter = admin.locator('#m-search select[name=account]');
    await accountFilter.focus();
    await accountFilter.selectOption('active');
    await admin.waitForFunction(() => document.activeElement?.name === 'account' && document.querySelector('#m-q')?.closest('[aria-busy]')?.getAttribute('aria-busy') !== 'true');
    const accountRequest = url => url.searchParams.get('a') === 'admin-accounts';
    let releaseSearch;
    const searchGate = new Promise(resolve => { releaseSearch = resolve; });
    await admin.route(accountRequest, async route => {
      await searchGate;
      await route.continue();
    }, { times: 1 });
    const pendingSearch = admin.waitForRequest(r => accountRequest(new URL(r.url())));
    await admin.locator('#m-search select[name=membership]').selectOption('active');
    await pendingSearch;
    const query = admin.locator('#m-q');
    await query.fill('qa-bu');
    await query.press('ArrowLeft');
    const finishedSearch = admin.waitForResponse(r => accountRequest(new URL(r.url())));
    releaseSearch();
    await finishedSearch;
    await admin.waitForFunction(() => {
      const input = document.querySelector('#m-q');
      return document.querySelector('#m-q')?.closest('[aria-busy]')?.getAttribute('aria-busy') === 'false'
        && document.activeElement === input && input.value === 'qa-bu' && input.selectionStart === 4;
    });
    await search('qa-buyer');
    const card = admin.locator('.member-card');
    assert.match(await card.locator('.member-badges').innerText(), /2 级会员/);
    await card.locator('[data-edit-entitlement]').click();
    await card.locator('input[name=rank]').fill('1');
    await card.locator('select[name=mode]').selectOption('days');
    await card.locator('[name=days]').fill('21');
    admin.once('dialog', dialog => dialog.accept());
    const saved = admin.waitForResponse(r => r.url().includes('a=admin-account-entitlement'));
    await card.locator('[data-entitlement-form] [type=submit]').click();
    assert.equal((await saved).status(), 200);
    await card.locator('.member-badges').filter({ hasText: '1 级会员' }).waitFor();
    assert.ok(await card.locator('[data-edit-entitlement]').evaluate(el => document.activeElement === el));
    await buyer.reload();
    await buyer.locator('#account-rank').filter({ hasText: '1' }).waitFor();
    assert.ok(
      Math.abs(Date.parse((await get(buyer, 'account')).membership.until) - Date.now() - 21 * day) < 15000
    );
    assert.equal((await get(buyer, 'library', { kind: 'live', limit: 1 })).items[0].access, 'preview');
    assert.equal(await playback(), 'preview');
    const forbidden = await buyer.request.post(origin + '/functions/v1/app?a=admin-account-entitlement', {
      data: {},
    });
    assert.equal(forbidden.status(), 403);
    console.log('PASS 两个账号看到相同的合并等级与到期；管理员降级、改成 21 天后，会员账号、片库及播放器授权同步');
    await card.locator('[data-register-sale]').click();
    await admin.locator('#mr-email:visible').waitFor();
    assert.equal(await admin.locator('#mr-email').inputValue(), buyerEmail);
    const nav = key => admin.locator('.admin-task-nav [data-tab="' + key + '"]').click();
    await nav('upload');
    const selectMode = mode => admin.locator('[data-upload-mode="' + mode + '"]').click();
    const singlePicker = admin.locator('#file');
    assert.ok(await admin.locator('#batch-upload-host').isHidden());
    assert.ok(await admin.locator('#upload-form').isHidden());
    await singlePicker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
    await admin.locator('#probe').filter({ hasText: '请选择 MP4' }).waitFor();
    assert.ok(await admin.locator('#u-go').isDisabled());
    await singlePicker.setInputFiles({ name: 'previous.mp4', mimeType: 'video/mp4', buffer: require('node:fs').readFileSync(file) });
    await admin.waitForFunction(() => !document.querySelector('#u-go')?.disabled);
    await singlePicker.setInputFiles(file);
    await selectMode('batch');
    assert.ok(await admin.locator('#single-upload').isHidden());
    await selectMode('single');
    assert.equal(await admin.locator('#u-title').inputValue(), 'sample');
    await admin.waitForFunction(() => !document.querySelector('#u-go')?.disabled);
    await admin.locator('#u-title').fill('单条上传切换测试');
    await nav('members');
    await search(buyerEmail);
    await admin.locator('#admin-pair').click();
    await admin.locator('#file').waitFor({ state: 'attached' });
    assert.equal(await admin.locator('#file').evaluate(el => el.files[0].name), 'sample.mp4');
    assert.equal(await admin.locator('#u-title').inputValue(), '单条上传切换测试');
    assert.equal(await admin.locator('#m-q').inputValue(), buyerEmail);
    assert.ok(await admin.locator('#admin-upload-pane').isVisible());
    const columns = await admin
      .locator('#admin-panes')
      .evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 2);
    await nav('upload');
    await admin.locator('#admin-pair').click();
    await admin.goBack();
    await admin.locator('#m-q:visible').waitFor();
    await nav('upload');
    assert.equal(await admin.locator('#u-title').inputValue(), '单条上传切换测试');
    async function switchDuringUpload(start) {
      let entered, release;
      const reached = new Promise(resolve => {
        entered = resolve;
      });
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const target = url =>
        url.pathname === '/functions/v1/app' && url.searchParams.get('a') === 'admin-upload-complete';
      await admin.route(
        target,
        async route => {
          entered();
          await gate;
          await route.continue();
        },
        { times: 1 }
      );
      try {
        await start();
        await Promise.race([
          reached,
          wait(15000, 'timeout', { ref: false }).then(() => {
            throw new Error('upload completion request missing');
          }),
        ]);
        await nav('members');
        await search(buyerEmail);
        const completion = admin.waitForResponse(r => target(new URL(r.url())));
        release();
        assert.equal((await completion).status(), 200);
      } finally {
        release();
      }
    }
    await switchDuringUpload(() => admin.locator('#u-go').click());
    await nav('upload');
    const queue = admin.locator('[data-batch-files]');
    assert.ok(await admin.locator('#upload-form').isHidden());
    assert.equal(await singlePicker.inputValue(), '');
    await selectMode('batch');
    await queue.setInputFiles(file);
    await admin.locator('[data-batch-start]:enabled').waitFor();
    await switchDuringUpload(() => admin.locator('[data-batch-start]').click());
    await nav('upload');
    await admin.locator('[data-batch-list] [data-status]').filter({ hasText: '已保存草稿' }).waitFor();
    const drafts = (await get(admin, 'admin-videos', { limit: 20 })).items.filter(r => r.status === 'draft');
    assert.ok(drafts.some(r => r.title === '单条上传切换测试'));
    assert.ok(drafts.some(r => r.title === 'sample'));
    console.log(
      'PASS 登记购买自动填邮箱；保留单条文件和标题；桌面双栏与浏览器后退；切至查人时单条和批量上传均写入草稿'
    );
    await buyer.goto(origin + '/library?section=all&range=7&duration=long&sort=longest');
    await buyer.locator('#kind-list').getByText('跨页目标', { exact: true }).first().waitFor();
    assert.match(await buyer.locator('#library-result-count').innerText(), /\/ 1 条/);
    assert.ok(await buyer.locator('#library-period').isVisible());
    assert.ok(await buyer.locator('#library-duration').isVisible());
    await buyer.locator('#library-period').selectOption('1');
    await buyer.locator('#kind-list').getByText('没有符合条件的内容').waitFor();
    await buyer.locator('#library-duration').selectOption('short');
    await buyer.locator('#library-sort').selectOption('oldest');
    await buyer.locator('#kind-list a').first().waitFor();
    assert.match(buyer.url(), /sort=oldest/);
    await buyer.reload();
    await buyer.locator('#kind-list a').first().waitFor();
    assert.equal(await buyer.locator('#library-sort').inputValue(), 'oldest');
    assert.equal(await buyer.locator('#library-period').inputValue(), '1');
    await admin.setViewportSize({ width: 390, height: 844 });
    await admin.locator('#admin-section-picker').selectOption('members');
    await admin.locator('#admin-pair').click();
    await admin.locator('.member-card [data-edit-entitlement]').first().click();
    for (const width of [390, 360]) {
      for (const p of [admin, buyer]) {
        await p.setViewportSize({ width, height: 844 });
        assert.ok(
          await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          'mobile horizontal overflow at ' + width
        );
      }
    }
    assert.equal(
      await admin
        .locator('#admin-panes')
        .evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length),
      1
    );
    const picker = admin.locator('#admin-section-picker');
    await picker.selectOption('videos');
    await admin.locator('#admin-video-status').waitFor();
    await picker.selectOption('members');
    await admin.locator('#m-q:visible').waitFor();
    const sampleDraft = drafts.find(row => row.title === 'sample');
    await admin.evaluate(async id => {
      const { post } = await import('/assets/api.js');
      await post('admin-video-update', { videoId: id, status: 'published', tier_rank: 2, preview_seconds: 3 });
    }, sampleDraft.id);
    await buyer.goto(origin + '/library?q=sample');
    await buyer.locator('.screening-card').filter({ hasText: 'sample' }).click();
    await buyer.locator('.watch-heading h1').filter({ hasText: 'sample' }).waitFor();
    assert.ok(await buyer.evaluate(() => window.scrollY <= 1), 'opening a video starts at the top');
    const reel = buyer.locator('#reel');
    await reel.evaluate(video => { void video.play().catch(() => {}); });
    await buyer.waitForFunction(() => document.querySelector('#reel')?.currentTime > 0, null, { timeout: 10000 });
    assert.ok(await buyer.locator('.stage').evaluate(stage =>
      stage.getBoundingClientRect().bottom <= document.querySelector('.watch-heading').getBoundingClientRect().top));
    assert.ok(await buyer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await buyer.locator('#paywall:not([hidden])').waitFor();
    assert.equal(await buyer.locator('#paywall-title').innerText(), '试看结束');
    await buyer.locator('.watch-back').click();
    await buyer.locator('#kind-list .screening-card').first().waitFor();
    await buyer.goto(origin + '/v/' + videos[0].id);
    await buyer.getByRole('heading', { name: '这条视频暂无试看' }).waitFor();
    assert.equal(await buyer.locator('#reel').getAttribute('src'), null);
    console.log('PASS 手机切换后台；草稿发布、播放、试看结束和返回片库；无可用试看时显示会员入口');
    await buyer.goto(origin + '/library?section=all&sort=oldest&duration=short&page=3&per=6');
    const laterCard = buyer.locator('#kind-list .screening-card').nth(3);
    await laterCard.waitFor();
    await laterCard.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const cardPath = await laterCard.getAttribute('href');
    const catalogUrl = buyer.url();
    const topBefore = await laterCard.evaluate(el => el.getBoundingClientRect().top);
    await laterCard.focus();
    await buyer.keyboard.press('Enter');
    const returnLink = buyer.locator('.watch-back');
    await returnLink.waitFor();
    assert.equal(new URL(await returnLink.getAttribute('href'), origin).href, catalogUrl);
    await buyer.reload();
    await returnLink.click();
    const isBackAtCard = () => buyer.waitForFunction(path =>
      document.activeElement?.matches('#kind-list .screening-card') && document.activeElement.getAttribute('href') === path,
      cardPath, { timeout: 5000 });
    await isBackAtCard();
    assert.equal(buyer.url(), catalogUrl);
    assert.ok(Math.abs(await laterCard.evaluate(el => el.getBoundingClientRect().top) - topBefore) < 6);
    await buyer.keyboard.press('Enter');
    await returnLink.waitFor();
    await buyer.goBack();
    await isBackAtCard();
    await buyer.locator('#library-pagination').getByRole('link', { name: '下一页' }).click();
    assert.equal(new URL(buyer.url()).searchParams.get('page'), '4');
    const position = await buyer.locator('#library-result-count').evaluate(el => ({
      focused: el === document.activeElement, top: el.getBoundingClientRect().top,
      toolbar: document.querySelector('.library-browse-bar').getBoundingClientRect().bottom,
    }));
    assert.ok(position.focused && position.top >= position.toolbar - 1);
    await buyer.goto(origin + cardPath);
    assert.equal(await returnLink.getAttribute('href'), '/library');
    console.log('PASS 手机第三页筛选、键盘看片、播放器刷新、返回按钮和浏览器后退均回到原视频；独立视频链接返回片库');
    assert.deepEqual(errors, []);
    console.log(
      'PASS 140 条目录跨页筛选及排序、无匹配、直接链接与刷新；360px、390px 双栏自动堆叠，片库及后台无横向溢出'
    );
  } finally {
    if (browser) await browser.close();
    server.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
