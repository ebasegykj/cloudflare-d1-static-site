# 前台交付说明（给写前台代码的人）

> 读这一份就够。改样式、改交互、加页面随便来——**数据契约不动，数据也不会丢**。

## 架构一句话

- **Tier0（没接 D1）**：`/data/*` 就是仓库里的静态 `.js` 文件，Pages 直接发。
- **Tier2（接了 D1）**：Pages Functions 在服务端接管 `/data/*`，从 D1 读出来、按**同样的
  旧格式**输出，响应头标注数据源。

两种情况下**前台的 URL、文件名、全局变量名完全一致**。前台代码不需要知道自己跑在哪一档，
也不允许为此写分支。

## 数据接口清单

全部是「挂全局变量的 JS 文件」，**不是 JSON**——用 `<script>` 引入或 `injectScript()` 后直接读
全局变量，不要 `fetch` 回来 `JSON.parse`。

### `index.html` 静态引入（首屏就要用）

| URL | 挂载的全局变量 | 内容 |
|---|---|---|
| `data/meta.js` | `SITE_META` | 站名、副标题、起始年份、头像 |
| `data/watch-meta.js` | `WATCH_META` | 影视/图书统计（总数、分钟数、年份列表） |
| `data/posts.js` | `POSTS` | 文章列表（**无正文**） |
| `data/links.js` | `FRIEND_LINKS` | 友链 |
| `data/photos.js` | `PHOTO_WALL` | 图片墙 |

### `assets/app.js` 里 `injectScript()` 动态加载（用到才拉）

| URL | 挂载 | 说明 |
|---|---|---|
| `data/catalog.js` | `MOMENT_CATALOG` | 瞬间名录（`{年份:[片名]}`，查重与站内搜索用） |
| `data/todos.js` | `TODOS` | 待办（想看/想读/日常） |
| `data/moments.js` | `MOMENTS_YEARS` | 瞬间年份清单（几百字节） |
| `data/moments-<YYYY>.js` | `MOMENTS_PARTS["YYYY"]` | 瞬间年卷，用到哪年拉哪年 |
| `data/days-<YYYY>.js` | 合并进 `WATCH_DAYS` | 观影天索引，按年拆分 |
| `data/content/<slug>.js` | `POST_CONTENT[slug]` | 文章正文，一篇一文件 |

> `data/tmdb.js`（`TMDB_KEY`）与 `data/admin-lock.js` 只给管理后台用，前台不要引。

### 编码规则（踩过坑，别改）

- **`data/content/` 的 slug 必须 `encodeURIComponent`，而且只编码 slug 本身**：
  正确 `data/content/${encodeURIComponent(slug)}.js`；
  错误 `encodeURIComponent('data/content/' + slug + '.js')`——全路径编码会让请求落到
  静态回退、拿到旧数据。
- **仓库里的文件名是原始 slug**（可以是中文，中文算 Letter，文件名安全）。
  编码只发生在浏览器请求的 URL 上，不发生在 GitHub 路径上。

### 响应头（判断数据源用）

| `X-Data-Source` | 含义 |
|---|---|
| `d1-authoritative` | D1 是权威数据源，返回的是最新内容 |
| `static` | 静态回退（没接 D1，或 D1 里还没有这份文件） |
| `static-d1-error` | D1 异常，自动降级读静态副本（站点不会挂，但数据可能旧） |

所有数据响应都带 `ETag`，`If-None-Match` 命中回 304，前端不需要自己加缓存参数。
后台设置页的数据源徽章就是读这个头——**新增数据路径时如果漏带这个头，徽章会误报**。

## 列表加载策略与扩容边界（实测后决定：暂时不做分页）

**现状：文章列表全量渲染，不做分页。**

- `data/posts.js` 只存摘要（无正文），首屏 `<script>` 直接引入，`viewPosts()` 一次性渲染全部卡片
- 正文才是懒加载（点开某篇才 `injectScript('data/content/<slug>.js')`）
- 封面 `<img loading="lazy">` 交给浏览器原生长图懒加载

**实测（27 篇，headless 真渲染）**：全量构建 innerHTML 约 **2ms**、整页 DOM 约 43KB。人体感知阈值 100ms，余量 50 倍——现在加分页收益为 0，只增状态机复杂度。

**触发条件：`posts.js` 超过约 300 篇时再改，改法如下（不要只在前端切片）**

1. 先把 `posts.js` 按年拆分（`data/posts-YYYY.js`），学 `data/moments-YYYY.js` 的分年卷做法——那时 200KB+ 单文件传输才是真瓶颈
2. 再做渲染层分页：首屏 N 条 + 「加载更多」按钮，**不要用 1/2/3 页码**（博客是滚动浏览，页码要往 hash 路由塞状态、返回列表会丢滚动位置）
3. 分页状态存模块级，否则点进文章再返回会被打回第一页

## 数据怎么更新（前台不用管，但要知道边界）

- 唯一写入通道：微信 bot 或在线后台 → 写 D1（Tier2）或直接提交仓库（Tier0）
- Tier2 下发完内容刷新页面即可见，**不触发部署**
- 仓库里的 `data/` 在 Tier2 之后只是历史快照 / 降级副本，**会逐渐变旧，不要拿它做业务判断**
- 前台代码提交 → Pages 部署 → 只替换代码，**不碰 D1 一个字节**

## 可以自由做 / 禁止做

✅ 改样式、改交互、重构组件、加页面、加第三方库、改文案
✅ 新页面要数据：照上表引入即可（`<script>` 或 `injectScript`，不是 fetch JSON）

❌ **禁止修改 `data/` 下任何文件的内容并提交**（本地钩子会直接拒绝）
❌ **禁止改变数据 URL 契约**（路径、文件名、全局变量名）——Functions / worker / 后台三处
   以它为镜像，要动必须先读 [`SITE-STANDARD.md`](SITE-STANDARD.md) 并三处同步
❌ 不要假设"数据一定存在"：降级态会返回旧快照、文章可能已被删除，列表渲染必须容错
❌ 不要用 `onerror` / `try-catch` 判断动态脚本成败——Pages 对不存在的路径返回
   `200 + HTML`，`onerror` 永远不触发。**加载后检查全局变量有没有真的拿到。**

## 本地开发与部署验证

- 本地打开 `index.html` 看的是**上次 pull 下来的快照**；接了 D1 之后，真实内容以线上为准
- 改样式快速验证：直接双击 `index.html`（数据旧，但布局能看）
- 部署验证（防"push 了但线上没更新"）：见 [`SETUP.md`](SETUP.md#部署验证push-了但线上没变)
  的最简版本——push 后用线上地址实际打开，肉眼确认改动生效
- 给资源加 `?v=` 只是为了绕浏览器强缓存，改了 `assets/` 下的文件记得同步 bump
