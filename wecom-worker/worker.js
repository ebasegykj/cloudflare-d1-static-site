/**
 * 博客助手 Worker：企业微信消息 → 更新静态站（GitHub 单提交 → CF Pages 自动部署）
 *
 * 支持（个人微信里通过微信插件/微工作台发给自建应用）：
 *   瞬 \n 片名或书名 \n 文案 [可再带一行日期 10-29]   → 查 TMDB/Google Books → 确认 → 入瞬间
 *   文 \n 标题 \n 链接                                → 外链文章
 *   文 \n 标题 \n 大段文字(可多行)                    → 正文文章
 *   图 \n 图片URL(可多行)                             → 入图片墙
 *   （直接发图片文件）                                → 下载后转传图床 → 入图片墙
 *   撤回                                              → 撤掉最近一条未发布的暂存
 *   发                                                → 立即发布所有暂存（平时每5分钟自动合并发布一次）
 *
 * 环境变量（wrangler secret put 或 dashboard 配置）：
 *   CORP_ID, AGENT_ID, CORP_SECRET, WECOM_TOKEN, WECOM_AESKEY,
 *   GH_TOKEN, REPO(默认 your-name/your-repo), TMDB_KEY, IMG_TOKEN(图床)
 * KV 绑定：KV（存会话状态/暂存队列/去重/微信token缓存）
 */

/* ⚠️ 每次改本文件都必须更新 BUILD，并在部署后用 https://<域名>/version 核对线上版本。
   没有这一行，部署完就只能靠猜——CF 控制台不显示代码版本。 */
const BUILD = '20261103-1000';

/* ===== 站点规格（单站）：数据语义差异唯一登记处 =====
 * 数据路径 / 暂存标记 / 库名只允许改这里；
 * specOf 恒返回 main，保留函数形态以不动调用点。 */
const SITE_SPEC = {
  main: { dbVar: 'DB', manifest: 'data-import.json', dataDelRe: /^data\// },
};
const specOf = () => SITE_SPEC.main;

export default {
  async fetch(request, rawEnv, ctx) {
    let cfgErr = '';
    let env = rawEnv;
    if (rawEnv.CONFIG) {
      try { env = Object.assign({}, rawEnv, JSON.parse(rawEnv.CONFIG)); }
      catch (e) { cfgErr = String(e && e.message || e); }
    }
    const url = new URL(request.url);
    /* ---- CORS 预检（2026-11-02 补）：admin 设置页在站点域名下，跨域调 /api/admin/* 时
     * 浏览器会先发 OPTIONS（带自定义头 x-admin-key 必触发预检）；此前没处理，
     * 预检直接失败 → 所有浏览器后台的 D1 直写都不通。
     * 必须放在所有路由之前，且不能只靠响应头里的 ACAO——预检请求本身就要答对。 ---- */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
        'Access-Control-Max-Age': '86400',
      } });
    }
    /* 版本自证：部署后访问 /version，返回的 build 与本文件顶部 BUILD 一致才算真的上线了 */
    if (url.pathname === '/version') {
      return new Response(JSON.stringify({
        build: BUILD,
        hint: '与 worker.js 顶部 BUILD 对比；不一致说明 CF 里还是旧代码',
      }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    /* ---- 只读搜索代理：管理后台在国内浏览器里直连不了 api.themoviedb.org / googleapis，
       借 worker 出网（bot 的「瞬」一直走这条路）。只转发搜索/详情两个 GET，无缓存无状态。 ---- */
    const CORS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/tmdb' || url.pathname === '/tmdb/detail' || url.pathname === '/gbooks') {
      try {
        const q = url.searchParams.get('q');
        if (url.pathname === '/gbooks') {
          if (!q) return new Response(JSON.stringify({ error: 'missing q' }), { status: 400, headers: CORS });
          const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`);
          return new Response(await r.text(), { status: r.status, headers: CORS });
        }
        const key = env.TMDB_KEY || url.searchParams.get('key') || '';
        if (!key) return new Response(JSON.stringify({ error: 'TMDB key 未配置' }), { status: 400, headers: CORS });
        if (url.pathname === '/tmdb') {
          if (!q) return new Response(JSON.stringify({ error: 'missing q' }), { status: 400, headers: CORS });
          const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${key}&language=zh-CN&query=${encodeURIComponent(q)}`);
          return new Response(await r.text(), { status: r.status, headers: CORS });
        }
        const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie';
        const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
        if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400, headers: CORS });
        const r = await fetch(`https://api.themoviedb.org/3/${kind}/${id}?api_key=${key}&language=zh-CN`);
        return new Response(await r.text(), { status: r.status, headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 502, headers: CORS });
      }
    }

    /* ---- admin 写接口（D1 模式）：管理后台不再直连 GitHub，改走这里写 D1 ----
     * 鉴权：env.ADMIN_KEY（CF 后台 worker 变量里配）；admin 设置页填同一个 key。
     * 只提供写与连通性检查；读走站点自己的 /data/*（Functions 输出层），不从这里读。 */
    if (url.pathname === '/api/admin/ping') {
      const ok = (request.headers.get('x-admin-key') || '') === (env.ADMIN_KEY || '');
      return new Response(JSON.stringify({
        build: BUILD,
        d1: !!env.DB,
        auth: ok,
        hint: !env.DB ? 'worker 未绑定 D1（变量名 DB）'
          : (!env.ADMIN_KEY ? 'worker 未配置 ADMIN_KEY' : (ok ? 'ok' : 'key 不对')),
      }), { status: ok && env.DB ? 200 : 418, headers: CORS });
    }
    /* 数据源切换（互斥二选一）：admin 设置页只显示"切到另一边"一个按钮。
       GET /api/admin/source → {source:'d1'|'github', files:n}
       POST {mode:'d1'|'github'} → 切换（写/删 __meta/imported 权威标记） */
    if (url.pathname === '/api/admin/source') {
      if (!env.ADMIN_KEY || (request.headers.get('x-admin-key') || '') !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: 'ADMIN_KEY 不对（设置页与 worker 变量不一致）' }), { status: 401, headers: CORS });
      }
      const db = env.DB;
      if (!db) return new Response(JSON.stringify({ error: 'DB 未绑定' }), { status: 501, headers: CORS });
      try {
        if (request.method === 'GET') {
          let marker = false, n = 0;
          try {
            const m = await db.prepare('SELECT body FROM files WHERE path = ?1').bind('__meta/imported').first();
            marker = !!(m && m.body);
            const rs = await db.prepare('SELECT path FROM files').all();
            n = ((rs && rs.results) || []).filter((r) => r.path !== '__meta/imported').length;
          } catch (e) { /* 空库 */ }
          return new Response(JSON.stringify({ source: marker && n ? 'd1' : 'github', files: n }), { headers: CORS });
        }
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const mode = body.mode === 'd1' ? 'd1' : 'github';
          const msg = await d1SwitchSource({ ...env, DB: db }, mode);
          return new Response(JSON.stringify({ ok: true, source: mode, msg }), { headers: CORS });
        }
        return new Response(JSON.stringify({ error: 'GET/POST only' }), { status: 405, headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: CORS });
      }
    }
    if (url.pathname === '/api/admin/write') {
      try {
        if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: CORS });
        if (!env.ADMIN_KEY) return new Response(JSON.stringify({ error: 'worker 未配置 ADMIN_KEY，写接口不可用' }), { status: 501, headers: CORS });
        if ((request.headers.get('x-admin-key') || '') !== env.ADMIN_KEY) return new Response(JSON.stringify({ error: 'ADMIN_KEY 不对（admin 设置页与 worker 变量不一致）' }), { status: 401, headers: CORS });
        const payload = await request.json();
        const ops = (Array.isArray(payload.files) ? payload.files : [])
          .filter((f) => f && typeof f.path === 'string' && /^data\//.test(f.path)) // 只许写数据路径
          .map((f) => ({ path: f.path, body: f.deleted ? null : String(f.body == null ? '' : f.body) }));
        if (!ops.length) return new Response(JSON.stringify({ error: 'files 为空或路径不合法' }), { status: 400, headers: CORS });
        if (!env.DB) return new Response(JSON.stringify({ error: 'DB 未绑定，无法写 ' + ops[0].path }), { status: 501, headers: CORS });
        await applyFileOps(env, ops);
        return new Response(JSON.stringify({ ok: true, n: ops.length }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: CORS });
      }
    }

    // 企业微信回调默认走 /wecom；也接受根路径（有人配 URL 时漏了 /wecom）
    if (url.pathname !== '/wecom' && url.pathname !== '/') return new Response('not found', { status: 404 });
    if (url.searchParams.get('diag')) return diagResponse(env, url, cfgErr);
    try {
      if (request.method === 'GET') return await verifyUrl(request, env);
      if (request.method === 'POST') return await onMessage(request, env, ctx);
      return new Response('method?', { status: 405 });
    } catch (e) {
      console.error('top-level', request.method, url.pathname + url.search, e && e.stack || e);
      if (url.searchParams.get('debug')) return new Response('ERR: ' + String(e && e.message || e));
      return new Response('success'); // 解密层异常（签名不对等）回 success，避免微信重试轰炸
    }
  },

  async scheduled(event, rawEnv, ctx) {
    // 按用户设定：不自动发布。定时任务只做 D1 → data-backup 分支的每日备份。
    ctx.waitUntil(cronBackupAll(rawEnv));
  },
};

