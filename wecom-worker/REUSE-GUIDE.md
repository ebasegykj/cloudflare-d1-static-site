# 微信发文章 Bot · 小白部署指南

> **这是什么**：在企业微信里发消息，就能往你的静态网站上发文章/图片/瞬间的机器人。
> 发「文」→ 暂存 → 发「发」看清单 → 回「确认」→ 自动提交到你的 GitHub 仓库 → 网站约 1 分钟后自动更新。
>
> **你会拿到**：一个 `worker.js` 文件（本指南同目录）。所有修改都在这一个文件里，用记事本或 VSCode 打开就能改。
>
> **前提**：你的网站托管在 Cloudflare Pages 上、代码在 GitHub 仓库里（就是"改完仓库网站自动更新"那种）。
> 不用买服务器，全部免费。

---

## 准备清单（开始前确认都有）

| 需要 | 去哪拿 |
|---|---|
| 企业微信**管理员**权限 | 你公司/个人的企业微信后台 |
| GitHub 账号（仓库主人） | github.com |
| Cloudflare 账号 | dash.cloudflare.com（网站已在 CF Pages 上就有了） |
| 一个图床（可选，想发图就要） | 任何支持匿名上传、返回图片链接的图床 |

---

## 第 1 步：生成 GitHub 令牌（5 分钟）

1. 打开 github.com，登录，点右上角**头像 → Settings**
2. 左侧菜单拉到最底，点 **Developer settings**
3. **Personal access tokens → Fine-grained tokens → Generate new token**
4. 填写：
   - Token name：随便，如 `wecom-bot`
   - Expiration：建议 90 天或 1 年（到期要重新生成）
   - Repository access：选 **Only select repositories**，选中你要发的那个仓库
   - Permissions → Repository permissions → 找到 **Contents** → 选 **Read and write**
5. 点 Generate token，**立刻复制**保存（这个串只显示这一次）

## 第 2 步：企业微信创建应用（5 分钟）

1. 打开 work.weixin.qq.com 管理后台 → **应用管理 → 创建应用**（名字随意）
2. 进入应用详情页，记下两个值：
   - **AgentId**（一串数字）
   - **Secret**（点「查看」，会发送到你微信，复制保存）
3. 左侧 **我的企业 → 企业信息**，拉到最底，记下 **企业ID**（CorpID）

> ⚠️ 这个应用**不要**去配置「企业可信IP」。不影响文字消息；直接发图片本来就被微信限制（见文末常见问题）。

## 第 3 步：Cloudflare 创建 Worker（10 分钟）

1. 登录 dash.cloudflare.com → 左侧 **Workers & Pages → Create** → 选 **Create Worker** → Deploy（名字随意，如 `my-bot`）
2. 点 **Edit code（编辑代码）**：把右侧默认代码**全选删掉**，把 `worker.js` 的全部内容粘贴进去 → 右上角 **Deploy**
3. 回到 Worker 页面 → **Settings → Bindings → Add**：
   - 先去 **Storage & Databases → KV → Create namespace** 建一个（名字如 `my-bot-kv`）
   - 回到 Bindings，加一条：类型选 **KV namespace**，**变量名必须填 `KV`**，选刚建的命名空间 → Deploy
4. **Settings → Variables and Secrets → Add**：类型 Text，变量名 `CONFIG`，值先空着（第 5 步填）→ Deploy
5. **Settings → Triggers → Cron Triggers**：如果里面有定时规则，**删掉**（本机器人的发布只由你发「确认」触发，不需要定时）

> 先别关这个页面，后面还要回来贴 CONFIG。

## 第 4 步：改代码里的 4 个「适配点」（核心步骤）

用 VSCode/记事本打开 `worker.js`，**Ctrl+F 搜索「适配点」**，共 4 处，每处上面都有 `★★★` 注释说明。

改之前先做一件事：打开你网站现在的数据文件（就是存文章内容的那个 js/json），**复制一条真实的记录**放旁边对照。

| 标记 | 是什么 | 怎么改 |
|---|---|---|
| ★适配点1 | 内容存到仓库哪个文件 | 把 `data/moments.js` 之类换成你的文件名；`HEADERS` 里的字符串换成你数据文件的**第一行**（原样照抄） |
| ★适配点2 | 微信消息 → 你网站条目的字段映射 | `stagePost()` 里拼的 `title/content/date…` 字段名，对照你那条真实记录改。只想要文章？把「瞬间：搜索与确认」**整节删掉**，再删 `handleText` 里的瞬分支 |
| ★适配点3 | 观影图鉴专属的统计重算 | 你的网站没有就**删掉那一行**和 `buildDays` 函数本体 |
| ★适配点4 | 图床地址 | `img.example.com` 换成你自己的图床（要求：支持匿名 POST 上传，返回 `[{"src":"/file/xxx"}]` 格式）。没有图床就删掉 `uploadToImgbed` 函数和图片消息分支，图片只支持贴链接 |

改完把文件**重新粘贴到 CF Worker 编辑器 → Deploy**。

