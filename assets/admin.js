/* ============ 管理后台逻辑（GitHub 作为 CMS，无后端） ============ */
(function () {
  const $panel = document.getElementById('panel');
  const CFG_KEY = 'ghcms_cfg';
  const META = window.SITE_META || {};
  let cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
  const viewState = { manageAll: {}, manageUndated: false, todosShowDone: false }; // 管理页展开状态 / 未记日期筛选 / 待办已完成展开
  /* TMDB / Google Books 搜索经 worker 中转（国内浏览器直连不了这两个 API 域名；官网网页能开 ≠ API 域能通） */
  const API_PROXY = ''; // 填你的 worker 域名（TMDB/Google Books 搜索中转），或后台设置页里填
  let busy = false;

  /* ---------- 基础 UI ---------- */
  const toast = (msg, type = '') => {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast ' + type; t.hidden = false;
    clearTimeout(t._timer); t._timer = setTimeout(() => (t.hidden = true), 3500);
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const today = () => now().slice(0, 10).replace(/\//g, '-');

  /* ---------- D1 直写模式（2026-11 数据迁移方案 B）----------
   * 设置页填了 Worker 地址 + ADMIN_KEY → 发布走 worker 的 /api/admin/write 写 D1，
   * 即时生效、不触发部署；读（data/*.js）走站点自身的 Functions 输出层，天然是 D1 数据。
   * 两项留空 → 走 GitHub 提交（迁移完成前的旧行为）。 */
  const d1Mode = () => !!(cfg.apiKey && cfg.workerUrl);
  async function d1Write(ops) {
    const r = await fetch(cfg.workerUrl.replace(/\/+$/, '') + '/api/admin/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': cfg.apiKey },
      body: JSON.stringify({ files: ops }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`worker 写入失败: HTTP ${r.status} ${d.error || ''}`);
    return d;
  }

  /* ---------- GitHub Contents API ---------- */
  function headers() {
    if (!cfg.token) throw new Error('未配置 GitHub Token，请先到「设置」页填写');
    return { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' };
  }
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  async function ghFile(path) {
    const r = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch || 'main'}`, { headers: headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`读取 ${path} 失败: HTTP ${r.status}`);
    return r.json();
  }
  async function ghSave(path, content, message) {
    const old = await ghFile(path);
    const r = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify({ message, content: b64(content), branch: cfg.branch || 'main', sha: old ? old.sha : undefined }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(`提交失败: HTTP ${r.status} ${e.message || ''}`); }
    return r.json();
  }
  const serialize = (varName, arr, comment) =>
    `${comment}\nwindow.${varName} = ${JSON.stringify(arr, null, 0)};\n`;

  /* ---------- 拆分数据结构：文件格式与发文 bot、迁移脚本保持一致 ---------- */
  const POSTS_LIST_HEADER = '// 文章列表（由管理后台/发文bot维护；正文在 data/content/<slug>.js 按需加载）';
  const postContentFile = (slug, obj) =>
    `// 正文（slug=${slug}，由发文bot/管理后台维护；手改这个文件前台直接生效）\n`
    + 'window.POST_CONTENT = window.POST_CONTENT || {};\n'
    + `window.POST_CONTENT[${JSON.stringify(slug)}] = ${JSON.stringify(obj)};\n`;
  const momentsManifestFile = (years) =>
    '// 瞬间分卷清单（bot/后台维护；各年正文在 data/moments-YYYY.js）\nwindow.MOMENTS_YEARS = ' + JSON.stringify(years) + ';\n';
  const momentsVolumeFile = (y, arr) =>
    `// 瞬间数据 ${y} 年卷（由管理后台/发文bot维护）\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS[${JSON.stringify(y)}] = ${JSON.stringify(arr)};\n`;
  const catalogFile = (arr) => {
    const map = {};
    arr.forEach((m) => {
      if (!m.title) return;
      const yy = String(m.date || '').slice(0, 4) || '0000';
      (map[yy] = map[yy] || []).push(m.title);
    });
    return '// 瞬间名录：查重+站内搜索用（年份→片名列表；发布瞬间时自动重算，勿手改）\nwindow.MOMENT_CATALOG = ' + JSON.stringify(map) + ';\n';
  };
  const todosFile = (arr) =>
    '// 待办清单（想看/想读/日常；后台管理与前台待办页共用，完成的电影/图书自动记入瞬间）\nwindow.TODOS = ' + JSON.stringify(arr) + ';\n';
  const daysYearFile = (y, days) =>
    `// 观影天索引 ${y} 年（发布时自动重算，勿手改）\nwindow.WATCH_DAYS = window.WATCH_DAYS || {};\nObject.assign(window.WATCH_DAYS, ${JSON.stringify(days)});\n`;
  const watchMetaFile = (meta) =>
    '// 观影统计（发布时自动重算，勿手改）\nwindow.WATCH_META = ' + JSON.stringify(meta) + ';\n';
  const momentYearOf = (m) => (String(m.date || '').match(/^(\d{4})\//) || ['', '0000'])[1];

  /* admin.html 只引入 manifest（data/moments.js）与文章列表；
     各年瞬间卷在这里补齐（后台要全量数据才能增删改与重算统计），正文按需加载 */
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('加载失败：' + src));
    document.head.appendChild(s);
  });
  async function ensureAllMoments() {
    if (window.MOMENTS) return;
    const years = window.MOMENTS_YEARS || [];
    for (const y of years) await loadScript(`data/moments-${y}.js`);
    const parts = window.MOMENTS_PARTS || {};
    const all = [];
    years.forEach((y) => (parts[y] || []).forEach((m) => all.push(m)));
    all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    window.MOMENTS = all;
    window.MOMENTS_YEARS_LOADED = new Set(years);
  }
  /* ⚠️ 正文文件仓库路径用原始 slug（不 encode）：encodeURIComponent 只用于浏览器发请求。
     写路径一旦转义，文件名会变成字面量 %E6%B5%8B…，前台按中文 slug 取不到 → 正文加载失败 */
  const contentPath = (slug) => `data/content/${slug}.js`;
  async function ensurePostContent(slug) {
    window.POST_CONTENT = window.POST_CONTENT || {};
    if (window.POST_CONTENT[slug]) return window.POST_CONTENT[slug];
    /* 不能靠 try/catch 判断成败：CF Pages 对不存在的路径会返回 200 + 首页 HTML，
       onload 照样触发。所以加载后检查有没有真的拿到正文 */
    try { await loadScript(`data/content/${encodeURIComponent(slug)}.js`); }
    catch (e) { /* 加载失败按「没取到」处理，下面统一抛错 */ }
    if (window.POST_CONTENT[slug]) return window.POST_CONTENT[slug];
    throw new Error(`正文文件取不到：${slug}`);
  }

  /* ================= 暂存区：保存只记在本机，点「发布」才合并成 1 个提交 ================= */
  const STAGE_KEY = 'ghcms_stage';
  const emptyStage = () => ({ files: {}, blobs: {}, dels: [] });
  let stage = (() => {
    try { return { ...emptyStage(), ...JSON.parse(localStorage.getItem(STAGE_KEY) || '{}') }; }
    catch (e) { return emptyStage(); }
  })();
  const saveStage = () => localStorage.setItem(STAGE_KEY, JSON.stringify(stage));
  const stageCount = () =>
    Object.keys(stage.files).length + Object.keys(stage.blobs).length + stage.dels.length;

  async function gh(path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
      ...opts, headers: { ...headers(), ...(opts.headers || {}) },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} 失败: HTTP ${r.status} ${d.message || ''}`);
    return d;
  }
  const postBlob = async (content) => (await gh('/git/blobs', {
    method: 'POST', body: JSON.stringify({ content: b64(content), encoding: 'base64' }),
  })).sha;
  async function ghFileSha(path) {
    const r = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch || 'main'}`, { headers: headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`读取 ${path} 失败: HTTP ${r.status}`);
    return (await r.json()).sha;
  }

  /* 观影索引：分年 days 文件 + 全局统计（watch-meta）。发布瞬间后由 publish() 挑受影响年份重算 */
  function buildWatchFiles() {
    const w92 = (u) => (u || '').replace('/w500/', '/w92/');
    const days = {}; const perYear = {};
    MOMENTS.forEach((m) => {
      const d = String(m.date || '').match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
      if (!d || m.undated || d[1] === '1970' || d[1] === '1900' || m.type === 'book') return;
      const key = `${d[1]}-${d[2]}-${d[3]}`;
      const o = days[key] || (days[key] = { m: 0, t: 0, p: '' });
      if (m.kind === 'tv') o.t++; else o.m++;
      if (!o.p && m.poster) o.p = w92(m.poster);
      const y = perYear[d[1]] || (perYear[d[1]] = { days: 0, m: 0, t: 0 });
      if (m.kind === 'tv') y.t++; else y.m++;
    });
    Object.keys(days).forEach((k) => { const y = k.slice(0, 4); if (perYear[y]) perYear[y].days++; });
    const meta = {
      total: MOMENTS.length,
      movie: MOMENTS.filter((m) => m.type === 'movie').length,
      book: MOMENTS.filter((m) => m.type === 'book').length,
      mins: MOMENTS.reduce((s, m) => s + (m.runtime || 0), 0),
      years: [...new Set(Object.keys(days).map((k) => k.slice(0, 4)))].sort().reverse(),
      perYear,
      watchDays: Object.keys(days).length,
    };
    const files = {};
    const daysByYear = {};
    Object.keys(days).forEach((k) => {
      const y = k.slice(0, 4);
      (daysByYear[y] = daysByYear[y] || {})[k] = days[k];
    });
    Object.keys(daysByYear).forEach((y) => { files[`data/days-${y}.js`] = daysYearFile(y, daysByYear[y]); });
    files['data/watch-meta.js'] = watchMetaFile(meta);
    return files;
  }

  /* 暂存一条数据文件改动（记录线上基线 sha 用于发布前的冲突检查；没 Token 时也允许先暂存）
     D1 模式没有 sha 概念，基线留空（冲突检查在 publishD1 里跳过） */
  async function stageFile(path, content, msg) {
    const old = stage.files[path];
    let baseSha = old ? old.baseSha : null;
    if (!old && !d1Mode()) { try { baseSha = await ghFileSha(path); } catch (e) { baseSha = null; } }
    stage.files[path] = { content, msg, baseSha };
    saveStage();
    renderStageBar();
  }

  /* 真正发布：所有暂存文件 + 图片合并成一个 commit（Cloudflare 只部署 1 次） */
  async function publish() {
    if (location.protocol === 'file:') {
      alert('⚠️ 你正在用本地文件打开后台（file://）\n\n页面读的是你电脑上的旧数据快照，直接发布会把线上新内容（含微信发的文章）覆盖掉。\n\n请改用线上网址打开后台：你的站点地址 + /admin.html');
      return;
    }
    if (busy) return;
    const n = stageCount();
    if (!n) return toast('没有待发布的内容', 'err');
    const B = cfg.branch || 'main';
    busy = true;
    const st = document.getElementById('stage-status');
    const say = (t, cls = '') => { if (st) { st.textContent = t; st.className = 'status-line ' + cls; } };
    try {
      say('检查线上是否有新改动…');
      const conflicts = [];
      for (const [path, f] of Object.entries(stage.files)) {
        if (d1Mode() || !f.baseSha) continue; // D1 模式无 sha 基线；无基线也跳过
        try {
          const sha = await ghFileSha(path);
          if (sha && sha !== f.baseSha) conflicts.push(path);
        } catch (e) { /* 忽略单个文件检查失败 */ }
      }
      if (conflicts.length && !confirm(
        `以下文件在你暂存之后被改过（可能是别的设备或后台保存）：\n${conflicts.join('\n')}\n\n继续发布会用本机版本覆盖线上，确定继续吗？`
      )) { busy = false; say('已取消发布', 'err'); return; }

      // 数据变了就顺手重算观影索引：只重算受影响年份的 days 文件 + 全局统计（小文件）
      const stagedMomentYears = Object.keys(stage.files).filter((p) => /^data\/moments-\d{4}\.js$/.test(p));
      if (stagedMomentYears.length) {
        const files = buildWatchFiles();
        for (const path of stagedMomentYears) {
          if (!files[path]) continue; // 该年没有观影天（全是图书/随笔），无需 days 文件
          const baseSha = stage.files[path] ? stage.files[path].baseSha : (d1Mode() ? null : await ghFileSha(path));
          stage.files[path] = { content: files[path], msg: '重算观影索引', baseSha };
        }
        const metaPath = 'data/watch-meta.js';
        const metaBase = stage.files[metaPath] ? stage.files[metaPath].baseSha : (d1Mode() ? null : await ghFileSha(metaPath));
        stage.files[metaPath] = { content: files[metaPath], msg: '重算观影统计', baseSha: metaBase };
      }

      /* D1 模式：数据文件整体走 worker 写 D1（即时生效）；图片文件上传走 R2 是 Phase 3，
         有暂存图片时明确拦下，不静默丢弃 */
      if (d1Mode()) {
        const imgOps = Object.keys(stage.blobs).length + stage.dels.filter((p) => !/^(data|js)\//.test(p)).length;
        if (imgOps) {
          busy = false;
          say('✗ D1 模式暂不支持图片文件上传（R2 迁移 Phase 3 后开放）', 'err');
          toast('本次暂存含图片文件，D1 直写暂不支持。清空 Key 走 GitHub 模式，或删掉图片暂存项后发布文字部分', 'err');
          return;
        }
        say('写入 D1…');
        const ops = Object.entries(stage.files).map(([path, f]) => ({ path, body: f.content }));
        stage.dels.filter((p) => /^(data|js)\//.test(p)).forEach((path) => ops.push({ path, deleted: true }));
        const d = await d1Write(ops);
        stage = emptyStage(); saveStage(); renderStageBar();
        say('✓ 已发布（D1，即时生效）', 'ok');
        toast(`已发布 ${d.n} 项改动（D1 即时生效，无需等待部署）`, 'ok');
        return;
      }

      say('上传文本…');
      const entries = [];
      for (const [path, f] of Object.entries(stage.files)) {
        entries.push({ path, mode: '100644', type: 'blob', sha: await postBlob(f.content) });
      }
      Object.entries(stage.blobs).forEach(([path, sha]) => entries.push({ path, mode: '100644', type: 'blob', sha }));
      stage.dels.forEach((path) => entries.push({ path, mode: '100644', type: 'blob', sha: null }));

      say('合并成 1 个提交…');
      const head = await gh(`/git/ref/heads/${B}`);
      const headSha = head.object.sha;
      const headCommit = await gh(`/git/commits/${headSha}`);
      const tree = await gh('/git/trees', {
        method: 'POST',
        body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }),
      });
      const msgs = Object.values(stage.files).map((f) => f.msg).filter(Boolean);
      const message = `后台发布（${n} 项）\n\n- ` + [...new Set(msgs)].join('\n- ');
      const commit = await gh('/git/commits', {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
      });
      await gh(`/git/refs/heads/${B}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });

      stage = emptyStage(); saveStage(); renderStageBar();
      say('✓ 已发布，Cloudflare 约 1 分钟后部署完成', 'ok');
      toast(`已发布 ${n} 项改动（1 个提交 / 1 次部署）`, 'ok');
    } catch (e) {
      say('✗ ' + e.message, 'err');
      toast(e.message, 'err');
    } finally { busy = false; }
  }

  /* 右下角发布条：常驻显示，空态时提示流程 */
  function renderStageBar() {
    let bar = document.getElementById('stage-bar');
    const n = stageCount();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'stage-bar';
      bar.innerHTML = '<span class="sb-count"></span><button class="sb-pub">发布到线上</button><button class="sb-clear">放弃</button><span class="status-line" id="stage-status"></span>';
      document.body.appendChild(bar);
      bar.querySelector('.sb-pub').onclick = publish;
      bar.querySelector('.sb-clear').onclick = () => {
        if (!confirm(`放弃 ${stageCount()} 项未发布的改动？已上传的图片文件会留在仓库里（不会显示在页面）。`)) return;
        stage = emptyStage(); saveStage(); renderStageBar();
        toast('已放弃暂存', 'ok');
      };
    }
    const pub = bar.querySelector('.sb-pub');
    const clr = bar.querySelector('.sb-clear');
    const st = bar.querySelector('#stage-status');
    if (!n) {
      pub.disabled = true; clr.hidden = true;
      if (st && !/^✓|^✗/.test(st.textContent)) st.textContent = '';
      bar.querySelector('.sb-count').textContent = '暂存区：空';
      bar.title = '所有「保存」都会先攒在这里；攒好改动后点「发布到线上」，只部署 1 次';
      return;
    }
    pub.disabled = false; clr.hidden = false;
    const msgs = Object.values(stage.files).map((f) => f.msg).filter(Boolean);
    const imgs = Object.keys(stage.blobs).length + stage.dels.length;
    bar.querySelector('.sb-count').textContent =
      `待发布 ${n} 项${imgs ? `（含图片 ${imgs}）` : ''}`;
    bar.title = [...new Set(msgs)].join(' · ');
  }


  async function ghDelete(path, message) {
    // 删除也进暂存：发布时在同一个提交里删除文件（不额外触发部署）
    if (stage.dels.includes(path)) return false;
    stage.dels.push(path);
    saveStage(); renderStageBar();
    return true;
  }

  async function commit(varName, arr, comment, msg) {
    if (busy) return;
    busy = true;
    try {
      if (varName === 'POSTS') await commitPosts(arr, msg);
      else if (varName === 'MOMENTS') await commitMoments(arr, msg);
      else {
        await stageFile(`data/${fileOf(varName)}`, serialize(varName, arr, comment), msg);
        window[varName] = arr; // 同步内存数据，避免连续暂存时互相覆盖
      }
      toast(`已暂存：${msg}（点右下「发布到线上」才会上线）`, 'ok');
    } finally { busy = false; }
  }
  const fileOf = (v) => ({ POSTS: 'posts.js', PHOTO_WALL: 'photos.js', FRIEND_LINKS: 'links.js', SITE_META: 'meta.js' }[v]);

  /* 文章（C 方案）：列表一个小文件 + 每篇一个正文文件。
     只暂存正文有变化的篇目；删除文章时正文文件一起进 dels。 */
  async function commitPosts(arr, msg) {
    window.POST_CONTENT = window.POST_CONTENT || {};
    const oldBySlug = {};
    (window.POSTS || []).forEach((p) => (oldBySlug[p.slug] = p));
    const newSlugs = new Set();
    for (const p of arr) {
      newSlugs.add(p.slug);
      if (p.content === undefined) continue; // 没动正文的条目（删除/列表操作），不碰正文文件
      const cached = window.POST_CONTENT[p.slug];
      const obj = p.raw !== undefined ? { content: p.content, raw: p.raw } : { content: p.content };
      if (oldBySlug[p.slug] && cached && JSON.stringify(cached) === JSON.stringify(obj)) continue; // 正文没变
      await stageFile(contentPath(p.slug), postContentFile(p.slug, obj), msg);
      window.POST_CONTENT[p.slug] = obj;
    }
    for (const p of window.POSTS || []) {
      if (newSlugs.has(p.slug)) continue;
      const path = contentPath(p.slug);
      if (!stage.dels.includes(path)) stage.dels.push(path); // 删文连正文文件一起删
    }
    saveStage(); renderStageBar();
    const list = arr.map(({ content, raw, ...rest }) => rest);
    await stageFile('data/posts.js', `${POSTS_LIST_HEADER}\nwindow.POSTS = ${JSON.stringify(list)};\n`, msg);
    window.POSTS = list;
  }

  /* 瞬间（年分卷）：只暂存内容有变化的年份卷；年份清单增删时一并暂存 */
  async function commitMoments(arr, msg) {
    const parts = window.MOMENTS_PARTS = window.MOMENTS_PARTS || {};
    const years = window.MOMENTS_YEARS_LOADED || new Set(window.MOMENTS_YEARS || []);
    const byYear = new Map();
    arr.forEach((m) => {
      const y = momentYearOf(m);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(m);
    });
    for (const [y, vol] of byYear) {
      vol.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (years.has(y) && JSON.stringify(parts[y] || []) === JSON.stringify(vol)) continue; // 该年没变化
      await stageFile(`data/moments-${y}.js`, momentsVolumeFile(y, vol), msg);
      parts[y] = vol;
    }
    const yearList = [...byYear.keys()].sort().reverse();
    if (JSON.stringify(yearList) !== JSON.stringify(window.MOMENTS_YEARS || []))
      await stageFile('data/moments.js', momentsManifestFile(yearList), msg);
    /* 查重名录随瞬间一起重算（bot 侧发布同样会重算，两边格式一致） */
    await stageFile('data/catalog.js', catalogFile(arr), msg);
    window.MOMENTS = arr;
  }

  async function commitTodos(arr, msg) {
    await stageFile('data/todos.js', todosFile(arr), msg);
    window.TODOS = arr;
  }

  /* ---------- 本地图片上传 → 仓库 photos/（与图床链接二选一） ---------- */
  function shrink(file) {
    // 大图压缩：最长边 2560px、JPEG 0.88（gif/svg 不处理）
    return new Promise((res) => {
      if (/image\/(gif|svg)/.test(file.type)) return res(file);
      const img = new Image();
      img.onload = () => {
        const MAX = 2560;
        if (Math.max(img.width, img.height) <= MAX) return res(file);
        const k = MAX / Math.max(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => res(b || file), 'image/jpeg', 0.88);
      };
      img.onerror = () => res(file);
      img.src = URL.createObjectURL(file);
    });
  }
  async function uploadImage(file, subdir, onProgress) {
    const blob = await shrink(file);
    if (blob.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20MB，请先压缩`);
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = () => rej(new Error('读取文件失败'));
      r.readAsDataURL(blob);
    });
    const b64data = dataUrl.split(',')[1];
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const path = `photos/${subdir}/${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    onProgress && onProgress(`正在上传 ${file.name} …`);
    // 只上传 blob（不构成提交、不触发部署），发布时随其它改动一起进同一个 commit
    const sha = (await gh('/git/blobs', {
      method: 'POST', body: JSON.stringify({ content: b64data, encoding: 'base64' }),
    })).sha;
    stage.blobs[path] = sha;
    saveStage(); renderStageBar();
    return path; // 站内相对路径，本地双击与线上均有效
  }
  function pickFiles({ multiple = false, accept = 'image/*' } = {}) {
    return new Promise((res) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
      inp.onchange = () => res([...inp.files]);
      inp.click();
    });
  }

  /* ---------- Markdown → HTML（够用版） ---------- */
  function md(src) {
    const codes = [];
    src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      codes.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    src = esc(src);
    src = src.replace(/^### (.*)$/gm, '<h3>$1</h3>')
             .replace(/^## (.*)$/gm, '<h2>$1</h2>')
             .replace(/^# (.*)$/gm, '<h2>$1</h2>');
    src = src.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
    src = src.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
    src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
             .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
             .replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // 列表
    src = src.replace(/^(?:[-*] .*(?:\n|$))+/gm, (m) => '<ul>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>');
    // 段落
    src = src.split(/\n{2,}/).map((b) => {
      const t = b.trim();
      if (!t) return '';
      return /^<(h2|h3|ul|ol|blockquote|pre|img)/.test(t) ? t : `<p>${t.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    return src.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  }

  /* ---------- 各 Tab ---------- */
  const views = {
    moment() {
      let mtype = 'daily'; // daily | movie | book
      let picked = null;   // { title, runtime, poster }
      $panel.innerHTML = `
        <div class="form-card">
          <h2>发一条瞬间</h2>
          <p class="sub">选类型可参与统计；电影/图书支持搜名字自动附图。</p>
          <div class="field"><label>类型</label>
            <div class="seg" id="m-type">
              <button type="button" data-v="daily" class="on">💬 日常</button>
              <button type="button" data-v="movie">🎬 电影</button>
              <button type="button" data-v="book">📚 图书</button>
            </div></div>
          <div class="field" id="m-search-wrap" hidden>
            <label id="m-search-label">搜索电影（TMDB）</label>
            <div style="display:flex;gap:8px">
              <input id="m-search" placeholder="输入片名 / 书名，回车搜索">
              <button type="button" class="btn ghost" id="m-go">搜索</button>
            </div>
            <div id="m-results"></div>
            <p class="tip" id="m-picked-tip">点选结果后自动附上海报，并记录片名与时长（用于统计）。</p>
          </div>
          <div class="field"><label>时间（默认现在；补记昨天 / 之前的观影，改这里就行）</label>
            <input id="m-date" type="datetime-local"></div>
          <div class="field"><label>内容</label><textarea id="m-text" placeholder="记录点什么…"></textarea></div>
          <div class="field"><label>图片（每行一个链接；也可以点下方按钮从本机选图，自动上传）</label>
            <textarea id="m-imgs" placeholder="https://img.example.com/file/xxxx&#10;photos/moments/20261029-abc123.jpg"></textarea>
            <div style="margin-top:8px"><button type="button" class="btn ghost" id="m-upload">📁 从本机添加图片（可多选）</button></div>
            <p class="tip">本机图片会自动压缩（最长边 2560px）后存入仓库 photos/moments/，图床图直接贴链接即可。</p></div>
          <button class="btn" id="m-submit">保存（先暂存）</button>
          <div class="status-line" id="m-status"></div>
        </div>`;
      // 时间输入默认现在
      {
        const d = new Date(), p = (n) => String(n).padStart(2, '0');
        document.getElementById('m-date').value =
          `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      }
      // 类型切换
      const seg = document.getElementById('m-type');
      const wrap = document.getElementById('m-search-wrap');
      const label = document.getElementById('m-search-label');
      const search = document.getElementById('m-search');
      seg.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          mtype = b.dataset.v;
          wrap.hidden = mtype === 'daily';
          label.textContent = mtype === 'movie' ? '搜索电影 / 剧集（TMDB）' : '搜索图书（Google Books）';
          picked = null;
          document.getElementById('m-results').innerHTML = '';
          document.getElementById('m-picked-tip').textContent = mtype === 'movie'
            ? '点选结果后自动附上海报，并记录片名与时长（用于统计）。'
            : '点选结果后自动附上封面并记录书名。';
        };
      });
      // 搜索（TMDB 影视 / Google Books 图书）
      const normTitle = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
      const recorded = {}; // 片名/书名 → 已有记录日期数组（查重提示：同名条目可能是二刷）
      MOMENTS.forEach((m) => { if (m.title) (recorded[normTitle(m.title)] = recorded[normTitle(m.title)] || []).push(String(m.date).slice(0, 10)); });
      const dupHint = (t) => {
        const ds = recorded[normTitle(t)];
        return ds && ds.length ? `<span class="tip" style="margin-left:6px">⚠️ 已记录 ${ds.length} 次（最近 ${ds[ds.length - 1]}）—— 是二刷可直接选</span>` : '';
      };
      const doSearch = async () => {
        const q = search.value.trim();
        if (!q) return;
        const box = document.getElementById('m-results');
        const st = document.getElementById('m-status');
        box.innerHTML = '<p class="tip">搜索中…</p>';
        try {
          if (mtype === 'movie') {
            const key = cfg.tmdbKey || window.TMDB_KEY || '';
            const r = await fetch(`${API_PROXY}/tmdb?q=${encodeURIComponent(q)}${key ? '&key=' + key : ''}`);
            if (!r.ok) throw new Error('TMDB 搜索失败: HTTP ' + r.status);
            const d = await r.json();
            const rows = (d.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 8);
            box.innerHTML = rows.map((x, i) => `
              <div class="mgmt-item" data-pick="${i}" style="cursor:pointer">
                ${x.poster_path ? `<img class="mgmt-thumb" src="https://image.tmdb.org/t/p/w92${x.poster_path}">` : '<span class="mgmt-thumb"></span>'}
                <span class="mi-text">${esc(x.title || x.name)}（${(x.release_date || x.first_air_date || '----').slice(0, 4)} · ${x.media_type === 'tv' ? '剧集' : '电影'} · ⭐ ${x.vote_average || '-'}）${dupHint(x.title || x.name)}</span>
              </div>`).join('') || '<p class="tip">没有结果，换个关键词试试</p>';
            box.querySelectorAll('[data-pick]').forEach((el) => {
              el.onclick = async () => {
                const x = rows[+el.dataset.pick];
                st.textContent = '正在获取时长…'; st.className = 'status-line';
                try {
                  const kind = x.media_type === 'tv' ? 'tv' : 'movie';
                  const det = await (await fetch(`${API_PROXY}/tmdb/detail?kind=${kind}&id=${x.id}${key ? '&key=' + key : ''}`)).json();
                  const runtime = kind === 'movie' ? (det.runtime || 0)
                    : Math.round((det.episode_run_time?.[0] || 45) * (det.number_of_episodes || 0));
                  picked = { title: det.title || det.name, runtime, poster: x.poster_path ? `https://image.tmdb.org/t/p/w500${x.poster_path}` : '' };
                  if (picked.poster && !document.getElementById('m-imgs').value.trim()) document.getElementById('m-imgs').value = picked.poster;
                  document.getElementById('m-picked-tip').textContent =
                    `✓ 已选：《${picked.title}》${runtime ? ' · ' + runtime + ' 分钟' : ''} —— 发布后计入统计`;
                  st.textContent = ''; st.className = 'status-line';
                } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; }
              };
            });
          } else {
            const r = await fetch(`${API_PROXY}/gbooks?q=${encodeURIComponent(q)}`);
            if (!r.ok) throw new Error('Google Books 搜索失败: HTTP ' + r.status);
            const d = await r.json();
            const rows = (d.items || []).filter((x) => x.volumeInfo && x.volumeInfo.title).slice(0, 8);
            box.innerHTML = rows.map((x, i) => {
              const v = x.volumeInfo;
              const thumb = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail) || '').replace(/^http:/, 'https:');
              return `
              <div class="mgmt-item" data-pick="${i}" style="cursor:pointer">
                ${thumb ? `<img class="mgmt-thumb" src="${esc(thumb)}">` : '<span class="mgmt-thumb"></span>'}
                <span class="mi-text">${esc(v.title)}${v.authors ? ' · ' + esc(v.authors.slice(0, 2).join('/')) : ''}${v.publishedDate ? '（' + esc(v.publishedDate.slice(0, 4)) + '）' : ''}${dupHint(v.title)}</span>
              </div>`;
            }).join('') || '<p class="tip">没有结果，换个关键词试试</p>';
            box.querySelectorAll('[data-pick]').forEach((el) => {
              el.onclick = () => {
                const v = rows[+el.dataset.pick].volumeInfo;
                const thumb = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail) || '').replace(/^http:/, 'https:');
                picked = { title: v.title, runtime: 0, poster: thumb };
                if (picked.poster && !document.getElementById('m-imgs').value.trim()) document.getElementById('m-imgs').value = picked.poster;
                document.getElementById('m-picked-tip').textContent = `✓ 已选：《${picked.title}》—— 发布后计入统计`;
              };
            });
          }
        } catch (e) { box.innerHTML = ''; st.textContent = '✗ ' + e.message; st.className = 'status-line err'; }
      };
      document.getElementById('m-go').onclick = doSearch;
      search.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };
      document.getElementById('m-upload').onclick = async () => {
        const files = await pickFiles({ multiple: true });
        if (!files.length) return;
        const ta = document.getElementById('m-imgs'), st = document.getElementById('m-status');
        try {
          for (const f of files) {
            const path = await uploadImage(f, 'moments', (m) => { st.textContent = m; st.className = 'status-line'; });
            ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + path;
          }
          st.textContent = `✓ 已上传 ${files.length} 张`; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
      document.getElementById('m-submit').onclick = async () => {
        const text = document.getElementById('m-text').value.trim();
        if (!text) return toast('先写点内容吧', 'err');
        const imgs = document.getElementById('m-imgs').value.split('\n').map((s) => s.trim()).filter(Boolean);
        let content = text.split('\n').map((l) => `<p style="">${esc(l)}</p>`).join('');
        if (imgs.length) content += `<div class="moment-imgs">${imgs.map((u) => `<img src="${esc(u)}">`).join('')}</div>`;
        const dv = document.getElementById('m-date').value;
        let dateStr = now();
        if (dv) {
          if (new Date(dv) > new Date(Date.now() + 60000)) return toast('时间不能选未来', 'err');
          const [da, ti] = dv.split('T');
          dateStr = `${da.replace(/-/g, '/')} ${ti}:00`;
        }
        const item = { date: dateStr, content, type: mtype };
        if (picked && mtype !== 'daily') {
          item.title = picked.title;
          if (picked.runtime) item.runtime = picked.runtime;
          if (picked.poster) item.poster = picked.poster;
        }
        if (item.title) {
          /* 查重是全历史的（不限当天）：同名即提醒，给出最早记录年份；确认后照样能存（二刷场景） */
          const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
          const dups = MOMENTS.filter((x) => norm(x.title) === norm(item.title));
          if (dups.length) {
            const dates = dups.map((x) => String(x.date).slice(0, 10)).sort();
            const yr = dates[0].slice(0, 4);
            const msg = dups.length === 1
              ? `《${item.title}》${yr} 年已有记录，是否再刷一遍？`
              : `《${item.title}》${yr} 年已有记录，共 ${dups.length} 条（最近 ${dates[dates.length - 1]}），是否再刷一遍？`;
            if (!confirm(msg)) return;
          }
        }
        const st = document.getElementById('m-status'); st.textContent = '正在暂存…'; st.className = 'status-line';
        const arr = [item, ...MOMENTS];
        try {
          await commit('MOMENTS', arr, '// 瞬间数据（由管理后台维护）', `瞬间[${mtype}]: ${text.slice(0, 30)}`);
          st.textContent = '✓ 已暂存，点右下「发布到线上」上线'; st.className = 'status-line ok';
          document.getElementById('m-text').value = ''; document.getElementById('m-imgs').value = '';
          picked = null;
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
    },

    post() {
      $panel.innerHTML = `
        <div class="form-card">
          <h2>发布文章</h2>
          <p class="sub">用 Markdown 写正文。</p>
          <div class="row2">
            <div class="field"><label>标题 *</label><input id="p-title"></div>
            <div class="field"><label>分类</label><input id="p-cat" placeholder="效率"></div>
          </div>
          <div class="row2">
            <div class="field"><label>标签（逗号分隔）</label><input id="p-tags" placeholder="工具,折腾"></div>
            <div class="field"><label>封面图（链接或本机上传）</label>
              <div style="display:flex;gap:8px">
                <input id="p-cover" placeholder="https://img.example.com/file/xxxx 或留空">
                <button type="button" class="btn ghost" id="p-cover-up" title="从本机选图">📁</button>
              </div></div>
          </div>
          <div class="field"><label>正文（Markdown）</label><textarea id="p-body" class="md" placeholder="# 标题&#10;&#10;正文…&#10;&#10;\`\`\`代码块\`\`\`"></textarea>
            <div style="margin-top:8px"><button type="button" class="btn ghost" id="p-body-up">🖼️ 插入本机图片到正文</button></div>
          </div>
          <button class="btn" id="p-submit">保存（先暂存）</button>
          <div class="status-line" id="p-status"></div>
        </div>`;
      document.getElementById('p-cover-up').onclick = async () => {
        const [f] = await pickFiles();
        if (!f) return;
        const st = document.getElementById('p-status');
        try {
          const path = await uploadImage(f, 'covers', (m) => { st.textContent = m; st.className = 'status-line'; });
          document.getElementById('p-cover').value = path;
          st.textContent = '✓ 封面已上传'; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
      document.getElementById('p-body-up').onclick = async () => {
        const files = await pickFiles({ multiple: true });
        if (!files.length) return;
        const ta = document.getElementById('p-body'), st = document.getElementById('p-status');
        try {
          for (const f of files) {
            const path = await uploadImage(f, 'posts', (m) => { st.textContent = m; st.className = 'status-line'; });
            const pos = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
            ta.value = ta.value.slice(0, pos) + `![](${path})\n` + ta.value.slice(pos);
            ta.selectionStart = ta.selectionEnd = pos + `![](${path})\n`.length;
          }
          ta.focus();
          st.textContent = `✓ 已插入 ${files.length} 张`; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
      document.getElementById('p-submit').onclick = async () => {
        const title = document.getElementById('p-title').value.trim();
        const body = document.getElementById('p-body').value;
        if (!title || !body.trim()) return toast('标题和正文不能为空', 'err');
        const cat = document.getElementById('p-cat').value.trim() || '未分类';
        const tags = document.getElementById('p-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        const cover = document.getElementById('p-cover').value.trim();
        const slug = String(Date.now());
        const post = {
          slug, title, date: today(),
          categories: [{ name: cat, slug: 'cat-' + encodeURIComponent(cat) }],
          tags, cover, excerpt: body.replace(/[#>*`!\[\]\(\)]/g, '').trim().slice(0, 80),
          content: md(body), raw: body,
        };
        const st = document.getElementById('p-status'); st.textContent = '正在暂存…'; st.className = 'status-line';
        try {
          await commit('POSTS', [post, ...POSTS], '// 文章数据（由管理后台维护）', `文章: ${title}`);
          st.textContent = '✓ 已暂存，点右下「发布到线上」上线'; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
    },

    photo() {
      let pending = []; // 本机已上传、待随本批一起入墙的相对路径
      const renderPending = () => {
        const box = document.getElementById('g-pending');
        if (!box) return;
        box.innerHTML = pending.length
          ? `<p class="tip">已选 ${pending.length} 张本机图片（点「添加」时一并入墙）</p>` + pending.map((p, i) => `
            <div class="mgmt-item"><span class="mi-date">本机</span><span class="mi-text">${esc(p.split('/').pop())}</span><button class="btn danger" data-rm="${i}">移除</button></div>`).join('')
          : '';
        box.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { pending.splice(+b.dataset.rm, 1); renderPending(); }; });
      };
      $panel.innerHTML = `
        <div class="form-card">
          <h2>添加图片到图片墙</h2>
          <p class="sub">支持批量：图床链接一次贴多行，本机一次多选，两类可以混用。</p>
          <div class="field"><label>图床链接（每行一个）</label>
            <textarea id="g-srcs" placeholder="https://img.example.com/file/xxxx&#10;https://…"></textarea></div>
          <div class="field"><label>或从本机上传（可多选）</label>
            <button type="button" class="btn ghost" id="g-up">📁 选择图片（按住 Ctrl 可多选）</button>
            <div id="g-pending"></div>
            <p class="tip">本机图片自动压缩并存入仓库 photos/gallery/，逐张显示上传进度。</p></div>
          <div class="row2">
            <div class="field"><label>说明（本批共用）</label><input id="g-note" placeholder="随拍"></div>
            <div class="field"><label>日期</label><input id="g-date" type="date" value="${today()}"></div>
          </div>
          <button class="btn" id="g-submit">添加</button>
          <div class="status-line" id="g-status"></div>
        </div>`;
      document.getElementById('g-up').onclick = async () => {
        const files = await pickFiles({ multiple: true });
        if (!files.length) return;
        const st = document.getElementById('g-status');
        try {
          for (let i = 0; i < files.length; i++) {
            st.textContent = `正在压缩/上传 ${i + 1}/${files.length}：${files[i].name}`; st.className = 'status-line';
            pending.push(await uploadImage(files[i], 'gallery'));
            renderPending();
          }
          st.textContent = `✓ ${files.length} 张已上传，点「添加」入墙`; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
      document.getElementById('g-submit').onclick = async () => {
        const st = document.getElementById('g-status');
        const note = document.getElementById('g-note').value.trim();
        const links = document.getElementById('g-srcs').value.split('\n').map((s) => s.trim()).filter(Boolean);
        const items = [...pending.map((p) => ({ src: p })), ...links.map((s) => ({ src: s }))]
          .map((it) => ({ ...it, note, date: document.getElementById('g-date').value }));
        if (!items.length) return toast('请先填链接或上传图片', 'err');
        st.textContent = `正在暂存 ${items.length} 张…`; st.className = 'status-line';
        try {
          await commit('PHOTO_WALL', [...items, ...PHOTO_WALL], '// 图片墙清单（由管理后台维护）', `图片墙: +${items.length} 张${note ? '（' + note + '）' : ''}`);
          st.textContent = `✓ 已暂存 ${items.length} 张，点「发布到线上」上线`; st.className = 'status-line ok';
          document.getElementById('g-srcs').value = '';
          pending = []; renderPending();
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
    },

    links() {
      const render = () => {
        $panel.innerHTML = `
        <div class="form-card">
          <h2>添加朋友圈</h2>
          <p class="sub">朋友的个人站/博客，卡片会显示在前台「朋友圈」页；不传头像时自动用站名首字生成色块。</p>
          <div class="row2">
            <div class="field"><label>站名 *</label><input id="f-name" placeholder="我的小站"></div>
            <div class="field"><label>网址 *</label><input id="f-url" placeholder="https://example.pages.dev"></div>
          </div>
          <div class="field"><label>一句话介绍</label><input id="f-desc" placeholder="折腾、记录、生活"></div>
          <div class="field"><label>头像（链接或本机上传，可省略）</label>
            <div style="display:flex;gap:8px">
              <input id="f-avatar" placeholder="https://…/avatar.jpg">
              <button type="button" class="btn ghost" id="f-up">📁</button>
            </div></div>
          <button class="btn" id="f-submit">保存（先暂存）</button>
          <div class="status-line" id="f-status"></div>
        </div>
        <div class="form-card">
          <h2>已有朋友圈（${FRIEND_LINKS.length} 个）</h2>
          ${FRIEND_LINKS.map((f, i) => `
            <div class="mgmt-item">
              <span class="mi-text"><b>${esc(f.name)}</b> — ${esc(f.url)}</span>
              <button class="btn danger" data-fdel="${i}">删除</button>
            </div>`).join('') || '<p class="empty-tip">暂无朋友圈</p>'}
        </div>`;
        document.getElementById('f-up').onclick = async () => {
          const [f] = await pickFiles();
          if (!f) return;
          const st = document.getElementById('f-status');
          try {
            const path = await uploadImage(f, 'links', (m) => { st.textContent = m; st.className = 'status-line'; });
            document.getElementById('f-avatar').value = path;
            st.textContent = '✓ 已上传'; st.className = 'status-line ok';
          } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; }
        };
        document.getElementById('f-submit').onclick = async () => {
          const name = document.getElementById('f-name').value.trim();
          let url = document.getElementById('f-url').value.trim();
          if (!name || !url) return toast('站名和网址必填', 'err');
          if (!/^https?:\/\//.test(url)) url = 'https://' + url;
          const item = {
            name, url,
            desc: document.getElementById('f-desc').value.trim(),
            avatar: document.getElementById('f-avatar').value.trim(),
          };
          const st = document.getElementById('f-status'); st.textContent = '正在暂存…'; st.className = 'status-line';
          try {
            await commit('FRIEND_LINKS', [...FRIEND_LINKS, item], '// 友链数据（由管理后台维护）', `友链: ${name}`);
            st.textContent = '✓ 已添加'; st.className = 'status-line ok';
            render();
          } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
        };
        $panel.querySelectorAll('[data-fdel]').forEach((btn) => {
          btn.onclick = async () => {
            if (!confirm('确定删除这个朋友圈站点吗？')) return;
            const arr = FRIEND_LINKS.filter((_, i) => i !== +btn.dataset.fdel);
            try { await commit('FRIEND_LINKS', arr, '// 友链数据（由管理后台维护）', '删除友链'); render(); }
            catch (e) { toast(e.message, 'err'); }
          };
        });
      };
      render();
    },

    /* ---------- 待办清单管理（data/todos.js；前台待办页共用同一份数据） ---------- */
    todos() {
      const todos = window.TODOS || [];
      const pending = todos.filter((t) => !t.done && !t.dropped);
      const doneNotes = todos.filter((t) => t.done && t.kind === 'note');
      const doneRecs = todos.filter((t) => t.done && t.kind !== 'note');
      const dropped = todos.filter((t) => t.dropped);
      const ICON = { movie: '🎬', tv: '📺', book: '📚', note: '✍️' };
      const NAME = { movie: '电影', tv: '剧集', book: '图书', note: '日常' };
      const row = (t) => `
        <div class="mgmt-item">
          ${t.poster ? `<img class="mgmt-thumb" src="${esc(t.poster)}" loading="lazy" onerror="this.style.display='none'">` : ''}
          <span class="mi-date">${ICON[t.kind] || '•'} ${NAME[t.kind] || t.kind}</span>
          <span class="mi-text"${t.dropped ? ' style="text-decoration:line-through;opacity:.6"' : ''}>${t.title ? esc(t.title) : esc(t.note || '')}${t.title && t.note ? ' <small>— ' + esc(t.note.slice(0, 40)) + '</small>' : ''}${t.runtime ? `（${t.runtime} 分钟）` : ''}</span>
          ${t.dropped
            ? `<span class="mi-date">⊘ 废弃于 ${esc(String(t.droppedAt || '').slice(0, 10))}</span><button class="btn ghost" data-tdrop="${t.id}" data-back="1">恢复</button>`
            : t.done
            ? `<span class="mi-date">✓ ${esc(String(t.doneAt || ''))}</span><button class="btn ghost" data-tdone="${t.id}" data-back="1">撤销</button>`
            : `<button class="btn" data-tdone="${t.id}">✓ 完成</button><button class="btn ghost" data-tdrop="${t.id}">⊘ 废弃</button>`}
        </div>`;
      $panel.innerHTML = `
        <div class="form-card">
          <h2>➕ 添加待办</h2>
          <p class="sub">影视/图书输入名字搜索自动带海报和时长；日常直接写内容。完成后：电影/图书自动记入瞬间（完成日期=观看日期），日常只在此标记完成。计划没发生（改看了别的/不想看了）→ 点「废弃」留档，不删除不出瞬间，可随时恢复。</p>
          <div class="seg" id="td-type">
            <button type="button" data-v="movie" class="on">🎬 看片</button>
            <button type="button" data-v="tv">📺 追剧</button>
            <button type="button" data-v="book">📚 读书</button>
            <button type="button" data-v="note">✍️ 日常</button>
          </div>
          <div id="td-search-wrap" style="margin-top:10px">
            <div style="display:flex;gap:8px">
              <input id="td-search" placeholder="输入片名 / 书名，回车搜索" style="flex:1">
              <button type="button" class="btn ghost" id="td-go">搜索</button>
            </div>
            <div id="td-results"></div>
          </div>
          <div id="td-note-wrap" hidden>
            <div class="field"><label>日常内容</label><textarea id="td-note" placeholder="要做什么…"></textarea></div>
            <button class="btn" id="td-note-add">加入待办</button>
          </div>
          <div class="status-line" id="td-status"></div>
        </div>
        <div class="form-card">
          <h2>📋 待办（${pending.length}）</h2>
          ${pending.map(row).join('') || '<p class="empty-tip">清单是空的</p>'}
        </div>
        <div class="form-card">
          <h2>✅ 已完成 · 日常（${doneNotes.length}）</h2>
          ${doneNotes.map(row).join('') || '<p class="empty-tip">还没有完成的日常</p>'}
        </div>
        ${doneRecs.length ? `
        <div class="form-card">
          <h2><button type="button" class="btn ghost" id="td-recs-toggle">${viewState.todosShowDone ? '收起' : '展开'}</button> 已完成 · 影视/图书（${doneRecs.length}，已记入瞬间，默认隐藏）</h2>
          ${viewState.todosShowDone ? doneRecs.map(row).join('') : ''}
        </div>` : ''}
        ${dropped.length ? `
        <div class="form-card">
          <h2>⊘ 已废弃（${dropped.length}，计划没发生，留档可恢复）</h2>
          ${dropped.map(row).join('')}
        </div>` : ''}`;

      let tdKind = 'movie';
      const seg = document.getElementById('td-type');
      seg.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          tdKind = b.dataset.v;
          document.getElementById('td-search-wrap').hidden = tdKind === 'note';
          document.getElementById('td-note-wrap').hidden = tdKind !== 'note';
        };
      });
      const tdSay = (t, ok) => { const s = document.getElementById('td-status'); s.textContent = t; s.className = 'status-line ' + (ok ? 'ok' : 'err'); };

      /* 搜索走 worker 中转（与发瞬间同一代理），结果里标注已记录过的条目 */
      const normTitle = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
      const recorded = {};
      MOMENTS.forEach((m) => { if (m.title) (recorded[normTitle(m.title)] = recorded[normTitle(m.title)] || []).push(String(m.date).slice(0, 10)); });
      const dupBadge = (t) => {
        const ds = recorded[normTitle(t)];
        return ds ? ` <small style="color:#b45309">⚠️ 已记录 ${ds.length} 次（最近 ${ds.sort().slice(-1)[0]}）</small>` : '';
      };
      const addTodo = (t) => {
        const arr = [{ id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ...t, createdAt: now(), done: false, doneAt: null }, ...(window.TODOS || [])];
        commitTodos(arr, `待办 +：${t.title || (t.note || '').slice(0, 20)}`).then(() => {
          tdSay('✓ 已暂存，点右下「发布到线上」生效', true);
          views.todos();
        }).catch((e) => tdSay('✗ ' + e.message));
      };
      const doSearch = async () => {
        const q = document.getElementById('td-search').value.trim();
        const box = document.getElementById('td-results');
        if (!q || tdKind === 'note') return;
        box.innerHTML = '<p class="tip">搜索中…</p>';
        try {
          if (tdKind === 'book') {
            const r = await fetch(`${API_PROXY}/gbooks?q=${encodeURIComponent(q)}`);
            if (!r.ok) throw new Error('图书搜索失败: HTTP ' + r.status);
            const d = await r.json();
            const items = (d.items || []).slice(0, 8);
            box.innerHTML = items.length ? items.map((v, i) => `
              <div class="mgmt-item" style="cursor:pointer" data-tbook="${i}">
                <span class="mi-text">📚 ${esc(v.volumeInfo.title)}${v.volumeInfo.authors ? ' · ' + esc(v.volumeInfo.authors.slice(0, 2).join('/')) : ''}${dupBadge(v.volumeInfo.title)}</span>
              </div>`).join('') : '<p class="tip">没有找到，试试别的关键词</p>';
            box.querySelectorAll('[data-tbook]').forEach((el) => {
              el.onclick = () => {
                const v = items[+el.dataset.tbook];
                addTodo({ kind: 'book', title: v.volumeInfo.title, note: (v.volumeInfo.description || '').slice(0, 120), poster: (v.volumeInfo.imageLinks || {}).thumbnail || '', runtime: 0 });
              };
            });
          } else {
            const r = await fetch(`${API_PROXY}/tmdb?q=${encodeURIComponent(q)}`);
            if (!r.ok) throw new Error('影视搜索失败: HTTP ' + r.status);
            const d = await r.json();
            const items = (d.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 8);
            box.innerHTML = items.length ? items.map((x, i) => `
              <div class="mgmt-item" style="cursor:pointer" data-ttmdb="${i}">
                <span class="mi-text">${x.media_type === 'tv' ? '📺' : '🎬'} ${esc(x.title || x.name)}（${(x.release_date || x.first_air_date || '----').slice(0, 4)} · ⭐ ${x.vote_average || '-'}）${dupBadge(x.title || x.name)}</span>
              </div>`).join('') : '<p class="tip">没有找到，试试英文原名</p>';
            box.querySelectorAll('[data-ttmdb]').forEach((el) => {
              el.onclick = async () => {
                const x = items[+el.dataset.ttmdb];
                try {
                  const det = await (await fetch(`${API_PROXY}/tmdb/detail?kind=${x.media_type}&id=${x.id}`)).json();
                  addTodo({ kind: x.media_type, title: det.title || det.name || x.title || x.name, note: (det.tagline || '').slice(0, 120), poster: det.poster_path ? 'https://image.tmdb.org/t/p/w500' + det.poster_path : '', runtime: det.runtime || (det.episode_run_time && det.episode_run_time[0]) || 0, tmdbId: x.id });
                } catch (e) { tdSay('✗ ' + e.message); }
              };
            });
          }
        } catch (e) { box.innerHTML = ''; tdSay('✗ ' + e.message); }
      };
      document.getElementById('td-go').onclick = doSearch;
      document.getElementById('td-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
      document.getElementById('td-note-add').onclick = () => {
        const v = document.getElementById('td-note').value.trim();
        if (!v) return tdSay('先写点内容');
        addTodo({ kind: 'note', title: '', note: v });
      };

      /* 完成：电影/图书 → 弹日期确认（默认今天）→ 生成完整瞬间；日常 → 只标记完成 */
      const completeTodo = async (t, back) => {
        if (!t) return;
        if (back) {
          await commitTodos((window.TODOS || []).map((x) => (x.id === t.id ? { ...x, done: false, doneAt: null } : x)), '待办撤销：' + (t.title || '日常'));
          views.todos();
          return;
        }
        const label = t.title || (t.note || '').slice(0, 30);
        const d = prompt(`完成「${label}」的日期（YYYY-MM-DD，确定=今天）`, today());
        if (d === null) return;
        const date = (d.trim() || today());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日期格式应为 YYYY-MM-DD', 'err');
        if (t.kind !== 'note') {
          const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
          const dups = MOMENTS.filter((x) => norm(x.title) === norm(t.title));
          if (dups.length && !confirm(`《${t.title}》${String(dups[0].date).slice(0, 4)} 年已有记录，是否再刷一遍？`)) return;
          const item = { date: date.replace(/-/g, '/') + ' 12:00:00', content: '', type: t.kind === 'book' ? 'book' : 'movie' };
          item.title = t.title;
          if (t.runtime) item.runtime = t.runtime;
          if (t.poster) { item.poster = t.poster; item.content = `<div class="moment-imgs"><img src="${esc(t.poster)}" loading="lazy"></div>`; }
          if (t.kind === 'tv') item.kind = 'tv';
          if (t.tmdbId) item.tmdbId = t.tmdbId;
          await commitMoments([item, ...window.MOMENTS], `待办完成 → 瞬间：${t.title}（${date}）`);
        }
        await commitTodos((window.TODOS || []).map((x) => (x.id === t.id ? { ...x, done: true, doneAt: date } : x)), '待办完成：' + label);
        toast(t.kind === 'note' ? '已暂存：完成日常' : `已暂存：《${t.title}》记入瞬间（${date}）。点右下「发布到线上」生效`, 'ok');
        views.todos();
      };
      $panel.querySelectorAll('[data-tdone]').forEach((b) => {
        b.onclick = () => completeTodo((window.TODOS || []).find((x) => x.id === b.dataset.tdone), b.dataset.back);
      });
      /* 废弃：计划没发生（改看了别的/不看了），留档不删除；恢复=取消废弃标记 */
      $panel.querySelectorAll('[data-tdrop]').forEach((b) => {
        b.onclick = async () => {
          const t = (window.TODOS || []).find((x) => x.id === b.dataset.tdrop);
          if (!t) return;
          const label = t.title || (t.note || '').slice(0, 20);
          if (b.dataset.back) {
            await commitTodos((window.TODOS || []).map((x) => (x.id === t.id ? { ...x, dropped: false, droppedAt: null } : x)), '待办恢复：' + label);
            toast('已暂存：恢复未完成', 'ok');
          } else {
            await commitTodos((window.TODOS || []).map((x) => (x.id === t.id ? { ...x, dropped: true, droppedAt: now(), done: false, doneAt: null } : x)), '待办废弃：' + label);
            toast('已暂存：废弃「' + label + '」（不出瞬间，留档）', 'ok');
          }
          views.todos();
        };
      });
      const recToggle = document.getElementById('td-recs-toggle');
      if (recToggle) recToggle.onclick = () => { viewState.todosShowDone = !viewState.todosShowDone; views.todos(); };
    },

    manage() {
      const mk = (label, arr, varName, canEdit) => {
        const expanded = viewState.manageAll[varName];
        /* 未记日期筛选：这就是"待办清单"——逐年补上真实观看日期，补完的条目自动归入对应年份 */
        const undatedN = varName === 'MOMENTS' ? arr.filter((m) => m.undated).length : 0;
        const filtering = varName === 'MOMENTS' && viewState.manageUndated;
        const list = arr.map((m, i) => [m, i]).filter(([m]) => !filtering || m.undated);
        const shown = expanded ? list : list.slice(0, 15);
        return `
        <div class="form-card">
          <h2>${label}（共 ${list.length} 条）${varName === 'MOMENTS' && undatedN ? `<button type="button" class="btn ghost" data-undated style="margin-left:10px">${filtering ? '✓ 只看未记日期（再点恢复）' : '📋 待办：未记日期 ' + undatedN + ' 条'}</button>` : ''}</h2>
          <p class="sub">修改/删除先存进暂存区，点右下「发布到线上」时合并成 1 个提交、只部署 1 次；删除本机上传的图会连同仓库里的图片文件一起删掉。${varName === 'POSTS' ? '后台发布的文章可按 Markdown 编辑。' : ''}${varName === 'MOMENTS' && undatedN ? '未记日期的条目点「编辑」补上真实观看日期即可。' : ''}</p>
          ${shown.map(([m, oi]) => `
            <div class="mgmt-item">
              ${varName === 'PHOTO_WALL' ? `<img class="mgmt-thumb" src="${esc(m.src)}" loading="lazy" onerror="this.style.display='none'">` : ''}
              <span class="mi-date">${esc(m.undated ? '（未记日期）' : m.date)}</span>
              <span class="mi-text">${varName === 'POSTS' ? esc(m.title || '（无标题）') : `${m.type === 'movie' ? '🎬 ' : m.type === 'book' ? '📚 ' : ''}${esc((m.content || m.excerpt || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 60)) || esc(m.title || m.note || m.src || '')}`}</span>
              ${canEdit ? `<button class="btn ghost" data-edit="${varName}" data-idx="${oi}">编辑</button>` : ''}
              ${(varName === 'POSTS' || varName === 'PHOTO_WALL') ? `<button class="btn ghost" data-pin="${varName}" data-idx="${oi}"${oi === 0 ? ' disabled title="已经在最前"' : ' title="移到最前（新内容发布后会自然退到后面）"'}>顶</button>` : ''}
              <button class="btn danger" data-del="${varName}" data-idx="${oi}">删除</button>
            </div>`).join('') || '<p class="empty-tip">暂无内容</p>'}
          ${list.length > 15 ? `<button class="btn ghost" data-more="${varName}" style="margin-top:10px">${expanded ? '收起，只显示最近 15 条' : `显示全部 ${list.length} 条`}</button>` : ''}
        </div>`;
      };
      const show = (v) => (viewState.manageTab || 'ALL') === 'ALL' || (viewState.manageTab || 'ALL') === v;
      $panel.innerHTML = `
        <div class="seg" style="display:flex;margin-bottom:4px">
          ${[['ALL', '全部'], ['MOMENTS', '瞬间'], ['POSTS', '文章'], ['PHOTO_WALL', '图片墙']].map(([v, l]) =>
            `<button type="button" data-mtab="${v}" class="${(viewState.manageTab || 'ALL') === v ? 'on' : ''}">${l}</button>`).join('')}
        </div>`
        + (show('MOMENTS') ? mk('瞬间', MOMENTS, 'MOMENTS', true) : '')
        + (show('POSTS') ? mk('文章', POSTS, 'POSTS', true) : '')
        + (show('PHOTO_WALL') ? mk('图片墙', PHOTO_WALL, 'PHOTO_WALL', false) : '');
      $panel.querySelectorAll('[data-mtab]').forEach((b) => {
        b.onclick = () => { viewState.manageTab = b.dataset.mtab; views.manage(); };
      });
      $panel.querySelectorAll('[data-undated]').forEach((b) => {
        b.onclick = () => { viewState.manageUndated = !viewState.manageUndated; views.manage(); };
      });
      $panel.querySelectorAll('[data-more]').forEach((b) => {
        b.onclick = () => { viewState.manageAll[b.dataset.more] = !viewState.manageAll[b.dataset.more]; views.manage(); };
      });
      $panel.querySelectorAll('[data-pin]').forEach((btn) => {
        btn.onclick = async () => {
          const v = btn.dataset.pin, idx = +btn.dataset.idx;
          const arr = { POSTS, PHOTO_WALL }[v] || [];
          const item = arr[idx];
          if (!item || idx === 0) return;
          const next = [item, ...arr.filter((_, i) => i !== idx)];
          const kind = v === 'POSTS' ? '文章' : '图片';
          try {
            await commit(v, next, '// 由管理后台维护', `置顶一条${kind}：${String(item.title || item.src || '').slice(0, 40)}`);
            toast(`已置顶到最前（在暂存区）；点右下「发布到线上」前台才会变化`, 'ok');
            views.manage();
          } catch (e) { toast('置顶失败：' + e.message, 'err'); }
        };
      });
      $panel.querySelectorAll('[data-del]').forEach((btn) => {
        btn.onclick = async () => {
          const v = btn.dataset.del, idx = +btn.dataset.idx;
          const map = { MOMENTS, POSTS, PHOTO_WALL };
          const item = map[v][idx];
          // 收集该条目引用的仓库内图片文件（图墙的 src / 瞬间正文里的 photos/ 图片），删除条目时一并清理
          const contentPaths = [...new Set((String(item && item.content || '').match(/(?:src|href)="(photos\/[^"]+)"/g) || []).map((s) => s.replace(/^.*="/, '').replace(/"$/, '')))];
          const fileList = [...new Set([...(item && item.src && item.src.startsWith('photos/') ? [item.src] : []), ...contentPaths])];
          const kind = v === 'MOMENTS' ? '瞬间' : v === 'POSTS' ? '文章' : '图片';
          const extra = fileList.length ? `\n\n同时会删除仓库里的图片文件：\n${fileList.join('\n')}` : '';
          if (!confirm(`确定删除这条${kind}吗？删除会直接提交到仓库。${extra}`)) return;
          const arr = map[v].filter((_, i) => i !== idx);
          try {
            await commit(v, arr, `// 由管理后台维护`, `删除一条${kind}`);
            if (v === 'POSTS' && item.slug) {
              try { await ghDelete(contentPath(item.slug), `删除正文 ${item.slug}`); }
              catch (e) { toast(`文章已删除，但正文文件清理失败：${e.message}`, 'err'); }
            }
            for (const f of fileList) {
              try { await ghDelete(f, `删除图片文件 ${f}`); }
              catch (e) { toast(`${kind}已删除，但图片文件 ${f} 清理失败：${e.message}`, 'err'); }
            }
            views.manage();
          }
          catch (e) { toast(e.message, 'err'); }
        };
      });
      $panel.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.onclick = () => {
          const v = btn.dataset.edit, idx = +btn.dataset.idx;
          if (v === 'MOMENTS') views.editMoment(idx); else views.editPost(idx);
        };
      });
    },

    /* ---------- 编辑瞬间 ---------- */
    editMoment(i) {
      const m = MOMENTS[i];
      if (!m) return views.manage();
      // 把已发布的 HTML 拆回 文字 + 图片链接（文字一律提取纯文本，块级标签转为换行，避免 HTML 被二次转义）
      const tmp = document.createElement('div');
      tmp.innerHTML = m.content;
      const imgs = [...tmp.querySelectorAll('img')].map((im) => im.getAttribute('src'));
      const raw = tmp.innerHTML
        .replace(/<img[^>]*>/g, '')
        .replace(/<div class="moment-imgs">[\s\S]*?<\/div>/g, '')
        .replace(/<br[^>]*>/gi, '\n')
        .replace(/<\/(p|div|figure|figcaption|h[1-6]|li|blockquote)>/gi, '\n');
      const probe = document.createElement('textarea');
      probe.innerHTML = raw;
      const text = probe.value.replace(/<[^>]+>/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      $panel.innerHTML = `
        <div class="form-card">
          <h2>编辑瞬间 <small style="color:var(--text-sub);font-weight:400">· ${esc(m.date)}（发布时间保持不变）</small></h2>
          <div class="field"><label>类型</label>
            <div class="seg" id="e-type">
              <button type="button" data-v="daily" class="${m.type !== 'movie' && m.type !== 'book' ? 'on' : ''}">💬 日常</button>
              <button type="button" data-v="movie" class="${m.type === 'movie' ? 'on' : ''}">🎬 电影</button>
              <button type="button" data-v="book" class="${m.type === 'book' ? 'on' : ''}">📚 图书</button>
            </div></div>
          <div class="field"><label>观看日期${m.undated ? '（本条未记录日期 —— 补上真实日期后会归入对应年份并计入观影统计）' : '（一般不用改；改了会移动到对应年份）'}</label>
            <input id="e-date" type="date" value="${m.undated ? '' : esc(String(m.date).slice(0, 10).replace(/\//g, '-'))}"></div>
          <div class="field"><label>片名（电影/图书，选填）</label>
            <input id="e-title" value="${esc(m.title || '')}" placeholder="如：让子弹飞 —— 保存时自动查询时长与海报">
            <p class="tip">${m.title ? `已记录：《${esc(m.title)}》${m.runtime ? ' · ' + m.runtime + ' 分钟' : ''}` : '填写片名后保存，会自动匹配 TMDB 第一条结果获取时长；匹配错了可改片名重新保存。'}</p></div>
          <div class="field"><label>内容</label><textarea id="e-text">${esc(text)}</textarea></div>
          <div class="field"><label>图片（每行一个链接，可增删）</label><textarea id="e-imgs">${esc(imgs.join('\n'))}</textarea></div>
          <button class="btn" id="e-save">保存修改</button>
          <button class="btn ghost" id="e-back">← 返回管理</button>
          <div class="status-line" id="e-status"></div>
        </div>`;
      let etype = m.type || 'daily';
      document.querySelectorAll('#e-type button').forEach((b) => {
        b.onclick = () => {
          document.querySelectorAll('#e-type button').forEach((x) => x.classList.toggle('on', x === b));
          etype = b.dataset.v;
        };
      });
      document.getElementById('e-back').onclick = () => views.manage();
      // TMDB 自动查询：片名 → 时长 + 海报（取搜索第一条结果）
      const lookupTmdb = async (q) => {
        const key = cfg.tmdbKey || window.TMDB_KEY || '';
        const r = await fetch(`${API_PROXY}/tmdb?q=${encodeURIComponent(q)}${key ? '&key=' + key : ''}`);
        if (!r.ok) throw new Error('TMDB 搜索失败: HTTP ' + r.status);
        const d = await r.json();
        const x = (d.results || []).find((v) => v.media_type === 'movie' || v.media_type === 'tv');
        if (!x) return null;
        const kind = x.media_type === 'tv' ? 'tv' : 'movie';
        const det = await (await fetch(`${API_PROXY}/tmdb/detail?kind=${kind}&id=${x.id}${key ? '&key=' + key : ''}`)).json();
        const runtime = kind === 'movie' ? (det.runtime || 0)
          : Math.round((det.episode_run_time?.[0] || 45) * (det.number_of_episodes || 0));
        return { title: det.title || det.name, runtime, poster: x.poster_path ? `https://image.tmdb.org/t/p/w500${x.poster_path}` : '' };
      };
      document.getElementById('e-save').onclick = async () => {
        const text2 = document.getElementById('e-text').value.trim();
        if (!text2) return toast('内容不能为空', 'err');
        const title2 = document.getElementById('e-title').value.trim();
        let meta = { title: m.title || '', runtime: m.runtime || 0, poster: m.poster || '' };
        const st = document.getElementById('e-status');
        // 片名有变化或还没有时长时，电影类型自动查 TMDB
        if (title2 && etype === 'movie' && (title2 !== (m.title || '') || !m.runtime)) {
          st.textContent = '正在查询 TMDB（片名 → 时长/海报）…'; st.className = 'status-line';
          try {
            const hit = await lookupTmdb(title2);
            if (hit && hit.nokey) { toast('未配置 TMDB Key，仅保存片名（无时长）', 'err'); }
            else if (hit) {
              meta = hit;
              toast(`✓ 匹配：《${hit.title}》${hit.runtime ? ' · ' + hit.runtime + ' 分钟' : ''}`);
            } else { toast('TMDB 没搜到这部，仅保存片名', 'err'); }
          } catch (e) { toast('TMDB 查询失败，仅保存片名：' + e.message, 'err'); }
        }
        const imgs2 = document.getElementById('e-imgs').value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (meta.poster && !imgs2.length) imgs2.push(meta.poster); // 原本没图时把海报补为配图
        const dv = document.getElementById('e-date').value; // 补/改日期：YYYY-MM-DD（空=保持不变）
        let content = text2.split('\n').map((l) => `<p style="">${esc(l)}</p>`).join('');
        if (imgs2.length) content += `<div class="moment-imgs">${imgs2.map((u) => `<img src="${esc(u)}">`).join('')}</div>`;
        const arr = MOMENTS.map((x, j) => {
          if (j !== i) return x;
          const up = { date: x.date, content, type: etype };
          if (x.undated) up.undated = true;
          if (dv && dv !== String(x.date).slice(0, 10).replace(/\//g, '-')) {
            up.date = dv.replace(/-/g, '/') + ' 12:00:00';
            delete up.undated; // 有了真实日期就不再是"未记日期"
          }
          if (title2) { up.title = title2; if (meta.runtime) up.runtime = meta.runtime; if (meta.poster) up.poster = meta.poster; }
          return up;
        });
        st.textContent = '正在暂存…'; st.className = 'status-line';
        try {
          await commit('MOMENTS', arr, '// 瞬间数据（由管理后台维护）', `编辑瞬间 ${m.date}`);
          st.textContent = '✓ 已暂存，点右下「发布到线上」上线'; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
    },

    /* ---------- 编辑文章（正文按 slug 从 data/content/ 拉取） ---------- */
    async loadPostIntoMemory(p) {
      const obj = await ensurePostContent(p.slug);
      if (obj) { p.content = obj.content; if (obj.raw !== undefined) p.raw = obj.raw; }
      return p;
    },
    editPost(i) {
      const p = POSTS[i];
      if (!p) return views.manage();
      views.loadPostIntoMemory(p)
        .then(() => views.editPostForm(i))
        .catch((e) => toast('正文加载失败：' + e.message, 'err'));
    },
    editPostForm(i) {
      const p = POSTS[i];
      if (!p) return views.manage();
      const isMd = !!p.raw;
      const body = isMd ? p.raw : p.content;
      $panel.innerHTML = `
        <div class="form-card">
          <h2>编辑文章 <small style="color:var(--text-sub);font-weight:400">· ${esc(p.date)}（链接与日期保持不变）</small></h2>
          <div class="row2">
            <div class="field"><label>标题</label><input id="ep-title" value="${esc(p.title)}"></div>
            <div class="field"><label>分类</label><input id="ep-cat" value="${esc((p.categories[0] || {}).name || '')}"></div>
          </div>
          <div class="row2">
            <div class="field"><label>标签（逗号分隔）</label><input id="ep-tags" value="${esc((p.tags || []).join(','))}"></div>
            <div class="field"><label>封面图</label><input id="ep-cover" value="${esc(p.cover || '')}"></div>
          </div>
          <div class="field"><label>正文（${isMd ? 'Markdown' : 'HTML 源码 —— 该篇由旧站导入'}）</label>
            <textarea id="ep-body" class="md">${esc(body)}</textarea></div>
          <button class="btn" id="ep-save">保存修改</button>
          <button class="btn ghost" id="ep-back">← 返回管理</button>
          <div class="status-line" id="ep-status"></div>
        </div>`;
      document.getElementById('ep-back').onclick = () => views.manage();
      document.getElementById('ep-save').onclick = async () => {
        const title = document.getElementById('ep-title').value.trim();
        const body2 = document.getElementById('ep-body').value;
        if (!title || !body2.trim()) return toast('标题和正文不能为空', 'err');
        const cat = document.getElementById('ep-cat').value.trim() || (p.categories[0] || {}).name || '未分类';
        const tags = document.getElementById('ep-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        const cover = document.getElementById('ep-cover').value.trim();
        const content = isMd ? md(body2) : body2;
        const updated = {
          ...p, title, tags, cover, content,
          categories: [{ name: cat, slug: 'cat-' + encodeURIComponent(cat) }],
          excerpt: content.replace(/<[^>]+>/g, '').replace(/[#>*`!\[\]\(\)]/g, '').trim().slice(0, 80),
        };
        if (isMd) updated.raw = body2; // 保持 Markdown 源码，下次仍可 Markdown 编辑
        const arr = POSTS.map((x, j) => (j === i ? updated : x));
        const st = document.getElementById('ep-status'); st.textContent = '正在暂存…'; st.className = 'status-line';
        try {
          await commit('POSTS', arr, '// 文章数据（由管理后台维护）', `编辑文章: ${title}`);
          st.textContent = '✓ 已暂存，点右下「发布到线上」上线'; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
    },

    settings() {
      $panel.innerHTML = `
        <div class="form-card">
          <h2>站点信息</h2>
          <p class="sub">显示在页头、首页和浏览器标签上；头像留空时自动用站名首字生成色块。</p>
          <div class="row2">
            <div class="field"><label>站名</label><input id="s2-title" value="${esc(META.title || '')}"></div>
            <div class="field"><label>副标题</label><input id="s2-sub" value="${esc(META.subtitle || '')}"></div>
          </div>
          <div class="field"><label>头像（链接或本机上传）</label>
            <div style="display:flex;gap:8px">
              <input id="s2-avatar" value="${esc(META.avatar || '')}" placeholder="https://…/avatar.jpg">
              <button type="button" class="btn ghost" id="s2-up">📁</button>
            </div></div>
          <button class="btn" id="s2-save">保存站点信息</button>
          <div class="status-line" id="s2-status"></div>
        </div>
        <div class="form-card">
          <h2>观影图鉴</h2>
          <p class="sub">图鉴页标题下的副标题：留空默认显示「每日一句」（每天换一句）；填文字直接显示；填 https 链接则每天从该接口拉一句，如 https://v1.hitokoto.cn 。</p>
          <div class="field"><label>图鉴副标题</label>
            <input id="s2-watch" value="${esc(META.watchNote || '')}" placeholder="留空 = 每日一句"></div>
          <button class="btn" id="s2-watch-save">保存图鉴副标题</button>
          <div class="status-line" id="s2-watch-status"></div>
        </div>
        <div class="form-card">
          <h2>TMDB API Key（电影自动附图 / 时长统计）</h2>
          <p class="sub">免费申请：themoviedb.org → 头像 → Settings → API。Key 属"君子设置"会随站点公开，仅用于搜索，泄露无害；就算作废，已发布的 TMDB 图片链接照常显示。</p>
          <div class="field"><label>API Key (v3)</label><input id="s4-tmdb" value="${esc(cfg.tmdbKey || window.TMDB_KEY || '')}" placeholder="32 位十六进制字符串"></div>
          <button class="btn" id="s4-save">保存 Key（发布后全设备生效）</button>
          <div class="status-line" id="s4-status"></div>
        </div>
        <div class="form-card">
          <h2>GitHub 仓库设置</h2>
          <p class="sub">只需配置一次，保存在你自己浏览器的 localStorage 里。</p>
          <div class="row2">
            <div class="field"><label>GitHub 用户名 / 组织</label><input id="s-owner" value="${esc(cfg.owner || '')}" placeholder="your-username"></div>
            <div class="field"><label>仓库名</label><input id="s-repo" value="${esc(cfg.repo || '')}" placeholder="your-repo"></div>
          </div>
          <div class="row2">
            <div class="field"><label>分支</label><input id="s-branch" value="${esc(cfg.branch || 'main')}" placeholder="main"></div>
            <div class="field"><label>Token（Fine-grained PAT，只需该仓库 Contents 读写权限）</label><input id="s-token" type="password" value="${esc(cfg.token || '')}" placeholder="github_pat_…"></div>
          </div>
          <h2 style="margin-top:18px">D1 直写（数据迁移后启用，两项都填才生效）</h2>
          <div class="row2">
            <div class="field"><label>Worker 地址（bot 回调域名）</label><input id="s-worker" value="${esc(cfg.workerUrl || '')}" placeholder="https://bot.example.com"></div>
            <div class="field"><label>ADMIN_KEY（与 worker 变量一致）</label><input id="s-adminkey" type="password" value="${esc(cfg.apiKey || '')}" placeholder="与 CF 后台 worker 的 ADMIN_KEY 相同"></div>
          </div>
          <p class="tip">填写后发布走 D1 直写（即时生效、不再触发部署）；留空则走 GitHub 提交（约 1 分钟后生效）。</p>
          <h2 style="margin-top:18px">数据源</h2>
          <p class="tip" id="s-ds">检测数据源中…</p>
          <div class="btns" style="margin:8px 0 0"><button class="btn ghost" id="s-switch" style="display:none">切换</button><span class="tip" id="s-switch-tip"></span></div>
          <button class="btn" id="s-save">保存设置</button>
          <button class="btn ghost" id="s-test">测试连接</button>
          <div class="status-line" id="s-status"></div>
          <p class="tip" style="margin-top:14px">Token 创建方法：GitHub → Settings → Developer settings → Fine-grained personal access tokens → 只勾选你的站点仓库 + Contents: Read and write。</p>
        </div>`;
      document.getElementById('s2-up').onclick = async () => {
        const [f] = await pickFiles();
        if (!f) return;
        const st = document.getElementById('s2-status');
        try {
          const path = await uploadImage(f, 'meta', (m) => { st.textContent = m; st.className = 'status-line'; });
          document.getElementById('s2-avatar').value = path;
          st.textContent = '✓ 已上传'; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; }
      };
      const saveMeta = async (st) => {
        const meta = {
          title: document.getElementById('s2-title').value.trim() || 'My Site',
          subtitle: document.getElementById('s2-sub').value.trim(),
          since: META.since || String(new Date().getFullYear()),
          watchNote: document.getElementById('s2-watch').value.trim(),
          avatar: document.getElementById('s2-avatar').value.trim(),
        };
        st.textContent = '正在暂存…'; st.className = 'status-line';
        try {
          await commit('SITE_META', meta, '// 站点信息（由管理后台维护）', '更新站点信息');
          st.textContent = '✓ 已暂存，点右下「发布到线上」上线'; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
      document.getElementById('s2-save').onclick = () => saveMeta(document.getElementById('s2-status'));
      document.getElementById('s2-watch-save').onclick = () => saveMeta(document.getElementById('s2-watch-status'));
      document.getElementById('s4-save').onclick = async () => {
        const key = document.getElementById('s4-tmdb').value.trim();
        const st = document.getElementById('s4-status'); st.textContent = '正在暂存…'; st.className = 'status-line';
        try {
          cfg.tmdbKey = key; localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); // 本机即时生效
          await stageFile('data/tmdb.js',
            '// TMDB API Key（"君子设置"：随站点公开，仅用于电影搜索/时长查询，泄露无害）\n// 申请：themoviedb.org → 头像 → Settings → API\nwindow.TMDB_KEY = \'' + key + '\';\n',
            '更新 TMDB API Key');
          window.TMDB_KEY = key;
          st.textContent = '✓ 已暂存，发布后全设备生效'; st.className = 'status-line ok';
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; toast(e.message, 'err'); }
      };
      document.getElementById('s-save').onclick = () => {
        cfg = {
          owner: document.getElementById('s-owner').value.trim(),
          repo: document.getElementById('s-repo').value.trim(),
          branch: document.getElementById('s-branch').value.trim() || 'main',
          token: document.getElementById('s-token').value.trim(),
          workerUrl: document.getElementById('s-worker').value.trim(),
          apiKey: document.getElementById('s-adminkey').value.trim(),
        };
        localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
        const st = document.getElementById('s-status'); st.textContent = '✓ 已保存'; st.className = 'status-line ok';
      };
      document.getElementById('s-test').onclick = async () => {
        document.getElementById('s-save').click();
        const st = document.getElementById('s-status'); st.textContent = '正在测试…'; st.className = 'status-line';
        try {
          if (d1Mode()) {
            const r = await fetch(cfg.workerUrl.replace(/\/+$/, '') + '/api/admin/ping', { headers: { 'x-admin-key': cfg.apiKey } });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.ok !== false) { st.textContent = `✓ D1 直写通道正常（worker ${d.build}）`; st.className = 'status-line ok'; }
            else { st.textContent = '✗ D1 通道异常：' + (d.hint || d.error || ('HTTP ' + r.status)); st.className = 'status-line err'; }
            return;
          }
          const f = await ghFile('data/meta.js');
          st.textContent = f ? '✓ 连接成功，能读到仓库里的 data/meta.js' : '✗ 连接成功但仓库里没有 data/meta.js（检查仓库/分支）';
          st.className = 'status-line ' + (f ? 'ok' : 'err');
        } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'status-line err'; }
      };
      /* 数据源：徽章读响应头（前台真相）+ 互斥切换按钮（只显示"切到另一边"） */
      (async () => {
        const el = document.getElementById('s-ds');
        const btn = document.getElementById('s-switch');
        const tip = document.getElementById('s-switch-tip');
        if (!el) return;
        try {
          const r = await fetch('/data/meta.js?ds=' + Date.now(), { cache: 'no-store' });
          const src = r.headers.get('X-Data-Source') || '';
          el.textContent = src === 'd1-authoritative' ? '当前数据源：D1（权威）'
            : src === 'static-d1-error' ? '当前数据源：GitHub 静态（D1 异常，已自动降级）'
            : src === 'static' ? '当前数据源：GitHub 静态'
            : '当前数据源：未知（本次部署无标记，可能旧版 Functions）';
        } catch (e) { el.textContent = '数据源检测失败：' + e.message; }
        if (!d1Mode()) { if (tip) tip.textContent = '填好上面 Worker 地址 + ADMIN_KEY 后可一键切换'; return; }
        const api = cfg.workerUrl.replace(/\/+$/, '') + '/api/admin/source?site=main';
        try {
          const r = await fetch(api, { headers: { 'x-admin-key': cfg.apiKey } });
          const o = await r.json();
          if (!r.ok) { if (tip) tip.textContent = o.error || ('读取失败 ' + r.status); return; }
          const isD1 = o.source === 'd1';
          btn.style.display = '';
          btn.textContent = isD1 ? '切换到 GitHub 静态' : '切换到 D1';
          btn.onclick = async () => {
            const next = isD1 ? 'github' : 'd1';
            if (!confirm('把线上数据源切到 ' + (isD1 ? 'GitHub 静态' : 'D1') + '？')) return;
            btn.disabled = true; tip.textContent = '切换中…';
            try {
              const rr = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': cfg.apiKey }, body: JSON.stringify({ mode: next }) });
              const oo = await rr.json();
              tip.textContent = oo.msg || oo.error || '完成';
              if (oo.ok) setTimeout(() => location.reload(), 1200);
              else btn.disabled = false;
            } catch (e) { tip.textContent = '切换失败：' + e.message; btn.disabled = false; }
          };
        } catch (e) { if (tip) tip.textContent = '读不到数据源状态：' + e.message; }
      })();
    },
  };

  /* ---------- Tab 切换 ---------- */
  document.querySelectorAll('.admin-tabs .tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.admin-tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      views[t.dataset.tab]();
    };
  });
  /* ---------- 访问密码（前端遮挡，非真正安全；真正安全靠 Token 权限） ---------- */
  const LOCK = window.ADMIN_LOCK || {};
  const UNLOCK_KEY = 'adm_unlock_at';
  const isLocked = () => {
    if (!LOCK.enabled || !LOCK.pass) return false;
    const t = Number(localStorage.getItem(UNLOCK_KEY) || 0);
    return !(Date.now() - t < (LOCK.days || 30) * 864e5);
  };
  function mountLockLink() {
    if (document.getElementById('lock-now')) return;
    const back = document.querySelector('.admin-back');
    if (!back) return;
    const a = document.createElement('a');
    a.id = 'lock-now';
    a.href = 'javascript:void(0)';
    a.textContent = '🔒 锁定';
    a.style.cssText = 'margin-left:14px;color:var(--text-sub);font-size:13.5px';
    a.onclick = () => { localStorage.removeItem(UNLOCK_KEY); location.reload(); };
    back.parentNode.appendChild(a);
  }
  function boot() {
    const box = document.getElementById('lock-screen');
    const app = document.getElementById('admin-app');
    if (!isLocked() || !box) {
      if (box) box.hidden = true;
      mountLockLink();
      renderStageBar();
      views.moment();
      return;
    }
    box.hidden = false;
    app.style.visibility = 'hidden';
    const input = document.getElementById('lock-pass');
    const err = document.getElementById('lock-err');
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      if (v === String(LOCK.pass || '')) {
        localStorage.setItem(UNLOCK_KEY, String(Date.now()));
        box.hidden = true;
        app.style.visibility = '';
        mountLockLink();
        renderStageBar();
        views.moment();
      } else {
        err.textContent = '密码不对，再试一次';
        input.select();
      }
    };
    document.getElementById('lock-btn').onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    setTimeout(() => input.focus(), 120);
  }
  /* 本地文件（file://）打开时顶部红条警告：读的是本地旧快照，发布可能覆盖线上新内容 */
  if (location.protocol === 'file:') {
    const paint = () => {
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#d93025;color:#fff;padding:10px 16px;font:600 14px/1.5 system-ui,sans-serif;text-align:center';
      b.textContent = '⚠️ 本地文件模式：页面读的是电脑上的旧数据，发布将覆盖线上新内容 —— 请改用线上网址打开后台（站点地址 + /admin.html）';
      document.body.prepend(b);
    };
    if (document.body) paint(); else document.addEventListener('DOMContentLoaded', paint);
  }
  /* 进后台前先把各年瞬间卷与待办清单拉齐（增删改和统计重算都要全量数据）；拉不齐也进，报错提示 */
  const readyData = (window.MOMENTS_YEARS && window.MOMENTS_YEARS.length)
    ? ensureAllMoments().catch((e) => { toast('瞬间数据加载不完整：' + e.message, 'err'); })
    : Promise.resolve();
  readyData
    .then(() => (window.TODOS ? null : loadScript('data/todos.js')))
    .then(boot)
    .catch((e) => { toast('数据加载不完整：' + e.message, 'err'); boot(); });
})();
