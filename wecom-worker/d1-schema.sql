-- D1 数据层 schema（2026-11-02 迁移方案 B）
-- 设计：D1 当"文件系统"用——每行 = 旧仓库里的一个数据文件（path 相对仓库根，如 data/posts.js）。
-- bot / admin 生成完整文件内容的逻辑原样保留，只是把"写 GitHub blob"换成 upsert 一行。
-- 前端拿到的内容与旧静态文件逐字节一致（黄金样本测试盯着）。
-- 不做关系表：收益为零、迁移风险放大；将来有真实查询需求再议。
--
-- 注意：worker 每次写入前都会执行 ensureSchema（CREATE TABLE IF NOT EXISTS），
-- 本文件只是留档，不要求手动在 dashboard 里跑。

CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,     -- 相对仓库根，如 data/posts.js、data/content/<slug>.js
  body       TEXT NOT NULL,        -- 文件完整文本（与旧静态文件逐字节一致）
  updated_at INTEGER NOT NULL      -- 毫秒时间戳，最后写入时间
);

-- 免费版相关限制备忘（2026-11 官方文档核实）：
-- 单库 500MB（账号总量 5GB）/ 单行上限 2MB / SQL 语句 100KB（用绑定参数绕开）
-- / 每 Worker 调用 50 次 D1 查询（db.batch 算 1 次）/ Time Travel 仅 7 天（免费版）
-- 现有数据总量约 625KB、最大单文件 215KB，余量充足。