> 😵 看不懂适配点？把「你数据文件里的一条真实记录」发给写这个 bot 的人，几分钟就能帮你改好，你只负责后面两步。

## 第 5 步：企业微信配置回调 + 填 CONFIG（两个页面来回一次）

**① 先在企业微信拿到三个值（先别点保存！）：**

应用详情 → **接收消息 → 设置 API 接收**：

- URL 填：`https://你的worker名.你的CF子域.workers.dev/wecom`（在 Worker 的 Settings → Domains 里能看到完整地址，**末尾必须加 /wecom**）
- 点 **Token** 的「随机获取」→ **复制**
- 点 **EncodingAESKey** 的「随机获取」→ **复制**

**② 回 CF 填 CONFIG：**

Variables 里编辑 `CONFIG`，填**一整行**（不能有换行），逐字段对照：

```json
{"CORP_ID":"第2步的企业ID","AGENT_ID":"第2步的AgentId","CORP_SECRET":"第2步的Secret","WECOM_TOKEN":"刚复制的Token","WECOM_AESKEY":"刚复制的EncodingAESKey","GH_TOKEN":"第1步的令牌","REPO":"你的GitHub用户名/仓库名"}
```

> 可选字段（按需追加进同一行 JSON）：`TMDB_KEY`（发「瞬」搜电影用，themoviedb.org 申请）、`IMG_TOKEN`（图床要鉴权时填）、`ADMIN_KEY`（管理后台 D1 直写口令）、`SITE_URL`（站点域名，默认按 CF Pages 域名拼图片链接）。不填则用对应默认行为。

填完点 **Deploy**（不是只点保存）。

> 可选字段（用不到就不填）：`TMDB_KEY`（用「瞬」记观影需要，themoviedb.org 免费申请）、`SITE_URL`（站点域名，图片搜索结果拼可点链接用）、`IMG_TOKEN`（图床开了鉴权才填）。想用 D1 当数据库再加一个 Storage → D1 绑定，变量名 `DB`。

**③ 回企业微信点「保存」**——这时 CF 上已经有同一套密钥了，应该直接保存成功。

> ⚠️ 两个页面的 Token/AESKey 必须**复制粘贴**，不要手打——`O/0`、`l/1` 肉眼分不出来，打错一个就报"解密失败"。

## 第 6 步：验收

1. 在企业微信（或微信插件）里给应用发：**帮助** → 应收到指令说明
2. 发：`文` 换行 `测试标题` 换行 `正文内容` → 应回「已暂存文章」
3. 发：**发** → 收到待发清单 → 回：**确认** → 回「🚀 已发布」
4. 打开 GitHub 仓库，应看到新提交「微信发布：1 条」；约 1 分钟后网站上能看到

---

## 日常怎么用

| 你发什么 | 效果 |
|---|---|
| `文`⏎标题⏎正文（可多行） | 发布成文章 |
| 正文里贴 `https://...jpg` 或图床链接 | 自动变成**内嵌图片** |
| 贴 `.mp4` / `.mp3` 链接 | 自动变成**播放器** |
| 贴 `.pdf` / `.zip` 链接 | 变成 📎 下载链接 |
| 贴普通网址 | 变成可点击链接 |
| `撤回` | 撤掉最后一条暂存 |
| `清空` | 清空暂存区（发错了用） |
| `发` → 看清单 → `确认` / `取消` | 推送或放弃 |

**不需要 Markdown**，就像平时打字一样，链接直接贴在文字中间。

---

## 出错了怎么办（对照表）

| 症状 | 原因 | 处理 |
|---|---|---|
| 企业微信保存回调失败 / 日志报"解密失败" | 两边 Token/AESKey 不一致 | 重新复制粘贴，CF 重新 Deploy 后再保存 |
| 发消息没任何反应 | URL 少了 `/wecom`，或 CONFIG 没部署 | 检查回调 URL；CF 确认 CONFIG 已 Deploy |
| 发布失败 404 Not Found | 仓库路径写错 | Git 路径相对**仓库根**。本地进仓库目录执行 `git rev-parse --show-toplevel` 看根在哪 |
| 发布失败 GitHub 401 | 令牌过期或没 Contents 写权限 | 重新生成第 1 步的令牌，更新 CONFIG |
| 图片是坏的 / 打开是一段文字 | 贴的链接不是图片本身 | 确认链接直接打开就是图片 |
| 直接发图片报 60020 | 企业微信限制服务器下载媒体，**架构上无解** | 改用图床：手机上传图床 → 发链接 |
| 确认后没反应 | 暂存是空的 | 先发内容再发「发」 |

---

## 安全提醒

- `CONFIG` 里全是钥匙（Secret/令牌），**别截图发给别人**
- GitHub 令牌只给了单个仓库的 Contents 权限，泄露了影响也有限，但发现泄露要立刻去 GitHub 删掉重新生成
- 修改令牌/AESKey 后，记得两边同步更新（企业微信后台 + CF 的 CONFIG）