/* ---- base64 / utf8（Workers 无 Buffer） ---- */
function b64decodeUtf8(b64) {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64encodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ================= 企业微信加解密 ================= */

function b64url(s) { return s.replace(/-/g, '+').replace(/_/g, '/'); }
function str2ab(s) { return new TextEncoder().encode(s); }
function ab2str(b) { return new TextDecoder().decode(b); }

async function aesRaw(env) {
  // EncodingAESKey 43 位字母数字，补一个 '=' 即标准 base64，解码为 32 字节 AES-256 密钥；IV = 密钥前 16 字节
  return Uint8Array.from(atob(env.WECOM_AESKEY + '='), (c) => c.charCodeAt(0));
}
function sign(arr) {
  return crypto.subtle.digest('SHA-1', str2ab(arr.slice().sort().join(''))).then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`)) || xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : '';
}
function xmlWrap(inner) { return `<xml>${inner}</xml>`; }

/* ---- 裸 AES-256-CBC（纯 JS） ----
   为什么不用 WebCrypto：它的 AES-CBC 强制按 16 字节做 PKCS#7，解密时自动剥掉填充，
   且补位值只认 1~16；企业微信是按 32 字节补位（1~32），补位 >16 时 WebCrypto 直接抛
   OperationError。两边不兼容，所以自己实现。 */
const SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256), MUL = {};
(function initTables() {
  const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  const gmul = (a, b) => {
    let r = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) r ^= a;
      a = (a & 0x80) ? ((a << 1) ^ 0x1b) & 0xff : (a << 1) & 0xff;
      b >>= 1;
    }
    return r;
  };
  for (const m of [1, 2, 3, 9, 11, 13, 14]) {
    MUL[m] = new Uint8Array(256);
    for (let i = 0; i < 256; i++) MUL[m][i] = gmul(i, m);
  }
})();

function expandKey256(key) {
  const w = new Uint8Array(16 * 15);
  w.set(key.subarray(0, 32));
  let rc = 1;
  for (let i = 32; i < w.length; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 32 === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ rc; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[tmp];
      rc = MUL[2][rc];
    } else if (i % 32 === 16) {
      t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
    }
    w[i] = w[i - 32] ^ t0; w[i + 1] = w[i - 31] ^ t1;
    w[i + 2] = w[i - 30] ^ t2; w[i + 3] = w[i - 29] ^ t3;
  }
  return w;
}

function addRK(w, round, s) {
  const o = round * 16;
  for (let i = 0; i < 16; i++) s[i] ^= w[o + i];
}
function shiftRows(s, inv) {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const from = (c + (inv ? 4 - r : r)) % 4;
      s[r + 4 * c] = t[r + 4 * from];
    }
  }
}
function mixCols(s, inv) {
  const m2 = inv ? MUL[14] : MUL[2], m3 = inv ? MUL[11] : MUL[3], m4 = inv ? MUL[13] : MUL[1], m5 = inv ? MUL[9] : MUL[1];
  for (let c = 0; c < 4; c++) {
    const o = 4 * c;
    const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
    s[o] = m2[a0] ^ m3[a1] ^ m4[a2] ^ m5[a3];
    s[o + 1] = m5[a0] ^ m2[a1] ^ m3[a2] ^ m4[a3];
    s[o + 2] = m4[a0] ^ m5[a1] ^ m2[a2] ^ m3[a3];
    s[o + 3] = m3[a0] ^ m4[a1] ^ m5[a2] ^ m2[a3];
  }
}
function encBlock(w, s) {
  addRK(w, 0, s);
  for (let r = 1; r <= 14; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows(s, false);
    if (r !== 14) mixCols(s, false);
    addRK(w, r, s);
  }
}
function decBlock(w, s) {
  addRK(w, 14, s);
  for (let r = 13; r >= 0; r--) {
    shiftRows(s, true);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRK(w, r, s);
    if (r !== 0) mixCols(s, true);
  }
}
function aesCbcEncrypt(key, iv, data) {
  const w = expandKey256(key), out = new Uint8Array(data.length);
  let prev = iv.slice(0, 16);
  for (let o = 0; o < data.length; o += 16) {
    const s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = data[o + i] ^ prev[i];
    encBlock(w, s);
    out.set(s, o);
    prev = s;
  }
  return out;
}
function aesCbcDecrypt(key, iv, data) {
  const w = expandKey256(key), out = new Uint8Array(data.length);
  let prev = iv.slice(0, 16);
  for (let o = 0; o < data.length; o += 16) {
    const s = data.slice(o, o + 16);
    const cur = s.slice();
    decBlock(w, s);
    for (let i = 0; i < 16; i++) out[o + i] = s[i] ^ prev[i];
    prev = cur;
  }
  return out;
}

async function decryptMsg(env, query, bodyXml) {
  const enc = xmlVal(bodyXml, 'Encrypt');
  const sig = await sign([env.WECOM_TOKEN, query.timestamp, query.nonce, enc]);
  if (sig !== query.msg_signature) {
    console.error('[sigfail] tokenLen=' + (env.WECOM_TOKEN || '').length + ' expect=' + sig.slice(0, 12) + ' got=' + String(query.msg_signature).slice(0, 12) + ' ts=' + query.timestamp + ' nonce=' + query.nonce);
    throw new Error('签名校验失败');
  }
  const rawKey = await aesRaw(env);
  let b = b64url(String(enc || '').trim());
  if (b.includes('%')) { try { b = b64url(decodeURIComponent(b)); } catch (_) {} } // 防御：URL 二次编码
  b = b.replace(/ /g, '+'); // 防御：'+' 被当成空格解码
  const raw = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  if (raw.length < 32 || raw.length % 16 !== 0) {
    console.error('[bad-cipher] len=' + raw.length);
    throw new Error('密文长度异常：' + raw.length);
  }
  const pt = aesCbcDecrypt(rawKey, rawKey.slice(0, 16), raw);
  // 剥掉 PKCS7 填充（企业微信补位到 32 字节，取值 1..32）
  const pad = pt[pt.length - 1];
  if (pt.length < 20 || pad < 1 || pad > 32 || pad > pt.length - 20) {
    console.error('[aeskey-mismatch] ptLen=' + pt.length + ' lastByte=' + pad);
    throw new Error('解密失败：AESKey 与后台不一致（填充非法）');
  }
  const body = pt.subarray(0, pt.length - pad);
  // 明文 = random(16) + msg_len(4, 大端) + msg + receiveId
  const len = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16);
  if (20 + len > body.length) {
    console.error('[bad-len] len=' + len + ' body=' + body.length);
    throw new Error('明文长度字段异常：' + len);
  }
  return { xml: ab2str(body.subarray(20, 20 + len)), receiveId: ab2str(body.subarray(20 + len)) };
}

async function encryptMsg(env, plainXml, nonce, timestamp) {
  const rawKey = await aesRaw(env);
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  const msg = str2ab(plainXml);
  const corp = str2ab(env.CORP_ID);
  const buf = new Uint8Array(16 + 4 + msg.length + corp.length);
  buf.set(rnd, 0); new DataView(buf.buffer).setUint32(16, msg.length); buf.set(msg, 20); buf.set(corp, 20 + msg.length);
  // PKCS7 补位到 32 字节倍数（企业微信规范）
  const padLen = 32 - (buf.length % 32);
  const padded = new Uint8Array(buf.length + padLen); padded.set(buf); padded.fill(padLen, buf.length);
  const ct = aesCbcEncrypt(rawKey, rawKey.slice(0, 16), padded);
  let bin = '';
  for (let i = 0; i < ct.length; i += 0x8000) bin += String.fromCharCode(...ct.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  const sig = await sign([env.WECOM_TOKEN, timestamp, nonce, b64]);
  return xmlWrap(`<Encrypt><![CDATA[${b64}]]></Encrypt><MsgSignature><![CDATA[${sig}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce>`);
}

/* ---- 自检：访问 /wecom?diag=1 查看配置是否就位（不泄露密钥本体） ---- */
function diagResponse(env, url, cfgErr) {
  return (async () => {
    const info = { build: BUILD, site: env._site || '/wecom (主站点)', configParsed: !!env.CORP_ID, configError: cfgErr || 'none' };
    for (const k of ['CORP_ID', 'AGENT_ID', 'CORP_SECRET', 'WECOM_TOKEN', 'WECOM_AESKEY', 'GH_TOKEN', 'TMDB_KEY', 'REPO']) {
      const v = env[k];
      info[k] = v ? (String(v).length + ' chars') : 'MISSING';
    }
    info.KV = env.KV ? 'bound' : 'MISSING';
    const ak = env.WECOM_AESKEY || '';
    try { info.aesKeyBytes = Uint8Array.from(atob(ak + '='), (c) => c.charCodeAt(0)).length; }
    catch (e) { info.aesKeyBytes = 'DECODE FAIL: ' + String(e && e.message || e); }
    info.aesKeyHint = ak.length + ' chars, endsWith=' + ak.slice(-2);
    const q = Object.fromEntries(url.searchParams);
    if (q.echostr && q.msg_signature) {
      try { const r = await decryptMsg(env, q, xmlWrap(`<Encrypt><![CDATA[${q.echostr}]]></Encrypt>`)); info.verifyResult = 'OK: ' + r.xml; }
      catch (e) { info.verifyResult = 'FAIL: ' + String(e && e.message || e); }
    }
    return new Response(JSON.stringify(info, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  })();
}

async function verifyUrl(request, env) {
  const q = Object.fromEntries(new URL(request.url).searchParams);
  const { xml } = await decryptMsg(env, q, xmlWrap(`<Encrypt><![CDATA[${q.echostr}]]></Encrypt>`));
  return new Response(xml, { headers: { 'Content-Type': 'text/plain' } });
}

/* ================= 消息入口 ================= */

async function replyText(env, query, to, text) {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Response(
    await encryptMsg(env, xmlWrap(`<ToUserName><![CDATA[${to}]]></ToUserName><FromUserName><![CDATA[${env.AGENT_ID}]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content>`), query.nonce, ts),
    { headers: { 'Content-Type': 'text/xml' } },
  );
}

async function onMessage(request, env, ctx) {
  const q = Object.fromEntries(new URL(request.url).searchParams);
  const body = await request.text();
  let msg;
  try {
    msg = await decryptMsg(env, q, body);
  } catch (e) {
    console.error('decrypt', e && e.stack || e);
    return new Response('success');
  }
  if (msg.receiveId !== env.CORP_ID) throw new Error('receiveId 不匹配');
  const xml = msg.xml;
  const type = xmlVal(xml, 'MsgType');
  const from = xmlVal(xml, 'FromUserName');
  const msgId = xmlVal(xml, 'MsgId');

  // 去重（微信 5 秒无响应会重推）
  try {
    if (msgId) {
      if (await env.KV.get('seen:' + msgId)) return new Response('success');
      await env.KV.put('seen:' + msgId, '1', { expirationTtl: 3600 });
    }
    let out;
    if (type === 'text') out = await handleText(env, from, xmlVal(xml, 'Content').trim(), ctx);
    else if (type === 'image') out = await handleImageFile(env, xmlVal(xml, 'MediaId'));
    else out = '目前支持：文字（瞬/文/图 开头）、图片、撤回';
    return replyText(env, q, from, out);
  } catch (e) {
    console.error('handle', e && e.stack || e);
    return replyText(env, q, from, '✗ 出错了：' + (e.message || e));
  }
}

/* ================= 指令解析 ================= */

const URL_RE = /https?:\/\/\S+/;
const DATE_RE = /\s(\d{1,2})[-月.](\d{1,2})\s*日?$/;

/* ================= 发布结果落地 ================= */

/* 成败都写 KV（「结果」指令可查）。成功返回空串 → 上层不推送；
   失败返回一句人话 → 上层用 message/send 主动推（不受回调 5 秒限制）。
   原始报错只存 KV，发「结果」才展开——那是给人排查用的。 */
async function reportPublish(env, user, r, n) {
  const d = new Date(Date.now() + 8 * 3600e3);
  const at = d.toISOString().replace('T', ' ').slice(0, 19);
  const raw = String((r && r.msg) || '').trim();
  const rec = JSON.stringify({ at, ok: !!(r && r.ok), n, raw });
  await env.KV.put('pubres:' + user, rec, { expirationTtl: 86400 }).catch(() => {});
  if (r && r.ok) return '';
  console.error('[publish-failed]', raw);
  /* 失败原因必须让人看见：写进 pubfail，主动推送里有、推送失败时下一条指令也会补播（见 handleText） */
  await env.KV.put('pubfail:' + user, rec, { expirationTtl: 86400 }).catch(() => {});
  const why = raw ? raw.split('\n')[0].replace(/^发布失败[：:]\s*/, '').slice(0, 200) : '未知原因（发「结果」看详情）';
  return `✗ 发布失败：${why}\n网站不会有新内容；内容已放回暂存区，回「发」→「确认」重试即可。`;
}

async function handleText(env, user, text, ctx) {
  /* 发布结果不在这里插播：同步发布已经把结果回在同一条消息里，
     失败的内容会自动回到暂存区，你想复核随时发「结果」。不制造噪音。 */
  const out = await handleTextBody(env, user, text, ctx);
  /* 兜底播报：失败推送可能没送到（企业微信应用消息受可信 IP 限制，报错只在 CF 日志）
     → 下次任何指令都先在开头补一条「上次发布失败：原因」，播一次即销号 */
  if (/^结果$/.test(String(text).trim())) return out;
  const f = await env.KV.get('pubfail:' + user).catch(() => null);
  if (!f) return out;
  await env.KV.delete('pubfail:' + user).catch(() => {});
  let rec = null;
  try { rec = JSON.parse(f); } catch (e) { /* 老格式，忽略 */ }
  const why = String((rec && rec.raw) || '').split('\n')[0].replace(/^发布失败[：:]\s*/, '').slice(0, 200) || '未知原因';
  return `⚠️ 上次发布失败：${why}\n（内容已放回暂存区，回「发」→「确认」重试）\n\n` + out;
}

async function handleTextBody(env, user, text, ctx) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const cmd = lines[0];

  /* D1 迁移运维命令（一次性）：导入D1 / 核对D1（放在会话态之前，任何状态下都可用；D 允许漏打）
     备份D1 是慢操作（全表读 + 多次 GitHub 调用，数据量大时实测超 5 秒被动回话窗口，
     微信静默丢回复且用户不知道成没成）→ 必须转后台 + 主动推送结果，与「确认」发布同模式。 */
  if (/^导入D1?$/i.test(cmd)) return d1Import(env);
  if (/^核对D1?$/i.test(cmd)) return d1Verify(env);
  if (/^备份D1?$/i.test(cmd)) {
    const task = d1Backup(env).then(
      (r) => ({ ok: true, msg: r || '' }),
      (e) => ({ ok: false, msg: String((e && e.message) || e) })
    );
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(task.then(async (r) => {
        /* 结果必须落 KV：主动推送受企业微信可信 IP 白名单限制（60020）会静默失败，
           收不到推送时用户发「备份结果」可查（与「结果」查发布同思路）。 */
        const rec = JSON.stringify({ ok: r.ok, op: '备份', at: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', raw: r.msg });
        await env.KV.put('bkres:' + user, rec, { expirationTtl: 86400 }).catch(() => {});
        if (!r.ok) console.error('[d1Backup]', r.msg);
        await sendAppMessage(env, user, (r.ok ? '' : '✗ 备份失败：') + r.msg).catch((e) => console.error('[backup-notify]', (e && e.message) || e));
      }));
      return '🚀 备份已安排后台执行，完成后微信通知你（首次要建分支+传文件，可能要一两分钟）\n数据量大时自动分批：收不到推送就发「备份结果」查看；提示「续传」就再发一次「备份D1」';
    }
    const r = await task; // 无 waitUntil 的环境（单测兜底）：同步返回结果
    return r.msg;
  }
  /* 「数据源」：灾备可观测（当前权威源 + 备份状态 + 恢复步骤）；「恢复D1」：从备份分支灌回（灾备动作） */
  if (/^数据源$/i.test(cmd)) return d1SourceInfo(env);
  { const sw = cmd.match(/^数据源(切)?(D1|GitHub|G|静态)$/i); if (sw) return d1SwitchSource(env, /^D1$/i.test(sw[2]) ? 'd1' : 'github'); }
  if (/^恢复D1?$/i.test(cmd)) {
    const task = d1Restore(env).then(
      (r) => ({ ok: true, msg: r || '' }),
      (e) => ({ ok: false, msg: String((e && e.message) || e) })
    );
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(task.then(async (r) => {
        const rec = JSON.stringify({ ok: r.ok, op: '恢复', at: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', raw: r.msg });
        await env.KV.put('bkres:' + user, rec, { expirationTtl: 86400 }).catch(() => {});
        if (!r.ok) console.error('[d1Restore]', r.msg);
        await sendAppMessage(env, user, (r.ok ? '' : '✗ 恢复失败：') + r.msg).catch((e) => console.error('[restore-notify]', (e && e.message) || e));
      }));
      return '🚀 恢复已安排后台执行（从 data-backup 分支灌回 D1，量大自动分批）\n发「备份结果」查进度；完成后发「核对D1」验证，线上即以 D1 为准';
    }
    const r = await task;
    return r.msg;
  }

  /* 翻页：任何列表/搜索结果多于一条消息时，回「下页」继续看 */
  if (/^(下页|更多)$/.test(cmd)) {
    const st = JSON.parse(await env.KV.get('page:' + user) || 'null');
    if (!st) return '当前没有可翻页的列表（查待办 / 查瞬 关键词 等结果多于一页时可用）';
    const pages = Math.ceil(st.lines.length / st.size);
    if (st.page + 1 >= pages) return `已到末页（共 ${st.lines.length} 条）`;
    st.page += 1;
    await env.KV.put('page:' + user, JSON.stringify(st), { expirationTtl: 1800 });
    return renderPage(st, st.page);
  }

  // 会话中：回复序号选候选
  const conv = JSON.parse(await env.KV.get('conv:' + user) || 'null');
  if (conv) {
    if (/^取消$/.test(text)) { await env.KV.delete('conv:' + user); return '已取消'; }
    if (/^二刷$/.test(text) && conv.repick) {
      await env.KV.delete('conv:' + user);
      return await confirmMoment(env, user, Object.assign({}, conv.repick, { force: true }), conv.text, conv.date);
    }
    if (/^(强完|二刷)$/.test(text) && conv.redoTodo) {
      await env.KV.delete('conv:' + user);
      const sel = conv.redoTodo;
      await pushPending(env, { file: 'todos', op: 'done', item: { id: sel.id, title: sel.title || sel.note || '', doneAt: bjNow() } });
      await stageMoment(env, user, { type: sel.todoKind === 'book' ? 'book' : 'movie', title: sel.title, runtime: sel.runtime || 0, poster: sel.poster || '', kind: sel.todoKind, tmdbId: sel.tmdbId }, '', '');
      return `✓ 已暂存完成（二刷）：《${String(sel.title || sel.note || '').slice(0, 30)}》（已同时暂存一条瞬间）（可继续其他操作；想直接发布回「发」→「确认」）`;
    }
    if (/^\d+$/.test(cmd) && conv.candidates && conv.todo) {
      const c = conv.candidates[+cmd - 1];
      if (!c) return `序号超出范围（1~${conv.candidates.length}），回复"取消"重来`;
      await env.KV.delete('conv:' + user);
      return await stageTodoPick(env, user, c);
    }
    if (/^\d+$/.test(cmd) && conv.candidates) {
      const c = conv.candidates[+cmd - 1];
      if (!c) return `序号超出范围（1~${conv.candidates.length}），回复"取消"重来`;
      await env.KV.delete('conv:' + user);
      return await confirmMoment(env, user, c, conv.text, conv.date);
    }
    /* 统一格式：动作在前、序号在后 —— 删 1,2 / 完 1,2 / 废 1,2 / 开 1,2 / 顶 1 / 改 1
       （序号 = 上一条列表的编号，多个用逗号或空格分隔；和「删 关键词」一样都是动作在前）
       待办支持 完/废/开，内容支持 删；两类不能混在一批里 */
    const ACT_RE = /^(删除|删|废弃|废|完成|完|恢复|开|置顶|顶|修改|改)\s*([\d\s.,，、]+)$/;
    const actM = conv.results ? cmd.match(ACT_RE) : null;
    if (actM) {
      const act = actM[1];
      const nums = [...new Set(actM[2].split(/[\s.,，、]+/).filter(Boolean).map(Number))];
      const items = [];
      for (const n of nums) {
        const h = conv.results[n - 1];
        if (!h) return `序号 ${n} 超出范围（1~${conv.results.length}）\n要按关键词操作：回「取消」退出，再发「${/^(删|删除)/.test(act) ? '删' : act} 关键词」`;
        items.push(h);
      }
      const allTodo = items.every((h) => h.kind === 'todo');
      if (!allTodo && items.some((h) => h.kind === 'todo')) {
        return '待办和文章/瞬间/图片不能混在一批，分开来（待办：完/废/开；内容：删）';
      }
      /* 单条 + 改/顶：等同「选中后回 改/顶」 */
      if (/^(改|修改|顶|置顶)$/.test(act)) {
        if (items.length > 1) return '「改」「顶」一次只能一条，如：顶 1';
        const h = items[0];
        await env.KV.delete('conv:' + user);
        await env.KV.put('sel:' + user, JSON.stringify(h), { expirationTtl: 1800 });
        if (/^(顶|置顶)$/.test(act)) return stagePinSel(env, user, h);
        return beginEditSel(env, user, h);
      }
      await env.KV.delete('conv:' + user);
      if (allTodo) {
        if (/^(删|删除)$/.test(act)) return '待办不能删（会丢记录）：回「废」标记废弃即可';
        if (/^(完|完成)$/.test(act)) return items.length === 1 ? todoDoneSel(env, user, items[0]) : todoDoneMany(env, user, items);
        if (/^(废|废弃)$/.test(act)) return todoOpMany(env, user, items, 'drop');
        return todoOpMany(env, user, items, 'undone');
      }
      if (/^(删|删除)$/.test(act)) {
        if (items.length === 1 && ['moment', 'post', 'photo'].includes(items[0].kind)) return stageDeleteSel(env, user, items[0]);
        return stageDeleteMany(env, user, items);
      }
      return '内容条目只能「删」；「完/废/开」是待办的动作';
    }
    /* 旧写法「1.2 删」已统一为动作在前 */
    if (conv.results && /^[\d\s.,，、]+(删除|删|废弃|废|完成|完|恢复|开)$/.test(cmd)) {
      return '动作写在前面：删 1,2 / 完 1,2 / 废 1,2 / 开 1,2';
    }
    /* 只看序号（不带动作）：一次选多条，再回 删 / 完 / 废 / 开 */
    const multiCmd = (conv.results && /^[\d\s.,、]+$/.test(cmd) && /\d[\s.,、]+\d/.test(cmd)) ? cmd : '';
    if (multiCmd) {
      const nums = multiCmd.split(/[\s.,、]+/).filter(Boolean).map(Number);
      const items = [];
      for (const n of nums) {
        const h = conv.results[n - 1];
        if (!h) return `序号 ${n} 超出范围（1~${conv.results.length}），回复"取消"退出`;
        items.push(h);
      }
      const allTodo = items.every((h) => h.kind === 'todo');
      if (!allTodo && items.some((h) => h.kind === 'todo')) {
        return '待办和文章/瞬间/图片不能混在一批，分开选（待办：完/废/开；内容：删）';
      }
      await env.KV.delete('conv:' + user);
      await env.KV.put('sel:' + user, JSON.stringify({ kind: 'multi', items }), { expirationTtl: 1800 });
      const menu = allTodo
        ? '回「完」完成 /「废」废弃 /「开」恢复 /「取消」退出\n（也可以一次到位：完 1,2 / 废 1,2 / 开 1,2）'
        : '回「删」一起进暂存删除 /「取消」退出\n（也可以一次到位：删 1,2；「改」「顶」请单选）';
      return `已选中 ${items.length} 条${allTodo ? '待办' : ''}：\n` + items.map((h, i) => `${i + 1}. ${selLabel(h)}`).join('\n') + '\n\n' + menu;
    }
    if (/^\d+$/.test(cmd) && conv.results) {
      const h = conv.results[+cmd - 1];
      if (!h) return `序号超出范围（1~${conv.results.length}），回复"取消"退出`;
      await env.KV.delete('conv:' + user);
      await env.KV.put('sel:' + user, JSON.stringify(h), { expirationTtl: 1800 });
      if (h.kind === 'todo') {
        const icon = h.todoKind === 'movie' ? '🎬' : h.todoKind === 'tv' ? '📺' : h.todoKind === 'book' ? '📚' : '✍️';
        const st = h.dropped ? '已废弃' : h.done ? '已完成' : '未完成';
        return `已选中：${icon} ${String(h.title || h.note || '').slice(0, 30)}（${st}）\n回复`
          + (h.done || h.dropped ? '「开」恢复未完成 /「取消」退出' : '「完」完成 /「废」废弃 /「取消」退出');
      }
      return `已选中：${selLabel(h)}\n回复「删」删除 / 「改」修改 / 「顶」置顶 /「取消」退出`;
    }
  }

  /* ===== 主站管理：查/删/改/待办（bot 端 CRUD） ===== */
  {
    /* 没选中就直接回动词：唯一命中 = 自动选中执行（省一步序号）；多命中提示先回序号 */
    const verbOnly = /^(改|删|删除|顶|置顶)$/.test(cmd);
    const convRaw0 = verbOnly ? await env.KV.get('conv:' + user) : null;
    const conv0 = convRaw0 ? JSON.parse(convRaw0) : null;
    if (conv0 && conv0.results && conv0.results.length) {
      if (conv0.results.length === 1) {
        await env.KV.put('sel:' + user, JSON.stringify(conv0.results[0]), { expirationTtl: 1800 });
        await env.KV.delete('conv:' + user);
      } else {
        return `找到 ${conv0.results.length} 条，先回复序号选中（如：1），再回「${cmd}」`;
      }
    }
    /* 选中条目后的操作菜单（「查」→ 序号 → 这里）；发新命令（改待办/查待办/完 序号/待办…）则清掉选中态直接执行
       全局命令（发/确认/撤回/清空/结果/帮助/下页）也要放行——否则在选中态下回「发」会被菜单拦住 */
    const selRaw = await env.KV.get('sel:' + user);
    if (selRaw && /^(改待办|查待办|待办|完\s*\d+|强完|废\s*\d+|开\s*\d+|查\s+\S|查瞬\s|查文\s|查图\s|顶\s+\S|置顶\s+\S|发|确认(顶)?|撤回(\s*\d+)?|清空|结果|帮助|下页|更多)/.test(text)) {
      await env.KV.delete('sel:' + user);
    } else if (selRaw) {
      const sel = JSON.parse(selRaw);
      if (/^取消$/.test(text)) { await env.KV.delete('sel:' + user); return '已退出选中'; }
      if (sel.kind === 'multi') {
        const allTodo = sel.items.every((h) => h.kind === 'todo');
        if (allTodo) {
          if (/^完$/.test(cmd)) return todoDoneMany(env, user, sel.items);
          if (/^废(弃)?$/.test(cmd)) return todoOpMany(env, user, sel.items, 'drop');
          if (/^开$/.test(cmd)) return todoOpMany(env, user, sel.items, 'undone');
          return `已选中 ${sel.items.length} 条待办：\n` + sel.items.map((h, i) => `${i + 1}. ${selLabel(h)}`).join('\n')
            + '\n\n回「完」完成 /「废」废弃 /「开」恢复 /「取消」退出';
        }
        if (/^(删|删除)$/.test(cmd)) return stageDeleteMany(env, user, sel.items);
        return `已选中 ${sel.items.length} 条：\n` + sel.items.map((h, i) => `${i + 1}. ${selLabel(h)}`).join('\n')
          + '\n\n回「删」一起进暂存删除 /「取消」退出';
      }
      /* 单条选中只有这一条：动作后面写「1」也认（跟列表里的「删 1」同一写法，不用记规则） */
      const one = /^(删除|删|置顶|顶|修改|改|完成|完|废弃|废|恢复|开)\s*1$/.test(cmd) ? cmd.replace(/\s*1$/, '') : cmd;
      if (sel.kind === 'todo') {
        if (/^完$/.test(one)) return todoDoneSel(env, user, sel);
        if (/^废(弃)?$/.test(one)) {
          await env.KV.delete('sel:' + user);
          await pushPending(env, { file: 'todos', op: 'drop', item: { id: sel.id, title: sel.title || sel.note || '', droppedAt: bjNow() } });
          return `✓ 已暂存废弃：「${String(sel.title || sel.note || '').slice(0, 30)}」（可继续其他操作；想直接发布回「发」→「确认」）`;
        }
        if (/^开$/.test(one)) {
          await env.KV.delete('sel:' + user);
          await pushPending(env, { file: 'todos', op: 'undone', item: { id: sel.id, title: sel.title || sel.note || '' } });
          return `✓ 已暂存恢复未完成：「${String(sel.title || sel.note || '').slice(0, 30)}」（可继续其他操作；想直接发布回「发」→「确认」）`;
        }
        return '当前选中：' + String(sel.title || sel.note || '').slice(0, 30) + '\n回复「完」完成 /「废」废弃 /「开」恢复 /「取消」退出';
      }
      if (/^(删|删除)$/.test(one)) return stageDeleteSel(env, user, sel);
      if (/^(顶|置顶)$/.test(one)) return stagePinSel(env, user, sel);
      if (/^改$/.test(one)) {
        if (sel.kind === 'photo') return '图片不支持改，回「顶」可把它排到图墙最前';
        return beginEditSel(env, user, sel);
      }
      if (sel.kind === 'photo') return '当前选中：' + selLabel(sel) + '\n回复「删」删除 /「顶」排到最前 /「取消」退出';
      return '当前选中：' + selLabel(sel) + '\n回复「删」删除 / 「改」修改 / 「顶」置顶 / 「取消」退出';
    }
    /* 编辑状态：改文章正文 / 改瞬间文案或日期（「改」→ 这里接收新内容） */
    const editRaw = await env.KV.get('edit2:' + user);
    if (editRaw) {
      const ed = JSON.parse(editRaw);
      if (/^取消$/.test(text)) { await env.KV.delete('edit2:' + user); return '已取消修改'; }
      if (ed.kind === 'moment') {
        const dm = text.match(/^改日期\s+(\d{4})-(\d{1,2})-(\d{1,2})\s*$/);
        await env.KV.delete('edit2:' + user);
        if (dm) {
          const nd = `${dm[1]}-${String(+dm[2]).padStart(2, '0')}-${String(+dm[3]).padStart(2, '0')}`;
          await pushPending(env, { file: 'medit', item: { year: ed.year, idx: ed.idx, title: ed.title, date: nd } });
          return `✓ 已暂存改日期：《${ed.title}》→ ${nd}（可继续其他操作；想直接发布回「发」→「确认」）`;
        }
        await pushPending(env, { file: 'medit', item: { year: ed.year, idx: ed.idx, title: ed.title, text } });
        return `✓ 已暂存改文案：《${ed.title}》（图片保留）（可继续其他操作；想直接发布回「发」→「确认」）`;
      }
      await env.KV.delete('edit2:' + user);
      const bodyLines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await pushPending(env, { file: 'pedit', item: { slug: ed.slug, title: ed.title, content: mdBlock(bodyLines) } });
      return `✓ 已暂存修改正文：《${ed.title}》（标题/摘要/封面不变）（可继续其他操作；想直接发布回「发」→「确认」）`;
    }

    /* 待办专用：查待办=未完成列表（可带关键词筛选），查待办完成=已完成列表 */
    if (/^查待办完成(清单|列表)?$/.test(cmd)) return todoListCmd(env, user, 'done');
    if (/^查待办(清单|列表)?$/.test(cmd)) return todoListCmd(env, user, 'pending');
    if (/^查待办\s+(.+)$/.test(text)) return todoListCmd(env, user, 'pending', text.replace(/^查待办\s+/, '').trim());
    const sm = text.match(/^查(瞬间|瞬|文章|文|图片|图)\s+(.+)$/);
    if (sm) {
      const scopeMap = { '瞬间': 'moment', '瞬': 'moment', '文章': 'post', '文': 'post', '图片': 'photo', '图': 'photo' };
      return searchAllCmd(env, user, sm[2].trim(), scopeMap[sm[1]]);
    }
    if (/^查/.test(cmd)) {
      const kw = text.replace(/^查\s*/, '').trim();
      if (!kw) return '格式：查 关键词（搜全部）\n或定向：查瞬 / 查文 / 查图 + 关键词\n待办看列表：查待办 / 查待办完成';
      return searchAllCmd(env, user, kw, 'all');
    }
    /* 置顶：把老文章顶到列表最前（新内容仍插最前，会把它自然挤下去） */
    if (/^(顶|置顶)\s+\S/.test(text)) return pinByKeyword(env, user, text.replace(/^(顶|置顶)\s+/, '').trim());
    /* 删/改 + 关键词：唯一命中直接执行，多命中选中后需再确认（防误选） */
    const mk = text.match(/^(删|改)\s+(.+)$/);
    if (mk) return manageByKeyword(env, user, mk[2].trim(), mk[1] === '删' ? 'del' : 'edit');
    if (/^改待办/.test(cmd)) {
      const kw = text.replace(/^改待办\s*/, '').trim();
      if (!kw) return '格式：改待办 序号 或 改待办 关键词\n（选中后回复「完」完成 /「废」废弃 /「开」恢复）';
      return manageTodo(env, user, kw);
    }
    if (/^(待办列表|待办清单)$/.test(cmd)) return todoListCmd(env, user, 'pending');
    /* 待办动作 + 序号：完 1,2,3 / 废 1,2,3 / 开 1,2,3（序号 = 查待办列表里的编号，动作在前）
       与内容条目的「删 1,2」保持同一写法；强完（二刷）只能单条 */
    const tdm = text.match(/^(待办强完|强完|待办完|待办废|待办开|完|废|废弃|开|恢复)\s*([\d\s.,，、]+)$/);
    if (tdm) {
      const act = tdm[1];
      const nums = [...new Set(tdm[2].split(/[\s.,，、]+/).filter(Boolean).map(Number))];
      const force = /^(待办强完|强完)$/.test(act);
      if (force) {
        if (nums.length > 1) return '「强完」（二刷）一次只能一条，如：强完 3';
        return todoDoneCmd(env, user, nums[0], true, text);
      }
      if (nums.length === 1 && /^(待办完|完)$/.test(act)) return todoDoneCmd(env, user, nums[0], false, text);
      const arr = parseArr(await readRepoData(env, 'data/todos.js'));
      const pend = arr.filter((t) => !t.done && !t.dropped);
      const items = [];
      for (const n of nums) {
        const t = pend[n - 1];
        if (!t) return `序号 ${n} 超出范围（共 ${pend.length} 条未完成）。发「查待办」查看`;
        items.push({ kind: 'todo', id: t.id, title: t.title || '', note: t.note || '', todoKind: t.kind, runtime: t.runtime || 0, poster: t.poster || '', tmdbId: t.tmdbId, done: !!t.done, dropped: !!t.dropped, date: t.createdAt });
      }
      if (/^(待办完|完)$/.test(act)) return todoDoneMany(env, user, items);
      if (/^(待办废|废|废弃)$/.test(act)) return todoOpMany(env, user, items, 'drop');
      return todoOpMany(env, user, items, 'undone');
    }
    let mm = text.match(/^待办(电影|剧|影视)\s+([\s\S]+)$/);
    if (mm) {
      const rest = mm[2].trim();
      if (!rest) return '格式：待办电影 片名（搜电影/剧集后选择加入待办）';
      return todoSearchCmd(env, user, rest);
    }
    mm = text.match(/^待办(书|图书)\s+([\s\S]+)$/);
    if (mm) {
      const rest = mm[2].trim();
      if (!rest) return '格式：待办书 书名（直接新增图书待办，不搜索）';
      await pushPending(env, { file: 'todos', op: 'add', item: { id: todoId(), kind: 'book', title: rest, note: '', poster: '', runtime: 0, createdAt: bjDate() + ' 12:00:00', done: false, doneAt: null } });
      return `✓ 已暂存图书待办：《${rest.slice(0, 30)}》（可继续其他操作；想直接发布回「发」→「确认」）`;
    }
    if (/^待办/.test(cmd)) {
      const rest = (lines.slice(1).join('\n') || text.replace(/^待办\s*/, '')).trim();
      if (!rest) return '格式：\n待办 日常事项（直接记，不搜索）\n待办电影 片名（搜电影/剧集）\n待办书 书名（直接新增图书）\n如：待办 明天去修电脑';
      await pushPending(env, { file: 'todos', op: 'add', item: { id: todoId(), kind: 'note', title: '', note: rest, poster: '', runtime: 0, createdAt: bjDate() + ' 12:00:00', done: false, doneAt: null } });
      return `✓ 已暂存日常待办：「${rest.slice(0, 30)}」（可继续其他操作；想直接发布回「发」→「确认」）`;
    }
  }

  const um = cmd.match(/^撤回(?:\s*(\d+))?$/i);
  if (um) return undoLast(env, user, um[1] ? +um[1] : 0);
  if (/^(清空|清空暂存|clear)$/i.test(cmd)) {
    const list = JSON.parse(await env.KV.get('pending') || '[]');
    await env.KV.put('pending', '[]');
    await env.KV.delete('pubok:' + user);
    return list.length ? `✗ 已清空暂存区（丢弃 ${list.length} 条）` : '暂存区本来就是空的';
  }
  if (/^(发|发布|publish)$/i.test(cmd)) {
    const list = JSON.parse(await env.KV.get('pending') || '[]');
    if (!list.length) return '暂存区是空的，没有要发布的';
    await env.KV.put('pubok:' + user, '1', { expirationTtl: 900 });
    return publishPreview(list);
  }
  const okM = text.match(/^(确认|确定|推送|yes|ok)\s*(顶|保持顶|保顶|保持置顶)?$/i);
  if (okM) {
    const keepPin = !!(okM[2]);
    const ok = await env.KV.get('pubok:' + user);
    if (!ok) return '没有待确认的发布。先发「发」查看待发清单。';
    await env.KV.delete('pubok:' + user);
    const list = JSON.parse(await env.KV.get('pending') || '[]');
    if (!list.length) return '暂存区是空的，没有要发布的';

    /* 你的规则：成功不用回（你本来就会刷页面确认），失败才单独推一条。
       因此发布一律后台跑——回复立即返回，不占微信回调的 5 秒窗口，
       也彻底避开"GitHub 慢导致降级提示"的时序问题。
       最近一次成败随时发「结果」可查。 */
    const task = flush(env, true, { keepPin }).then(
      (r) => ({ ok: true, msg: r || '' }),
      (e) => ({ ok: false, msg: String((e && e.message) || e) })
    );
    if (ctx && ctx.waitUntil) {
      /* 失败走 message/send 主动推送，与回调的 5 秒窗口无关，慢到什么时候都能送达 */
      ctx.waitUntil(
        task.then(async (r) => {
          const txt = await reportPublish(env, user, r, list.length);
          if (txt) await sendAppMessage(env, user, txt).catch((e) => console.error('[notify-failed]', e));
        })
      );
      return `🚀 已安排发布，稍等刷新网站即可。失败会单独通知你。`;
    }
    const done = await task; // 无 waitUntil 的环境（单测兜底）：同步落 KV
    return await reportPublish(env, user, done, list.length);
  }
  if (/^(取消)$/.test(text) && !conv) {
    const ok = await env.KV.get('pubok:' + user);
    if (ok) {
      await env.KV.delete('pubok:' + user);
      const n = JSON.parse(await env.KV.get('pending') || '[]').length;
      return `已退出发布，${n} 条暂存都还在（继续操作，或回「发」再看清单）`;
    }
  }
  if (/^(帮助|help|？|\?)$/i.test(cmd)) return helpText(env);

  /* 发布结果查询：默认只给"成没成"，原始报错展开在这里（排查用） */
  if (/^(结果|诊断|状态|result|status)$/i.test(cmd)) {
    const r = await env.KV.get('pubres:' + user);
    if (!r) return '最近没有发布记录。发「发」→「确认」之后再看这里';
    let o = {};
    try { o = JSON.parse(r); } catch (_) { o = { raw: String(r) }; }
    return [
      (o.ok ? '✓ 上次发布成功' : '✗ 上次发布失败') + (o.at ? `（${o.at}）` : ''),
      o.n ? `条数：${o.n}` : '',
      o.raw ? '原始返回：\n' + String(o.raw).slice(0, 400) : '',
      o.ok ? '' : '\n内容已放回暂存区，回复「发」→「确认」重试',
    ].filter(Boolean).join('\n');
  }

  /* 备份/恢复结果查询：推送可能被企业微信拦掉，这里兜底（读 bkres，后台任务完成后落 KV） */
  if (/^(备份|恢复)结果$/i.test(cmd)) {
    const r = await env.KV.get('bkres:' + user);
    if (!r) return '最近没有备份/恢复记录。发「备份D1」或「恢复D1」之后（等一两分钟）再看这里';
    let o = {};
    try { o = JSON.parse(r); } catch (_) { o = { raw: String(r) }; }
    const what = o.op || '备份';
    return [
      (o.ok ? '✓ 上次' + what + '成功' : '✗ 上次' + what + '失败') + (o.at ? `（${o.at}）` : ''),
      '原始返回：\n' + String(o.raw).slice(0, 400),
    ].filter(Boolean).join('\n');
  }

  if (/^(瞬|瞬间)$/.test(cmd)) {
    if (lines.length < 2) return '格式：\n瞬\n片名或书名\n文案（可多行，最后可带日期如 10-29）';
    const name = lines[1];
    let rest = lines.slice(2).join('\n');
    let date = '';
    const dm = rest.match(DATE_RE);
    if (dm) {
      const now = new Date();
      const mm = +dm[1], dd = +dm[2];
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return `日期看不懂：${dm[0]}`;
      let y = now.getFullYear();
      if (mm > now.getMonth() + 1) y--; // 补记去年的
      date = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      rest = rest.replace(DATE_RE, '');
    }
    return searchWatch(env, user, name, rest, date);
  }

  if (/^(文|文章)$/.test(cmd)) {
    if (lines.length < 3) return '格式：\n文\n标题\n链接 或 正文（可多行）';
    return stagePost(env, user, lines[1], lines.slice(2));
  }

  if (/^(图|图片)$/.test(cmd)) {
    const urls = lines.slice(1).filter((l) => URL_RE.test(l));
    if (!urls.length) return '格式：\n图\n图片链接（可多行）\n或直接发图片文件';
    return stagePhotos(env, user, urls);
  }

  if (/^(列表|文章列表|list)$/i.test(cmd)) {
    return '本站点没有文章列表查询，用后台管理页查看';
  }

  if (/^(改|修改)$/.test(cmd)) {
    return '先搜再改：回「改 关键词」搜文章，或「查 关键词」→ 回序号选中 → 回「改」贴新正文';
  }

  return conv ? '回复序号选择，或"取消"' : helpText(env);
}

/* ⚠ 微信被动回复上限 2048 字节：HELP 必须 ≤1950（test.mjs 有断言），加内容先量字节 */
const HELP = ['主站机器人支持：', '', '【新增】', '瞬 → 片名/书名 → 文案（末行可带日期 10-29；自动配海报，重复观看会提醒防误记）', '文 → 标题 → 链接或正文（可多行）', '图 → 图片链接（可多行）', '待办 事项 / 待办电影 片名（搜索） / 待办书 书名', '', '【查询】', '查瞬/查文/查图 关键词（查图可按日期：查图 10-29）', '查待办（未完成）/ 查待办完成 / 查 关键词（四类一起搜）', '（多命中回序号选中；多页回「下页」，序号跨页连续；批量：删 1,2 / 完 1,2 / 废 1,2 / 开 1,2）', '', '【选中后】', '改/删/顶；完 完成 / 废 废弃 / 开 恢复未完成', '强完 序号 —— 二刷强制再记一条瞬间', '', '【发布】', '发 → 确认 / 取消（含新增可回「确认顶」：保留原置顶）', '撤回 / 撤回 序号 / 清空 / 结果', '', '【数据与灾备】', '数据源 —— 当前 D1/GitHub 与备份｜数据源D1 / 数据源GitHub —— 切换数据源', '备份D1 —— 手动备份（另有每日自动）｜恢复D1 —— 从备份分支灌回｜备份结果 —— 上次结果', '', '⚠️ 直接发图暂不可用：传图床后发「图+链接」'].join('\n');

function helpText() { return HELP; }

/* 单条暂存项的一句话描述：编号清单和「撤回」回执共用，保证两边叫法一致 */
function opLabel(op) {
  const it = op.item || {};
  const cut = (s, n = 26) => String(s == null ? '' : s).slice(0, n);
  const title = it.title || (it.content || '').replace(/<[^>]+>/g, '').slice(0, 14) || '';
  const book = title ? '《' + cut(title) + '》' : '';
  const file = String(it.src || it.url || '').split('/').pop() || '';
  switch (op.file) {
    case 'moments': return '新增瞬间 ' + book;
    case 'posts': return '新增文章 ' + book;
    case 'photos': return '新增图片 ' + cut(file, 24);
    case 'edit': case 'pedit': return '改正文 ' + book;
    case 'medit': return '改瞬间 ' + book + (it.date ? ' → ' + it.date : '');
    case 'mdel': return '删瞬间 ' + book;
    case 'pdel': return '删文章 ' + book;
    case 'phdel': return '删图片 ' + cut(file, 24);
    case 'pin': return '文章置顶 ' + book;
    case 'phpin': return '图片置顶 ' + cut(file, 24);
    case 'todos': return ({ add: '新增待办 ', done: '完成待办 ', drop: '废弃待办 ', undone: '恢复待办 ' }[op.op] || '待办 ') + cut(it.title || it.note, 20);
    default: return (op.file || '条目') + ' ' + book;
  }
}

/* 发布前的清单：逐条编号（编号 = 暂存区顺序 = 「撤回 序号」的序号），
   一眼能看出同名重复，也能精确撤掉某一条 */
function publishPreview(list) {
  const MAX = 20; // 一屏能看完，超出只显示前 20 条编号
  const lines = list.slice(0, MAX).map((op, i) => `${i + 1}. ${opLabel(op)}`);
  const more = list.length > MAX ? `\n…还有 ${list.length - MAX} 条（编号接着排）` : '';
  /* 本批含新增（文章/图片）才给两种推送选项，避免每批都啰嗦；
     取消 / 清空 单列一组：取消=退回暂存继续操作，清空=唯一不可恢复的动作，放最后 */
  const hasNew = list.some((o) => o.file === 'posts' || o.file === 'data' || o.file === 'photos');
  const tail = '回「取消」—— 先不发布，回去继续操作（内容都还在）\n回「清空」—— 全部丢弃，不可恢复';
  const foot = hasNew
    ? '新内容排哪，二选一（都是推到线上）：\n回「确认」—— 新内容排最前\n回「确认顶」—— 保留原置顶（新内容排在原第 1 条之后）\n\n其他：\n' + tail
    : '回「确认」—— 推送到线上\n' + tail;
  return `将发布 ${list.length} 条：\n` + lines.join('\n') + more + '\n\n回「撤回 序号」删掉其中一条\n' + foot;
}

/* ================= 瞬间：搜索与确认 ================= */
/* ★★★适配点2★★★ 从这里到「图片墙」一节结束，都是"微信消息 → 你网站的数据条目"的组装逻辑。
   条目字段（date/title/content/type…）要对照你自己数据文件里一条真实记录来改。
   只想收文章的话：保留 stagePost、删掉「瞬间」整节和 handleText 里的瞬分支即可。 */

async function searchWatch(env, user, name, text, date) {
  const hits = await tmdbSearch(env.TMDB_KEY, name);
  if (hits.length) {
    await env.KV.put('conv:' + user, JSON.stringify({ candidates: hits, text, date }), { expirationTtl: 1800 });
    return '找到这些，回复序号确认：\n' + hits.map((h, i) => `${i + 1}. ${h.label}`).join('\n') + '\n都不对回复"取消"，将转查图书';
  }
  return bookSearch(env, user, name, text, date);
}

async function bookSearch(env, user, name, text, date) {
  const hits = await googleBooks(name);
  if (!hits.length) {
    // 都查不到：按纯文字随笔入瞬间
    await stageMoment(env, user, { type: 'text', label: name }, text, date);
    return `《${name}》没查到电影/图书，已按纯文字随笔暂存（回复"撤回"可撤销）`;
  }
  await env.KV.put('conv:' + user, JSON.stringify({ candidates: hits, text, date, book: true }), { expirationTtl: 1800 });
  return '图书找到这些，回复序号确认：\n' + hits.map((h, i) => `${i + 1}. ${h.label}`).join('\n') + '\n都不对回复"取消"（将按纯文字随笔记录）';
}

async function tmdbSearch(key, query) {
  const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${key}&language=zh-CN&query=${encodeURIComponent(query)}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || [])
    .filter((x) => x.media_type === 'movie' || x.media_type === 'tv')
    .slice(0, 4)
    .map((x) => ({
      tmdbId: x.id, kind: x.media_type,
      title: x.media_type === 'movie' ? x.title : x.name,
      year: (x.release_date || x.first_air_date || '').slice(0, 4),
      poster: x.poster_path ? 'https://image.tmdb.org/t/p/w92' + x.poster_path : '',
      label: `${x.media_type === 'movie' ? '🎬' : '📺'} ${x.media_type === 'movie' ? x.title : x.name} (${(x.release_date || x.first_air_date || '').slice(0, 4)})`,
    }));
}

async function tmdbDetail(key, kind, id) {
  const r = await fetch(`https://api.themoviedb.org/3/${kind}/${id}?api_key=${key}&language=zh-CN`);
  if (!r.ok) return {};
  const x = await r.json();
  const runtime = kind === 'movie' ? x.runtime : (x.episode_run_time && x.episode_run_time[0]) || 0;
  return { title: kind === 'movie' ? x.title : x.name, runtime: runtime || 0, poster: x.poster_path ? 'https://image.tmdb.org/t/p/w92' + x.poster_path : '' };
}

async function googleBooks(q) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=4`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.items || []).map((it) => {
    const v = it.volumeInfo || {};
    return {
      book: true, title: v.title + (v.subtitle ? '：' + v.subtitle : ''),
      poster: (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail) || '').replace(/^http:/, 'https:'),
      label: `📚 ${v.title || '(无标题)'} (${(v.publishedDate || '').slice(0, 4)})`,
    };
  });
}

/* 瞬间查重：title→条目索引，KV 缓存 10 分钟（每次发布后清掉重建）。
   用来在「瞬」确认时提醒"已记录过"，避免同一部片重复入库（用户要求提醒而非拦截）。 */
async function momentsTitleIndex(env) {
  /* 名录优先：data/catalog.js 是发布时随瞬间自动重算的轻量索引（{年份:[片名]} 映射，~11KB），
     1 个请求搞定查重。名录缺失/损坏（老部署还没发布过瞬间）→ 退回全卷扫描。 */
  try {
    const text = await readRepoFile(env, 'data/catalog.js');
    const i = text.indexOf('{');
    const map = JSON.parse(text.slice(i, text.lastIndexOf('}') + 1));
    const pairs = [];
    Object.keys(map).sort((a, b) => b.localeCompare(a)).forEach((yy) => map[yy].forEach((t) => pairs.push({ t, d: yy })));
    if (pairs.length) return pairs;
  } catch (e) { /* 走兜底 */ }
  const cached = JSON.parse(await env.KV.get('momentsIdx') || 'null');
  if (cached) return cached;
  const ref = await gh(env, '/git/ref/heads/main');
  const base = await gh(env, '/git/commits/' + ref.object.sha);
  const tree = await gh(env, '/git/trees/' + base.tree.sha + '?recursive=1');
  const node = (p) => (tree.tree || []).find((t) => t.path === p);
  const mf = node('data/moments.js');
  if (!mf) return [];
  const years = parseMomentsManifest(await readDataFile(env, mf.sha));
  const idx = [];
  await Promise.all(years.map(async (y) => {
    const v = node(`data/moments-${y}.js`);
    if (!v) return;
    try {
      parseMomentPart(await readDataFile(env, v.sha)).forEach((m) => { if (m.title) idx.push({ t: m.title, d: m.date || '' }); });
    } catch (e) { /* 单卷坏了不影响整体查重 */ }
  }));
  await env.KV.put('momentsIdx', JSON.stringify(idx), { expirationTtl: 600 }).catch(() => {});
  return idx;
}
function findMomentDups(idx, title) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const t = norm(title);
  return idx.filter((x) => norm(x.t) === t).sort((a, b) => String(b.d).localeCompare(String(a.d)));
}

async function confirmMoment(env, user, c, text, date) {
  let title = c.title, runtime = 0, poster = c.poster || '';
  if (c.tmdbId) {
    const d = await tmdbDetail(env.TMDB_KEY, c.kind, c.tmdbId);
    title = d.title || title; runtime = d.runtime || 0; poster = d.poster || poster;
  }
  if (!c.force) {
    const dups = findMomentDups(await momentsTitleIndex(env), title);
    if (dups.length) {
      await env.KV.put('conv:' + user, JSON.stringify({ repick: c, text, date }), { expirationTtl: 1800 });
      const firstYr = String(dups[dups.length - 1].d || '').slice(0, 4); // dups 按日期倒序，末位=最早
      const extra = dups.length > 1 ? `（共 ${dups.length} 条，最近 ${String(dups[0].d).slice(0, 4)} 年）` : '';
      return `⚠️ 《${title}》${firstYr} 年已有记录${extra}，是否再刷一遍？\n\n是二刷 → 回复「二刷」，会新增一条\n发错了 → 重发「瞬」或「取消」`;
    }
  }
  await stageMoment(env, user, { type: c.book ? 'book' : 'movie', title, runtime, poster, kind: c.kind, tmdbId: c.tmdbId }, text, date);
  return `✓ 已暂存《${title}》${runtime ? ' ' + runtime + ' 分钟' : ''}。（可继续其他操作；想直接发布回「发」→「确认」）`;
}

async function stageMoment(env, user, pick, text, date) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const d = date || `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const hh = new Date(now.getTime() + 8 * 3600e3); // 北京时间
  const stamp = `${d.replace(/-/g, '/')} ${p(hh.getHours())}:${p(hh.getMinutes())}:00`;
  const paras = (text || '').split('\n').filter(Boolean).map((l) => `<p style="">${esc(l)}</p>`).join('');
  const item = {
    date: stamp,
    content: (pick.title ? `<p style="">${esc(pick.title)}${pick.runtime ? ` · ${pick.runtime} 分钟` : ''}</p>` : '') + paras + (pick.poster && pick.type === 'movie' ? `<div class="moment-imgs"><img src="${pick.poster.replace('/w92/', '/w500/')}"></div>` : ''),
    type: pick.type,
  };
  if (pick.title) { item.title = pick.title; item.runtime = pick.runtime || 0; item.poster = pick.poster || ''; if (pick.tmdbId) item.tmdbId = pick.tmdbId; }
  if (pick.type === 'movie') item.kind = pick.kind || 'movie';
  await pushPending(env, { file: 'moments', item });
}

/* ================= 文章 ================= */

/* markdown → 纯文本（给标题/摘要用：剥掉记号只留内容） */
function mdPlain(t) {
  return t
    .replace(/`([^`]*)`/g, '$1')             // 行内代码
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')  // 图片语法
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^\s*#{1,6}\s+/gm, '')          // 标题
    .replace(/^\s*>\s?/gm, '')               // 引用
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')   // 列表符
    .replace(/^\s*-{3,}\s*$/gm, '')          // 分隔线
    .replace(/^\s*\|[-\s|:]+\|\s*$/gm, '')   // 表格分隔行
    .replace(/\s*\|\s*/g, ' ')               // 表格竖线
    .replace(/\*\*([^*]*)\*\*/g, '$1').replace(/__([^_]*)__/g, '$1') // 粗体
    .replace(/\*([^*\n]+)\*/g, '$1')         // 斜体
    .replace(/\s+/g, ' ')
    .trim();
}

async function stagePost(env, user, title, bodyLines) {
  const first = bodyLines[0] || '';
  // 「原文链接」模式仅当整行就是一个 URL；一行里文字夹链接应走富文本识别
  const m0 = first.match(/https?:\/\/\S+/);
  const isLink = !!(m0 && bodyLines.length === 1 && first.trim() === m0[0] && first.length < 500);
  /* 标题剥 markdown 记号（用户常把 # 标题/粗体直接当标题行发） */
  const cleanTitle = (title.replace(/^#{1,6}\s+/, '').replace(/[`*]/g, '').trim()) || title;
  const content = isLink
    ? `<p style="">原文：<a href="${esc(first)}" target="_blank">${esc(first)}</a></p>`
    : mdBlock(bodyLines);
  /* 封面/摘要：cover 取正文第一张图；摘要剔除图片链接（它们在正文里是图，不是文字） */
  const cover = (content.match(/<img[^>]*src="([^"]+)"/i) || [])[1] || '';
  const summary = ((isLink ? '外链：' + first : mdPlain(bodyLines.join('\n')).replace(/<[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, (u) => (IMGBED_RE.test(u) || IMG_URL_RE.test(u) ? '' : u))
    .replace(/\s+/g, ' ').trim()).slice(0, 80)) || (cover ? '（图片）' : '');
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const excerpt = summary; // 字段名叫 excerpt，内容同规则
  const item = {
    slug: slugify(cleanTitle) || 'wecom-' + Date.now().toString(36),
    title: cleanTitle, date,
    categories: [], tags: [], cover, excerpt, content,
  };
  await pushPending(env, { file: 'posts', item });
  return `✓ 已暂存文章《${cleanTitle}》${isLink ? '(外链)' : ''}。（可继续其他操作；想直接发布回「发」→「确认」）` + await dupHint(env, 'posts', cleanTitle);
}

