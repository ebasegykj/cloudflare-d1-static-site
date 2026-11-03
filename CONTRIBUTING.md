# 协作须知（人看这里，AI 看 AGENTS.md）

这个仓库是一个"个人静态站"模板：Cloudflare Pages 出页面，数据放在 `data/`，
可选挂一个企业微信 bot 和一层 D1 数据库。你可以直接拿它当自己的站点用，也可以来改模板本身。

改代码只需要记住两句：

1. **只改代码，不碰数据。** `data/` 下任何文件都不要手改、不要 `git add -A`。
2. **动手前先拉取。** `git pull --rebase origin main`。

完整规则和原因见 [AGENTS.md](AGENTS.md)。

首次使用先启用提交检查（每个 clone 各一次）：

```bash
bash scripts/install-hooks.sh      # Windows 直接双击 scripts\install-hooks.bat
```

---

## 常见操作

| 想做什么 | 怎么做 |
|---|---|
| 把模板变成自己的站 | 见 [docs/SETUP.md](docs/SETUP.md) 第 0 章（5 步） |
| 接微信发文 / 接 D1 | 见 [docs/SETUP.md](docs/SETUP.md) 第 1、2 章 |
| 改页面样式 | 改 `assets/` 下的 css/js → `git add assets/xxx.css` → commit → push |
| 加/改文章 | **不要改文件**。用微信 bot 发，或打开 `admin.html` 发布 |
| 本地看效果 | 双击 `index.html`（数据是上次 pull 的快照） |
| 同步最新内容 | `git pull --rebase origin main` |
| 知道某个设计为什么这么怪 | [docs/PITFALLS.md](docs/PITFALLS.md) |

## 出错了

| 现象 | 原因 | 解决 |
|---|---|---|
| 提交被拒：「暂存区里有数据文件」 | 用了 `git add -A` | `git restore --staged data/` |
| 提交被拒：「落后 origin/main N 个提交」 | 没先 pull | `git pull --rebase origin main` |
| 推送被拒：non-fast-forward | 没先 pull | 同上，**绝不要 force push** |
| push 成功但线上没变 | Pages 漏了自动部署 | 空提交触发重建，见 `docs/SETUP.md` 常见问题 5 |
| 线上文章少了 | 数据被旧副本覆盖 | 见 AGENTS.md 第 7 节，用 Revert 还原 |

---

## 想改模板本身（提 PR）

欢迎，但模板的"克制"是它的价值，改动请守住边界：

1. **一个 PR 一件事。** 顺手重排文件、顺手改文案、顺手升级依赖，请拆开。
2. **不引入构建步骤。** 模板的卖点是"零构建、推上去就能跑"——不要加 webpack / vite /
   npm build 之类的环节。能用原生 JS 解决的不要加依赖。
3. **不引入必须付费或必须注册的外部服务。** 免费额度内能跑完 Tier0 是硬要求。
4. **改了行为就同步文档。** 改了数据契约 → 更新 `docs/FRONTEND-GUIDE.md` 与
   `docs/SITE-STANDARD.md`；改了部署步骤 → 更新 `docs/SETUP.md`；
   修了 bug → 按四段式在 `docs/PITFALLS.md` 补一条（**这是提交的一部分**）。
5. **不提交真实站点的痕迹。** 你的站名、域名、token、文章内容、图片外链一律不要进 PR；
   demo 数据用占位内容。
6. **改 `wecom-worker/worker.js` 必须**：bump `BUILD`、跑 `cd wecom-worker && node test.mjs`
   全绿、在 PR 描述里贴测试结果。

### PR 前自查

```bash
cd wecom-worker && node test.mjs          # 只有改了 worker 才需要
git status                                # 暂存区里不该有 data/
git -c core.quotepath=false diff --stat   # 没有"整文件重写"这种假差异
```

提交信息用中文，一句话说清改了哪个页面 / 哪个功能。

## 报告问题

请带上：你走到哪一步（Tier0/1/2）、期望发生什么、实际发生什么、以及能复现的最小操作。
涉及后台/Worker 的问题，附上浏览器 Network 里那条失败请求的状态码与响应体
（**贴之前删掉 token、ADMIN_KEY、企业微信 secret**）。

## License

见 [LICENSE](LICENSE)。提交 PR 即表示同意以同一许可证分发你的贡献。
