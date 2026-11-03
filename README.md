# 我的小站 · 静态站模板

> 一个**零构建**的个人站模板：Cloudflare Pages 托管，数据是仓库里可读的 `.js` 文件，
> 想进阶可以挂一个企业微信 bot 在手机上发文，再往上可以接 Cloudflare D1 当数据库。
>
> 文章 / 瞬间 / 观影记录 / 待办 / 图片墙 / 友链，一套就够。

**三句话定位**：不用买服务器、不用装 node_modules、不用学框架。
clone 下来连上 Cloudflare Pages 就能访问；觉得够用了就停在那儿，一句话都不用再配。

<!-- 截图：想放预览图，把图片放到 docs/ 下（如 docs/preview.png），再在这里加一行 <img src="docs/preview.png" alt="首页" width="720"> -->

---

## 架构

```
                        ┌─────────────────────────────┐
   浏览器 ────────────→ │  Cloudflare Pages            │
                        │  index.html + assets/        │
                        │  /data/*.js  ← 静态数据文件   │
                        └──────────────┬──────────────┘
                                       │ 写（Tier0：浏览器直连 GitHub API）
                                       │ 写（Tier1：走 Worker）
                        ┌──────────────┴──────────────┐
                        │  GitHub 仓库（main 分支）     │
                        │  = 站点本体，push 即发布      │
                        └──────────────┬──────────────┘
                                       │
   ┌───────────────────┐   回调 /wecom │
   │ 企业微信自建应用    │ ──────────────┤
   └───────────────────┘               │
                        ┌──────────────┴──────────────┐
                        │  Worker（可选，Tier1）        │
                        │  收微信消息 → 暂存 → 发布      │
                        │  /api/admin/* 给后台用        │
                        └──────────────┬──────────────┘
                                       │ 写（Tier2：数据进库，发布不再触发部署）
                        ┌──────────────┴──────────────┐
                        │  Cloudflare D1（可选，Tier2） │
                        │  files(path, body)           │
                        └──────────────┬──────────────┘
                                       │ 读（Pages Functions 接管 /data/*）
                                       └──→ 响应头 X-Data-Source 标注数据源
```

**关键点**：无论走到哪一档，前台的 URL 和全局变量名**一个字都不变**
（`data/posts.js` → `window.POSTS`）。所以你可以先用 Tier0 跑半年，再无声无息地升到 Tier2。

---

## 三档能力

| | **Tier0 开箱即跑** | **Tier1 微信发布** | **Tier2 D1 数据层** |
|---|---|---|---|
| **你需要准备** | GitHub 账号、Cloudflare 账号 | Tier0 + 企业微信（自建应用） | Tier1 + 一个 D1 数据库 |
| **你要做** | 推仓库、Pages 连仓库（5 步，约 10 分钟） | 建 Worker、配 8~10 个环境变量、配微信回调 | `wrangler d1 create`、生成快照、微信发「导入D1」 |
| **你会得到** | 线上静态站 + 浏览器后台写文章 | 在微信里发「文」→「确认」就发布 | 数据存数据库，发布**即时生效**、不再消耗 Pages 构建次数 |
| **谁在写数据** | 浏览器 → GitHub API | Worker → GitHub API | Worker → D1 |
| **发布延迟** | 约 1 分钟（触发一次构建） | 约 1 分钟 | 秒级（刷新页面即见） |
| **不要它会怎样** | — | 只能在电脑上打开后台发文 | 数据量大了以后每次发布都触发构建；备份只能靠 git 历史 |
| **可以跳过吗** | 不能 | 能，随时再加 | 能，随时再加 |

成本：三档都在 Cloudflare / GitHub 免费额度内。个人站的量级通常连 1% 都用不到
（限额表见 [`docs/PITFALLS.md`](docs/PITFALLS.md) 最后一节）。

---

## 快速开始（Tier0，五步）

**1）拿到一份自己的仓库**

GitHub 上点 **Use this template** → 创建新仓库（Private 也行）。

**2）本地拿到一份代码（可选）**

想改样式/文案才需要本地副本；只发文的话可以完全在网页上操作。