/* 正文里的裸链接自动识别：图片链接→内嵌图，视频/音频→播放器，附件→📎下载链接，网址→可点链接 */
const IMG_URL_RE = /\.(jpe?g|png|gif|webp|bmp|avif)(\?\S*)?$/i;
const VIDEO_URL_RE = /\.(mp4|webm|mov|m4v)(\?\S*)?$/i;
const AUDIO_URL_RE = /\.(mp3|m4a|wav|ogg)(\?\S*)?$/i;
const FILE_URL_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)(\?\S*)?$/i;
const IMGBED_RE = /^https:\/\/img\.example\.com\/file\//; // ★★★适配点4★★★ 换成你的图床域名（无扩展名链接默认按图片处理）

function richLine(line) {
  // URL 后面紧挨中文标点时不把标点吞进链接
  const re = /https?:\/\/[^\s<>"'。，、！？；：）)】\]]+/g;
  let out = '', last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) out += esc(line.slice(last, m.index));
    const u = m[0];
    if (VIDEO_URL_RE.test(u)) {
      out += `<video src="${u}" controls preload="metadata"></video>`;
    } else if (AUDIO_URL_RE.test(u)) {
      out += `<audio src="${u}" controls preload="metadata"></audio>`;
    } else if (IMGBED_RE.test(u) || IMG_URL_RE.test(u)) {
      out += `<img src="${u}" alt="">`;
    } else if (FILE_URL_RE.test(u)) {
      let name = '附件';
      try { name = decodeURIComponent(u.split('/').pop().split('?')[0]) || '附件'; } catch (_) {}
      out += `<a href="${u}" target="_blank">📎 ${esc(name)}</a>`;
    } else {
      out += `<a href="${u}" target="_blank">${esc(u)}</a>`;
    }
    last = m.index + u.length;
  }
  out += esc(line.slice(last));
  return out;
}

