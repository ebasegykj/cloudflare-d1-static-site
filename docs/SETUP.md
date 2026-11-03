# 接入手册（SETUP）

> 这个模板分三档，**从哪一档开始都行，随时可以往上加**：
>
> | 档位 | 你要准备 | 你会得到 |
> |---|---|---|
> | **Tier0 开箱即跑** | 一个 GitHub 账号 + 一个 Cloudflare 账号 | 线上静态站，浏览器里写文章 |
> | **Tier1 微信发布** | 一个企业微信（自建应用） | 微信里发消息就能发文章，不用开电脑 |
> | **Tier2 D1 数据层** | 上面两档都跑通 | 数据存数据库，发布不再触发部署 |
>
> 只想要一个能写文章的静态站 → 做完第一章就停，后面的都别碰。
> 每章都按「你需要准备什么 → 一步步做什么 → 怎么验证成功」写，做完一章再进下一章。

---

## 第 0 章 · Tier0：把站点跑起来

### 你需要准备什么

- GitHub 账号（仓库可以 Private，Pages 照样能部署 Private 仓库）
- Cloudflare 账号（免费版足够）
- 不用买域名，`*.pages.dev` 直接能用

### 一步步做什么

**1）把模板变成你自己的仓库**

在 GitHub 上点这个仓库的 **Use this template**（或 Fork），拿到一份自己的副本。
如果你是在本地已经有一份，也可以直接推到新建的空仓库：

```bash
git init
git add .
git commit -m "init: 从模板初始化"
git remote add origin https://github.com/<你的用户名>/<你的仓库名>.git
git branch -M main
git push -u origin main
```

> 这一次初始提交用 `git add .` 是安全的（还没有任何线上数据）。**之后再也不要用 `-A`**，
> 原因见 [`AGENTS.md`](../AGENTS.md) 第 2 节。

**2）连接 Cloudflare Pages**

Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** →
选刚推的仓库，构建设置照抄：

