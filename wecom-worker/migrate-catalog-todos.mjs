// 一次性迁移：生成查重名录 + 待办清单，摘除 1900/1970 占位卷。跑完即弃。
// 防二次运行：todos.js 已存在直接退出（二次运行会把 manifest 当数据源写坏）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = (p) => path.join(ROOT, 'data', p);
const read = (p) => fs.readFileSync(DATA(p), 'utf8');

if (fs.existsSync(DATA('todos.js'))) {
  console.error('data/todos.js 已存在，拒绝二次运行（防止把清单当原始数据写坏）');
  process.exit(1);
}

const volArr = (y) => {
  const t = read(`moments-${y}.js`);
  return JSON.parse(t.match(/MOMENTS_PARTS\["(\d+)"\] = ([\s\S]*);\s*$/m)[2]);
};

// 1. 读全部卷
const manifest = JSON.parse(read('moments.js').match(/\[[\s\S]*\]/)[0]);
let all = [];
for (const y of manifest) all = all.concat(volArr(y));
console.log('迁移前总条数:', all.length);

// 2. 查重名录：{ 年份: [片名...] } 映射（年份只存一次，~11KB；查重只需年份不需日期）
const catalog = {};
all.filter((m) => m.title).forEach((m) => {
  const yy = String(m.date || '').slice(0, 4) || '0000';
  (catalog[yy] = catalog[yy] || []).push(m.title);
});

// 3. 待办清单：1900/1970 两卷全部是 undated 占位条目 → 转为待办
for (const y of ['1900', '1970']) {
  if (volArr(y).some((x) => !x.undated)) throw new Error(`${y} 卷里有非 undated 条目，中止迁移`);
}
const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
const todos = [];
for (const y of ['1900', '1970']) {
  volArr(y).forEach((x, i) => {
    todos.push({
      id: 't' + String(todos.length + 1).padStart(3, '0'),
      kind: x.type === 'book' ? 'book' : (x.kind === 'tv' ? 'tv' : 'movie'),
      title: x.title || '',
      note: (x.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      poster: x.poster || '',
      runtime: x.runtime || 0,
      createdAt: nowIso,
      done: false,
      doneAt: null,
    });
  });
}
console.log('待办条目:', todos.length);

// 4. 摘除占位卷后的剩余瞬间
const keepYears = manifest.filter((y) => y !== '1900' && y !== '1970');
let rest = [];
for (const y of keepYears) rest = rest.concat(volArr(y));
console.log('剩余瞬间条数:', rest.length, '(应 = 迁前 - 31)');

// 5. 写文件
fs.writeFileSync(DATA('catalog.js'),
  '// 瞬间名录：查重+站内搜索用（年份→片名列表；bot/后台发布瞬间时自动重算，勿手改）\nwindow.MOMENT_CATALOG = ' + JSON.stringify(catalog) + ';\n');
fs.writeFileSync(DATA('todos.js'),
  '// 待办清单（想看/想读/日常；后台管理与前台待办页共用，完成的电影/图书自动记入瞬间）\nwindow.TODOS = ' + JSON.stringify(todos) + ';\n');
fs.writeFileSync(DATA('moments.js'),
  '// 瞬间分卷清单（bot/后台维护；各年正文在 data/moments-YYYY.js）\nwindow.MOMENTS_YEARS = ' + JSON.stringify(keepYears.sort((a, b) => b.localeCompare(a))) + ';\n');
for (const y of ['1900', '1970']) {
  fs.rmSync(DATA(`moments-${y}.js`), { force: true });
  fs.rmSync(DATA(`days-${y}.js`), { force: true });
}

// 6. watch-meta 重算（undated 不再计入"已看"统计）——逻辑与 worker buildWatch 一致
const w92 = (u) => (u || '').replace('/w500/', '/w92/');
const days = {}; const perYear = {};
rest.forEach((m) => {
  const d = String(m.date || '').match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
  if (!d || m.undated || d[1] === '1970' || d[1] === '1900' || m.type === 'book') return;
  const key = `${d[1]}-${d[2]}-${d[3]}`;
  const o = days[key] || (days[key] = { m: 0, t: 0, p: '' });
  if (m.kind === 'tv') o.t++; else o.m++;
  if (!o.p && m.poster) o.p = w92(m.poster);
  const yy = perYear[d[1]] || (perYear[d[1]] = { days: 0, m: 0, t: 0 });
  if (m.kind === 'tv') yy.t++; else yy.m++;
});
Object.keys(days).forEach((k) => { const yy = k.slice(0, 4); if (perYear[yy]) perYear[yy].days++; });
const meta = {
  total: rest.length,
  movie: rest.filter((m) => m.type === 'movie').length,
  book: rest.filter((m) => m.type === 'book').length,
  mins: rest.reduce((s, m) => s + (m.runtime || 0), 0),
  years: [...new Set(Object.keys(days).map((k) => k.slice(0, 4)))].sort().reverse(),
  perYear,
  watchDays: Object.keys(days).length,
};
fs.writeFileSync(DATA('watch-meta.js'),
  '// 观影统计（发布时自动重算，勿手改）\nwindow.WATCH_META = ' + JSON.stringify(meta) + ';\n');

// 7. 校验
const cat = JSON.parse(read('catalog.js').match(/MOMENT_CATALOG = (\{[\s\S]*\});/)[1]);
const td = JSON.parse(read('todos.js').match(/TODOS = (\[[\s\S]*\]);/)[1]);
if (Object.values(cat).flat().length !== all.filter((m) => m.title).length) throw new Error("名录条数不符");
if (td.length !== 31) throw new Error('待办应为 31 条，实际 ' + td.length);
if (rest.length !== all.length - 31) throw new Error('剩余条数不符');
console.log('✓ 迁移完成: 名录', Object.values(cat).flat().length, '条 / 待办', td.length, '条 / 瞬间剩', rest.length, '条 / 统计 total=' + meta.total);