/* 行内 markdown：**粗体**、`代码`。在 richLine 之后跑——URL 已变成 <a>/<img>，
   记号替换不会碰标签内部（** 和 ` 不会出现在 URL/已转义文本之外的地方也能安全替换） */
function mdInline(html) {
  return html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

/* 块级 markdown：## 标题 / > 引用 / - 列表 / 空行分段；其余行为普通段落。
   无记号的文本和以前完全一样（逐行 <p>），完全向后兼容。 */
function mdBlock(lines) {
  const out = [];
  let para = [], quote = [], list = [];
  const flushPara = () => { if (para.length) { out.push(`<p style="">${para.map(mdInline).join('<br>')}</p>`); para = []; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote style="">${quote.map(mdInline).join('<br>')}</blockquote>`); quote = []; } };
  const flushList = () => { if (list.length) { out.push(`<ul style="">${list.map((i) => `<li>${mdInline(i)}</li>`).join('')}</ul>`); list = []; } };
  const flushAll = () => { flushPara(); flushQuote(); flushList(); };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushAll(); continue; }
    let m;
    if ((m = line.match(/^#{1,4}\s+(.+)$/))) { flushAll(); out.push(`<h3 style="">${mdInline(richLine(m[1]))}</h3>`); }
    else if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(richLine(m[1])); }
    else if ((m = line.match(/^[-*]\s+(.+)$/))) { flushPara(); flushQuote(); list.push(richLine(m[1])); }
    else { flushQuote(); flushList(); para.push(richLine(line)); }
  }
  flushAll();
  return out.join('');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || '';
}

/* 同标题重发：slug/标题撞车时加时间戳后缀（北京时间）。
   key 进 slug：测试顶和说明-10-31-1835；show 进标题副标题：测试顶和说明 · 10-31 18:35
   这样站内搜索同名时也能一眼看出哪篇是最新发的 */
function cnStamp(d) {
  const t = new Date((d ? d.getTime() : Date.now()) + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
  const hm = `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
  return { key: `${md}-${hm.replace(':', '')}`, show: `${md} ${hm}` };
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* ================= 图片墙 ================= */

async function stagePhotos(env, user, urls) {
  for (const u of urls) await pushPending(env, { file: 'photos', item: { src: u, note: '', date: bjDate() } });
  return `✓ 已暂存 ${urls.length} 张图片。（可继续其他操作；想直接发布回「发」→「确认」）`;
}

async function handleImageFile(env, mediaId) {
  const src = await uploadToImgbed(env, mediaId);
  await pushPending(env, { file: 'photos', item: { src, note: '', date: bjDate() } });
  return `✓ 已暂存图片 ${src}\n（可继续其他操作；想直接发布回「发」→「确认」）`;
}

function bjDate() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function bjNow() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/* ================= 主站管理：查 / 删 / 改 / 待办 ================= */

/* 读仓库里任意 data/*.js：D1 优先（迁移后新真相），未命中回退 GitHub（旧路径 3 次调用） */
async function readRepoData(env, path) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT body FROM files WHERE path = ?1').bind(path).first();
      if (row && row.body != null) return row.body;
    } catch (e) { /* 回退 GitHub */ }
  }
  const ref = await gh(env, '/git/ref/heads/main');
  const base = await gh(env, '/git/commits/' + ref.object.sha);
  const tree = await gh(env, '/git/trees/' + base.tree.sha + '?recursive=1');
  const node = (tree.tree || []).find((t) => t.path === path);
  if (!node) throw new Error('仓库里找不到 ' + path);
  return readDataFile(env, node.sha);
}

const normKw = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
/* 图片地址：图床链接原样返回；仓库相对路径（photos/gallery/…）拼站点域名，保证复制即可打开。
   域名优先取 env.SITE_URL，未配置时用 CF 默认域名（换自定义域名也不影响，两个都通） */
const SITE_BASE = (env) => String((env && env.SITE_URL) || 'https://your-site.pages.dev').replace(/\/+$/, '');
function photoUrl(env, src) {
  const s = String(src || '');
  if (!s) return '';
  if (/^(https?:)?\/\//i.test(s) || /^data:/i.test(s)) return s;
  return SITE_BASE(env) + '/' + s.replace(/^\/+/, '');
}
function selLabel(sel) {
  const tag = (sel.kind === 'moment') ? '[瞬]'
    : (sel.kind === 'post') ? '[文]'
      : (sel.kind === 'photo') ? '[图]' : '[待]';
  const when = sel.date ? '（' + String(sel.date).slice(0, 10) + '）' : '';
  /* 图片：完整 URL 不截断（截断就没法打开）；其他类型标题截断 30 字 */
  if (sel.kind === 'photo') return `${tag} ${sel.url || sel.src || ''}${when}`;
  return `${tag} ${String(sel.title || sel.note || sel.name || sel.src || '').slice(0, 30)}${when}`;
}

/* 分类型搜索（每个函数独立 try，单类数据损坏不影响其他） */
/* 各搜索：内部 try/catch 兜底，但网络失败记入 errs（可选传入），由调用方决定是否提示重试 */
async function searchMomentsKw(env, k, errs) {
  const out = [];
  try {
    const text = await readRepoFile(env, 'data/catalog.js');
    const map = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const years = Object.keys(map).sort((a, b) => b.localeCompare(a))
      .filter((y) => (map[y] || []).some((t) => normKw(t).includes(k)));
    for (const y of years.slice(0, 3)) { // 最多拉 3 个命中年份的卷
      const vol = parseMomentPart(await readRepoData(env, `data/moments-${y}.js`));
      vol.forEach((m, idx) => { if (normKw(m.title).includes(k)) out.push({ kind: 'moment', year: y, idx, title: m.title, date: m.date }); });
    }
  } catch (e) { if (errs) errs.push('瞬间'); /* 名录缺失跳过 */ }
  return out;
}
async function searchPostsKw(env, k, errs) {
  const out = [];
  try {
    parseArr(await readRepoData(env, 'data/posts.js')).forEach((p) => {
      if (normKw(p.title).includes(k)) out.push({ kind: 'post', slug: p.slug, title: p.title, date: p.date });
    });
  } catch (e) { if (errs) errs.push('文章'); /* 无文章 */ }
  return out;
}
async function searchPhotosKw(env, k, errs, byDate) {
  const out = [];
  /* 图片的备注基本为空、src 是哈希，唯一人可读的线索是日期。
     专用「查图」时允许按日期匹配（10-29 / 2026-10-29 / 20261029 都认）；
     全库搜不启用，否则「查 2026」会被整年的图灌满。
     注意：只有查询词本身是「纯日期形态」（数字+分隔符、≥4 位数字）才按日期搜，
     否则「查图 O1」里的数字 1 会命中全部日期。 */
  const isDateKw = byDate && /^[\d\-\/.年月日]+$/.test(String(k || '')) && String(k).replace(/\D/g, '').length >= 4;
  const kd = isDateKw ? String(k).replace(/\D/g, '') : '';
  try {
    parseArr(await readRepoData(env, 'data/photos.js')).forEach((p, idx) => {
      const hitText = normKw(p.note).includes(k) || normKw(p.src).includes(k);
      const hitDate = !!(byDate && kd) && String(p.date || '').replace(/\D/g, '').includes(kd);
      if (hitText || hitDate) out.push({ kind: 'photo', idx, src: p.src, url: photoUrl(env, p.src), date: p.date });
    });
  } catch (e) { if (errs) errs.push('图片'); /* 无图片墙 */ }
  return out;
}
async function searchTodosKw(env, k, state, errs) {
  const out = [];
  try {
    parseArr(await readRepoData(env, 'data/todos.js')).forEach((t) => {
      const st = t.dropped ? 'dropped' : t.done ? 'done' : 'pending';
      if (st !== (state || 'pending')) return;
      if (normKw(t.title).includes(k) || normKw(t.note).includes(k)) out.push({ kind: 'todo', id: t.id, title: t.title || '', note: t.note || '', todoKind: t.kind, runtime: t.runtime || 0, poster: t.poster || '', tmdbId: t.tmdbId, done: !!t.done, dropped: !!t.dropped, date: t.droppedAt || t.doneAt || t.createdAt });
    });
  } catch (e) { if (errs) errs.push('待办'); /* 无待办 */ }
  return out;
}

/* 查：scope = moment/post/photo/todo(未完成)/todo-done(已完成)/all */
/* ---- 统一分页：结果多于一页时只回第一页，回「下页」翻看。序号全局连续，跨页可直接用 ---- */
function renderPage(st, p) {
  const pages = Math.ceil(st.lines.length / st.size);
  const start = p * st.size;
  let out = st.title + '\n' + st.lines.slice(start, start + st.size).map((l, i) => `${start + i + 1}. ${l}`).join('\n');
  if (pages > 1) out += `\n\n— 第 ${p + 1}/${pages} 页` + (p + 1 < pages ? '，回复「下页」看后面' : '（已到末页）');
  if (st.footer && (pages === 1 || p + 1 >= pages)) out += '\n\n' + st.footer;
  return out;
}
async function pagedReply(env, user, title, lines, size, footer) {
  const st = { title, lines, size, footer: footer || '', page: 0 };
  await env.KV.put('page:' + user, JSON.stringify(st), { expirationTtl: 1800 });
  return renderPage(st, 0);
}

async function searchAllCmd(env, user, kw, scope) {
  const k = normKw(kw);
  /* 并行跑各搜索：全库搜串行最多 7 个请求容易超微信 5 秒回复时限（回复被丢弃=看起来没结果） */
  const errs = [];
  const jobs = [];
  if (scope === 'all' || scope === 'moment') jobs.push(searchMomentsKw(env, k, errs));
  if (scope === 'all' || scope === 'post') jobs.push(searchPostsKw(env, k, errs));
  if (scope === 'all') jobs.push(searchPhotosKw(env, k, errs, false));
  if (scope === 'photo') jobs.push(searchPhotosKw(env, k, errs, true));
  if (scope === 'all') jobs.push(searchTodosKw(env, k, false, errs));
  if (scope === 'todo') jobs.push(searchTodosKw(env, k, false, errs));
  if (scope === 'todo-done') jobs.push(searchTodosKw(env, k, true, errs));
  let out = [];
  for (const part of await Promise.all(jobs)) out = out.concat(part);
  const hits = out.slice(0, 50);
  if (!hits.length) {
    if (errs.length) return `搜索请求失败（${[...new Set(errs)].join('/')}源），请重发一次试试`;
    if (scope === 'all' && /^[瞬文图待办]/.test(kw) && kw.length > 1)
      return `没找到含「${kw}」的条目。\n提示：类型和关键词之间要有空格，如「查瞬 ${kw.slice(1)}」「查待办 ${kw.slice(2)}」`;
    return `没找到含「${kw}」的条目`;
  }
  await env.KV.put('conv:' + user, JSON.stringify({ results: hits }), { expirationTtl: 1800 });
  if (scope.startsWith('todo')) {
    return pagedReply(env, user, '找到这些，回复序号选中：', hits.map((h) => {
      const icon = h.todoKind === 'movie' ? '🎬' : h.todoKind === 'tv' ? '📺' : h.todoKind === 'book' ? '📚' : '✍️';
      return `${icon} ${String(h.title || h.note || '').slice(0, 26)}（${h.dropped ? '已废弃·' : h.done ? '已完成·' : ''}${String(h.date || '').slice(0, 10)}）`;
    }), 10, '选好后回：完 1 / 废 1 / 开 1（多条用逗号：完 1,2）/「取消」退出');
  }
  /* 底部操作提示按结果类型显示：图片没有「改」（有「顶」），全库混搜就不写死 */
  const allPhoto = hits.length && hits.every((h) => h.kind === 'photo');
  const foot = allPhoto || scope === 'photo'
    ? '选好后回：删 1 / 顶 1（多条：删 1,2）/「取消」退出'
    : scope === 'all'
      ? '选好后回：删 1,2 / 改 1 / 顶 1 / 完 1,2（按类型，动作在前）/「取消」退出'
      : '选好后回：删 1,2 / 改 1 / 顶 1（动作在前）/「取消」退出';
  return pagedReply(env, user, '找到这些，回复序号选中：', hits.map((h) => selLabel(h)), 10, foot);
}

/* 改待办 关键词/序号：先搜未完成，再搜已完成；序号按未完成列表定位 */
async function manageTodo(env, user, kw) {
  let sel = null;
  const stateText = { pending: '未完成', done: '已完成', dropped: '已废弃' };
  if (/^\d+$/.test(kw)) {
    const pend = parseArr(await readRepoData(env, 'data/todos.js')).filter((t) => !t.done && !t.dropped);
    const t = pend[+kw - 1];
    if (!t) return `序号超出范围（共 ${pend.length} 条未完成）。发「查待办」查看`;
    sel = { kind: 'todo', id: t.id, title: t.title || '', note: t.note || '', todoKind: t.kind, runtime: t.runtime || 0, poster: t.poster || '', tmdbId: t.tmdbId, done: false, dropped: false, date: t.createdAt };
  } else {
    const k = normKw(kw);
    /* 未完成 → 已完成 → 已废弃 逐层兜底 */
    for (const st of ['pending', 'done', 'dropped']) {
      const hits = (await searchTodosKw(env, k, st)).slice(0, 10);
      if (!hits.length) continue;
      if (hits.length === 1) { sel = hits[0]; break; }
      await env.KV.put('conv:' + user, JSON.stringify({ results: hits }), { expirationTtl: 1800 });
      return `${stateText[st]}的里找到这些，回复序号选中：\n` + hits.map((h, i) => `${i + 1}. ${String(h.title || h.note || '').slice(0, 26)}（${String(h.date || '').slice(0, 10)}）`).join('\n')
        + (st === 'pending'
          ? '\n\n选好后回：完 1 / 废 1（多条：完 1,2）/「取消」退出'
          : '\n\n选好后回：开 1（多条：开 1,2）/「取消」退出');
    }
    if (!sel) return `未完成、已完成、已废弃里都没找到「${kw}」`;
  }
  await env.KV.put('sel:' + user, JSON.stringify(sel), { expirationTtl: 1800 });
  const icon = sel.todoKind === 'movie' ? '🎬' : sel.todoKind === 'tv' ? '📺' : sel.todoKind === 'book' ? '📚' : '✍️';
  const st = sel.dropped ? 'dropped' : sel.done ? 'done' : 'pending';
  return `已选中：${icon} ${String(sel.title || sel.note || '').slice(0, 30)}（${stateText[st]}）\n回复`
    + (st === 'pending' ? '「完」完成 /「废」废弃 /「取消」退出' : '「开」恢复未完成 /「取消」退出');
}

/* 选中待办标记完成（影视/图书走查重+同步瞬间，与 完 序号 同链路） */
async function todoDoneSel(env, user, sel) {
  await env.KV.delete('sel:' + user);
  if (sel.done) return '这条已经是完成状态，回复「开」可恢复未完成';
  const isMedia = sel.todoKind !== 'note' && !!sel.title;
  if (isMedia) {
    const dups = findMomentDups(await momentsTitleIndex(env), sel.title);
    if (dups.length) {
      const firstYr = String(dups[dups.length - 1].d || '').slice(0, 4);
      const extra = dups.length > 1 ? `（共 ${dups.length} 条）` : '';
      await env.KV.put('conv:' + user, JSON.stringify({ redoTodo: sel }), { expirationTtl: 1800 });
      return `⚠️ 《${sel.title}》${firstYr} 年已有记录${extra}。\n二刷 → 回复「强完」（会新增一条瞬间）\n发错 → 回复「取消」`;
    }
  }
  await pushPending(env, { file: 'todos', op: 'done', item: { id: sel.id, title: sel.title || sel.note || '', doneAt: bjNow() } });
  let extra = '';
  if (isMedia) {
    await stageMoment(env, user, { type: sel.todoKind === 'book' ? 'book' : 'movie', title: sel.title, runtime: sel.runtime || 0, poster: sel.poster || '', kind: sel.todoKind, tmdbId: sel.tmdbId }, '', '');
    extra = '（影视/图书已同时暂存一条瞬间）';
  }
  return `✓ 已暂存完成：《${String(sel.title || sel.note || '').slice(0, 30)}》${extra}（可继续其他操作；想直接发布回「发」→「确认」）`;
}

/* 批量待办：废弃/恢复只改状态；完成时影视/图书照旧自动记瞬间，但要先查重
   （一条「强完」要人确认，所以有重复的条目这一批就先不动，单独处理） */
async function todoOpMany(env, user, items, op) {
  await env.KV.delete('sel:' + user);
  const tag = op === 'drop' ? '废弃' : '恢复未完成';
  const list = items.slice(0, 20);
  for (const t of list) {
    const item = { id: t.id, title: t.title || t.note || '' };
    if (op === 'drop') item.droppedAt = bjNow();
    await pushPending(env, { file: 'todos', op, item });
  }
  const names = list.map((t) => '《' + String(t.title || t.note || '').slice(0, 20) + '》').join('、');
  return `✓ 已暂存${tag} ${list.length} 条：${names}（可继续其他操作；想直接发布回「发」→「确认」）`;
}

async function todoDoneMany(env, user, items) {
  await env.KV.delete('sel:' + user);
  /* 只有未完成、且不是影视/图书的可以直接批量完成 */
  const todo = items.filter((t) => !t.done && !t.dropped);
  const media = todo.filter((t) => t.todoKind !== 'note' && t.title);
  const dupTitles = [];
  let idx = null;
  if (media.length) {
    idx = await momentsTitleIndex(env).catch(() => null);
    for (const t of media) if (idx && findMomentDups(idx, t.title).length) dupTitles.push(t.title);
  }
  const ok = todo.filter((t) => !dupTitles.includes(t.title));
  let momentN = 0;
  for (const t of ok) {
    await pushPending(env, { file: 'todos', op: 'done', item: { id: t.id, title: t.title || t.note || '', doneAt: bjNow() } });
    if (t.todoKind !== 'note' && t.title) {
      await stageMoment(env, user, { type: t.todoKind === 'book' ? 'book' : 'movie', title: t.title, runtime: t.runtime || 0, poster: t.poster || '', kind: t.todoKind, tmdbId: t.tmdbId }, '', '');
      momentN += 1;
    }
  }
  let out = `✓ 已暂存完成 ${ok.length} 条：${ok.map((t) => '《' + String(t.title || t.note || '').slice(0, 20) + '》').join('、')}`;
  if (momentN) out += `（其中 ${momentN} 条影视/图书已同时暂存瞬间）`;
  out += '（可继续其他操作；想直接发布回「发」→「确认」）';
  if (dupTitles.length) {
    out += `\n⚠️ ${dupTitles.map((t) => '《' + t + '》').join('、')} 之前已记录，这批没动。`
      + '\n二刷请单条来：查待办 → 序号选中 → 回「强完」';
  }
  const skipped = items.filter((t) => t.done || t.dropped).length;
  if (skipped) out += `\n（另有 ${skipped} 条本来就是完成/废弃状态，已跳过）`;
  return out;
}

/* 置顶 = 把条目移到数组最前（列表按数组顺序渲染）。不用 pin 字段：新内容照旧插最前把它挤下去 */
async function stagePinSel(env, user, sel) {
  await env.KV.delete('sel:' + user);
  const name = sel.title || sel.src || '';
  if (sel.kind === 'moment') return '瞬间按日期排序，不支持置顶';
  if (sel.kind === 'todo') return '待办不支持置顶';
  if (sel.kind === 'post') await pushPending(env, { file: 'pin', item: { slug: sel.slug, title: sel.title } });
  else await pushPending(env, { file: 'phpin', item: { src: sel.src } });
  return `✓ 已暂存置顶：${String(name).slice(0, 40)}（发布后排到最前；下次上新内容会自然退到后面）（可继续其他操作；想直接发布回「发」→「确认」）`;
}

/* 顶 关键词：搜文章（图片用「查图 关键词」选中后回「顶」） */
async function pinByKeyword(env, user, kw) {
  const k = normKw(kw);
  const hits = (await searchPostsKw(env, k)).slice(0, 10);
  if (!hits.length) return `没找到标题含「${kw}」的文章\n（图片置顶：先「查图 关键词」，选中后回「顶」）`;
  if (hits.length === 1) return stagePinSel(env, user, hits[0]);
  await env.KV.put('conv:' + user, JSON.stringify({ results: hits }), { expirationTtl: 1800 });
  return `找到 ${hits.length} 篇，回复序号选中：\n` + hits.map((h, i) => `${i + 1}. ${selLabel(h)}`).join('\n')
    + '\n\n选中后回复「顶」置顶 /「取消」放弃';
}

/* 删/改 + 关键词：唯一命中直接执行（省两步对话），多命中选中后需再回「删/改」确认（防误选） */
async function manageByKeyword(env, user, kw, action) {
  const k = normKw(kw);
  let out = await searchMomentsKw(env, k);
  out = out.concat(await searchPostsKw(env, k), await searchPhotosKw(env, k));
  const hits = out.slice(0, 10);
  if (!hits.length) return `没找到含「${kw}」的条目`;
  if (hits.length === 1) return action === 'del' ? stageDeleteSel(env, user, hits[0]) : beginEditSel(env, user, hits[0]);
  await env.KV.put('conv:' + user, JSON.stringify({ results: hits }), { expirationTtl: 1800 });
  return `找到 ${hits.length} 条「${kw}」，回复序号选中：\n` + hits.map((h, i) => `${i + 1}. ${selLabel(h)}`).join('\n')
    + `\n\n选中后回复「${action === 'del' ? '删' : '改'}」执行（防误选） /「取消」放弃`;
}

/* 批量删除：一次把多条选中项推入暂存。
   瞬间/图片靠数组下标定位，必须倒序推——前一条删掉后 idx 会整体前移，正序会定位失败 */
async function stageDeleteMany(env, user, items) {
  await env.KV.delete('sel:' + user);
  const names = [];
  for (const sel of items) {
    if (sel.kind === 'post') await pushPending(env, { file: 'pdel', item: { slug: sel.slug, title: sel.title } });
    else continue;
    names.push(sel.title || sel.name || '');
  }
  const moms = items.filter((s) => s.kind === 'moment')
    .sort((a, b) => (String(a.year) === String(b.year) ? b.idx - a.idx : String(b.year).localeCompare(String(a.year))));
  for (const sel of moms) {
    await pushPending(env, { file: 'mdel', item: { year: sel.year, idx: sel.idx, title: sel.title, date: sel.date } });
    names.push(sel.title || '');
  }
  const phs = items.filter((s) => s.kind === 'photo').sort((a, b) => b.idx - a.idx);
  for (const sel of phs) {
    await pushPending(env, { file: 'phdel', item: { idx: sel.idx, src: sel.src } });
    names.push(String(sel.src || '').split('/').pop() || '');
  }
  return `✓ 已暂存删除 ${items.length} 条：${names.map((n) => '《' + String(n).slice(0, 24) + '》').join('、')}（可继续其他操作；想直接发布回「发」→「确认」）`;
}

function stageDeleteSel(env, user, sel) {
  return (async () => {
    await env.KV.delete('sel:' + user);
    if (sel.kind === 'moment') await pushPending(env, { file: 'mdel', item: { year: sel.year, idx: sel.idx, title: sel.title, date: sel.date } });
    else if (sel.kind === 'post') await pushPending(env, { file: 'pdel', item: { slug: sel.slug, title: sel.title } });
    else await pushPending(env, { file: 'phdel', item: { idx: sel.idx, src: sel.src } });
    return `✓ 已暂存删除：${selLabel(sel)}（可继续其他操作；想直接发布回「发」→「确认」）`;
  })();
}

function beginEditSel(env, user, sel) {
  return (async () => {
    await env.KV.delete('sel:' + user);
    if (sel.kind === 'post') {
      await env.KV.put('edit2:' + user, JSON.stringify({ kind: 'post', slug: sel.slug, title: sel.title }), { expirationTtl: 1800 });
      return `修改《${sel.title}》正文：直接把新正文贴进来（markdown，整体替换；标题/摘要/封面不变）\n回复「取消」放弃`;
    }
    if (sel.kind === 'moment') {
      await env.KV.put('edit2:' + user, JSON.stringify({ kind: 'moment', year: sel.year, idx: sel.idx, title: sel.title }), { expirationTtl: 1800 });
      return `修改瞬间《${sel.title}》：\n· 直接发新文案（替换文字，图片保留）\n· 或发「改日期 2025-06-01」（只改日期）\n回复「取消」放弃`;
    }
    if (sel.kind === 'todo') return '待办不支持改，回复「完」完成 /「废」废弃 /「开」恢复即可';
    return '图片墙条目不支持改：删了重新发即可';
  })();
}

/* 改瞬间文案：保留片名行和图片块，文字段落整体替换（与 stageMoment 同一 HTML 结构） */
function rebuildMomentText(m, newText) {
  const c = String(m.content || '');
  const titleP = m.title ? (c.match(/<p[^>]*>[^<]*<\/p>/) || [''])[0] : '';
  const paras = String(newText).split('\n').map((s) => s.trim()).filter(Boolean).map((l) => `<p style="">${esc(l)}</p>`).join('');
  const media = (c.match(/<div class="moment-imgs">[\s\S]*?<\/div>/g) || []).join('');
  return titleP + paras + media;
}

/* ---- 待办 ---- */
function todoId() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

/* 待办电影 片名：只搜 TMDB（电影+剧集），搜不到就提示（图书没有好的国内刮削源，待办书直接新增） */
async function todoSearchCmd(env, user, rest) {
  const hits = await tmdbSearch(env.TMDB_KEY, rest);
  if (!hits.length) return `TMDB 没搜到「${rest}」。\n换个片名试试，或发「待办书 ${rest}」直接记图书`;
  await env.KV.put('conv:' + user, JSON.stringify({ candidates: hits, todo: true }), { expirationTtl: 1800 });
  return '找到这些，回复序号加入待办：\n' + hits.map((h, i) => `${i + 1}. ${h.label}`).join('\n') + '\n都不对回复"取消"';
}

async function stageTodoPick(env, user, c) {
  let title = c.title, runtime = 0, poster = c.poster || '';
  if (c.tmdbId) {
    const d = await tmdbDetail(env.TMDB_KEY, c.kind, c.tmdbId);
    title = d.title || title; runtime = d.runtime || 0; poster = d.poster || poster;
  }
  const item = { id: todoId(), kind: c.book ? 'book' : (c.kind || 'movie'), title, note: '', poster, runtime, createdAt: bjDate() + ' 12:00:00', done: false, doneAt: null };
  if (c.tmdbId) item.tmdbId = c.tmdbId;
  await pushPending(env, { file: 'todos', op: 'add', item });
  return `✓ 已暂存待办：${item.kind === 'movie' ? '🎬' : item.kind === 'tv' ? '📺' : '📚'}《${title}》（可继续其他操作；想直接发布回「发」→「确认」）`;
}

async function todoListCmd(env, user, view, kw) {
  const arr = parseArr(await readRepoData(env, 'data/todos.js'));
  const icon = (t) => (t.kind === 'movie' ? '🎬' : t.kind === 'tv' ? '📺' : t.kind === 'book' ? '📚' : '✍️');
  const line = (t, when) => `${icon(t)} ${(t.title || t.note || '').slice(0, 24)}（${when}）`;
  const toSel = (t, done) => ({ kind: 'todo', id: t.id, title: t.title || '', note: t.note || '', todoKind: t.kind, runtime: t.runtime || 0, poster: t.poster || '', tmdbId: t.tmdbId, done, dropped: !!t.dropped, date: t.createdAt });
  if (view === 'done') {
    const fin = arr.filter((t) => t.done).sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || '')));
    const dropN = arr.filter((t) => t.dropped).length;
    if (!fin.length) return '还没有已完成的待办' + (dropN ? `（已废弃 ${dropN} 条）` : '');
    await env.KV.put('conv:' + user, JSON.stringify({ results: fin.map((t) => toSel(t, true)) }), { expirationTtl: 1800 });
    return pagedReply(env, user, '已完成的待办（最近在前），回复序号选中：',
      fin.map((t) => line(t, '完成于 ' + String(t.doneAt || '').slice(0, 10))), 15,
      '选好后回：开 1（多条：开 1,2）/「取消」退出' + (dropN ? `\n另有已废弃 ${dropN} 条（改待办 关键词 可搜到并恢复）` : ''));
  }
  let pend = arr.filter((t) => !t.done && !t.dropped);
  if (kw) {
    const k = normKw(kw);
    pend = pend.filter((t) => normKw(t.title).includes(k) || normKw(t.note).includes(k));
    if (!pend.length) return `未完成待办里没找到「${kw}」（发「改待办 ${kw}」可搜已完成/已废弃）`;
    await env.KV.put('conv:' + user, JSON.stringify({ results: pend.map((t) => toSel(t, false)) }), { expirationTtl: 1800 });
    return pagedReply(env, user, `未完成待办（筛选「${kw}」），回复序号选中：`,
      pend.map((t) => line(t, String(t.createdAt || '').slice(0, 10))), 15,
      '选中后：回「完」完成 /「废」废弃');
  }
  const dropN = arr.filter((t) => t.dropped).length;
  if (!pend.length) {
    const fin = arr.filter((t) => t.done).length;
    const bits = [];
    if (fin) bits.push(`已完成 ${fin} 条（查待办完成 可看）`);
    if (dropN) bits.push(`已废弃 ${dropN} 条`);
    return bits.length ? `待办清单是空的（${bits.join('，')}）` : '待办清单是空的，享受无所事事的时光';
  }
  await env.KV.put('conv:' + user, JSON.stringify({ results: pend.map((t) => toSel(t, false)) }), { expirationTtl: 1800 });
  return pagedReply(env, user, '未完成待办，回复序号选中：',
    pend.map((t) => line(t, String(t.createdAt || '').slice(0, 10))), 15,
    '选好后回：完 1 / 废 1（多条：完 1,2；影视/图书完成会自动记一条瞬间）\n「取消」退出');
}

