/* 一次性迁移脚本（跑完即弃）：主站 posts C 方案 + moments 年分卷
 *
 * 用法：在 site/ 目录下 node wecom-worker/migrate-main-split.mjs
 * 数据以本地 pull 下来的副本为准（bot/后台以 GitHub main 为唯一真相，
 * 迁移前先 git pull --rebase，确认没有待发布的暂存）。
 *
 * 产出：
 *   data/posts.js          → 列表（去掉 content/raw）
 *   data/content/<enc(slug)>.js → 每篇正文一个文件 {content, raw}
 *   data/moments.js        → 年份清单 manifest（window.MOMENTS_YEARS）
 *   data/moments-YYYY.js   → 每年一卷（window.MOMENTS_PARTS["YYYY"]）
 *   data/days-YYYY.js      → 观影天索引按年拆（window.WATCH_DAYS 合并式）
 *   data/watch-meta.js     → 全局统计（window.WATCH_META）
 *   删除 data/days.js（旧文件，内容已拆进上面两类）
 *
 * 校验（不过校验不写盘）：
 *   - 文章：列表+正文重组后与原数据逐字段全等
 *   - 瞬间：各卷按日期倒序拼回后与原数组逐条全等
 *   - 观影索引：重算结果与旧 days.js 的 WATCH_DAYS/WATCH_META 逐键比对
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = (p) => path.join(ROOT, 'data', p);
const read = (p) => fs.readFileSync(DATA(p), 'utf8');
const parseArr = (text) => JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));

/* 防呆：本脚本只能跑一次。跑过之后 moments.js 已变成 manifest，再跑会拿 manifest 当数据源 */
if (fs.existsSync(DATA('moments.js')) && fs.readFileSync(DATA('moments.js'), 'utf8').includes('MOMENTS_YEARS')) {
  console.error('✗ data/moments.js 已经是分卷清单（迁移完成过），请勿重复运行。\n  如需重来：git restore data/ && git clean -fd data/');
  process.exit(1);
}

/* ---------- 1. 文章 C 方案 ---------- */
function migratePosts() {
  const posts = parseArr(read('posts.js'));
  const list = [], contents = {};
  for (const p of posts) {
    const { content, raw, ...rest } = p;
    if (!rest.slug) throw new Error(`文章缺 slug：${rest.title}`);
    if (contents[rest.slug]) throw new Error(`slug 重复：${rest.slug}`);
    list.push(rest);
    const obj = raw === undefined ? { content } : { content, raw };
    contents[rest.slug] = obj;
  }
  /* 校验：重组全等（逐字段） */
  for (const p of posts) {
    const re = { ...list.find((x) => x.slug === p.slug), ...contents[p.slug] };
    for (const k of Object.keys(p)) {
      if (JSON.stringify(re[k]) !== JSON.stringify(p[k]))
        throw new Error(`文章 ${p.slug} 字段 ${k} 重组不一致`);
    }
  }
  const contentFile = (slug, obj) =>
    `// 正文（slug=${slug}，由发文bot/管理后台维护；手改这个文件前台直接生效）\n`
    + `window.POST_CONTENT = window.POST_CONTENT || {};\n`
    + `window.POST_CONTENT[${JSON.stringify(slug)}] = ${JSON.stringify(obj)};\n`;
  return { listText: '// 文章列表（由管理后台/发文bot维护；正文在 data/content/<slug>.js 按需加载）\nwindow.POSTS = ' + JSON.stringify(list) + ';\n',
    contents, contentFile, count: posts.length };
}

