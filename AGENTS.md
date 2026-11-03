# AGENTS.md — 给 AI / 协作者的硬规则

> **接手任何任务前，先读这一份。** 它比代码注释优先，比"我觉得这样更合理"优先。
>
> 配套文档（按需要读，别一次全读）：
> - [`docs/PITFALLS.md`](docs/PITFALLS.md) — 踩坑实录。**改代码前扫一遍**，修完任何 bug 必须回来补一条。
> - [`docs/SETUP.md`](docs/SETUP.md) — 三档接入手册（Tier0 静态 / Tier1 微信 / Tier2 D1）。
> - [`docs/FRONTEND-GUIDE.md`](docs/FRONTEND-GUIDE.md) — 前台数据接口契约 + 可改/禁改清单。
> - [`docs/SITE-STANDARD.md`](docs/SITE-STANDARD.md) — 数据语义差异的**唯一登记处**（`SITE_SPEC`）。
>
> 本仓库根目录 = 站点本体，Pages 直接从 `main` 出页面。
> **push 到 main 就是发布到线上**：没有预发环境、没有 CI 兜底、没有回滚按钮。
> 任何 AI（Claude Code / Cursor / Codex / Copilot / 通义灵码 / Trae…）接手本仓库，读完本文件再动手。

---

## 一句话

**只改代码，不碰数据；动手前先拉取。**

---

## 1. 「数据」是哪些：禁止改动、禁止提交

`data/` 目录下全部是**运行时数据**，不是源码：

| 文件 | 内容 |
|---|---|
| `data/posts.js` | 文章**列表**（无正文） |
| `data/content/<slug>.js` | 每篇正文一个文件（`window.POST_CONTENT["slug"] = {…}`；**文件名用原始 slug，不要 encodeURIComponent**） |
| `data/moments.js` | 瞬间**年份清单** |
| `data/moments-YYYY.js` | 瞬间每年一卷（发布只写当年卷） |
| `data/days-YYYY.js` | 观影天索引按年拆（自动重算，勿手改） |
| `data/watch-meta.js` | 观影/读书全局统计（发布时自动重算，勿手改） |
| `data/catalog.js` | 瞬间名录 `{年份:[片名]}`（查重与站内搜索，自动重算） |
| `data/todos.js` | 待办清单（前台待办页与后台共用） |
| `data/photos.js` | 图片墙清单 |
| `data/links.js` | 友链 |
| `data/meta.js` | 站点元信息 |
| `data/tmdb.js` | 影视元数据用的公开 key |
| `data/admin-lock.js` | 后台口令哈希 |

拆分结构的读写逻辑在三处必须保持一致：`wecom-worker/worker.js`（bot）、
`assets/admin.js`（后台）、`assets/app.js`（前台按需加载）。
**改文件格式要三处同步改，并 bump worker 的 `BUILD`。**

### ⚠️ 五条不能凭直觉改的约定

**1. 正文文件名用原始 slug，不要 `encodeURIComponent`。**
`slugify()` 只保留字母数字（中文算 Letter），得到的名字本来就文件名安全。
`encodeURIComponent` 是给**浏览器发 HTTP 请求**用的：一旦用进 GitHub 的 path，文件名会变成
字面量 `%E6%B5%8B…`，而前台按编码后的 URL 请求时被解码成中文 → 404 → 详情页「正文加载失败」。

**2. 「置顶」= 数组顺序，没有 pin 字段。**
列表直接按 `window.POSTS` 的数组顺序渲染：置顶 = `splice` 出来 `unshift` 到第 0 位。
不要"顺手规范化"加 `pin: true` / `order: 1`——那会让 bot、后台、前台三处判断全部失效。
新内容照旧插最前，被置顶的那条自然退到后面，这是要的语义，不是 bug。

**3. 改样式随便改，改数据形状要三处同步。**
布局 / CSS / 路由 / 文案 → 随便改，bot 完全不读前端代码。
但把 `p.title` 改名、把 `data/content/<slug>.js` 的包裹格式改掉、改数据文件路径、分支不叫
`main` → bot 会照旧写老格式，表现为「bot 说发布成功，页面上没内容」。
**这类故障两端都不报错，最难查。**

**4. 同标题重发 = 自动加时间戳，不覆盖、不拦截。**
slug 由标题生成，同名必然撞车。约定：撞车时**新条目**改名为 `标题 · MM-DD HH:mm`、
slug 加后缀 `-MM-DD-HHmm`（`cnStamp()`），老文章一个字不动。
这是刻意的行为，别"优化"成拒绝发布或覆盖旧文。

**5. 发布失败必须把原因回给用户。**
失败话术里带原始原因首行；同时写 KV `pubfail:`——主动推送没送达时（企业微信受可信 IP 限制，
常见 `errcode 60020`），用户下一条指令开头会补播「⚠️ 上次发布失败：原因」，播一次即销号。
**排障不要只依赖 CF 日志，用户看不到日志。**

### 这些文件只由两个东西写入

1. **微信 bot**（`wecom-worker/worker.js`）→ GitHub Git Data API 或 D1，一次一个 commit
2. **`admin.html`** → GitHub Contents API 或 worker `/api/admin/*`

Tier0/Tier1 下它们直接打 `api.github.com`、不落本地磁盘；Tier2 下写 D1。
**所以本地磁盘上的 `data/*.js` 永远只是"上次 pull 下来的只读副本"。**

### ❌ 禁止

- 用编辑器手改 `data/` 下任何文件
- `git add data/`、`git add -A`、`git add .`、`git commit -a`
- 为了让页面"看起来对"而改数据文件

### ✅ 正确做法

提交时**逐个列出真正改了的代码文件**：

```bash
git add index.html assets/app.js assets/style.css
git commit -m "首页 hero 换版"
```