async function todoDoneCmd(env, user, n, force) {
  const arr = parseArr(await readRepoData(env, 'data/todos.js'));
  const pend = arr.filter((t) => !t.done && !t.dropped);
  const t = pend[n - 1];
  if (!t) return `序号超出范围（共 ${pend.length} 条未完成）。发「查待办」查看`;
  const isMedia = t.kind !== 'note' && !!t.title;
  if (isMedia && !force) {
    const dups = findMomentDups(await momentsTitleIndex(env), t.title);
    if (dups.length) {
      const firstYr = String(dups[dups.length - 1].d || '').slice(0, 4);
      const extra = dups.length > 1 ? `（共 ${dups.length} 条）` : '';
      return `⚠️ 《${t.title}》${firstYr} 年已有记录${extra}。\n二刷 → 回复「强完 ${n}」（会新增一条瞬间）\n发错 → 回复「取消」`;
    }
  }
  await pushPending(env, { file: 'todos', op: 'done', item: { id: t.id, title: t.title || t.note || '', doneAt: bjNow() } });
  let extra = '';
  if (isMedia) {
    await stageMoment(env, user, { type: t.kind === 'book' ? 'book' : 'movie', title: t.title, runtime: t.runtime || 0, poster: t.poster || '', kind: t.kind, tmdbId: t.tmdbId }, '', '');
    extra = '（影视/图书已同时暂存一条瞬间）';
  }
  return `✓ 已暂存完成：《${String(t.title || t.note || '').slice(0, 30)}》${extra}（可继续其他操作；想直接发布回「发」→「确认」）`;
}

