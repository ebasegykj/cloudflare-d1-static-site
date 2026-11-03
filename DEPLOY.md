# 部署指南（DEPLOY）

> 面向"把站点放上线"和"改完代码确保真的上线了"两件事。
> 第一次接入、想看每一步的验收标准，读 [`docs/SETUP.md`](docs/SETUP.md)；本文只讲部署动作本身。

## 架构

```
Tier0  GitHub 仓库 ──(Push)──→ Cloudflare Pages ──→ 浏览器
                                    ↑
                              data/*.js 静态文件

Tier1  企业微信 ──回调──→ Worker(你的 bot) ──写──→ GitHub / D1
                                    │                    │
                                    └──→ 后台 /admin.html ←┘
                                          ↓
                                    Pages 重新构建（Tier0/1）或即时生效（Tier2）
```

三样东西的部署方式各不相同，**别混**：

| 东西 | 怎么"上线" | 生效时间 |
|---|---|---|
| 站点代码（`index.html`、`assets/`） | push 到 `main`，Pages 自动构建 | 约 1 分钟 |
| 数据（`data/*.js`） | bot / 后台写入，commit 到 `main` | 约 1 分钟 |
| Worker（`wecom-worker/worker.js`） | CF 控制台重贴代码 或 `wrangler deploy` | 立即（几秒） |

---

## 一、建仓库（一次性）

1. GitHub 新建仓库（名字随意，可以 Private；Pages 支持 Private 仓库）
2. 推代码上去：

```bash
git init
git add .
git commit -m "init: 从模板初始化"
git remote add origin https://github.com/<你的用户名>/<你的仓库名>.git
git branch -M main
git push -u origin main
```

> 这是**唯一**可以 `git add .` 的时机（还没有任何线上数据）。

## 二、连接 Cloudflare Pages（一次性）

1. CF 控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选仓库，构建设置：

