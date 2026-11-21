// Public library structure. Content browsing comes before promotional/help text.
export function lessonLibraryMarkup({ promo, purchaseSteps }) {
  return `<div class="wrap lesson-home compact-library liquid-library">
    <header class="library-masthead">
      <div class="library-heading"><h1 id="lesson-title">拳击视频库</h1><div class="library-hero-actions"><a class="btn btn-primary" href="#teaching-library">浏览全部视频</a><a class="library-recent-link" href="/library?section=latest&amp;range=7&amp;page=1" data-wall-recent>近 7 天更新</a></div><p class="library-overview" id="library-overview" role="status">正在读取教学影像目录…</p></div>
      <section id="library-feature" class="liquid-cover-wall" aria-label="精选教学影像封面墙" data-running="false" data-rotating="false"><div class="liquid-wall-glow" aria-hidden="true"></div><div class="liquid-wall-grid" data-wall-grid aria-live="off"></div><div class="liquid-wall-controls"><span data-wall-status>精选教学影像</span><div><button type="button" data-wall-next>换一组 ↻</button><button type="button" data-wall-pause aria-pressed="false" aria-label="暂停封面墙动效">暂停流动</button></div></div></section>
    </header>
    <section class="lesson-catalog compact-catalog" id="teaching-library" aria-labelledby="catalog-title">
      <h2 class="catalog-sr-only" id="catalog-title">全部教学影像</h2>
      <div class="library-browse-bar">
        <nav id="library-sections" class="library-sections" aria-label="教学影像栏目"></nav>
        <div class="library-search-row"><label class="library-search" for="lib-q"><span class="catalog-sr-only" id="library-search-label">搜索教学影像</span><input id="lib-q" class="input" type="search" placeholder="搜索教学影像名称或说明" autocomplete="off"></label>
          <details class="library-advanced" id="library-advanced"><summary>更多筛选<span id="library-filter-count"></span></summary><div class="library-advanced-panel"><label>视频所需等级<select class="input" id="library-tier"></select></label><label>我能看什么<select class="input" id="library-access"><option value="all">全部权限</option><option value="full">已解锁完整版</option><option value="preview">仅能试看</option></select></label><label><span id="library-progress-label">学习进度</span><select class="input" id="library-progress"><option value="all">全部进度</option><option value="new">还没开始</option><option value="resume">可继续观看</option><option value="finished">已看至结尾</option></select></label><button class="btn btn-sm btn-ghost" type="button" data-library-refresh>刷新目录与进度</button><button class="btn btn-sm btn-ghost" type="button" data-clear-filters>清空筛选</button></div></details>
          <div class="row library-view-modes" id="view-modes" role="group" aria-label="教学影像显示方式"></div>
        </div>
      </div>
      <div class="library-category-row" data-video-controls><div id="kind-tabs" class="row" role="group" aria-label="按类别筛选教学影像"></div><p id="catalog-viewer-context" class="library-viewer-context"></p></div>
      <div class="library-quick-filters" id="library-date-tools" aria-label="视频筛选与排序" role="group" hidden>
        <label>发布时间<select class="input" id="library-period"></select></label>
        <label>视频时长<select class="input" id="library-duration"><option value="all">不限时长</option><option value="short">少于 2 分钟</option><option value="medium">2 至不足 5 分钟</option><option value="long">5 分钟及以上</option></select></label>
        <label id="library-sort-label">排序<select class="input" id="library-sort"><option value="catalog">目录顺序</option><option value="newest">最新发布优先</option><option value="oldest">最早发布优先</option><option value="shortest">时长从短到长</option><option value="longest">时长从长到短</option></select></label>
        <label id="library-group-label" hidden>日期分组<select class="input" id="library-date-group"><option value="day">按日期分组</option><option value="none">连续排列</option></select></label>
      </div>
      <div class="library-results-bar"><p id="library-result-count" role="status" aria-live="polite" tabindex="-1"></p><div class="library-page-quick" id="library-page-quick"></div></div>
      <p class="library-scope-note" id="library-scope-note" hidden></p>
      <div id="library-active-filters" class="row" role="group" aria-label="当前筛选条件" hidden></div>
      <div id="kind-list" class="library-results"></div>
      <div class="library-pagination-row"><div id="library-pagination"></div><label class="library-page-size">每页<select class="input" id="library-page-size" aria-label="每页显示数量"><option value="6">6 条</option><option value="12">12 条</option></select></label></div>
      <div id="library-load-more"></div>
    </section>
    <details class="library-help" id="library-help"><summary>观看帮助与会员说明<span>试看、档位与激活码</span></summary><div class="library-help-body">
      ${promo ? `<p>${promo}</p>` : ''}
      <div class="library-help-links"><a href="/pricing" data-link>查看会员价格</a><a href="/account" data-link>兑换激活码 / 查看记录</a></div>
      <div class="faq-list"><details><summary>未购买会员，可以先试看吗？</summary><p>可以。打开教学影像查看试看内容，具体试看时长以播放页面为准。</p></details><details><summary>我的会员能看哪些视频？</summary><p>打开视频可查看所需等级。你的会员达到该等级，就能看完整版。</p></details><details><summary>怎样购买并绑定激活码？</summary><p>${purchaseSteps}</p></details><details><summary>会员到期后怎样继续观看？</summary><p>观看记录仍会保留。到“会员与购买”联系站长选择续期档位。</p></details></div>
    </div></details>
  </div>`;
}