async function wecomToken(env) {
  const cached = JSON.parse(await env.KV.get('wecom_token') || 'null');
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${env.CORP_ID}&corpsecret=${env.CORP_SECRET}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('获取微信凭证失败：' + JSON.stringify(j));
  await env.KV.put('wecom_token', JSON.stringify({ token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 }), { expirationTtl: 7200 });
  return j.access_token;
}

/* 主动发应用消息（用于后台任务的结果通知——回调回复只有 5 秒窗口，发布耗时超了就靠这条） */
async function sendAppMessage(env, toUser, text) {
  const token = await wecomToken(env);
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ touser: toUser, msgtype: 'text', agentid: Number(env.AGENT_ID) || env.AGENT_ID, text: { content: text } }),
  });
  const j = await r.json();
  if (j.errcode) throw new Error('发送通知失败：' + JSON.stringify(j));
  return j;
}

function sniffImage(buf) {
  // 返回 MIME；不是常见图片格式则返回 null（微信出错时 HTTP 也是 200，只能靠内容判断）
  const b = buf;
  const ascii = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

async function uploadToImgbed(env, mediaId) {
  const token = await wecomToken(env);
  const mr = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`);
  const buf = new Uint8Array(await mr.arrayBuffer());
  if (buf[0] === 0x7b /* '{' —— 微信把错误 JSON 当 200 返回 */) {
    let j = {};
    try { j = JSON.parse(new TextDecoder().decode(buf)); } catch (_) {}
    if (+j.errcode === 60020) {
      throw new Error('⚠️ 直接发图片暂时不可用：企业微信把咱服务器 IP 拦在门外（可信IP限制，60020）。\n请改发图片链接：先把图传到图床，再发「图\\n链接」');
    }
    throw new Error('下载图片失败：' + JSON.stringify(j).slice(0, 160));
  }
  const mime = sniffImage(buf);
  if (!mime) throw new Error('下载到的不是图片（' + buf.length + ' 字节），已放弃');
  /* ★★★适配点4★★★ 图床地址：改成你自己的图床（需支持匿名 POST 上传，返回 [{"src":"/file/xxx"}]）。
     没有图床可删掉 uploadToImgbed 整个函数和 handleImageFile 里的调用（图片只支持链接）。 */
  const ur = await fetch('https://img.example.com/upload', {
    method: 'POST',
    headers: env.IMG_TOKEN ? { Authorization: 'Bearer ' + env.IMG_TOKEN } : {}, // 图床匿名可传，凭证可选
    body: (() => { const fd = new FormData(); fd.append('file', new Blob([buf], { type: mime }), 'wecom-' + Date.now() + '.' + (mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1])); return fd; })(),
  });
  if (!ur.ok) throw new Error('传图床失败 ' + ur.status);
  const uj = await ur.json();
  const src = Array.isArray(uj) ? uj[0] && uj[0].src : uj.src;
  if (!src) throw new Error('图床返回异常：' + JSON.stringify(uj).slice(0, 100));
  return 'https://img.example.com' + src;
}

/* ================= 暂存队列与发布 ================= */

async function pushPending(env, op) {
  const list = JSON.parse(await env.KV.get('pending') || '[]');
  list.push(op);
  await env.KV.put('pending', JSON.stringify(list));
}

/* 暂存重名提醒：暂存区里已经有同名条目就提一句（不拦发布——同名会在发布时自动加时间戳区分）。
   只读 KV，不额外请求 GitHub，不拖慢暂存。
   注意：要在 pushPending 之后调用，同名条目数含刚存的这条（≥2 才算重名）。 */
async function dupHint(env, file, names) {
  const list = [].concat(names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!list.length) return '';
  const pend = JSON.parse(await env.KV.get('pending') || '[]');
  const hits = [];
  for (const n of list) {
    const key = normKw(n);
    const cnt = pend.filter((o) => o.file === file && o.item && normKw(o.item.title || o.item.name) === key).length;
    if (cnt >= 2) hits.push(`《${n.slice(0, 26)}》×${cnt}`);
  }
  if (!hits.length) return '';
  return `\n⚠️ 暂存区里已有同名：${hits.slice(0, 3).join('、')}——发布后都会上线（新的自动加时间戳）。`
    + '\n想删掉多余的：回「发」看清单编号，再回「撤回 序号」';
}

/* 撤回：不带序号撤最后一条；带序号撤「发」清单里的第 N 条（编号 = 暂存区顺序） */
async function undoLast(env, user, n) {
  const list = JSON.parse(await env.KV.get('pending') || '[]');
  if (!list.length) return '暂存区是空的';
  let idx = list.length - 1;
  if (n) {
    if (!(n >= 1 && n <= list.length)) return `序号超出范围（暂存区共 ${list.length} 条，回「发」看编号）`;
    idx = n - 1;
  }
  const [gone] = list.splice(idx, 1);
  await env.KV.put('pending', JSON.stringify(list));
  const what = opLabel(gone);
  if (!list.length) return `✓ 已撤回第 ${idx + 1} 条：${what}\n（暂存区已空，没有要发布的内容了）`;
  return `✓ 已撤回第 ${idx + 1} 条：${what}\n（还剩 ${list.length} 条，回「发」看最新清单）`;
}

/* ---- 数据文件读写 ---- */
/* ★★★适配点1★★★ 你的网站内容存在哪个文件、开头长什么样。
   下面三个 key（moments/posts/photos）是暂存分类名，value 是写回仓库时数据文件的"文件头"。
   原样对照你自己数据文件的第一行来改。文件名在下方 flush() 里的 put('data/xxx.js', ...) 同步改。 */

const HEADERS = {
  /* 主站文章/瞬间已是拆分结构：
     - posts：列表在 data/posts.js（无正文），正文一篇一个 data/content/<slug>.js
     - moments：manifest 在 data/moments.js，各年一卷 data/moments-YYYY.js
     - photos：单文件，见 flush() 里的 photos 分支 */
  posts: '// 文章列表（由管理后台/发文bot维护；正文在 data/content/<slug>.js 按需加载）\nwindow.POSTS = ',  photos: '// 图片墙清单（由管理后台维护）\nwindow.PHOTO_WALL = ',
  todos: '// 待办清单（想看/想读/日常；后台管理与前台待办页共用，完成的电影/图书自动记入瞬间）\nwindow.TODOS = ',
};

async function gh(env, path, init) {
  const isGet = !init || !init.method || init.method === 'GET';
  let lastErr;
  for (let attempt = 0; attempt < (isGet ? 2 : 1); attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 400)); // GET 偶发 5xx/网络抖动重试一次
    try {
      const r = await fetch(`https://api.github.com/repos/${env.REPO || 'your-name/your-repo'}${path}`, {
        ...init,
        headers: {
          Authorization: 'Bearer ' + env.GH_TOKEN,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'wecom-bot',
          ...(init && init.headers || {}),
        },
      });
      if (r.ok) return r.json();
      lastErr = new Error(`GitHub ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      if (r.status < 500) break; // 4xx 是请求本身的问题，不重试
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function readDataFile(env, blobSha) {
  // 用 Git Data API 读 blob：不受 /contents 单文件 1MB 限制（moments.js 迟早会超）
  const j = await gh(env, '/git/blobs/' + blobSha);
  return b64decodeUtf8(j.content);
}

/* ---- D1 存储层（2026-11-02 迁移方案 B）----
 * 绑定 env.DB 即启用；未绑定时所有路径行为与旧版完全一致（GitHub 文件读写）。
 * 数据模型：files 表 = 旧仓库 data/ 目录的镜像（path 相对仓库根，body = 文件全文）。
 * bot/admin 生成完整文件内容的逻辑全部保留，只是落点从 GitHub blob 换成 upsert 一行。
 * 迁移期双轨：读 D1 优先、未命中回退 GitHub；写只在一边（env.DB 存在 → 只写 D1）。
 * 备份三层见 MIGRATION-D1.md：Time Travel（免费版 7 天）+ worker Cron 每日导出（Phase 2）。 */

const D1_SCHEMA = 'CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)';

async function ensureSchema(env) {
  await env.DB.exec(D1_SCHEMA);
}

/* 数据文件读取：D1 优先，未命中/异常回退 GitHub（回退走 /contents，现有数据文件都 <1MB） */
async function readRepoFile(env, path) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT body FROM files WHERE path = ?1').bind(path).first();
      if (row && row.body != null) return row.body;
    } catch (e) { /* D1 抖动不挂死读路径，落到 GitHub */ }
  }
  const j = await gh(env, '/contents/' + path + '?ref=main');
  return b64decodeUtf8(j.content || '');
}

/* 批量应用文件写操作：[{path, body}] upsert；[{path, body:null}] 删除。
 * flush 的 D1 分支和 admin 写接口共用这一个出口，保证事务性与行为一致。 */
async function applyFileOps(env, ops) {
  if (!ops.length) return;
  await ensureSchema(env);
  const now = Date.now();
  const stmts = ops.map((op) => (op.body == null)
    ? env.DB.prepare('DELETE FROM files WHERE path = ?1').bind(op.path)
    : env.DB.prepare('INSERT INTO files (path, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET body = ?2, updated_at = ?3').bind(op.path, op.body, now));
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  await env.KV.delete('momentsIdx').catch(() => {}); // 瞬间查重索引失效，下次查重重建
}

/* 「导入D1」：从仓库快照（tools/gen-import.mjs 生成）全量导入 files 表。
 * 快照 = data-import.json（data/* 路径）。
 * 只覆盖 JSON 里列出的路径，不删多余行（多余行通常是导入后又发布的新内容）。
 * 注意：快照可能 >1MB，/contents 默认 JSON 模式对 >1MB 文件
 * 返回 403 too_large，必须用 raw Accept 拉 text。 */
function manifestPathOf(env) { return specOf(env).manifest; }
async function ghRaw(env, path) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 400));
    try {
      const r = await fetch(`https://api.github.com/repos/${env.REPO || 'your-name/your-repo'}${path}`, {
        headers: {
          Authorization: 'Bearer ' + env.GH_TOKEN,
          Accept: 'application/vnd.github.raw',
          'User-Agent': 'wecom-bot',
        },
      });
      if (r.ok) return r.text();
      lastErr = new Error(`GitHub ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      if (r.status < 500) break;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function d1Import(env) {
  if (!env.DB) return '未绑定 D1（env.DB 缺失）：CF 后台给 worker 加 D1 绑定，变量名 ' + specOf(env).dbVar;
  const manifest = JSON.parse(await ghRaw(env, '/contents/' + manifestPathOf(env) + '?ref=main'));
  const rows = manifest.files || [];
  if (!rows.length) return manifestPathOf(env) + ' 里没有文件，先在本地跑 node tools/gen-import.mjs 再提交';
  await ensureSchema(env);
  const now = Date.now();
  const stmts = rows.map((f) => env.DB
    .prepare('INSERT INTO files (path, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET body = ?2, updated_at = ?3')
    .bind(f.path, f.body, now));
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  /* 打"已导入"标记：Functions 输出层见到它就把 D1 当唯一真相（查不到=404，不回退静态文件）。
     只在显式导入时打——防止"绑定了 D1 但还没导入"时站点数据全 404。 */
  await env.DB.prepare('INSERT INTO files (path, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET body = ?2, updated_at = ?3')
    .bind('__meta/imported', String(manifest.generated || new Date().toISOString()), now).run(); // ⚠️ 必须 .run()：bind() 不发请求
  await env.KV.delete('momentsIdx').catch(() => {});
  return `✓ D1 导入完成：${rows.length} 个文件（快照 ${String(manifest.generated || '').slice(0, 10)}，${((manifest.totalBytes || 0) / 1024).toFixed(0)} KB）\n回「核对D1」验证一致性`;
}

/* 「核对D1」：把快照与 D1 逐行比对（内容级，不是只看长度）。
 * 性能红线：企业微信被动回话只有 5 秒——绝不能逐文件 await（47~63 次串行往返必超时，
 * 超时后微信直接丢回话、端上表现为一片寂静）。改为整表分块读回内存一次性比对。 */
async function d1Verify(env) {
  const varName = specOf(env).dbVar;
  if (!env.DB) return `未绑定 D1（变量 ${varName} 缺失）`;
  const manifest = JSON.parse(await ghRaw(env, '/contents/' + manifestPathOf(env) + '?ref=main'));
  const rows = manifest.files || [];
  // 整表分块读回（每块 ≤25 行，控制单次响应体积；全部内容级比对）
  const have = new Map();
  const PAGE = 25;
  for (let off = 0; ; off += PAGE) {
    const rs = await env.DB.prepare('SELECT path, body FROM files ORDER BY path LIMIT ?1 OFFSET ?2').bind(PAGE, off).all();
    const list = (rs && rs.results) || [];
    for (const r of list) have.set(r.path, r.body == null ? null : String(r.body));
    if (list.length < PAGE) break;
  }
  let same = 0; const diff = [], missing = [];
  for (const f of rows) {
    if (!have.has(f.path) || have.get(f.path) == null) missing.push(f.path);
    else if (have.get(f.path) === f.body) same++;
    else diff.push(f.path);
  }
  const lines = [`D1 共 ${have.size} 行；快照 ${rows.length} 个文件：一致 ${same}、内容不同 ${diff.length}、缺失 ${missing.length}`];
  if (diff.length) lines.push('内容不同（D1 里可能是导入后的新发布，属正常）：\n' + diff.slice(0, 10).join('\n'));
  if (missing.length) lines.push('缺失（要重跑「导入D1」）：\n' + missing.slice(0, 10).join('\n'));
  if (!diff.length && !missing.length) lines.push('✓ 快照与 D1 完全一致');
  return lines.join('\n');
}

/* git blob 内容寻址 sha1：blob <len>\0 + 内容。用于跳过未变化文件的上传。 */
async function gitBlobSha(text) {
  const data = new TextEncoder().encode(text);
  const head = new TextEncoder().encode('blob ' + data.length + '\0');
  const buf = new Uint8Array(head.length + data.length);
  buf.set(head, 0); buf.set(data, head.length);
  const hex = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(hex)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* 「备份D1」：把 files 表全量导出为旧格式数据文件，提交到本仓库 data-backup 分支。
 * - 双保险之一（另一层是 D1 自带 Time Travel 7 天）：分支里的文件本身就是
 *   可部署的完整站点数据，CF 不可用时指向任何静态托管即可复活。
 * - 只动 data/ 数据前缀 + 根目录原样保留其他文件；差量提交（内容寻址）。
 * - 定时跑（scheduled，CF 后台配 Cron Trigger），也可 bot 手动「备份D1」。 */
const BK_CHUNK = 30; // 免费版 Worker 单次调用限 50 子请求：建分支 5 + 本批 blob 30 + 提交 5 + 通知 2 ≈ 42

async function d1Backup(env) {
  const varName = specOf(env).dbVar;
  if (!env.DB) return `未绑定 D1（变量 ${varName} 缺失），无法备份`;
  if (!env.GH_TOKEN) return '未配置 GH_TOKEN，无法写备份分支';

  // 0. 续传游标：首备差异文件多时会撞 50 子请求上限，分批跑
  let curs = null;
  try { curs = JSON.parse(await env.KV.get('bkcurs') || 'null'); } catch (e) { curs = null; }

  // 1. 待上传清单：有游标用游标；否则全表读回 + 与分支树差量比对
  //    （即使游标读到旧值也安全：差量基于分支树，已提交的文件自然跳过）
  let todo, delItems = [], total = 0, same = 0, totalFiles = 0, done = { added: 0, changed: 0, deleted: 0 };
  if (curs && Array.isArray(curs.todo)) {
    todo = curs.todo; delItems = curs.delItems || []; totalFiles = curs.totalFiles || 0;
    total = curs.total || todo.length; same = curs.same || 0; done = curs.done || done;
  } else {
    // 全表读回（分块，跳过 __meta/ 内部标记）
    const files = new Map(); // path -> body
    const PAGE = 25;
    for (let off = 0; ; off += PAGE) {
      const rs = await env.DB.prepare('SELECT path, body FROM files ORDER BY path LIMIT ?1 OFFSET ?2').bind(PAGE, off).all();
      const list = (rs && rs.results) || [];
      for (const r of list) if (r.path && !String(r.path).startsWith('__meta/')) files.set(r.path, r.body == null ? '' : String(r.body));
      if (list.length < PAGE) break;
    }
    if (!files.size) return 'D1 是空的，先「导入D1」再备份';
    totalFiles = files.size;

    // data-backup 分支：不存在则从 main 创建
    let refSha;
    try { refSha = (await gh(env, '/git/ref/heads/data-backup')).object.sha; }
    catch (e) {
      if (!/404/.test(String((e && e.message) || e))) throw e;
      refSha = (await gh(env, '/git/ref/heads/main')).object.sha;
      await gh(env, '/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/data-backup', sha: refSha }) });
    }
    const baseCommit = await gh(env, '/git/commits/' + refSha);
    const oldTree = await gh(env, '/git/trees/' + baseCommit.tree.sha + '?recursive=1');

    // 差量：blob 内容寻址一致就跳过（增量传输，全无变化则零上传）
    // ⚠ 换行符统一 LF 再比对/上传：仓库 core.autocrlf=true + text=auto 时存 LF，
    //   而导入快照读的是 Windows 工作区文件（CRLF）→ D1 全是 CRLF，不归一会
    //   个个"有差异"，首备必撞 50 子请求上限（实测）。JS 文件行尾不影响语义。
    const norm = (s) => s.replace(/\r\n/g, '\n');
    todo = [];
    for (const [path, body] of files) {
      const nb = norm(body);
      const sha = await gitBlobSha(nb);
      const old = (oldTree.tree || []).find((t) => t.type === 'blob' && t.path === path);
      if (old && old.sha === sha) { same++; continue; }
      todo.push({ path, body: nb, isNew: !old });
    }
    // D1 里已删除的文件 → 备份分支同步删除（只认 data/ 数据路径，防误伤代码——test.mjs 回归用例锁定）
    const delRe = specOf(env).dataDelRe; // 站点差异注册表：备份删除同步只认本站数据路径
    for (const t of oldTree.tree || []) {
      if (t.type !== 'blob' || !delRe.test(t.path)) continue;
      if (files.has(t.path)) continue;
      delItems.push(t.path);
    }
    total = todo.length;
    if (!total && !delItems.length) return `✓ 备份分支已是最新（${same} 个文件无变化），未产生新提交`;
  }

  // 2. 本批上传（≤BK_CHUNK 个 blob）
  const batch = todo.slice(0, BK_CHUNK);
  const rest = todo.slice(BK_CHUNK);
  const treeItems = delItems.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null }));
  for (const it of batch) {
    const b = await gh(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: b64encodeUtf8(it.body), encoding: 'base64' }) });
    treeItems.push({ path: it.path, mode: '100644', type: 'blob', sha: b.sha });
  }

  // 3. 提交本批（base_tree 用分支当前头，只带本批变更项）
  const ref = await gh(env, '/git/ref/heads/data-backup');
  const baseCommit = await gh(env, '/git/commits/' + ref.object.sha);
  const tree = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeItems }) });
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const added = done.added + batch.filter((it) => it.isNew).length;
  const changed = done.changed + batch.filter((it) => !it.isNew).length;
  const deleted = done.deleted + delItems.length;
  const commit = await gh(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message: `D1 每日备份 ${stamp}（共 ${totalFiles || total} 文件，本次变更 ${total}）`, tree: tree.sha, parents: [ref.object.sha] }) });
  await gh(env, '/git/refs/heads/data-backup', { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });

  // 4. 没传完 → 存游标，下次续传
  if (rest.length) {
    await env.KV.put('bkcurs', JSON.stringify({ todo: rest, delItems: [], total, same, totalFiles, done: { added, changed, deleted } }), { expirationTtl: 86400 });
    return `⏳ 已备份 ${total - rest.length}/${total}（本批已提交到分支），再发一次「备份D1」自动续传剩余 ${rest.length} 个`;
  }
  await env.KV.delete('bkcurs').catch(() => {});
  return `✓ 已备份到 data-backup 分支（${added} 新增 / ${changed} 更新 / ${deleted} 删除 / ${same} 无变化${curs ? '，续传完成' : ''}）\ncommit ${commit.sha.slice(0, 7)}`;
}

/* 「数据源」：极简状态 + 切换指引（用户要求：只报 D1/GitHub 与怎么切，不啰嗦） */
async function d1SourceInfo(env) {
  const spec = specOf(env);
  if (!env.DB) return '当前数据源：GitHub 静态（未绑定 D1）\n切 D1：CF 后台绑定后发「导入D1」';
  let dataRows = [], marker = false, dbErr = '';
  try {
    const rs = await env.DB.prepare('SELECT path FROM files').all();
    dataRows = ((rs && rs.results) || []).map((r) => String(r.path)).filter((p) => spec.dataDelRe.test(p));
    const m = await env.DB.prepare('SELECT body FROM files WHERE path = ?1').bind('__meta/imported').first();
    marker = !!(m && m.body);
  } catch (e) { dbErr = String((e && e.message) || e).slice(0, 80); }
  let bk = '无备份';
  try {
    const cs = await gh(env, '/commits?sha=data-backup&per_page=1'); // gh 返回的是已解析的 JSON 对象，别再 parse
    if (Array.isArray(cs) && cs[0]) bk = String(cs[0].commit && cs[0].commit.message || '').split('\n')[0] + '（' + String(cs[0].sha).slice(0, 7) + '）';
  } catch (e) { /* 404 → 保持默认 */ }
  if (dbErr) return `当前数据源：GitHub 静态（D1 异常：${dbErr}）\n切 D1：发「数据源D1」｜数据丢了：发「恢复D1」`;
  if (marker && dataRows.length) {
    return `当前数据源：D1（${dataRows.length} 文件）｜备份：${bk}\n切 GitHub：发「数据源GitHub」｜切回 D1：发「数据源D1」（数据丢了先「恢复D1」）`;
  }
  return `当前数据源：GitHub 静态（D1 里 ${dataRows.length} 文件${marker ? '' : '，无标记'}）｜备份：${bk}\n切 D1：发「数据源D1」${dataRows.length ? '' : '（D1 空的话先「恢复D1」或「导入D1」）'}`;
}

/* 「数据源D1 / 数据源GitHub」：切换线上数据源（权威标记开关；bot/后台写入始终进 D1） */
async function d1SwitchSource(env, mode) {
  const spec = specOf(env);
  if (!env.DB) return '未绑定 D1（' + spec.dbVar + ' 缺失），无法切换';
  if (mode !== 'd1') {
    await env.DB.prepare('DELETE FROM files WHERE path = ?1').bind('__meta/imported').run();
    return '✓ 已切到 GitHub 静态：线上读仓库数据副本（内容较旧、只读）\nbot/后台新内容仍写入 D1，线上暂不显示；切回发「数据源D1」';
  }
  const rs = await env.DB.prepare('SELECT path FROM files').all();
  const n = ((rs && rs.results) || []).filter((r) => r.path !== '__meta/imported').length;
  if (!n) return 'D1 里没有数据文件，切回 D1 前先发「恢复D1」或「导入D1」';
  await env.DB.prepare('INSERT INTO files (path, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
    .bind('__meta/imported', new Date().toISOString(), Date.now()).run();
  return `✓ 已切回 D1（${n} 文件）：线上即刻以 D1 为准，发「核对D1」可验证`;
}

/* 「恢复D1」：从 data-backup 分支把数据文件灌回 files 表（备份的逆操作，灾备用）。
 * 与备份同理分批（免费版 50 子请求上限），游标 rscurs 续传；完成后重写权威标记。 */
const RS_CHUNK = 20;
async function d1Restore(env) {
  const spec = specOf(env);
  if (!env.DB) return '未绑定 D1（变量 ' + spec.dbVar + ' 缺失），无法恢复';
  if (!env.GH_TOKEN) return '未配置 GH_TOKEN，无法读备份分支';
  let curs = null;
  try { curs = JSON.parse(await env.KV.get('rscurs') || 'null'); } catch (e) { curs = null; }

  let todo, dels = [], total = 0, done = 0;
  if (curs && Array.isArray(curs.todo)) {
    todo = curs.todo; dels = curs.dels || []; total = curs.total || todo.length; done = curs.done || 0;
  } else {
    let refSha;
    try { refSha = (await gh(env, '/git/ref/heads/data-backup')).object.sha; }
    catch (e) { return '备份分支不存在：先「备份D1」跑一次备份，才有恢复的源头'; }
    const baseCommit = await gh(env, '/git/commits/' + refSha);
    const tree = await gh(env, '/git/trees/' + baseCommit.tree.sha + '?recursive=1');
    const files = (tree.tree || []).filter((t) => t.type === 'blob' && spec.dataDelRe.test(t.path)).map((t) => t.path);
    if (!files.length) return '备份分支上没有数据文件：先「备份D1」';
    const rs = await env.DB.prepare('SELECT path FROM files').all();
    const have = new Set(files);
    dels = ((rs && rs.results) || []).map((r) => String(r.path)).filter((p) => spec.dataDelRe.test(p) && !have.has(p));
    todo = files; total = files.length;
  }

  const batch = todo.slice(0, RS_CHUNK), rest = todo.slice(RS_CHUNK);
  const now = Date.now();
  const upsert = env.DB.prepare('INSERT INTO files (path, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET body = ?2, updated_at = ?3');
  for (const p of batch) {
    const body = await ghRaw(env, '/contents/' + p + '?ref=data-backup');
    await upsert.bind(p, body, now).run();
  }
  for (const p of dels) await env.DB.prepare('DELETE FROM files WHERE path = ?1').bind(p).run();

  if (rest.length) {
    await env.KV.put('rscurs', JSON.stringify({ todo: rest, dels: [], total, done: done + batch.length }), { expirationTtl: 86400 });
    return `⏳ 已恢复 ${done + batch.length}/${total}（本批已入库），再发一次「恢复D1」继续剩余`;
  }
  await upsert.bind('__meta/imported', new Date().toISOString(), now).run();
  await env.KV.delete('rscurs').catch(() => {});
  return `✓ 恢复完成：${total} 个数据文件已写回 D1${dels.length ? '，删除多余 ' + dels.length + ' 个' : ''}，权威标记已刷新\n发「核对D1」验证；线上即刻以 D1 为准`;
}

/* 复刻 fetch 的站点 env 合并（CONFIG），供 scheduled 用 */
function siteEnvFor(rawEnv) {
  let env = Object.assign({}, rawEnv);
  if (rawEnv.CONFIG) { try { env = Object.assign(env, JSON.parse(rawEnv.CONFIG)); } catch (e) { /* 配置坏就按裸跑 */ } }
  return env;
}

/* Cron：把 D1 导出到仓库的 data-backup 分支。 */
async function cronBackupAll(rawEnv) {
  try {
    const r = await d1Backup(siteEnvFor(rawEnv));
    console.log(`[cron-backup] ${String(r).replace(/\n/g, ' | ')}`);
  } catch (e) {
    console.error('[cron-backup] 失败:', (e && e.stack) || e);
  }
}

function parseArr(text) {
  // 不能按最后一个 ';' 切——正文里 style="…;…" 含分号，且文件末尾可能没有分号。
  // 数组一定从第一个 '[' 开始、以最后一个 ']' 结束。
  const i = text.indexOf('['), j = text.lastIndexOf(']');
  if (i < 0 || j < i) throw new Error('数据文件结构异常：找不到数组');
  return JSON.parse(text.slice(i, j + 1));
}

/* 观影索引重算（瞬间分卷后按年拆）：
   daysByYear = { 'YYYY': { 'YYYY-MM-DD': {m,t,p} } }，meta 为全局统计。
   调用方只写受影响年份的 days-YYYY.js + 整份 watch-meta.js（小文件）。 */
function buildWatch(moments) {
  const w92 = (u) => (u || '').replace('/w500/', '/w92/');
  const days = {}, perYear = {};
  moments.forEach((m) => {
    const d = String(m.date || '').match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
    if (!d || m.undated || d[1] === '1970' || d[1] === '1900') return;
    if (m.type === 'book') return;
    const key = `${d[1]}-${d[2]}-${d[3]}`;
    const o = days[key] || (days[key] = { m: 0, t: 0, p: '' });
    if (m.kind === 'tv') o.t++; else o.m++;
    if (!o.p && m.poster) o.p = w92(m.poster);
    const y = perYear[d[1]] || (perYear[d[1]] = { days: 0, m: 0, t: 0 });
    y.m += m.kind === 'tv' ? 0 : 1;
    y.t += m.kind === 'tv' ? 1 : 0;
  });
  Object.keys(days).forEach((k) => { const y = k.slice(0, 4); if (perYear[y]) perYear[y].days++; });
  const daysByYear = {};
  Object.keys(days).forEach((k) => {
    const y = k.slice(0, 4);
    (daysByYear[y] = daysByYear[y] || {})[k] = days[k];
  });
  const meta = {
    total: moments.length,
    movie: moments.filter((m) => m.type === 'movie').length,
    book: moments.filter((m) => m.type === 'book').length,
    mins: moments.reduce((s, m) => s + (m.runtime || 0), 0),
    years: [...new Set(Object.keys(days).map((k) => k.slice(0, 4)))].sort().reverse(),
    perYear, watchDays: Object.keys(days).length,
  };
  return { daysByYear, meta };
}

/* ---- 主站拆分数据结构的读写（与迁移脚本/管理后台保持同一文件格式） ---- */

function momentsManifestFile(years) {
  return '// 瞬间分卷清单（bot/后台维护；各年正文在 data/moments-YYYY.js）\nwindow.MOMENTS_YEARS = ' + JSON.stringify(years) + ';\n';
}
function parseMomentsManifest(text) {
  const m = text.match(/window\.MOMENTS_YEARS\s*=\s*(\[[^\]]*\])/);
  if (!m) throw new Error('data/moments.js 结构异常：找不到 MOMENTS_YEARS（若刚做分卷迁移，请先把 CF 上的 worker 更新到最新版）');
  return JSON.parse(m[1]);
}
function momentsVolumeFile(y, arr) {
  return `// 瞬间数据 ${y} 年卷（由管理后台/发文bot维护）\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS[${JSON.stringify(y)}] = ${JSON.stringify(arr)};\n`;
}
function parseMomentPart(text) {
  const i = text.indexOf('MOMENTS_PARTS[');
  if (i < 0) throw new Error('moments-YYYY.js 结构异常：找不到 MOMENTS_PARTS');
  const s = text.indexOf('= [', i); // 键名是 MOMENTS_PARTS["YYYY"]，数组在「= [」之后
  const e = text.lastIndexOf(']');
  if (s < 0 || e < s) throw new Error('moments-YYYY.js 结构异常');
  return JSON.parse(text.slice(s + 2, e + 1));
}
function daysYearFile(y, days) {
  return `// 观影天索引 ${y} 年（发布时自动重算，勿手改）\nwindow.WATCH_DAYS = window.WATCH_DAYS || {};\nObject.assign(window.WATCH_DAYS, ${JSON.stringify(days)});\n`;
}
function watchMetaFile(meta) {
  return '// 观影统计（发布时自动重算，勿手改）\nwindow.WATCH_META = ' + JSON.stringify(meta) + ';\n';
}
/* 查重名录：{ 年份: [片名...] } 映射（年份只存一次，~11KB；查重只需年份不需日期） */
function catalogFile(all) {
  const map = {};
  all.forEach((m) => {
    if (!m.title) return;
    const yy = String(m.date || '').slice(0, 4) || '0000';
    (map[yy] = map[yy] || []).push(m.title);
  });
  return '// 瞬间名录：查重+站内搜索用（年份→片名列表；发布瞬间时自动重算，勿手改）\nwindow.MOMENT_CATALOG = ' + JSON.stringify(map) + ';\n';
}
/* 单篇正文文件：slug 索引进 POST_CONTENT，详情页按需加载 */
function mainContentFile(slug, obj) {
  return `// 正文（slug=${slug}，由发文bot维护；手改这个文件前台直接生效）\nwindow.POST_CONTENT = window.POST_CONTENT || {};\nwindow.POST_CONTENT[${JSON.stringify(slug)}] = ${JSON.stringify(obj)};\n`;
}
/* ⚠️ 正文文件的仓库路径必须用「原始 slug」拼，绝对不要 encodeURIComponent。
   slugify 只保留字母数字（中文算 Letter），转义后已无路径危险字符；encodeURIComponent 是给
   浏览器发 HTTP 请求用的，用在 GitHub path 上会把文件名写成字面量 `%E6%B5%8B…`，
   而前台按 `encodeURIComponent(slug)` 请求时会被解码成中文 → 404 → 详情页「正文加载失败」。
   2026-10-30~31 由 bot 发的中文标题文章全部踩过这个坑，别再改回去。 */