| 项 | 填什么 |
|---|---|
| Framework preset | **None** |
| Build command | **留空** |
| Build output directory | **/** |

点 **Save and Deploy**。首次构建约 1 分钟。

**3）打开站点**

构建完成后拿到 `https://<项目名>.pages.dev`。首页应该能看到 demo 数据（示例文章、瞬间、
图片墙）——这些数据在仓库 `data/` 目录里，是模板自带的。

**4）配置在线后台（写文章用）**

1. GitHub → 头像 → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**
   - Repository access：**Only select repositories**，只勾你的站点仓库
   - Permissions → Repository permissions → **Contents: Read and write**
   - 生成后立刻复制（只显示一次）
2. 打开 `https://<项目名>.pages.dev/admin.html`
3. 「设置」页填：GitHub 用户名 / 仓库名 / 分支（`main`）/ Token → 保存 → 点 **测试连接**

**5）试着发一篇**

admin.html → 发文章 → 写标题和正文 → 发布。约 1 分钟后仓库多一个 commit，站点自动更新。

### 怎么验证成功

```bash
curl -I https://<项目名>.pages.dev/data/posts.js
```

- 状态码 `200`
- 响应头含 `X-Data-Source: static`（Tier0 的正确答案）
- 内容里能看到你刚发的文章标题

后台再点一次「测试连接」，应显示连接成功。

### Tier0 的两条限制（不是 bug）

- 每次发布都会往仓库写文件 → 触发一次 Pages 构建（免费额度 500 次/月）
- 仓库里的 `data/` 就是唯一真相，**不要手改、不要提交它的旧副本**（详见 `AGENTS.md`）

---

## 第 1 章 · Tier1：微信里发文章

> 目标：在企业微信里发「文」+ 标题 + 正文，回「发」→「确认」，站点就更新。
> 全部在 Cloudflare Worker 上跑，不买服务器，免费额度足够个人用。

### 你需要准备什么

| 需要 | 从哪拿 |
|---|---|
| 企业微信**管理员**权限 | work.weixin.qq.com 管理后台 |
| GitHub Token（Contents 读写） | 同 Tier0 第 4 步，可复用 |
| Cloudflare 账号 + 一个 KV 命名空间 | dash.cloudflare.com |
| （可选）TMDB API Key | 只影响「瞬」的影视自动配图 |
| （可选）图床 | 只影响直接发图片，没有就贴链接 |

### 一步步做什么

**1）建 KV 命名空间**

CF 控制台 → **Storage & Databases** → **KV** → **Create namespace**，名字随意（如 `my-site-kv`）。

**2）建 Worker**

**Workers & Pages** → **Create** → **Create Worker**，名字随意（如 `my-site-bot`）→ Deploy。
然后 **Edit code**：把默认代码全删，粘贴 [`wecom-worker/worker.js`](../wecom-worker/worker.js)
全文 → **Deploy**。

**3）绑定 KV（名字必须叫 `KV`）**

Worker → **Settings** → **Bindings** → **Add** → **KV namespace**，
Variable name 填 **`KV`**，选第 1 步建的命名空间 → Save。

**4）配置环境变量**

Worker → **Settings** → **Variables and Secrets**，逐条添加（**都是 Secret，不要写进仓库**）：

| 变量名 | 作用 | 示例 |
|---|---|---|
| `CORP_ID` | 企业微信「我的企业」里的企业 ID | `ww1234567890abcdef` |
| `AGENT_ID` | 自建应用的 AgentId（纯数字） | `1000002` |
| `CORP_SECRET` | 自建应用的 Secret | `kR9x…`（点「查看」发到微信里） |
| `WECOM_TOKEN` | 回调校验 Token（企业微信里点「随机获取」） | `QDG6eK…` |
| `WECOM_AESKEY` | 回调 EncodingAESKey，43 位（点「随机获取」） | `jWmYm7y…` |
| `GH_TOKEN` | GitHub Fine-grained PAT，Contents 读写 | `github_pat_11ABC…` |
| `REPO` | 仓库全名 `owner/repo` | `your-name/my-site` |
| `ADMIN_KEY` | 后台写接口的密钥，自己编一串长随机串 | `8f3c1d…`（≥32 位） |
| `TMDB_KEY` | 可选。影视搜索/配图，用不到就不配 | `1a2b3c…` |
| `IMG_TOKEN` | 可选。图床 token，用不到就不配 | — |
| `DB` | **Tier2 才需要**，D1 绑定名 | 见第 2 章 |

> 也可以只配一条 `CONFIG`（一整行 JSON），键名与上表相同——worker 会把它合并进环境。
> 两种方式二选一，**不要同一份密钥同时出现在两处**，排障时容易改错一边。
>
> CF 的 Variables 有「加密」选项，务必选加密；它们永远不该出现在仓库、文档、截图里。

**5）拿到 Worker 地址，配企业微信回调**

- Worker 的 **Settings → Domains** 里能看到 `https://<worker名>.<子域>.workers.dev`
- 企业微信管理后台 → **应用管理** → 你的自建应用 → **接收消息** → **设置 API 接收**
  - URL：`https://<worker名>.<子域>.workers.dev/wecom`（**末尾必须是 `/wecom`**）
  - Token / EncodingAESKey：点「随机获取」，**复制粘贴**到第 4 步（不要手打，
    `O/0`、`l/1` 肉眼分不出来）
  - 顺序很重要：**先在 CF 填好变量并 Deploy，再回企业微信点保存**——企业微信保存时会
    立刻回调验证，CF 上没配好就保存必然失败
- 建议把应用可见范围设成只有你自己

**6）后台切到 Worker 写入（可选但推荐）**

admin.html → 设置 → 填 **Worker 地址** + **ADMIN_KEY** → 点「测试连接」。
连通后发布走 `POST /api/admin/*`，比浏览器直连 GitHub 快，也不用把 Token 放在浏览器里。

### 怎么验证成功

按顺序，每步都要过：

1. 浏览器打开 `https://<worker域名>/version` → 返回 `build` 字段，与 `worker.js` 顶部
   `const BUILD` **完全一致**（不一致说明 CF 上还是旧代码）
2. 微信里给应用发 **`帮助`** → 收到指令说明
3. 发：
   ```
   文
   测试标题
   这是正文
   ```
   → 回「已暂存文章」
4. 发 **`发`** → 收到待发清单 → 回 **`确认`** → 回「🚀 已发布」
5. GitHub 仓库出现一条新 commit（消息形如 `微信发布：1 条`），约 1 分钟后线上可见

### 出问题先看这三件事

- `/version` 打不开 → Worker 没部署成功，或域名拼错
- 企业微信里发了没反应 → 回调 URL 少了 `/wecom`，或 `WECOM_TOKEN`/`WECOM_AESKEY` 与后台不一致
- 回「发布失败」→ 看话术里带的**原始原因首行**（Token 权限、分支名不对、仓库名写错）

---

## 第 2 章 · Tier2：D1 权威数据源

> 目标：数据从"仓库里的文件"搬进 Cloudflare D1，发布**即时生效、不再触发 Pages 构建**。
> 仓库 `data/` 退化为降级副本，站点照常可读。
>
> 原理：Pages Functions（`functions/data/[[path]].js`）接管 `/data/*` 的读取，
> 优先查 D1；D1 里没有就回退静态文件。**前台 URL 契约一个字都没变。**

### 你需要准备什么

- Tier1 已跑通（导入/核对/备份都是微信命令，走 worker）
- 一个 D1 数据库
- 会跑一条 node 命令（`tools/gen-import.mjs`）

### 一步步做什么

**1）建 D1 库**

```bash
npx wrangler d1 create my-site-data
```

记下返回的 `database_id`。然后在 `wecom-worker/wrangler.toml` 里补上绑定（**变量名必须是 `DB`**）：

```toml
[[d1_databases]]
binding = "DB"
database_name = "my-site-data"
database_id = "<上一步的 database_id>"
```

> 走 dashboard 粘贴部署的话，不用改 wrangler.toml：Worker → Settings → Bindings →
> 添加 **D1 database**，Variable name 填 `DB`。
>
> **没绑 `DB` = 完全不影响 Tier0/Tier1**：Functions 查不到 `env.DB` 就整站走静态，
> 两个档位的老行为原样保留。所以这一步不会把站点弄坏。

**2）建表（可选）**

worker 每次写入前都会自己 `CREATE TABLE IF NOT EXISTS`，正常不用手动建。
想先建好可以用：

```bash
npx wrangler d1 execute my-site-data --remote --file=wecom-worker/d1-schema.sql
```

表结构就一张：

```sql
files(path TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)
```

一行 = 旧仓库里的一个数据文件（`path` 如 `data/posts.js`、`data/content/<slug>.js`），
`body` 是文件全文——**逐字节一致**，所以前端拿到的内容和静态时代完全一样。

**3）生成导入快照**

```bash
node tools/gen-import.mjs
```

产物是仓库根目录的 `data-import.json`（`{generated, count, totalBytes, files:[{path, body}]}`）。
脚本会做两件事：按路径排序、检查单行是否超 D1 的 2MB 上限（超了直接报错退出）。

把 `data-import.json` **提交上去**：

```bash
git add data-import.json
git commit -m "chore: 生成 D1 导入快照"
git push
```

> ⚠️ 快照就是"生成那一刻"的数据。生成之后如果又发过文章，**必须重新生成再提交**，
> 否则导进去的是旧数据（有「核对D1」兜底能查出来）。

**4）导入 D1**

微信里发 **`导入D1`**。

worker 会从仓库拉 `data-import.json`，把每个文件 upsert 进 `files` 表，然后写一行
**`__meta/imported`** 标记。

**这行标记是全站的切换开关**：

| `__meta/imported` | Functions 行为 |
|---|---|
| **不存在** | 查不到就回退静态文件（迁移期双轨，站点永远有内容） |
| **存在** | D1 是唯一真相：查不到就 **404**，绝不回退 |

> 为什么有这条规则：D1 模式下删掉的文章，如果还允许回退静态文件，就会出现"删了还在"的
> 诈尸现象。**要退回静态模式，用微信「数据源GitHub」或后台数据源按钮删掉这行标记**，
> 不要手工去 D1 里删数据。

**5）核对**

发 **`核对D1`**：把快照与 D1 **逐行内容比对**（不是只看条数），列出缺失/不一致。
全绿再往下走。

**6）验证线上真的换了源**

```bash
curl -I https://<项目名>.pages.dev/data/posts.js
```

响应头应该是 `X-Data-Source: d1-authoritative`。

| 你看到 | 含义 | 怎么办 |
|---|---|---|
| `d1-authoritative` | D1 接管成功 | 完成 |
| `static` | 没走 D1：Functions 没部署 或 `DB` 没绑定 或 没有 `__meta/imported` | 依次检查绑定名、`_routes.json`、导入结果 |
| `static-d1-error` | D1 报错，自动降级（站点没挂） | 看 CF 日志；常见是表不存在或绑定名写成别的 |

**7）收尾（可选）**

- 仓库 `data/` 可以留着（当降级副本），也可以删掉——删掉后 D1 一挂就只剩 404。
  **建议留着**，`data/` 总大小通常只有几百 KB。
- 首次「备份D1」建议在核对通过后立刻发一次，把 `data-backup` 分支建起来
  （之后每天定时自动备份）。
- 备份分支**永远不要合并回 `main`**——GitHub 上那个 Compare & pull request 横幅直接忽略。

### 日常运维命令（微信里发）

| 命令 | 作用 |
|---|---|
| `数据源` | 当前是 D1 还是 GitHub + 备份状态 |
| `数据源D1` / `数据源GitHub` | 互斥切换（写/删 `__meta/imported`） |
| `备份D1` | 手动备份到 `data-backup` 分支（每日自动一次；量大分批，提示续传就再发一次） |
| `恢复D1` | D1 数据丢了从备份分支灌回（同样分批续传） |
| `备份结果` | 上次备份/恢复的结果（推送被拦时的兜底） |
| `导入D1` / `核对D1` | 迁移期工具，日常不用 |

> 完整的灾备流程、恢复演练步骤、限额表在 `docs/skill/` 里的技能包里
> （见 [`README.md`](../README.md) 文档索引）；不看技能包，上面这张表也够用。

---

## 常见问题

### 1）后台点发布报 CORS 错 / 请求根本没到 Worker

浏览器的跨域请求只要带自定义头（`x-admin-key` 就是），就会先发 `OPTIONS` 预检。
worker 必须在**所有路由之前**统一答 204，并带上 `Access-Control-Allow-Methods` 和
`Access-Control-Allow-Headers`（自定义头要列进去）。模板里的 worker 已经处理了。

**关键认知：本地 `curl` 调通 ≠ 浏览器能调通。** 排查 CORS 一律用浏览器 DevTools 的
Network 面板看那条 `OPTIONS`，别用 curl 自证清白。

### 2）微信收不到主动推送（错误码 60020）

企业微信应用消息受**可信 IP 白名单**限制，未加白时推送静默失败（`errcode 60020`），
你只会发现"没收到消息"。两个应对：

- 不要依赖推送做关键链路：发布/备份结果都落 KV，用 `结果` / `备份结果` 主动查；
- 发布失败时 worker 会写 `pubfail:`，你下一条指令开头会补播一次「⚠️ 上次发布失败：原因」。

### 3）"备份D1"回执正常，但没有结果 / 报 Too many subrequests

免费版**单次 Worker 调用最多 50 次子请求**。数据多时一次备份上传不完，任务被平台掐断。
正确行为（模板已实现）：**每批 30 个 blob + KV 游标续传**，回执提示"再发一次命令续传"。
看到提示就再发一次 `备份D1`，不要以为是 bug。

### 4）Windows 下导入/备份出现"所有文件都变了"

`autocrlf` 把工作区文件换成了 CRLF，而仓库存的是 LF → 每个文件都变成"假差异"。
仓库 `.gitattributes` 已设 `* text=auto`（存 LF）；**任何读工作区文件写进 D1/快照的脚本，
读进来先 `.replace(/\r\n/g, '\n')`**。`tools/gen-import.mjs` 走的是 `readFileSync(utf8)`，
在 Windows 上如果你手工改过数据文件，先确认没有 CRLF 混入：

```bash
git -c core.quotepath=false diff --stat    # 不该出现"整文件重写"
```

### 5）push 成功了，但线上还是旧的

Pages 的 Git 集成偶发漏触发构建。注意 CF 控制台的「**重试部署**」只重跑旧提交，
**不拉最新代码**——用它等于白等。正确做法是用一个空提交触发全新构建：

```bash
git commit --allow-empty -m "chore: 触发部署"
git push
```

然后**用线上地址实际打开**确认改动生效（别以"CI 绿了"为准）。

更省事的办法是用仓库自带的 `deploy.sh`：它比对线上文件 sha256 与 HEAD，不一致就自动空提交
并轮询到生效。首次用前在仓库根建 `deploy.env`（已被 `.gitignore` 忽略），写一行：

```
DEPLOY_BASE=https://<你的域名>
```

然后 `bash deploy.sh`（不一致自动修）/ `bash deploy.sh --check`（只查）/ `bash deploy.sh --force`
（强制重建）。Windows 可以直接双击 `deploy.bat`。

### 6）导入 D1 之后，某些文章 404 了

这是 `__meta/imported` 存在的**预期行为**：D1 是唯一真相，D1 里没有的就是没有。
两种修法：

- 数据确实应该在 → 重新 `node tools/gen-import.mjs` → 提交 → `导入D1`；
- 想临时回静态 → 发 `数据源GitHub`（删标记），Functions 立刻恢复回退行为。

### 7）改完 `worker.js` 怎么确认线上是新的

bump 顶部 `const BUILD`（例如改成 `20261103-1530`）→ 重新部署 → 访问
`https://<worker域名>/version`，返回的 `build` 与文件里的一致才算上线。
**BUILD 不 bump = 永远不知道自己看的是哪一版。**

### 8）我能不能不用企业微信，只用后台发文

能。Tier0 就是纯后台模式；Tier1 的 Worker 只是多一条"手机发文"的通道。
后台设置页里把 Worker 地址和 `ADMIN_KEY` 清空，就退回浏览器直连 GitHub 的模式。

---

## 排障顺序（一句话版）

**先确认哪一层坏了**：`/version`（worker 活着吗）→ `curl -I /data/posts.js`
（Functions/数据源对不对）→ 后台「测试连接」（写通道通不通）→ 再看微信侧回调。
从下往上查，比一上来翻 CF 日志快得多。