/* ---------- 2. 瞬间年分卷 ---------- */
function yearOf(m) {
  const d = String(m.date || '').match(/^(\d{4})\//);
  return d ? d[1] : '0000';
}
function migrateMoments() {
  const moments = parseArr(read('moments.js'));
  const byYear = new Map();
  for (const m of moments) {
    const y = yearOf(m);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(m);
  }
  const years = [...byYear.keys()].sort().reverse();
  /* 校验：各卷拼回（按日期倒序）与原数组逐条全等 */
  const merged = [...byYear.values()].flat()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (merged.length !== moments.length) throw new Error('瞬间条数不一致');
  for (let i = 0; i < moments.length; i++) {
    const a = [...moments].sort((x, y) => String(y.date).localeCompare(String(x.date)))[i];
    if (JSON.stringify(merged[i]) !== JSON.stringify(a))
      throw new Error(`瞬间第 ${i} 条拼回不一致：${merged[i].title || merged[i].date}`);
  }
  const manifestText = '// 瞬间分卷清单（bot/后台维护；各年正文在 data/moments-YYYY.js）\nwindow.MOMENTS_YEARS = ' + JSON.stringify(years) + ';\n';
  const volumeFile = (y, arr) =>
    `// 瞬间数据 ${y} 年卷（由管理后台/发文bot维护）\n`
    + `window.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\n`
    + `window.MOMENTS_PARTS[${JSON.stringify(y)}] = ${JSON.stringify(arr)};\n`;
  return { manifestText, volumeFile, byYear, years, count: moments.length };
}

/* ---------- 3. 观影索引（与 worker/admin 的 buildDays 同逻辑重算） ---------- */
function buildWatch(moments) {
  const w92 = (u) => (u || '').replace('/w500/', '/w92/');
  const days = {}, perYear = {};
  moments.forEach((m) => {
    const d = String(m.date || '').match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
    if (!d || m.undated || d[1] === '1970' || d[1] === '1900') return;
    if (m.type === 'book') return;
    const key = `${d[1]}-${d[2]}-${d[3]}`;
    const o = days[key] || (days[key] = { m: 0, t: 0, p: '' });
    if (m.kind === 'tv') o.t++; else o.m++;
    if (!o.p && m.poster) o.p = w92(m.poster);
    const y = perYear[d[1]] || (perYear[d[1]] = { days: 0, m: 0, t: 0 });
    y.m += m.kind === 'tv' ? 0 : 1;
    y.t += m.kind === 'tv' ? 1 : 0;
  });
  Object.keys(days).forEach((k) => { const y = k.slice(0, 4); if (perYear[y]) perYear[y].days++; });
  const meta = {
    total: moments.length,
    movie: moments.filter((m) => m.type === 'movie').length,
    book: moments.filter((m) => m.type === 'book').length,
    mins: moments.reduce((s, m) => s + (m.runtime || 0), 0),
    years: [...new Set(Object.keys(days).map((k) => k.slice(0, 4)))].sort().reverse(),
    perYear, watchDays: Object.keys(days).length,
  };
  const daysByYear = {};
  Object.keys(days).forEach((k) => {
    const y = k.slice(0, 4);
    (daysByYear[y] = daysByYear[y] || {})[k] = days[k];
  });
  return { daysByYear, meta };
}

/* ---------- 主流程 ---------- */
const posts = migratePosts();
const moments = migrateMoments();
const all = [...moments.byYear.values()].flat();
const { daysByYear, meta } = buildWatch(all);

/* 与旧 days.js 比对（应完全一致，不一致只警告——旧文件可能滞后一次发布） */
let dayDiff = 0;
try {
  const oldText = read('days.js');
  const cut = oldText.indexOf('window.WATCH_META = ');
  const oldDays = JSON.parse(oldText.slice(oldText.indexOf('{'), oldText.lastIndexOf('}', cut) + 1));
  const oldMeta = JSON.parse(oldText.slice(oldText.indexOf('{', cut), oldText.lastIndexOf('}') + 1));
  const newDays = Object.assign({}, ...Object.values(daysByYear));
  for (const k of new Set([...Object.keys(oldDays), ...Object.keys(newDays)])) {
    if (JSON.stringify(oldDays[k]) !== JSON.stringify(newDays[k])) { dayDiff++; console.warn(`  ⚠ days[${k}] 不一致 旧=${JSON.stringify(oldDays[k])} 新=${JSON.stringify(newDays[k])}`); }
  }
  for (const k of new Set([...Object.keys(oldMeta), ...Object.keys(meta)])) {
    if (JSON.stringify(oldMeta[k]) !== JSON.stringify(meta[k])) console.warn(`  ⚠ meta.${k} 不一致 旧=${JSON.stringify(oldMeta[k])} 新=${JSON.stringify(meta[k])}`);
  }
} catch (e) { console.warn('  ⚠ 旧 days.js 比对跳过：', e.message); }

/* 写盘（校验全部通过才会到这里） */
fs.mkdirSync(DATA('content'), { recursive: true });
fs.writeFileSync(DATA('posts.js'), posts.listText);
for (const [slug, obj] of Object.entries(posts.contents))
  fs.writeFileSync(DATA(path.join('content', encodeURIComponent(slug) + '.js')), posts.contentFile(slug, obj));
fs.writeFileSync(DATA('moments.js'), moments.manifestText);
for (const y of moments.years)
  fs.writeFileSync(DATA(`moments-${y}.js`), moments.volumeFile(y, moments.byYear.get(y)));
for (const [y, days] of Object.entries(daysByYear))
  fs.writeFileSync(DATA(`days-${y}.js`),
    `// 观影天索引 ${y} 年（发布时自动重算，勿手改）\nwindow.WATCH_DAYS = window.WATCH_DAYS || {};\nObject.assign(window.WATCH_DAYS, ${JSON.stringify(days)});\n`);
fs.writeFileSync(DATA('watch-meta.js'),
  '// 观影统计（发布时自动重算，勿手改）\nwindow.WATCH_META = ' + JSON.stringify(meta) + ';\n');
if (fs.existsSync(DATA('days.js'))) fs.rmSync(DATA('days.js'));

/* 报告 */
const kb = (n) => (n / 1024).toFixed(1) + 'KB';
console.log(`✓ 文章 ${posts.count} 篇 → 列表 ${kb(fs.statSync(DATA('posts.js')).size)} + ${posts.count} 个正文文件`);
console.log(`✓ 瞬间 ${moments.count} 条 → ${moments.years.length} 卷：` +
  moments.years.map((y) => `${y}(${moments.byYear.get(y).length}条/${kb(fs.statSync(DATA(`moments-${y}.js`)).size)})`).join(' '));
console.log(`✓ 观影索引 → ${Object.keys(daysByYear).length} 个 days-YYYY.js + watch-meta.js${dayDiff ? `（与旧 days.js 有 ${dayDiff} 天不一致，见上方警告）` : '（与旧 days.js 完全一致）'}`);