function contentPath(slug) { return `data/content/${slug}.js`; }
const momentYearOf = (m) => (String(m.date || '').match(/^(\d{4})\//) || ['', '0000'])[1];

/* ---- 一次提交发布所有暂存（Git Trees API 单 commit） ---- */

async function flush(env, manual, opts) {
  /* keepPin：「确认 保持顶」——本批新增不插第 0 位，而是排到发布前原第 1 条之后
     （等价于发布后再把原第 0 位顶一次；不需要任何字段，也不需要记得谁被顶过） */
  const keepPin = !!(opts && opts.keepPin);
  const pending = JSON.parse(await env.KV.get('pending') || '[]');
  if (!pending.length) return manual ? '' : undefined;
  await env.KV.put('pending', '[]'); // 先清空防并发重复提交
  try {
  const files = {};
  for (const op of pending) files[op.file] = true;
  const useD1 = !!env.DB; // 迁移开关：绑了 D1 → 读写全走 files 表，GitHub 只剩代码仓库

  // GitHub 模式才需要 HEAD 文件树（按路径查 blob）；D1 模式读走 readRepoData/applyFileOps
  let ref = null, base = null, rootTree = null;
  const blobSha = (p) => {
    const n = (rootTree.tree || []).find((t) => t.path === p);
    if (!n) throw new Error('仓库里找不到 ' + p);
    return n.sha;
  };
  if (!useD1) {
    ref = await gh(env, '/git/ref/heads/main');
    base = await gh(env, '/git/commits/' + ref.object.sha);
    rootTree = await gh(env, '/git/trees/' + base.tree.sha + '?recursive=1');
  }
  /* 数据文件读：D1 模式直接读表（1 次查询）；GitHub 模式走 blob（原逻辑） */
  const srcText = async (p) => useD1 ? readRepoData(env, p) : readDataFile(env, blobSha(p));

  const contents = {};
  for (const f of Object.keys(files)) {
    if (['moments', 'posts', 'todos', 'photos', 'mdel', 'medit', 'pdel', 'pedit', 'phdel', 'pin', 'phpin'].includes(f)) continue; // 拆分结构/管理操作，见下方对应分支
    const text = await srcText(`data/${f}.js`);
    contents[f] = { arr: parseArr(text), header: HEADERS[f] };
  }

  for (const op of pending) {
    if (contents[op.file]) contents[op.file].arr.unshift(op.item);
  }

  // 组装每个文件的新文本：D1 模式收进 d1Ops（末尾一批 upsert）；GitHub 模式 blob 进同一个 tree（单 commit）
  const treeItems = [];
  const d1Ops = [];
  const put = async (path, text) => {
    if (useD1) { d1Ops.push({ path, body: text }); return; }
    if (text === null) { treeItems.push({ path, mode: '100644', type: 'blob', sha: null }); return; } // sha:null = 删除该文件
    const b = await gh(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: b64encodeUtf8(text), encoding: 'base64' }) });
    treeItems.push({ path, mode: '100644', type: 'blob', sha: b.sha });
  };

  /* ★★★适配点1（续）★★★ 这里是要写回仓库的文件路径（相对仓库根）。 */

  /* 主站文章（C 方案）：列表只存标题摘要（小文件整写无所谓），正文一篇一个新 blob，写完不再动 */
  if (files.posts) {
    const listText = await srcText('data/posts.js');
    const arr = parseArr(listText);
    const slugs = new Set(arr.map((p) => p.slug));
    /* 保持顶：插到原第 1 条之后（第 0 位不动）；否则照旧插最前。
       多个新增都插同一位置 → 后发的仍在前，与 unshift 顺序一致 */
    const at = keepPin && arr.length ? 1 : 0;
    for (const it of pending.filter((o) => o.file === 'posts').map((o) => o.item)) {
      const { content, raw, ...list } = it;
      /* 同标题重发（用户会故意这么测）：不拦、不丢，自动加时间戳副标题 + slug 后缀，
         保证唯一、能一眼看出最新那篇。标题只在撞车时才动 */
      if (slugs.has(list.slug)) {
        const st = cnStamp();
        let s = `${list.slug}-${st.key}`;
        for (let n = 2; slugs.has(s); n++) s = `${list.slug}-${st.key}-${n}`;
        list.title = `${list.title} · ${st.show}`;
        list.slug = s;
      }
      slugs.add(list.slug);
      arr.splice(at, 0, list);
      await put(contentPath(list.slug), mainContentFile(list.slug, raw === undefined ? { content } : { content, raw }));
    }
    await put('data/posts.js', HEADERS.posts + JSON.stringify(arr) + '\n');
  }

  /* 主站瞬间（年分卷）：增/删/改统一处理。读全部卷重算全局统计，只重写受影响年份的卷
     + 对应 days + watch-meta + 查重名录（读不产生 blob/commit，写放大已根治）。 */
  if (files.moments || files.mdel || files.medit) {
    const years = parseMomentsManifest(await srcText('data/moments.js'));
    let all = [];
    for (const y of years) all = all.concat(parseMomentPart(await srcText(`data/moments-${y}.js`)));
    const touched = new Set();
    for (const it of pending.filter((o) => o.file === 'moments').map((o) => o.item)) { all.unshift(it); touched.add(momentYearOf(it)); }
    for (const op of pending.filter((o) => o.file === 'mdel' || o.file === 'medit')) {
      const vol = all.filter((m) => momentYearOf(m) === op.item.year);
      const m = vol[op.item.idx];
      if (!m || (op.item.title && m.title !== op.item.title)) throw new Error(`瞬间定位失败（${op.item.year} 年第 ${op.item.idx + 1} 条），数据可能已变化，请重新「查」再操作`);
      const i = all.indexOf(m);
      if (op.file === 'mdel') {
        all.splice(i, 1);
      } else {
        if (op.item.text !== undefined) m.content = rebuildMomentText(m, op.item.text);
        if (op.item.date) {
          touched.add(momentYearOf(m)); // 旧年份
          m.date = op.item.date.replace(/-/g, '/') + String(m.date || '').slice(10); // 保留时分秒
        }
      }
      touched.add(momentYearOf(m));
    }
    all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const touchedArr = [...touched];
    for (const y of touchedArr) await put(`data/moments-${y}.js`, momentsVolumeFile(y, all.filter((m) => momentYearOf(m) === y)));
    const yearSet = [...new Set(all.map(momentYearOf))].sort().reverse();
    if (JSON.stringify(yearSet) !== JSON.stringify([...years].sort((a, b) => b.localeCompare(a)))) await put('data/moments.js', momentsManifestFile(yearSet));
    const { daysByYear, meta } = buildWatch(all);
    for (const y of touchedArr) await put(`data/days-${y}.js`, daysYearFile(y, daysByYear[y] || {})); // 删空/改走年份也要清 days
    await put('data/watch-meta.js', watchMetaFile(meta));
    /* 查重名录：发布瞬间时顺手重算（all 已在内存里，零额外读开销） */
    await put('data/catalog.js', catalogFile(all));
  }

  /* 主站待办：add/done/drop/undone 四种 op 应用后整写（单文件几十 KB；不提供删除，废弃即归档） */
  if (files.todos) {
    const arr = parseArr(await srcText('data/todos.js'));
    for (const op of pending.filter((o) => o.file === 'todos')) {
      if (op.op === 'add') arr.unshift(op.item);
      else if (op.op === 'done') {
        const t = arr.find((x) => x.id === op.item.id);
        if (!t) throw new Error('待办不存在（可能刚被改过）：' + op.item.id);
        t.done = true; t.doneAt = op.item.doneAt; t.dropped = false; t.droppedAt = null; delete t.undated;
      } else if (op.op === 'drop') {
        const t = arr.find((x) => x.id === op.item.id);
        if (!t) throw new Error('待办不存在（可能刚被改过）：' + op.item.id);
        t.dropped = true; t.droppedAt = op.item.droppedAt; delete t.undated;
      } else if (op.op === 'undone') {
        const t = arr.find((x) => x.id === op.item.id);
        if (!t) throw new Error('待办不存在（可能刚被改过）：' + op.item.id);
        t.done = false; t.doneAt = null; t.dropped = false; t.droppedAt = null;
      }
    }
    await put('data/todos.js', HEADERS.todos + JSON.stringify(arr) + ';\n');
  }

  /* 主站文章删除/置顶：列表去除 + 正文文件删除（tree sha:null）；置顶 = 移到数组最前（列表按数组顺序渲染） */
  if (files.pdel || files.pin) {
    const arr = parseArr(await srcText('data/posts.js'));
    for (const op of pending.filter((o) => o.file === 'pdel')) {
      const i = arr.findIndex((p) => p.slug === op.item.slug);
      if (i < 0) throw new Error('文章不存在（可能刚删过）：' + op.item.slug);
      if (op.item.title && arr[i].title !== op.item.title) throw new Error('文章定位校验失败，请重新「查」再删');
      arr.splice(i, 1);
      await put(contentPath(op.item.slug), null);
    }
    for (const op of pending.filter((o) => o.file === 'pin')) {
      const i = arr.findIndex((p) => p.slug === op.item.slug);
      if (i < 0) throw new Error('文章不存在（可能刚删过）：' + op.item.slug);
      if (i > 0) arr.unshift(arr.splice(i, 1)[0]);
    }
    await put('data/posts.js', HEADERS.posts + JSON.stringify(arr) + '\n');
  }

  /* 主站文章改正文：只重写该篇正文文件（列表/摘要/封面不动） */
  if (files.pedit) {
    for (const op of pending.filter((o) => o.file === 'pedit')) {
      await put(contentPath(op.item.slug), mainContentFile(op.item.slug, { content: op.item.content }));
    }
  }

  /* 图片墙：新增 / 删除 / 置顶 统一处理，一个文件只写一次
     顺序必须是「先按原 idx 删 → 再新增插最前 → 最后按 src 置顶移最前」，
     否则先 unshift 会让删/顶用的索引错位（旧代码 add+del 同批会互相覆盖，这里顺手修掉） */
  if (pending.some((o) => ['photos', 'phdel', 'phpin'].includes(o.file))) {
    const arr = parseArr(await srcText('data/photos.js'));
    for (const op of pending.filter((o) => o.file === 'phdel').sort((a, b) => b.item.idx - a.item.idx)) {
      if (!arr[op.item.idx] || (op.item.src && arr[op.item.idx].src !== op.item.src)) throw new Error('图片定位失败（数据可能已变化），请重新「查」');
      arr.splice(op.item.idx, 1);
    }
    /* 保持顶：插到删完之后的第一张之后；否则插最前（后发的在上，与 unshift 一致） */
    const pAt = keepPin && arr.length ? 1 : 0;
    for (const op of pending.filter((o) => o.file === 'photos')) arr.splice(pAt, 0, op.item);
    for (const op of pending.filter((o) => o.file === 'phpin')) {
      const i = arr.findIndex((p) => p.src === op.item.src);
      if (i > 0) arr.unshift(arr.splice(i, 1)[0]);
    }
    await put('data/photos.js', HEADERS.photos + JSON.stringify(arr) + '\n');
  }

  /* 图片墙（新增/删除/置顶）已在上面统一写入，这里不再单独写 photos.js */

  if (useD1) {
    await applyFileOps(env, d1Ops); // 内部含 ensureSchema + momentsIdx 失效
    return `🚀 已发布 ${pending.length} 条到线上（已生效，无需等待）`;
  }

  const tree = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree: treeItems }) });
  const commit = await gh(env, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: `微信发布：${pending.length} 条（${Object.keys(files).map((f) => ({ moments: '瞬间', posts: '文章', photos: '图片', mdel: '删瞬间', medit: '改瞬间', pdel: '删文章', pedit: '改正文', phdel: '删图', pin: '文章置顶', phpin: '图片置顶', todos: '待办' }[f])).join(' ')}）`, tree: tree.sha, parents: [ref.object.sha] }),
  });
  await gh(env, '/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
  await env.KV.delete('momentsIdx').catch(() => {}); // 瞬间查重索引失效，下次查重重建

  return `🚀 已发布 ${pending.length} 条到线上（约 1 分钟后生效）`;
  } catch (e) {
    // 失败回滚：本次条目放回暂存区，避免用户内容丢失
    const rest = JSON.parse(await env.KV.get('pending') || '[]');
    await env.KV.put('pending', JSON.stringify(pending.concat(rest)));
    console.error('[flush-failed]', e && e.stack || e);
    throw new Error('发布失败：' + String(e && e.message || e) + '\n内容已放回暂存区，可重试「发」');
  }
}
