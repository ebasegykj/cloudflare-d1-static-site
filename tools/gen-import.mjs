#!/usr/bin/env node
/* 生成 D1 导入清单 data-import.json（一次性迁移用）。
 *
 * 用法：在 site/ 目录下  node tools/gen-import.mjs
 * 输出：仓库根目录 data-import.json = { generated, count, totalBytes, files: [{path, body}] }
 *       path 相对仓库根（data/posts.js、data/content/<slug>.js …），body 是文件完整文本。
 *
 * worker 收到「导入D1」命令时从 GitHub raw 拉这个文件，逐行 upsert 进 D1 files 表。
 * 注意：data-import.json 是当前数据的快照——如果导入前数据又变过（bot 发了新内容），
 * 必须重新生成并提交后再发「导入D1」，否则 D1 里是旧快照（有「核对D1」命令兜底验证）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..'); // site/
const files = [];
let walk = (dir, prefix) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { walk(full, prefix + name + '/'); continue; }
    if (!name.endsWith('.js')) continue;
    files.push({ path: prefix + name, body: fs.readFileSync(full, 'utf8') });
  }
};
walk(path.join(root, 'data'), 'data/');

files.sort((a, b) => a.path.localeCompare(b.path));
const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.body, 'utf8'), 0);
const out = { generated: new Date().toISOString(), count: files.length, totalBytes, files };

// 单行 2MB 上限检查（D1 硬限制），提前在这里报错比线上失败友好
const over = files.filter((f) => Buffer.byteLength(f.body, 'utf8') > 2 * 1024 * 1024);
if (over.length) {
  console.error('以下文件超过 D1 单行 2MB 上限，先拆分：');
  for (const f of over) console.error('  ' + f.path);
  process.exit(1);
}

fs.writeFileSync(path.join(root, 'data-import.json'), JSON.stringify(out));
console.log(`OK：${files.length} 个文件，共 ${(totalBytes / 1024).toFixed(1)} KB → data-import.json（仓库根）`);
