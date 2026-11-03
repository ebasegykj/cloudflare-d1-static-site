/* ============ 开源模板站前端逻辑（无依赖，file:// 与 CF Pages 均可用） ============ */
(function () {
  /* ---------- 基础工具（必须最前，后文多处引用） ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const $app = document.getElementById('app');
  const META = window.SITE_META || {};
  const POSTS = window.POSTS || []; // 列表（无正文；正文在 data/content/<slug>.js 按需加载）
  /* 瞬间分卷存储：manifest（data/moments.js）+ 各年一卷（data/moments-YYYY.js）。
     进瞬间页先加载最新一卷，往更早翻页/切年份/全局搜索时再按需拉对应卷。 */
  let MOMENTS = [];
  const DATA = { posts: POSTS, moments: MOMENTS };
  const PHOTOS = window.PHOTO_WALL || [];
  /* 观影索引分年存储：统计在 watch-meta.js（页面直接引入），
     天索引在 days-YYYY.js（用到哪年拉哪年），拉取后合并进 window.WATCH_DAYS */
  const WMETA = window.WATCH_META || { total: 0, movie: 0, book: 0, mins: 0, years: [], perYear: {} };

  const injectScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('加载失败：' + src));
    document.head.appendChild(s);
  });

  let momentsLoading = null;
  let momentsYears = [];
  const loadedYears = new Set();
  function rebuildMoments() {
    const parts = window.MOMENTS_PARTS || {};
    const all = [];
    momentsYears.forEach((y) => { if (loadedYears.has(y)) (parts[y] || []).forEach((m) => all.push(m)); });
    all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    MOMENTS = all; DATA.moments = all;
  }
  async function ensureMomentYear(y) {
    if (loadedYears.has(y)) return;
    await injectScript(`data/moments-${y}.js`);
    loadedYears.add(y);
    rebuildMoments();
  }
  function loadMoments() {
    if (momentsLoading) return momentsLoading;
    momentsLoading = (async () => {
      await injectScript('data/moments.js');
      momentsYears = window.MOMENTS_YEARS || [];
      if (momentsYears.length) await ensureMomentYear(momentsYears[0]); // 默认只拉最新一卷
      else { MOMENTS = []; DATA.moments = MOMENTS; }
    })();
    return momentsLoading;
  }
  const ensureAllMomentYears = async () => { for (const y of momentsYears) await ensureMomentYear(y); };

  /* 观影天索引：按年拉取（该年没有观影记录时没有对应文件，直接跳过） */
  const loadedDays = new Set();
  const WD = () => window.WATCH_DAYS || {};
  function ensureDays(year) {
    if (loadedDays.has(year)) return Promise.resolve();
    if (!WMETA.perYear || !WMETA.perYear[year]) return Promise.resolve(); // 该年无观影记录
    return injectScript(`data/days-${year}.js`).then(() => { loadedDays.add(year); })
      .catch(() => { loadedDays.add(year); /* 404 等失败按空处理，不打断页面 */ });
  }


  /* ---------- 主题 ---------- */
  const themeBtn = document.getElementById('theme-toggle');
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark' || (!savedTheme && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.dataset.theme = 'dark';
    themeBtn.textContent = '☀️';
  }
  themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = dark ? '' : 'dark';
    themeBtn.textContent = dark ? '🌙' : '☀️';
    localStorage.setItem('theme', dark ? 'light' : 'dark');
  });

  /* ---------- 站点信息 ---------- */
  document.title = `${META.title} · ${META.subtitle || ''}`;
  document.getElementById('site-title').textContent = META.title || '';
  document.getElementById('site-subtitle').textContent = META.subtitle || '';
  const brandAvatar = document.getElementById('brand-avatar');
  if (META.avatar) brandAvatar.innerHTML = `<img src="${esc(META.avatar)}" alt="">`;
  else brandAvatar.textContent = (META.title || 'R').trim()[0] || 'R';
  document.getElementById('footer-text').textContent =
    `© ${META.title || ''} ${META.since ? '· since ' + META.since : ''} · 用记录对抗遗忘`;
  const DEFAULT_COVER = 'assets/default-cover.svg';

  /* ---------- 按文章生成缺省封面：同文同色，首字大字 + 分类小字 ---------- */
  const PALETTES = [
    ['#4b8c7e', '#2c5a50'], ['#5b7db1', '#39547c'], ['#b08968', '#7c5c40'],
    ['#8a7fb1', '#5c5280'], ['#c17b66', '#8c4f3e'], ['#6a9a58', '#456c37'],
    ['#5f8fa8', '#3d637a'],
  ];
  const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  function coverFor(p) {
    const pal = PALETTES[hashStr(p.slug || p.title || '') % PALETTES.length];
    const ch = esc((p.title || '文').trim()[0] || '文');
    const cat = (p.categories && p.categories[0] && p.categories[0].name) || '';
    const sub = esc([cat, p.date].filter(Boolean).join(' · '));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="440" viewBox="0 0 640 440">`
      + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
      + `<stop offset="0" stop-color="${pal[0]}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient></defs>`
      + `<rect width="640" height="440" fill="url(#g)"/>`
      + `<circle cx="560" cy="40" r="150" fill="#fff" opacity="0.07"/>`
      + `<circle cx="70" cy="410" r="170" fill="#fff" opacity="0.06"/>`
      + `<text x="320" y="272" font-family="-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="190" font-weight="700" text-anchor="middle" fill="#fff" opacity="0.92">${ch}</text>`
      + `<text x="44" y="398" font-family="-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="30" fill="#fff" opacity="0.6">${sub}</text>`
      + `</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg).replace(/'/g, '%27');
  }
  // 封面加载失败 → 回落到该文的生成封面
  window.__postCovers = {};
  window.coverFallback = function (img) {
    img.onerror = null;
    img.src = window.__postCovers[img.dataset.slug] || DEFAULT_COVER;
  };

  /* ---------- 工具 ---------- */
  const fmtDate = (d) => (d || '').replace(/\//g, '-');
  function setActive(tab) {
    document.querySelectorAll('#nav a').forEach((a) =>
      a.classList.toggle('active', a.dataset.tab === tab));
  }
  const setTitle = (t) => (document.title = t ? `${t} · ${META.title || ''}` : `${META.title || ''} · ${META.subtitle || ''}`);

  /* ---------- 返回顶部 ---------- */
  const backtop = document.getElementById('backtop');
  addEventListener('scroll', () => backtop.classList.toggle('show', scrollY > 420), { passive: true });
  backtop.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));

  /* ---------- 文章增强：外链 / 懒加载 / 公式 / 图表 ---------- */
  const cdnCache = {};
  function loadScript(src) {
    cdnCache[src] = cdnCache[src] || new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('CDN 加载失败'));
      document.head.appendChild(s);
    });
    return cdnCache[src];
  }
  function enhanceArticle(root) {
    root.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    root.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; img.classList.add('zoomable'); });
    if (root.textContent.includes('$$')) renderMath(root);
    const mmCodes = root.querySelectorAll('code.language-mermaid');
    if (mmCodes.length) renderMermaid(mmCodes);
  }
  async function renderMath(root) {
    try {
      if (!document.querySelector('link[data-katex]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet'; css.dataset.katex = 1;
        css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
        document.head.appendChild(css);
      }
      await loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js');
      renderMathInElement(root, { delimiters: [{ left: '$$', right: '$$', display: true }], throwOnError: false });
    } catch (e) { /* 离线时静默跳过，公式按原文显示 */ }
  }
  async function renderMermaid(codes) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js');
      window.mermaid.initialize({ startOnLoad: false, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default' });
      const divs = [...codes].map((code) => {
        const div = document.createElement('div');
        div.className = 'mermaid'; div.textContent = code.textContent;
        code.closest('pre').replaceWith(div);
        return div;
      });
      await window.mermaid.run({ nodes: divs });
    } catch (e) { /* CDN 不可用时保留代码原文 */ }
  }
  window.addEventListener('hashchange', route);

  /* ---------- lightbox ---------- */
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lightbox-img');
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.zoomable');
    if (img) { lbImg.src = img.src; lb.hidden = false; e.preventDefault(); }
  });
  lb.addEventListener('click', () => { lb.hidden = true; lbImg.src = ''; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { lb.hidden = true; lbImg.src = ''; } });

  /* ---------- 迷你热力图（按天：深绿=电影日，淡绿=剧集区间，空白=没看） ---------- */
  const TV_SPAN_DAYS = 7; // 剧集从记录日起 7 天内算"在看"
  function tvSpanSet(year) {
    const set = new Set();
    Object.keys(WD()).forEach((k) => {
      if (!k.startsWith(year) || !WD()[k].t) return;
      const dt = new Date(k + 'T12:00:00');
      for (let i = 0; i < TV_SPAN_DAYS; i++) {
        const d2 = new Date(dt); d2.setDate(d2.getDate() + i);
        set.add(d2.toISOString().slice(0, 10));
      }
    });
    return set;
  }
  function heatRows(year) {
    const span = tvSpanSet(year);
    let html = '';
    for (let mo = 1; mo <= 12; mo++) {
      const dim = new Date(+year, mo, 0).getDate();
      let row = '<div class="heat-row">';
      for (let d = 1; d <= dim; d++) {
        const key = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const day = WD()[key];
        const cls = day && day.m ? 'mv' : day && day.t ? 'tv' : span.has(key) ? 'tv' : '';
        row += `<i class="${cls}" title="${key}${day ? ' · ' + (day.m + day.t) + ' 部' : ''}"></i>`;
      }
      html += row + '</div>';
    }
    return html;
  }

  /* ---------- 视图：文章列表 ---------- */
  async function viewPosts() {
    setActive('posts');
    setTitle('');
    const posts = DATA.posts;
    const year = (WMETA.years && WMETA.years[0]) || String(new Date().getFullYear());
    await ensureDays(year); // 首页热力卡片要用该年的观影天索引
    const yStat = (WMETA.perYear && WMETA.perYear[year]) || { days: 0 };
    $app.innerHTML = `
      <section class="hero-row hero-posts">
        <div class="hero-main">
          <h1>${esc(META.title || '')}</h1>
          ${META.subtitle ? `<p class="hero-sub">${esc(META.subtitle)}</p>` : ''}
          <p class="hero-meta">共 ${posts.length} 篇文章 · <button type="button" class="link-btn" id="search-toggle">搜索</button></p>
          <div class="search-box search-mini" id="search-wrap" hidden>
            <span>🔍</span>
            <input id="search" type="text" placeholder="搜索文章…" />
            <span class="hint" id="search-hint"></span>
          </div>
        </div>
        <a class="heat-card" href="#/watch" title="查看观影图鉴">
          <div class="heat-head"><b>${year} 观影</b><span>${yStat.days || 0} 个观影日</span></div>
          <div class="heat-grid">${heatRows(year)}</div>
          <div class="heat-foot">累计 ${WMETA.movie || 0} 部 · 不务正业${Math.round((WMETA.mins || 0) / 60)} h →</div>
        </a>
      </section>
      <div class="post-list" id="post-list"></div>`;

    const list = document.getElementById('post-list');
    const hint = document.getElementById('search-hint');
    function render(q) {
      q = (q || '').trim().toLowerCase();
      const shown = q
        ? posts.filter((p) => (p.title + p.excerpt).toLowerCase().includes(q)) // 正文单独存文件，搜索按标题+摘要
        : posts;
      hint.textContent = q ? `${shown.length} 篇匹配` : '';
      if (!shown.length) { list.innerHTML = `<p class="empty-tip">没有找到相关文章</p>`; return; }
      list.innerHTML = shown.map((p) => {
        window.__postCovers[p.slug] = coverFor(p);
        return `
        <article class="post-card" onclick="location.hash='#/post/${esc(p.slug)}'">
          <div class="post-cover"><img class="zoom-off" src="${esc(p.cover || window.__postCovers[p.slug])}" data-slug="${esc(p.slug)}" loading="lazy" onerror="coverFallback(this)"></div>
          <div class="post-card-body">
            <h3>${esc(p.title)}</h3>
            <p class="post-excerpt">${esc((p.excerpt || '').slice(0, 120))}</p>
            <div class="post-meta">
              ${p.categories.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('')}
              <span>${esc(p.date)}</span>
            </div>
          </div>
        </article>`;}).join('');
    }
    render();
    const wrap = document.getElementById('search-wrap');
    document.getElementById('search-toggle').onclick = () => {
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) document.getElementById('search').focus();
    };
    document.getElementById('search').addEventListener('input', (e) => render(e.target.value));
  }

  /* ---------- 视图：文章详情（正文按 slug 从 data/content/ 拉取） ---------- */
  let postSeq = 0;
  async function loadPostContent(slug) {
    if (window.POST_CONTENT && window.POST_CONTENT[slug]) return window.POST_CONTENT[slug];
    /* 文件名 = 原始 slug，请求时才 encode（浏览器负责，别手动写进仓库路径）。
       不能靠 try/catch 判断成败：CF Pages 对不存在的路径会返回 200 + 首页 HTML，
       script 的 onload 照样触发（onerror 不触发）。所以加载后检查有没有真的拿到正文 */
    try { await injectScript(`data/content/${encodeURIComponent(slug)}.js`); }
    catch (e) { /* 加载失败按「没取到」处理，下面统一返回 null */ }
    return (window.POST_CONTENT || {})[slug] || null;
  }
  async function viewPost(slug) {
    const idx = DATA.posts.findIndex((p) => p.slug === slug);
    const p = DATA.posts[idx];
    if (!p) { location.hash = '#/'; return; }
    setActive('posts');
    const mySeq = ++postSeq;
    const prev = DATA.posts[idx + 1], next = DATA.posts[idx - 1];
    $app.innerHTML = `
      <div class="article-head">
        <a class="back-link" href="#/">← 返回文章列表</a>
        <h1>${esc(p.title)}</h1>
        <div class="article-meta">
          ${p.categories.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('')}
          ${p.tags.map((t) => `<span># ${esc(t)}</span>`).join('')}
          <span>📅 ${esc(p.date)}</span>
        </div>
      </div>
      <article class="article" id="post-body"><p class="empty-tip">正文加载中…</p></article>      <nav class="post-list" style="margin-top:-24px">
        ${prev ? `<article class="post-card" onclick="location.hash='#/post/${esc(prev.slug)}'"><div class="post-card-body"><p class="post-excerpt" style="margin:0">← 上一篇</p><h3 style="margin:4px 0 0">${esc(prev.title)}</h3></div></article>` : ''}
        ${next ? `<article class="post-card" onclick="location.hash='#/post/${esc(next.slug)}'"><div class="post-card-body"><p class="post-excerpt" style="margin:0">下一篇 →</p><h3 style="margin:4px 0 0">${esc(next.title)}</h3></div></article>` : ''}
      </nav>`;
    setTitle(p.title);
    window.scrollTo(0, 0);
    const art = $app.querySelector('.article');
    try {
      const obj = await loadPostContent(slug);
      if (mySeq !== postSeq) return; // 期间用户已跳走，别再动 DOM
      const html = (obj && obj.content) || '';
      art.innerHTML = html || '<p class="empty-tip">（无正文）</p>';
      enhanceArticle(art);
    } catch (e) {
      if (mySeq !== postSeq) return;
      art.innerHTML = '<p class="empty-tip">正文加载失败，刷新重试</p>';
    }
  }

  /* ---------- 视图：瞬间 ---------- */
  /* ---------- 年份滚轮：上下滑动或点击直接生效（无按钮、无提示文字） ---------- */
  function wheelHTML(id, years, cur, cls) {
    return `<div class="year-wheel${cls ? ' ' + cls : ''}" id="${id}">
      <div class="yw-scroll">
        <div class="yw-pad"></div>
        ${years.map((y) => `<div class="yw-item${y === String(cur) ? ' on' : ''}" data-y="${y}">${y}</div>`).join('')}
        <div class="yw-pad"></div>
      </div>
      <div class="yw-mask"></div>
    </div>`;
  }
  function mountWheel(id, onChange) {
    const box = document.getElementById(id);
    if (!box) return;
    const sc = box.querySelector('.yw-scroll');
    const items = [...sc.querySelectorAll('.yw-item')];
    let cur = items.findIndex((el) => el.classList.contains('on'));
    if (cur < 0) cur = 0;
    const mark = (i) => { items.forEach((el, j) => el.classList.toggle('on', j === i)); cur = i; };
    const settle = () => {
      const mid = sc.scrollTop + sc.clientHeight / 2;
      let best = 0, bd = 1e9;
      items.forEach((el, i) => {
        const c = el.offsetTop + el.offsetHeight / 2, d = Math.abs(c - mid);
        if (d < bd) { bd = d; best = i; }
      });
      if (best !== cur) { mark(best); onChange(items[best].dataset.y); }
    };
    sc.addEventListener('scroll', () => { clearTimeout(sc._t); sc._t = setTimeout(settle, 100); }, { passive: true });
    items.forEach((el, i) => (el.onclick = () => { mark(i); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); onChange(el.dataset.y); }));
    setTimeout(() => items[cur] && items[cur].scrollIntoView({ block: 'center' }), 30);
  }

  /* ---------- 时间线按月份分桶 ---------- */
  function bucketByMonth(list) {
    const map = new Map();
    list.forEach((m) => {
      const k = m.undated ? '0000-00' : fmtDate(m.date).slice(0, 7);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    });
    return [...map.entries()].map(([key, items]) => ({ key, items })).sort((a, b) => (a.key < b.key ? 1 : -1));
  }
  const monthLabel = (k) => (k === '0000-00' ? '更早看过 · 未记录日期' : k.replace('-', ' 年 ') + ' 月');
  function momentCard(m) {
    // 单图多图排版：把 content-wrp 里的 img 抽出来做宫格
    const tmp = document.createElement('div');
    tmp.innerHTML = m.content;
    // 只有一张图的 moment-imgs 容器拆掉包装（CSV 导入的单图条目否则会被压成 150px 小格子）
    tmp.querySelectorAll('.moment-imgs').forEach((d) => {
      const ims = [...d.querySelectorAll('img')];
      if (ims.length === 1) d.replaceWith(ims[0]);
    });
    // columns 只有一列有图、其余列全空时折叠（老 App 导出的空半列浪费宽度）
    tmp.querySelectorAll('.columns').forEach((c) => {
      const cols = [...c.children].filter((el) => el.classList && el.classList.contains('column'));
      const filled = cols.filter((el) => el.textContent.trim() || el.querySelector('img'));
      if (filled.length === 1 && filled[0].querySelector('img') && !filled[0].textContent.trim()) {
        c.replaceWith(filled[0].querySelector('img'));
      }
    });
    // 全文只有一张图 → 统一海报宽度，视觉一致
    const allImgs = tmp.querySelectorAll('img');
    if (allImgs.length === 1) {
      const box = document.createElement('div');
      box.className = 'moment-one';
      allImgs[0].replaceWith(box);
      box.appendChild(allImgs[0]);
    }
    const imgs = [...tmp.querySelectorAll('img')];
    let textHtml = tmp.innerHTML;
    if (imgs.length >= 2) {
      imgs.forEach((im) => { if (im.src) textHtml = textHtml.replace(im.outerHTML, ''); });
      textHtml += `<div class="moment-imgs">${imgs.map((im) => `<img class="zoomable" src="${esc(im.getAttribute('src'))}" loading="lazy">`).join('')}</div>`;
    } else {
      tmp.querySelectorAll('img').forEach((im) => { im.classList.add('zoomable'); im.loading = 'lazy'; });
      textHtml = tmp.innerHTML;
    }
    const badge = m.type === 'movie'
      ? `<span class="moment-badge">🎬${m.title ? ' ' + esc(m.title) : ''}${m.runtime ? ' · ' + m.runtime + ' 分钟' : ''}</span>`
      : m.type === 'book'
        ? `<span class="moment-badge">📚${m.title ? ' ' + esc(m.title) : ''}</span>`
        : '';
    return `
      <div class="moment-item">
        <div class="moment-dot">✦</div>
        <div class="moment-card">
          <div class="moment-date">🗓 ${esc(m.undated ? '更早看过 · 未记录日期' : fmtDate(m.date).replace(' 12:00:00', ''))}${badge}</div>
          <div class="moment-content">${textHtml}</div>
        </div>
      </div>`;
  }
  /* 标题行自适应对齐：把 2026 与 🎬 的字形墨迹左缘精确压到时间线竖线上
     （数字/emoji 字形自带留白且各平台字体不同，CSS 盒子对齐会有 1~6px 视觉偏差） */
  function alignHeroLine() {
    const wrap = document.getElementById('m-wrap');
    const wheel = document.getElementById('mw');
    const stats = document.querySelector('.tl-stats');
    const search = document.getElementById('m-search-wrap');
    if (!wrap || !wheel || !stats) return;
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => {
      const lineLeft = parseFloat(getComputedStyle(wrap, '::before').left) || 21;
      const lineX = wrap.getBoundingClientRect().left + lineLeft;
      const c = alignHeroLine._c || (alignHeroLine._c = document.createElement('canvas').getContext('2d'));
      const inkLeft = (el, text, centered) => {
        const cs = getComputedStyle(el);
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        c.textAlign = centered ? 'center' : 'left';
        const r = el.getBoundingClientRect();
        const alignX = centered ? r.left + r.width / 2 : r.left;
        return alignX - c.measureText(text).actualBoundingBoxLeft;
      };
      const on = wheel.querySelector('.yw-item.on');
      if (!on) return;
      const dWheel = lineX - inkLeft(on, on.textContent, true);
      const dStats = lineX - inkLeft(stats, stats.textContent, false);
      wheel.style.marginLeft = (parseFloat(getComputedStyle(wheel).marginLeft) + dWheel) + 'px';
      stats.style.marginLeft = (parseFloat(getComputedStyle(stats).marginLeft) + dStats) + 'px';
      if (search) search.style.marginLeft = (parseFloat(getComputedStyle(search).marginLeft) + dStats) + 'px';
    });
  }
  async function viewMoments(param) {
    setActive('moments');
    const stats = [];
    if (WMETA.movie) stats.push(`🎬 ${WMETA.movie} 部`);
    if (WMETA.book) stats.push(`📚 ${WMETA.book} 本`);
    if (WMETA.mins) stats.push(`${Math.round(WMETA.mins / 60)} 小时`);
    const years = (WMETA.years && WMETA.years.length) ? WMETA.years : [String(new Date().getFullYear())];
    let curYear = (param && /^\d{4}/.test(param)) ? param.slice(0, 4) : years[0];
    if (!years.includes(curYear)) curYear = years[0];
    $app.innerHTML = `
      <section class="hero-row hero-tl">
        <div class="hero-main">
          <div class="tl-head">
            ${wheelHTML('mw', years, curYear, 'inline')}
            <h1>瞬间<span class="count-tag">共 ${WMETA.total || 0} 条</span><button type="button" class="link-btn sub-link" id="m-search-toggle">搜索</button></h1>
          </div>
          <p class="tl-stats">${stats.join(' · ')}</p>
          <div class="search-box search-mini" id="m-search-wrap" hidden>
            <span>🔍</span>
            <input id="m-q" type="text" placeholder="搜索片名 / 书名 / 内容…" />
            <span class="hint" id="m-q-hint"></span>
          </div>
        </div>
      </section>
      <div class="moments-wrap" id="m-wrap"><p class="empty-tip">加载中…</p></div>
      <button class="btn ghost" id="m-more" hidden style="margin:18px auto 0;display:block"></button>`;
    setTitle('瞬间');
    alignHeroLine();
    try { await loadMoments(); }
    catch (e) { document.getElementById('m-wrap').innerHTML = '<p class="empty-tip">瞬间数据加载失败，刷新试试</p>'; return; }

    let months = bucketByMonth(DATA.moments);
    let startIdx = Math.max(0, months.findIndex((g) => g.key.startsWith(curYear)));
    let shown = 1;
    let searching = false;
    const wrap = document.getElementById('m-wrap');
    const btn = document.getElementById('m-more');

    const paint = (html) => {
      wrap.innerHTML = html;
      wrap.querySelectorAll('.moment-content img').forEach((im) => { im.classList.add('zoomable'); im.loading = 'lazy'; });
    };
    /* 最早的'0000-00'（未记录日期）条目存在 1900/1970 卷里，翻到那个月时对应卷必然已加载 */
    const renderPage = async () => {
      searching = false;
      let slice = months.slice(startIdx, startIdx + shown);
      const need = [...new Set(slice.map((g) => g.key.slice(0, 4)))].filter((y) => y !== '0000' && !loadedYears.has(y));
      if (need.length) {
        try { await Promise.all(need.map(ensureMomentYear)); }
        catch (e) { paint('<p class="empty-tip">数据加载失败，刷新试试</p>'); return; }
        months = bucketByMonth(DATA.moments);
        slice = months.slice(startIdx, startIdx + shown);
      }
      paint(slice.map((g) => `<div class="moment-month">${monthLabel(g.key)}</div>` + g.items.map(momentCard).join('')).join('')
        || '<p class="empty-tip">这一年还没有记录</p>');
      const next = months[startIdx + shown];
      const oldestLoaded = momentsYears.filter((y) => loadedYears.has(y)).slice(-1)[0];
      const nextYear = oldestLoaded ? momentsYears[momentsYears.indexOf(oldestLoaded) + 1] : null;
      if (next) { btn.hidden = false; btn.textContent = `加载更早（${monthLabel(next.key)}）`; btn._loadYear = null; }
      else if (nextYear) { btn.hidden = false; btn.textContent = `加载更早（${nextYear} 年）`; btn._loadYear = nextYear; }
      else { btn.hidden = true; btn._loadYear = null; }
    };
    /* 起点：定位到 param 指定的月份（图鉴点某天跳过来时用） */
    if (param && /^\d{4}-\d{2}/.test(param)) {
      const mi = months.findIndex((g) => g.key === param.slice(0, 7));
      if (mi >= 0) { startIdx = mi; shown = 1; }
    }
    renderPage();
    btn.onclick = async () => {
      if (searching) return;
      if (btn._loadYear) {
        btn.disabled = true; btn.textContent = '加载中…';
        try { await ensureMomentYear(btn._loadYear); months = bucketByMonth(DATA.moments); }
        catch (e) { /* 保持原状，下次再试 */ }
        btn.disabled = false;
      } else shown++;
      renderPage();
    };
    mountWheel('mw', async (y) => {
      curYear = y;
      if (!loadedYears.has(y) && momentsYears.includes(y)) {
        try { await ensureMomentYear(y); } catch (e) { /* 加载失败则该年显示为空 */ }
      }
      months = bucketByMonth(DATA.moments);
      const i = months.findIndex((g) => g.key.startsWith(y));
      startIdx = i < 0 ? months.length : i;
      shown = 1;
      renderPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    /* 搜索：点标题行「搜索」展开输入框；首次搜索把所有年份卷拉齐后全量过滤（最多 200 条），清空后回到按月分页 */
    const mSearch = document.getElementById('m-search-wrap');
    document.getElementById('m-search-toggle').onclick = () => {
      mSearch.hidden = !mSearch.hidden;
      if (!mSearch.hidden) q.focus();
    };
    const q = document.getElementById('m-q');
    const hint = document.getElementById('m-q-hint');
    /* 名录检索：片名命中 → 只拉对应年份的卷（老记录秒出，不必全量）；
       片名没命中（可能是正文关键词）→ 退回全量加载再搜 */
    const catalogYears = (kw) => {
      const cat = window.MOMENT_CATALOG || {};
      const years = new Set();
      Object.keys(cat).forEach((yy) => { if (cat[yy].some((t) => t.toLowerCase().includes(kw))) years.add(yy); });
      return years;
    };
    q.addEventListener('input', async () => {
      const kw = q.value.trim().toLowerCase();
      if (!kw) { hint.textContent = ''; renderPage(); return; }
      searching = true;
      if (!window.MOMENT_CATALOG) { try { await injectScript('data/catalog.js'); } catch (e) { /* 没有名录就走全量 */ } }
      const years = window.MOMENT_CATALOG ? catalogYears(kw) : null;
      if (years && years.size) {
        hint.textContent = '按名录检索…';
        try { await Promise.all([...years].map(ensureMomentYear)); months = bucketByMonth(DATA.moments); } catch (e) { /* 拉不到的卷跳过 */ }
      } else if (loadedYears.size < momentsYears.length) {
        hint.textContent = '搜索全部内容…';
        try { await ensureAllMomentYears(); months = bucketByMonth(DATA.moments); } catch (e) { /* 拉不到的卷跳过 */ }
      }
      searching = true;
      const hits = DATA.moments.filter((m) => (m.title || '').toLowerCase().includes(kw)
        || (m.content || '').toLowerCase().includes(kw)).slice(0, 200);
      hint.textContent = `${hits.length} 条匹配`;
      btn.hidden = true;
      paint(hits.length ? hits.map(momentCard).join('') : '<p class="empty-tip">没有找到相关瞬间</p>');
    });
  }

  /* ---------- 视图：待办清单（想看/想读/日常；完成的电影/图书自动进了瞬间，这里只显示待办和完成的日常） ---------- */
  /* 演示数据：仅 #/todos/demo 时注入，用于预览跨年时间线效果，不写任何数据文件 */
  function todoDemo() {
    const p = (i) => ((window.TODOS || [])[i] || {}).poster || '';
    return [
      { id: 'demo1', title: '演示 · 2024 想读的书', note: '2024 新增，一直没读', poster: p(5), createdAt: '2024-03-08 09:00:00', done: false, doneAt: null },
      { id: 'demo2', title: '演示 · 2024 想看的电影', note: '2024 新增，2025 年初看完', poster: p(3), createdAt: '2024-11-20 22:00:00', done: true, doneAt: '2025-01-15 20:30:00' },
      { id: 'demo3', title: '演示 · 2025 想看的电影', note: '', poster: p(4), createdAt: '2025-02-14 10:00:00', done: true, doneAt: '2025-12-31 23:00:00' },
      { id: 'demo4', title: '演示 · 2025 日常计划', note: '2025 新增，今年完成', poster: '', createdAt: '2025-08-01 08:00:00', done: true, doneAt: '2026-04-02 21:00:00' },
      { id: 'demo5', title: '演示 · 2026 想追的剧', note: '', poster: p(0), createdAt: '2026-01-05 10:00:00', done: false, doneAt: null },
      { id: 'demo6', title: '演示 · 2026 想看的电影（改看了别的）', note: '当天看了另一部，计划废弃', poster: p(1), createdAt: '2026-02-10 09:00:00', done: false, doneAt: null, dropped: true, droppedAt: '2026-02-11 21:00:00' },
    ];
  }
  let todosLoading = null;
  function loadTodos() {
    if (window.TODOS) return Promise.resolve();
    if (!todosLoading) todosLoading = injectScript('data/todos.js');
    return todosLoading;
  }
  async function viewTodos(param) {
    setActive('todos');
    setTitle('待办清单');
    $app.innerHTML = '<div class="wrap"><div id="todo-wrap"><p class="empty-tip">加载中…</p></div></div>';
    try { await loadTodos(); }
    catch (e) { document.getElementById('todo-wrap').innerHTML = '<p class="empty-tip">待办数据加载失败，刷新试试</p>'; return; }
    const todos = (window.TODOS || []).concat(param === 'demo' ? todoDemo() : []);
    let todoTab = 'pending';
    const day = (s) => (s || '').slice(0, 10);
    const dd = (s) => (s || '').slice(5, 10);
    const item = (t) => {
      const when = day(todoTab === 'pending' ? t.createdAt : todoTab === 'dropped' ? (t.droppedAt || t.createdAt) : (t.doneAt || t.createdAt)) || day(t.createdAt);
      return `
      <div class="todo-tl-row${todoTab === 'dropped' ? ' dropped' : ''}">
        <span class="todo-tile${t.poster ? '' : ' no-poster'}">
          ${t.poster ? `<img loading="lazy" src="${esc(t.poster)}" alt="" onerror="this.remove()">` : ''}
          <b>${esc(dd(when))}</b>
        </span>
        <span class="todo-tl-title">${t.title ? esc(t.title) : (t.note ? esc(t.note) : '（无标题）')}${t.title && t.note ? `<i>${esc(t.note)}</i>` : ''}</span>
      </div>`;
    };
    const whenOf = (t) => day(todoTab === 'pending' ? t.createdAt : todoTab === 'dropped' ? (t.droppedAt || t.createdAt) : (t.doneAt || t.createdAt)) || day(t.createdAt);
    const render = () => {
      const list = todos.filter((t) => todoTab === 'pending' ? (!t.done && !t.dropped) : todoTab === 'dropped' ? !!t.dropped : !!t.done)
        .sort((a, b) => whenOf(b).localeCompare(whenOf(a))); // 按日期倒序，新的在上
      const years = [], byYear = {};
      list.forEach((t) => {
        const y = whenOf(t).slice(0, 4) || '----';
        if (!byYear[y]) { byYear[y] = []; years.push(y); }
        byYear[y].push(t);
      });
      document.getElementById('todo-body').innerHTML =
        `<div class="todo-tl">${years.length
          ? years.map((y) => `<div class="todo-tl-year">${esc(y)}</div>` + byYear[y].map(item).join('')).join('')
          : '<p class="empty-tip">暂无</p>'}</div>`;
    };
    const nPend = todos.filter((t) => !t.done && !t.dropped).length;
    const nDone = todos.filter((t) => t.done && !t.dropped).length;
    const nDrop = todos.filter((t) => t.dropped).length;
    document.getElementById('todo-wrap').innerHTML =
      `<div class="todo-tabs">
        <button class="todo-tab active" data-tab="pending">未完成（${nPend}）</button>
        <button class="todo-tab" data-tab="done">已完成（${nDone}）</button>
        <button class="todo-tab" data-tab="dropped">废弃（${nDrop}）</button>
      </div>
      <div id="todo-body"></div>`;
    document.querySelectorAll('.todo-tab').forEach((b) => b.addEventListener('click', () => {
      todoTab = b.dataset.tab;
      document.querySelectorAll('.todo-tab').forEach((x) => x.classList.toggle('active', x === b));
      render();
    }));
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- 视图：观影图鉴（月历 + 剧照缩略图） ---------- */
  async function viewWatch(param) {
    setActive('watch');
    const years = (WMETA.years && WMETA.years.length) ? WMETA.years : [String(new Date().getFullYear())];
    let curYear = (param && /^\d{4}/.test(param)) ? param.slice(0, 4) : years[0];
    if (!years.includes(curYear)) curYear = years[0];
    $app.innerHTML = `
      <section class="hero-row hero-hang">
        <div class="hero-main">
          <h1>观影图鉴</h1>
          <p id="watch-note">${esc((META.watchNote || '').trim() && !/^https?:\/\//i.test((META.watchNote || '').trim()) ? META.watchNote.trim() : '每日一句 · 加载中…')}</p>
        </div>
        ${wheelHTML('ww', years, curYear)}
      </section>
      <div class="year-grid" id="year-grid"></div>
      <div class="heat-legend" style="margin-top:16px">
        <span><i class="mv"></i>电影日（当天第一部海报）</span>
        <span><i class="tv"></i>剧集（记录起 7 天）</span>
        <span><i></i>没看</span>
      </div>`;
    const grid = document.getElementById('year-grid');
    const renderYear = (year) => {
      const span = tvSpanSet(year);
      let out = '';
      for (let mo = 1; mo <= 12; mo++) {
        const dim = new Date(+year, mo, 0).getDate();
        const off = (new Date(+year, mo - 1, 1).getDay() + 6) % 7;
        let g = off ? '<span></span>'.repeat(off) : '';
        for (let d = 1; d <= dim; d++) {
          const key = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const day = WD()[key];
          let cls = '', bg = '', label = '';
          if (day && day.m) { cls = 'mv'; label = `<b>${d}</b>`; if (day.p) bg = `<img loading="lazy" src="${esc(day.p)}" alt="">`; }
          else if (day && day.t) { cls = 'tv'; label = `<b>${d}</b>`; }
          else if (span.has(key)) { cls = 'tv'; label = `<b>${d}</b>`; }
          if (day) g += `<a class="cal-day ${cls}" href="#/moments/${key}" title="${key} · ${day.m + day.t} 部">${bg}${label}</a>`;
          else g += `<span class="cal-day ${cls}">${label}</span>`;
        }
        out += `<div class="mcard"><h5>${mo} 月</h5><div class="cal">${g}</div></div>`;
      }
      grid.innerHTML = out;
    };
    await ensureDays(curYear); // 该年的观影天索引（没看过片的年份没有索引文件，直接跳过）
    renderYear(curYear);
    mountWheel('ww', async (y) => { curYear = y; await ensureDays(y); renderYear(y); });
    setTitle('观影图鉴');
    /* 副标题：留空 → 默认每日一句；填链接 → 每天从该接口拉一句；填文字 → 直接显示 */
    const note = (META.watchNote || '').trim();
    if (/^https?:\/\//i.test(note) || !note) {
      const el = document.getElementById('watch-note');
      el.textContent = '每日一句 · 加载中…';
      dailyQuote(note || HITOKOTO_URL).then((t) => { el.textContent = t || WATCH_NOTE_DEFAULT; });
    }
  }

  /* 图鉴副标题：后台填文字直接显示；填链接则每天从该接口拉一句；留空默认用每日一句 */
  const WATCH_NOTE_DEFAULT = '一年一张剧照月历 · 点有颜色的日子看当天记录';
  const HITOKOTO_URL = 'https://v1.hitokoto.cn/';
  async function dailyQuote(url) {
    try {
      const today = new Date().toDateString();
      const cache = JSON.parse(sessionStorage.getItem('daily-quote') || 'null');
      if (cache && cache.d === today && cache.u === url) return cache.t;
      const r = await fetch(url, { cache: 'no-store' });
      let t = (await r.text()).trim();
      try { const j = JSON.parse(t); t = j.hitokoto || j.content || j.text || j.sentence || j.quote || t; } catch (e) { /* 纯文本 */ }
      t = t.split('\n')[0].replace(/\s+/g, ' ').slice(0, 120);
      if (t) sessionStorage.setItem('daily-quote', JSON.stringify({ d: today, u: url, t }));
      return t;
    } catch (e) { return ''; }
  }


  /* ---------- 视图：图片墙 ---------- */
  function viewGallery() {
    setActive('gallery');
    let body;
    if (!PHOTOS.length) {
      body = `<div class="gallery-empty">
        <p style="font-size:30px;margin:0 0 8px">🖼️</p>
        <p>图片墙还是空的</p>
        <p style="font-size:13px">把图片放进 <code>photos/</code> 文件夹，<br>再在 <code>data/photos.js</code> 里照示例加一行即可。</p>
      </div>`;
    } else {
      body = `<div class="gallery-cols" id="gallery-cols"></div>`;
    }
    $app.innerHTML = `
      <section class="hero"><h1>图片墙</h1><p>记录生活里的画面 · 共 ${PHOTOS.length} 张</p></section>
      ${body}`;
    if (PHOTOS.length) layoutGallery();
    setTitle('图片墙');
  }

  /* ---------- 瀑布流布局：按图片真实宽高比、短列优先分配 ---------- */
  const galleryRatios = new Map(); // src -> 已知宽高比，重排时用于更准的分配
  function layoutGallery(force) {
    const wrap = document.getElementById('gallery-cols');
    if (!wrap) return;
    const w = wrap.clientWidth || 720;
    const n = w > 640 ? 3 : 2; // 桌面 3 列 / 手机 2 列
    // 关键：列数没变就不重建。手机下滑时地址栏收起会触发 resize，
    // 若此时重建 DOM 会导致滚动位置重置（"跳回顶部来回跳"的根源）
    if (!force && wrap.childElementCount === n) return;
    const cols = Array.from({ length: n }, () => {
      const c = document.createElement('div');
      c.className = 'gallery-col';
      return c;
    });
    const heights = new Array(n).fill(0.0001);
    PHOTOS.forEach((ph) => {
      const el = document.createElement('div');
      el.className = 'gallery-item';
      el.innerHTML = `<img class="zoomable" src="${esc(ph.src)}" loading="lazy" style="aspect-ratio:3/4">` +
        (ph.note ? `<p class="gallery-note">${esc(ph.note)}${ph.date ? ' · ' + esc(ph.date) : ''}</p>` : '');
      const img = el.querySelector('img');
      const setRatio = () => {
        if (img.naturalWidth) {
          const r = img.naturalWidth / img.naturalHeight;
          img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
          galleryRatios.set(ph.src, r); // 只记录，不搬家、不重排——布局在原地自然长高
        }
      };
      if (img.complete && img.naturalWidth) setRatio();
      else { img.onload = setRatio; img.onerror = () => { img.style.aspectRatio = '5/4'; }; }
      const k = heights.indexOf(Math.min(...heights));
      cols[k].appendChild(el);
      heights[k] += 1 / (galleryRatios.get(ph.src) || 0.72); // 未知比例用默认值估算
    });
    wrap.replaceChildren(...cols);
  }
  let galleryResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(galleryResizeTimer);
    galleryResizeTimer = setTimeout(() => {
      if (document.getElementById('gallery-cols')) layoutGallery(); // 列数变化才真正重排
    }, 200);
  });

  /* ---------- 视图：友链 ---------- */
  function viewLinks() {
    setActive('links');
    const L = window.FRIEND_LINKS || [];
    const cards = L.map((f) => `
      <a class="friend-card" href="${esc(f.url)}" target="_blank" rel="noopener">
        <span class="friend-avatar">
          <i>${esc((f.name || '友').trim()[0])}</i>
          ${f.avatar ? `<img src="${esc(f.avatar)}" loading="lazy" onerror="this.remove()">` : ''}
        </span>
        <span class="friend-info">
          <strong>${esc(f.name)}</strong>
          <small>${esc(f.desc || f.url)}</small>
        </span>
      </a>`).join('');
    $app.innerHTML = `
      <section class="hero"><h1>朋友圈</h1><p>朋友们的自留地 · 共 ${L.length} 个</p></section>
      ${L.length ? `<div class="friends-grid">${cards}</div>` : `
      <div class="gallery-empty">
        <p style="font-size:30px;margin:0 0 8px">🤝</p>
        <p>还没有朋友圈站点</p>
        <p style="font-size:13px">到管理后台的「朋友圈」页添加朋友的小站即可。</p>
      </div>`}`;
    setTitle('朋友圈');
  }

  /* ---------- 路由 ---------- */
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [seg, param] = h.split('/');
    if (seg === 'post' && param) viewPost(decodeURIComponent(param));
    else if (seg === 'moments') viewMoments(param ? decodeURIComponent(param) : '');
    else if (seg === 'todos') viewTodos(param);
    else if (seg === 'watch') viewWatch(param ? decodeURIComponent(param) : '');
    else if (seg === 'gallery') viewGallery();
    else if (seg === 'links') viewLinks();
    else viewPosts();
  }
  route();
})();
