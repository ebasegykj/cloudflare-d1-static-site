// 一次性脚本：按 TMDB 上映/首播日期回填待办 createdAt；早于 2000 年的统一写 2004（保留月日）
// 用法：node migrate-todos-dates.mjs [--write]
//   默认 dry-run 只打印映射；--write 才写回 data/todos.js
// 图书不走 TMDB：遥远的救世主=小说 2005-05；逻辑哲学论=原著 1921 → 2004

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROXY = 'https://your-bot.example.com/tmdb?q=';
const BOOK_DATES = {
  '遥远的救世主': '2005-05-01',   // 小说初版 2005 年
  '逻辑哲学论': '2004-01-01',     // 原著 1921 年，早于 2000 → 2004
};
// 个别条目手动修正：带季数后缀 TMDB 搜不到 / 未上映影片
const OVERRIDE = {
  t003: { query: '弥留之国的爱丽丝' },               // 第一季，首播 2020-12-10
  t029: { date: '2023-10-07' },                      // 间谍过家家 第二季日本首播
  // t010 装甲战争：漫威未上映，无日期 → 保持原值
};

function readTodos() {
  const src = fs.readFileSync(path.join(__dirname, '../data/todos.js'), 'utf8');
  const m = src.match(/window\.TODOS\s*=\s*(\[[\s\S]*?\]);?\s*$/);
  if (!m) throw new Error('无法解析 todos.js');
  return JSON.parse(m[1]);
}

async function lookup(title, kind) {
  const r = await fetch(PROXY + encodeURIComponent(title));
  if (!r.ok) return null;
  const j = await r.json();
  const hit = (j.results || []).find((x) => x.media_type === kind);
  if (!hit) return null;
  const date = (kind === 'movie' ? hit.release_date : hit.first_air_date) || '';
  return { date, hitTitle: kind === 'movie' ? hit.title : hit.name };
}

(async () => {
  const todos = readTodos();
  const out = [];
  for (const t of todos) {
    let date = '';
    let src = '';
    if (t.kind === 'book') {
      date = BOOK_DATES[t.title.replace(/[‎\u200e]/g, '').trim()] || '';
      src = 'book-fixed';
    } else if (OVERRIDE[t.id] && OVERRIDE[t.id].date) {
      date = OVERRIDE[t.id].date; src = 'manual';
    } else {
      const q = (OVERRIDE[t.id] && OVERRIDE[t.id].query) || t.title.replace(/[‎\u200e]/g, '').trim();
      const hit = await lookup(q, t.kind);
      if (hit && /^\d{4}-\d{2}-\d{2}$/.test(hit.date)) {
        date = hit.date; src = `tmdb:${hit.hitTitle}`;
      }
    }
    if (date) {
      const y = +date.slice(0, 4);
      if (y < 2000) { date = '2004' + date.slice(4); src += ' →2004'; }
      t.createdAt = date + ' 12:00:00';
    }
    out.push(`${t.id} | ${t.kind} | ${t.title} | ${date || '未查到→保持原值'} | ${src}`);
    await new Promise((r) => setTimeout(r, 350)); // 轻微限速
  }
  console.log(out.join('\n'));
  if (process.argv.includes('--write')) {
    const keep = fs.readFileSync(path.join(__dirname, '../data/todos.js'), 'utf8').split('window.TODOS =')[0];
    fs.writeFileSync(path.join(__dirname, '../data/todos.js'),
      keep + 'window.TODOS = ' + JSON.stringify(todos) + ';\n');
    console.log('\n已写回 data/todos.js');
  } else {
    console.log('\n(dry-run，未写文件；确认后加 --write)');
  }
})();