```bash
git clone https://github.com/<你的用户名>/<你的仓库名>.git
cd <你的仓库名>
```

> **零部署先看效果**：clone（或 Download ZIP 解压）后直接**双击 `index.html`**，
> 浏览器里就能看到完整站点——demo 文章、瞬间、待办都在，数据加载全部走本地文件，
> 不需要任何服务器。局限：在线后台的写入功能和「每日一句」外链在本地不可用，
> 想发文还得走第 3）步部署。（后台 `admin.html` 也能本地打开看界面，但设置会与
> 其他本地页面共享浏览器存储，见下方「管理后台默认密码」一节。）

**3）Cloudflare Pages 连仓库**

CF 控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 选仓库：

```
Framework preset      : None
Build command         : （留空）
Build output directory: /
```

**4）等 1 分钟，打开 `https://<项目名>.pages.dev`**

首页应该能看到模板自带的 demo 内容（示例文章、瞬间、图片墙）。想换成自己的：
改 `data/meta.js` 里的站名/副标题，`data/posts.js` 等文件用后台改（**不要手改**，见下）。

**5）配后台，发第一篇**

GitHub → Settings → Developer settings → **Fine-grained tokens** → Contents 权限
**Read and write** → 生成后打开 `https://<项目名>.pages.dev/admin.html` → 设置页填
用户名 / 仓库名 / `main` / Token → **测试连接** → 发文章。

> 验证接入是否成功：`curl -I https://<项目名>.pages.dev/data/posts.js`
> 应返回 `200` 且响应头有 `X-Data-Source: static`。

细节、每一步的验收标准、以及 Tier1/Tier2 的完整步骤：
👉 [`docs/SETUP.md`](docs/SETUP.md)

---

## 在线示例

**https://www.hehyc.com** —— 本模板的真实部署（内容为演示数据）。
你也可以 fork / Use this template 后两分钟部署出自己的同名站点，步骤就是上面的「快速开始」。

---

## 管理后台默认密码

- **本模板没有账号概念，只有一个访问口令**：默认 `admin123`（定义在
  `data/admin-lock.js` 的 `pass` 字段）。它只是「挡住随手点进来的人」的前端门锁，
  明文随仓库公开——**这不是安全边界**，真正的安全靠 GitHub Token 权限（改不了内容）。
- **改密码**：编辑 `data/admin-lock.js` → 改 `pass: '你的新口令'` → 提交推送即可，
  前台与后台无需其他改动。上线后第一件事就建议改掉它。
- **GitHub 设置页（后台 → 设置）**：模板默认值为空、占位符是 `your-username` /
  `your-repo`，填你自己刚建的仓库和 Token。注意这些值保存在**浏览器 localStorage**：
  如果你用 `file://` 方式本地打开 `admin.html`，浏览器会在所有本地页面间共享这份
  存储，可能显示你其他站点存过的配置——换台电脑或部署到线上域名后即为全新配置。

---

## 仓库结构

