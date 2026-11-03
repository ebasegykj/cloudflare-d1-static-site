/* 数据文件输出层：/data/* 全部由这里接管（_routes.json include 了 /data/*）。
 *
 * 读序：D1 files 表（新真相）→ 没有则回退同路径静态文件（迁移期双轨兜底）。
 * 输出与旧静态文件逐字节一致，前端 app.js 的 <script src="data/..."> 契约不变。
 *
 * 注意（Pages 平台行为，2026-11 官方文档核实）：
 * - Pages Functions 优先于静态资产，所以本 Function 会先于 /data/ 下的静态文件执行；
 * - env.ASSETS.fetch() 可以绕过路由直接取静态资产，正好用作回退；
 * - _routes.json 只 include /data/*，其余路径不进 Function（纯静态，免费额度无虞）。
 *
 * 缓存策略：no-cache + ETag——发布要即时可见，不能让浏览器/边缘拿旧数据；
 * ETag 用 D1 updated_at + body 长度合成（不做全量哈希，省 CPU）。
 */

function jsHeaders(etag) {
  return {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    ...(etag ? { ETag: etag } : {}),
  };
}

export async function onRequestGet(context) {
  const { env, params, request } = context;

  // [[path]] 是多段通配；中文 slug 可能以编码或解码两种形态到达，两种都试
  const raw = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  const candidates = [];
  const add = (s) => { if (s && !candidates.includes(s)) candidates.push(s); };
  add(raw);
  try { add(decodeURIComponent(raw)); } catch (e) { /* 乱码路径不强解 */ }
  const paths = candidates.map((s) => 'data/' + s);

  if (env.DB) {
    try {
      const stmt = env.DB.prepare('SELECT body, updated_at FROM files WHERE path = ?1');
      for (const p of paths) {
        const row = await stmt.bind(p).first();
        if (row && row.body != null) {
          const etag = `W/"d1-${row.updated_at}-${row.body.length}"`;
          // ⚠ 成功命中也必须带 X-Data-Source：admin 设置页的数据源徽章读它，
          //   之前漏带导致徽章永远显示"无标记，可能还是旧版 Functions"（2026-11-02）
          const hitH = () => ({ ...jsHeaders(etag), 'X-Data-Source': 'd1-authoritative' });
          if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: hitH() });
          return new Response(row.body, { headers: hitH() });
        }
      }
      /* 双轨开关：data-import.json 导入时会写 __meta/imported 标记行。
         有标记 = D1 是唯一真相：这里查不到 = 已被删除/尚未发布 → 404，绝不回退
         （否则 D1 模式下删掉的文章会继续从静态文件里"诈尸"）。
         没标记 = 还没导入过（D1 可能是空的）→ 回退静态文件，站点照常。 */
      const meta = await env.DB.prepare('SELECT body FROM files WHERE path = ?1').bind('__meta/imported').first();
      if (meta && meta.body) return notFound(paths[0], 'd1-authoritative');
    } catch (e) {
      // D1 异常不挂死站点：落到静态回退，并在响应头留下诊断线索
      const r = await assetFallback(context, paths[0]);
      r.headers.set('X-Data-Source', 'static-d1-error');
      return r;
    }
  }

  const r = await assetFallback(context, paths[0]);
  r.headers.set('X-Data-Source', 'static');
  return r;
}

async function assetFallback(context, path) {
  // 双轨期回退：仓库里 data/ 还在，从静态资产取同路径文件
  try {
    const url = new URL(context.request.url);
    const asset = await context.env.ASSETS.fetch(new URL(url.origin + '/' + path));
    if (asset.ok) {
      const h = jsHeaders(null);
      for (const k of ['Content-Type']) h[k] = asset.headers.get(k) || h[k];
      return new Response(asset.body, { status: 200, headers: h });
    }
  } catch (e) { /* 落到 404 */ }
  return notFound(path, 'static');
}

function notFound(path, source) {
  return new Response('// data file not found: ' + path + '\n', {
    status: 404,
    headers: { ...jsHeaders(null), 'X-Data-Source': source },
  });
}