| 项 | 填什么 | 为什么 |
|---|---|---|
| Framework preset | **None** | 没有构建框架 |
| Build command | **留空** | 纯静态，不需要构建 |
| Build output directory | **/** | 站点在仓库根目录 |

3. **Save and Deploy**。1 分钟后拿到 `https://<项目名>.pages.dev`
4. 想用自己的域名：Pages 项目 → **Custom domains** → 添加 → 按提示改 DNS

> 仓库根目录的 `_routes.json` 只把 `/data/*` 交给 Functions，其余路径纯静态。
> **不要**为了"让某种路由生效"往里加 `/` 或 `*`——免费额度会被 Functions 调用吃光，
> 而且静态资源会多绕一层。

## 三、部署 Worker（Tier1 才需要）

完整变量清单见 [`docs/SETUP.md`](docs/SETUP.md) 第 1 章。这里只说部署动作。

### 方式 A：控制台粘贴（不需要本地环境）

1. **Workers & Pages** → **Create** → **Create Worker** → Deploy
2. **Edit code** → 全删 → 粘贴 `wecom-worker/worker.js` 全文 → **Deploy**
3. **Settings → Bindings** 加 KV：变量名必须叫 **`KV`**
4. **Settings → Variables and Secrets** 加变量（全部选加密）
5. 改完代码要重新上线时：**Edit code → 再粘一次 → Deploy**（没有任何自动同步）

### 方式 B：wrangler（改得勤时更省事）

```bash
cd wecom-worker
npx wrangler login
npx wrangler deploy
```

`wrangler.toml` 里已配好 `name`、`main`、cron、KV 与 D1 绑定占位
（`PASTE_KV_ID_HERE` 换成你自己的 id）。密钥**不要**写进 `wrangler.toml`：

```bash
npx wrangler secret put GH_TOKEN
npx wrangler secret put CORP_SECRET
# … 逐个按 docs/SETUP.md 的清单来
```

### 两种方式共同的规矩

- **改 `worker.js` 必须 bump 顶部 `const BUILD`**，否则无法确认线上跑的是哪一版
- 部署后访问 `https://<worker域名>/version`，返回的 `build` 与文件里一致才算真的上线
- 改完必须跑测试：`cd wecom-worker && node test.mjs`

## 四、部署验证（push 了但线上没变？）

**永远以线上为准，不以"CI 绿了"为准。**

| 验证对象 | 怎么做 | 正确结果 |
|---|---|---|
| 站点代码 | 浏览器打开线上地址，看改动是否可见 | 改动已生效 |
| 数据源 | `curl -I https://<域名>/data/posts.js` | Tier0/1：`X-Data-Source: static`；Tier2：`d1-authoritative` |
| Worker | 打开 `https://<worker域名>/version` | `build` 与 `worker.js` 顶部 `BUILD` 一致 |
| 后台写通道 | admin.html → 设置 → **测试连接** | 显示连接成功（D1 模式还会显示 build 与库状态） |

**Pages 漏了自动部署怎么办**（症状：push 成功、线上还是旧的）：

```bash
git commit --allow-empty -m "chore: 触发部署"
git push
```

空提交会触发一次全新构建。**不要用 CF 控制台的「重试部署」**——它只重跑旧提交，
不拉最新代码，用了等于白等。

若仓库带了 `deploy.sh`（比对线上文件 sha256 与 HEAD，不一致自动空提交并轮询到生效）：

```bash
# 首次使用：在仓库根建 deploy.env（已被 .gitignore 忽略），内容一行：
#   DEPLOY_BASE=https://<你的域名>

bash deploy.sh          # 不一致就自动拉起部署并等待
bash deploy.sh --check  # 只查不改，适合放进日常巡检
bash deploy.sh --force  # 跳过比对，强制触发一次构建
```

站点域名写在 `deploy.env` 里，不会进仓库；Windows 也可以双击 `deploy.bat`。

## 五、回滚

| 场景 | 做法 |
|---|---|
| 代码改坏了 | GitHub 上找到上一个好 commit → **Revert** → push，Pages 自动重建 |
| 数据被旧副本覆盖 | 同上 Revert（bot 每次发布是独立 commit，可精确回滚） |
| Worker 改坏了 | CF → Worker → **Deployments** → 选上一个版本 → **Rollback** |
| D1 数据坏了 | 微信发 `恢复D1`（从 `data-backup` 分支灌回）→ `核对D1` 验证 |

> Worker 回滚后**别忘了** BUILD 会跟着退回去；下次改代码前重新 bump 到一个更大的值。

## 六、安全

### 密钥放哪（红线）

| 密钥 | 唯一合法位置 |
|---|---|
| 企业微信 `CORP_SECRET` / `WECOM_TOKEN` / `WECOM_AESKEY` | Worker 环境变量（加密） |
| `GH_TOKEN` | Worker 环境变量；Tier0 模式下可存在**你自己的浏览器 localStorage** |
| `ADMIN_KEY` | Worker 环境变量 + 后台设置页 |
| `TMDB_KEY` / `IMG_TOKEN` | Worker 环境变量（TMDB 的公开 key 例外，见 `data/tmdb.js`） |

**这些值永远不进仓库、不进前端代码、不进截图。** 一旦误提交：立刻在对应平台吊销重发，
不要试图"从历史里删掉"——历史是公开的。

### 后台的两层（可选）

1. **页面口令**（`data/admin-lock.js`，纯前端遮挡）：只挡"随手点进来的人"，
   懂技术的人看源码能绕过。改法：把新密码的 SHA-256 填进 `hash`。
2. **Cloudflare Access**（真正的锁）：Zero Trust → Access → Applications →
   Self-hosted → 域名选 `*.pages.dev`、Path 填 `admin.html` → 策略 Allow 只允许你的邮箱。
   开启后没有邮箱验证码连页面都打不开。

### 仓库可见性

Private 仓库也能部署 Pages，源码不外露；代价是别人看不到你的站（也没关系）。
**无论仓库是否公开，密钥都不该在里面**——公开仓库会被爬虫扫 token。

## 七、日常发布节奏

```
写内容 → 微信「发」→「确认」/ 后台发布 → 约 1 分钟后线上可见
改代码 → git add <具体文件> → commit → push → 约 1 分钟重建 → 打开线上确认
改 worker → bump BUILD → 跑 test.mjs → 部署 → 打开 /version 核对
```

三件事都有自己的"生效确认动作"，**没有一件事是"push 完就当成了"**。
这条纪律的来源见 [`docs/PITFALLS.md`](docs/PITFALLS.md)。