```
.
├── index.html                入口页（唯一的 HTML）
├── admin.html                在线后台：发文/发瞬间/管理，纯前端
├── _routes.json              只把 /data/* 交给 Functions，其余纯静态
├── _redirects                把 DEPLOY.md 挡在站外（文档不该被访问到）
│
├── assets/                   前台代码（无构建、无依赖、直接跑）
│   ├── app.js                路由 + 各页面渲染 + 按需加载数据
│   ├── style.css             全站样式（含暗色）
│   ├── admin.js / admin.css  后台逻辑与样式
│   └── default-cover.svg     无封面时的占位图
│
├── data/                     ★ 运行时数据：只读、禁止手改、禁止 git add
│   ├── meta.js               站点信息（SITE_META）
│   ├── posts.js              文章列表（POSTS，无正文）
│   ├── content/<slug>.js     文章正文，一篇一文件
│   ├── moments.js            瞬间年份清单
│   ├── moments-YYYY.js       瞬间年卷（按年拆，用到才拉）
│   ├── catalog.js            瞬间名录（查重 + 站内搜索）
│   ├── todos.js              待办
│   ├── photos.js             图片墙
│   ├── links.js              友链
│   ├── watch-meta.js         观影/读书统计
│   ├── days-YYYY.js          观影天索引（按年拆，自动重算）
│   ├── tmdb.js               影视搜索用的公开 key
│   └── admin-lock.js         后台访问口令（明文，默认 admin123，上线必改）
│
├── functions/data/[[path]].js  数据输出层：优先 D1，没有就回退静态文件
├── tools/gen-import.mjs        生成 data-import.json（Tier2 一次性迁移用）
├── wecom-worker/               微信 bot（可选部署）
│   ├── worker.js               全部逻辑都在这一个文件里
│   ├── test.mjs                测试（改 worker 必跑）
│   ├── d1-schema.sql           D1 表结构（就一张表）
│   └── wrangler.toml           命令行部署配置
├── scripts/git-hooks/          本地钩子：拦住"提交数据文件"和"没先 pull"
├── deploy.sh / deploy.bat      部署验证：比对线上与 HEAD，漏部署就空提交拉起
│
├── docs/                       文档（见下）
├── LICENSE                     MIT
└── .github/workflows/guard-data.yml   服务端兜底：混合提交自动撤回数据
```

**只有 `data/` 是数据，其他都是代码。** 这条界线是这个模板唯一的强约束，
理由和后果见 [`AGENTS.md`](AGENTS.md)。

---

## 文档索引

| 文档 | 什么时候读 |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | **接入必读**。Tier0/1/2 三章，每章「准备什么 / 怎么做 / 怎么验证」+ 常见问题 |
| [`DEPLOY.md`](DEPLOY.md) | 部署动作、部署验证、回滚、密钥放哪、Cloudflare Access 加锁 |
| [`docs/FRONTEND-GUIDE.md`](docs/FRONTEND-GUIDE.md) | 改前台：数据接口清单（URL → 全局变量）、编码规则、可改/禁改 |
| [`docs/PITFALLS.md`](docs/PITFALLS.md) | 踩坑实录（现象/根因/规则/验证四段式）。**改代码前扫一遍** |
| [`docs/SITE-STANDARD.md`](docs/SITE-STANDARD.md) | 数据语义差异的唯一登记处（`SITE_SPEC`）；想加第二个站点时必读 |
| [`AGENTS.md`](AGENTS.md) | 给 AI 与协作者的硬规则（仓库纪律 + 铁律十条） |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 想改模板本身、提 PR |
| [`docs/skill/cf-d1-static-site.zip`](docs/skill/cf-d1-static-site.zip) | **D1 运维方法论技能包**：灾备/恢复/限额/核对流程的成套说明。WorkBuddy 用户可直接安装使用；不用 WorkBuddy 的话，读 [`docs/SETUP.md`](docs/SETUP.md) 第 2 章 + [`docs/PITFALLS.md`](docs/PITFALLS.md) 就够 |

---

## 设计取舍（为什么不是 xxx）

- **为什么不用框架/构建**：站点只有一个 HTML 和几个 JS，构建步骤带来的收益（组件化、
  热更新）在这里抵不过"推上去就能跑"的价值。没有 `npm install`，就没有依赖腐烂。
- **为什么数据是可读的 `.js`**：你想手改一行文案、想用 grep 搜自己的文章、想退款到
  三年后还能看懂——文本文件是最长命的格式。
- **为什么坚持"数据与代码分家"**：`data/` 由 bot 和后台写，`其他` 由你和 AI 写。
  两边混着改就会互相覆盖（真实事故，见 PITFALLS 第 2 节）。
- **为什么保留静态回退**：D1 挂了站点不应该挂。`functions/data/[[path]].js` 在 D1
  异常时会自动回退读仓库里的静态副本，只多一个响应头标注。

---

## License

[MIT](LICENSE) —— 随便用、随便改、商用也行，保留版权声明即可。

**免责声明**：模板不附带任何担保。站点内容、第三方服务（GitHub / Cloudflare / 企业微信 /
图床）的可用性与费用、以及密钥泄露造成的后果，由使用者自行承担。
上线前请自行确认所在地区对内容托管的相关要求。