`git status` 里如果出现 `M data/posts.js`，那是 pull 带下来的新内容，**放着别动**——
它已经在远端了，提交它没有任何意义，只会增加冲突面。

---

## 2. 覆盖数据会发生什么

假设本地 `posts.js` 是三天前 pull 的。不小心 `git add -A` 提交并 push：

- 远端 `posts.js` 回退到三天前
- 这三天里通过 bot / admin 发布的文章**从线上直接消失**
- 你不一定马上发现；等发现时又发了更多新内容，回滚会连带丢新的

**这是本仓库唯一能造成真实数据丢失的操作。** 其余都是代码，改错了 revert 一条就行。

---

## 3. 动手前必须同步

```bash
git fetch origin
git status                      # 看落后多少
git pull --rebase origin main
```

**必须 `--rebase`，不要 merge。** main 有三方在写：你的本地、微信 bot、在线 admin。
merge 会造出一堆无意义的合并提交，历史很快没法读。本地有未提交改动时先 `git stash` 或先提交。

---

## 4. 改完之后

1. 只 `git add` 代码文件
2. commit message 说清改了哪个页面 / 哪个功能
3. push 前再 `git fetch` 一次（钩子会替你查）
4. push 后用线上地址**实际打开**确认（Pages 约 1 分钟生效）

---

## 5. 铁律十条（违反即事故）

1. **只改代码，不碰数据**；动手前 `git pull --rebase`，**禁 merge、禁 force push**。
2. 数据文件禁止本地编辑提交（pre-commit / pre-push 会拦；紧急放行
   `ALLOW_DATA_COMMIT=1`，只用于初始化导入这类纯数据提交，且**单独一趟 push**）。
3. **worker 改动必 bump `BUILD`**，部署后访问 `/version` 核对一致才算上线。
4. **改 worker 必跑测试**：`cd wecom-worker && node test.mjs`（**必须在该目录下跑**）。
5. **D1 API**：`prepare().bind()` 返回不可 await 的语句，必须接 `.run()` / `.all()` /
   `.first()` 或进 `batch()`；漏 `.run()` 静默不执行。
6. **新增暂存标记必须登记 flush 的跳过清单**，删类操作必须有端到端用例。
7. **循环发 fetch 的批处理必须限批**（免费版单次调用 50 子请求）+ KV 游标续传。
8. **`waitUntil` 后台任务结果必须落 KV**——推送可能被企业微信 IP 白名单静默拦截。
9. **读文件生成快照/备份时统一 CRLF→LF**（仓库 `* text=auto` 存 LF，不归一会差量全量命中）。
10. **push 后必须验证线上真的部署了**（Pages 偶发漏自动部署；CF「重试部署」只重跑旧提交）：
    空提交触发一次新构建，再用线上地址确认。

---

## 6. 已装的防线

`scripts/git-hooks/` 下有 pre-commit / pre-push 钩子。启用后：

| 时机 | 拦截条件 |
|---|---|
| commit | 暂存区含 `data/` 文件 → **拒绝提交** |
| commit / push | 本地落后 `origin/main` → **拒绝**，提示先 `pull --rebase` |

启用（每个 clone 各做一次）：

```bash
bash scripts/install-hooks.sh      # Windows 直接双击 scripts/install-hooks.bat
```

极少数确需提交数据时：`ALLOW_DATA_COMMIT=1 git commit …`

> GitHub Desktop 用户同样受保护——Desktop 内部调用 git，钩子照常触发。

### 服务端兜底（不依赖任何人配合）

[`.github/workflows/guard-data.yml`](.github/workflows/guard-data.yml) 在 GitHub 服务器上跑，
**每个 push 都会检查**：

- 一次**提交**同时改了「代码」和「数据」→ 判定为 `git add -A` 误操作
- 只把数据文件还原到这次提交之前，**代码改动保留**，并推一个「自动修复」commit
- 检测期间远端若又前进（bot 刚发了文章），放弃自动修复、只报警，避免抹掉更新的内容

bot 和 admin 只改数据、不改代码，所以不会被误伤。

> **改这个工作流必读**：判类前必须 `git config core.quotepath false`。
> 默认 `quotepath=true` 会把含中文的路径输出成 `"data/content/\346\265\213…js"`，
> 开头多了引号，`^data/` 匹配不上 → 数据被当成"代码" → 中文标题文章一发布就被判为混合提交、
> 整份回滚。
> 判定当前是否正常：`git -c core.quotepath=false diff --name-only A B` 输出的路径不应带引号。
>
> **本地钩子可以被 `--no-verify` 绕过、也可以因为没装而失效；这一层不行。**

---

## 7. 万一真覆盖了

```bash
git log --oneline -- data/posts.js             # 找出覆盖前那个 commit
git show <sha>:data/posts.js > /tmp/old.js     # 取出当时的完整内容
```

在 GitHub 网页上找到那次误覆盖的 commit → **Revert**，也能一键还原。
bot 每次发布都是独立 commit，所以每条数据都能精确追溯到「谁在什么时候加的」。

---

## 8. 文档索引

| 你想干什么 | 读这份 |
|---|---|
| 从零把站点跑起来 / 接微信 / 接 D1 | [`docs/SETUP.md`](docs/SETUP.md) |
| 改前台样式、写页面、取数据 | [`docs/FRONTEND-GUIDE.md`](docs/FRONTEND-GUIDE.md) |
| 知道哪些坑已经踩过、为什么有这些规则 | [`docs/PITFALLS.md`](docs/PITFALLS.md) |
| 加数据路径、改数据语义、加第二个站点 | [`docs/SITE-STANDARD.md`](docs/SITE-STANDARD.md) |
| 部署方式与验证 | [`DEPLOY.md`](DEPLOY.md) |
| 想参与改进模板 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
