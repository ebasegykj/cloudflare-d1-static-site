/* 本地自测：加解密往返 + URL 验证 + 文本指令路由（不联网打 GitHub） */
import worker from './worker.js';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';

const AESKEY = 'aAWwxeqtwIkA5HmZxTGSVTppPLdKUlIBevXpNe9QT6O';
const TOKEN = 'Dz3yFNPtcZaOBrqI';
const env = {
  CORP_ID: 'ww2418465765df31d5',
  AGENT_ID: '1000002',
  WECOM_TOKEN: TOKEN,
  WECOM_AESKEY: AESKEY,
  KV: {
    _s: {},
    async get(k) { return this._s[k] ?? null; },
    async put(k, v) { this._s[k] = String(v); },
    async delete(k) { delete this._s[k]; },
  },
};

const H = { 'Content-Type': 'text/xml' };

function qs(o) { return new URLSearchParams(o).toString(); }

/* 严格按企业微信规范实现：裸 AES-256-CBC + PKCS#7 补位到 32 字节（密钥从 env 取） */
function rawKeyOf(env) { return Buffer.from(env.WECOM_AESKEY + '=', 'base64'); }

function wecomEncrypt(rawKey, corpId, msgBuf) {
  const rnd = nodeCrypto.randomBytes(16);
  const len = Buffer.alloc(4); len.writeUInt32BE(msgBuf.length);
  let buf = Buffer.concat([rnd, len, msgBuf, Buffer.from(corpId)]);
  const padLen = 32 - (buf.length % 32);
  buf = Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
  const c = nodeCrypto.createCipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]);
}

function wecomDecrypt(rawKey, corpId, ctBuf) {
  const d = nodeCrypto.createDecipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
  d.setAutoPadding(false);
  const pt = Buffer.concat([d.update(ctBuf), d.final()]);
  const pad = pt[pt.length - 1];
  const body = pt.subarray(0, pt.length - pad);
  const msgLen = body.readUInt32BE(16);
  const msg = body.subarray(20, 20 + msgLen).toString('utf8');
  const corp = body.subarray(20 + msgLen).toString('utf8');
  if (corp !== corpId) throw new Error('corpId 不匹配: ' + JSON.stringify(corp));
  return msg;
}

function sha1hex(str) {
  return nodeCrypto.createHash('sha1').update(str).digest('hex');
}

/* 发一条文本消息并取回明文回复（opts: { env, path } 可选） */
async function sendText(text, nonce, ts, msgId, opts = {}) {
  const e = opts.env || env;
  const path = opts.path || '/wecom';
  const msgXml = `<xml>${xmlTag('ToUserName', e.CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'text')}${xmlTag('Content', text)}${xmlTag('MsgId', msgId)}</xml>`;
  const { enc, sig } = await encEnvelope(e, msgXml, nonce, ts);
  const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x${path}?${qs({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
  const res = await worker.fetch(req, e, opts.ctx || {});
  return await decryptReply(e, res);
}

async function encEnvelope(env, plainXml, nonce, ts) {
  const b64 = wecomEncrypt(rawKeyOf(env), env.CORP_ID, Buffer.from(plainXml, 'utf8')).toString('base64');
  const sig = sha1hex([env.WECOM_TOKEN, String(ts), nonce, b64].sort().join(''));
  return { enc: b64, sig, ts: String(ts), nonce };
}
function xmlTag(t, v) { return `<${t}><![CDATA[${v}]]></${t}>`; }

async function decryptReply(env, res) {
  const t = await res.text();
  const enc = (t.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/) || [])[1];
  if (!enc) throw new Error('回复不是加密报文（worker 可能报错）: ' + t.slice(0, 300));
  const sig = t.match(/<MsgSignature><!\[CDATA\[(.*?)\]\]><\/MsgSignature>/)[1];
  const ts = t.match(/<TimeStamp>(\d+)<\/TimeStamp>/)[1];
  const nonce = t.match(/<Nonce><!\[CDATA\[(.*?)\]\]><\/Nonce>/)[1];
  const mySig = sha1hex([env.WECOM_TOKEN, ts, nonce, enc].sort().join(''));
  if (mySig !== sig) throw new Error('回复签名不匹配');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(enc)) throw new Error('回复密文不是标准 base64: ' + enc.slice(0, 20));
  return wecomDecrypt(rawKeyOf(env), env.CORP_ID, Buffer.from(enc, 'base64'));
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '\n   ', e.message, '\n   ', (e.stack || '').split('\n')[1] || ''); }
}

/* 1. URL 验证（GET echo） */
await check('URL 验证：echostr 解密回显', async () => {
  const nonce = 'n1', ts = 1700000000;
  const { enc, sig } = await encEnvelope(env, 'echo-12345', nonce, ts);
  const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce, echostr: enc })}`);
  const res = await worker.fetch(req, env, {});
  const t = await res.text();
  if (t !== 'echo-12345') throw new Error('回显不符: ' + t);
});

/* 1b. 回归：企业微信按 32 字节补位，补位值可能 >16（WebCrypto 会在此崩），必须能解 */
await check('URL 验证：补位 25 字节（>16）', async () => {
  const nonce = 'n1b', ts = 1700000005;
  const echo = 'x'; // 明文 = 16+4+1+18 = 39 → 补位 25
  const { enc, sig } = await encEnvelope(env, echo, nonce, ts);
  const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce, echostr: enc })}`);
  const res = await worker.fetch(req, env, {});
  const t = await res.text();
  if (t !== echo) throw new Error('回显不符: ' + t);
});

/* 2. 帮助指令往返 */
await check('文本指令：帮助 → 加密回复', async () => {
  const nonce = 'n2', ts = 1700000001;
  const plain = `<xml><ToUserName>${xmlTag('ToUserName', '')}</ToUserName></xml>`.replace('<ToUserName></ToUserName>', '');
  const msgXml = `<xml>${xmlTag('ToUserName', env.CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'text')}${xmlTag('Content', '帮助')}${xmlTag('MsgId', 'm-test-1')}</xml>`;
  const { enc, sig } = await encEnvelope(env, msgXml, nonce, ts);
  const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
  const res = await worker.fetch(req, env, {});
  const replyXml = await decryptReply(env, res);
  if (!replyXml.includes('瞬')) throw new Error('回复里没有帮助内容: ' + replyXml.slice(0, 200));
});

/* 3. 图指令 → 暂存队列 */
await check('文本指令：图 → 暂存 photos', async () => {
  const nonce = 'n3', ts = 1700000002;
  const msgXml = `<xml>${xmlTag('ToUserName', env.CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'text')}${xmlTag('Content', '图\nhttps://example.com/a.jpg\nhttps://example.com/b.png')}${xmlTag('MsgId', 'm-test-2')}</xml>`;
  const { enc, sig } = await encEnvelope(env, msgXml, nonce, ts);
  const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
  const res = await worker.fetch(req, env, {});
  await decryptReply(env, res);
  const pending = JSON.parse(await env.KV.get('pending'));
  if (!Array.isArray(pending) || pending.length !== 2 || pending[0].file !== 'photos') throw new Error('暂存队列不对: ' + JSON.stringify(pending));
});

/* 4. 撤回 */
await check('文本指令：撤回 → 清空暂存', async () => {
  const nonce = 'n4', ts = 1700000003;
  const msgXml = `<xml>${xmlTag('ToUserName', env.CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'text')}${xmlTag('Content', '撤回')}${xmlTag('MsgId', 'm-test-3')}</xml>`;
  const { enc, sig } = await encEnvelope(env, msgXml, nonce, ts);
  const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
  const res = await worker.fetch(req, env, {});
  const reply = await decryptReply(env, res);
  if (!reply.includes('已撤回')) throw new Error('回复不对: ' + reply.slice(0, 120));
  const pending = JSON.parse(await env.KV.get('pending'));
  if (pending.length !== 1) throw new Error('应剩 1 条，实际: ' + JSON.stringify(pending));
  if (pending[0].item.src !== 'https://example.com/a.jpg') throw new Error('撤掉的应该是最近一条 b.png，剩: ' + JSON.stringify(pending));
});

/* 4b. 发 → 只回清单，不推送 */
await check('发：先回清单预览，不提交', async () => {
  const nonce = 'n4b', ts = 1700000010;
  const msgXml = `<xml>${xmlTag('ToUserName', env.CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'text')}${xmlTag('Content', '发')}${xmlTag('MsgId', 'm-test-4b')}</xml>`;
  const { enc, sig } = await encEnvelope(env, msgXml, nonce, ts);
  const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
  const res = await worker.fetch(req, env, {});
  const reply = await decryptReply(env, res);
  if (!reply.includes('将发布 1 条')) throw new Error('清单不对: ' + reply);
  if (!/1\. 新增图片 a\.jpg/.test(reply)) throw new Error('应列出图片: ' + reply);
  if (!reply.includes('确认')) throw new Error('缺少确认提示: ' + reply);
  if (!reply.includes('回「取消」—— 先不发布，回去继续操作（内容都还在）')) throw new Error('底部应说明取消会回去继续操作: ' + reply);
  if (!reply.includes('回「清空」—— 全部丢弃，不可恢复')) throw new Error('底部应给出清空出口并标注不可恢复: ' + reply);
  if (reply.includes('放弃')) throw new Error('「放弃（暂存保留）」自相矛盾的旧文案不应再出现: ' + reply);
  const pending = JSON.parse(await env.KV.get('pending'));
  if (pending.length !== 1) throw new Error('预览阶段不应改动暂存: ' + JSON.stringify(pending));
});

/* 4c. 取消 → 放弃本次发布，暂存保留 */
await check('取消：退出发布但保留暂存', async () => {
  const nonce = 'n4c', ts = 1700000011;
  const msgXml = `<xml>${xmlTag('ToUserName', env.CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'text')}${xmlTag('Content', '取消')}${xmlTag('MsgId', 'm-test-4c')}</xml>`;
  const { enc, sig } = await encEnvelope(env, msgXml, nonce, ts);
  const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
  const res = await worker.fetch(req, env, {});
  const reply = await decryptReply(env, res);
  if (!reply.includes('已退出发布')) throw new Error('回复不对: ' + reply);
  if (!reply.includes('1 条暂存都还在')) throw new Error('取消回话应带上还在的暂存条数: ' + reply);
  const pending = JSON.parse(await env.KV.get('pending'));
  if (pending.length !== 1) throw new Error('取消不应删除暂存: ' + JSON.stringify(pending));
});

/* 4d. 确认后 GitHub 失败（无 waitUntil 环境走同步兜底）→ 立即回失败话术 + 暂存必须回滚，不能丢内容 */
await check('确认：发布失败立即回话术 + 暂存回滚', async () => {
  await sendText('发', 'n4d1', 1700000012, 'm-test-4d1'); // 取得 pubok
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const reply = await sendText('确认', 'n4d2', 1700000013, 'm-test-4d2');
    if (!reply.includes('发布失败')) throw new Error('应回"发布失败": ' + reply);
    if (!reply.includes('network down')) throw new Error('失败原因必须直接回给用户（不能只留日志）: ' + reply);
    if (/\n\s+at /.test(reply)) throw new Error('不该把堆栈甩给用户: ' + reply);
  } finally { globalThis.fetch = realFetch; }
  const pending = JSON.parse(await env.KV.get('pending'));
  if (pending.length !== 1) throw new Error('暂存应回滚为 1 条，实际: ' + JSON.stringify(pending));
  const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
  if (!res || res.ok !== false) throw new Error('失败结果应落 KV 供「结果」查: ' + JSON.stringify(res));
  if (!res.raw.includes('network down')) throw new Error('原始报错应留存: ' + res.raw);
});

/* 4d2. 确认 → 立即回「已安排发布」（不等 GitHub）；后台失败后主动推一条（成功则静默） */
await check('确认：立即回话不等发布，失败主动推送', async () => {
  await sendText('文\n异步发布测试\n正文', 'n4g1', 1700000025, 'm-test-4g1');
  await sendText('发', 'n4g2', 1700000026, 'm-test-4g2');
  const jobs = [];
  const ctx = { waitUntil: (p) => jobs.push(p) };
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.github.com')) {
      await new Promise((r) => setTimeout(r, 60)); // 模拟慢发布
      throw new Error('network down');
    }
    if (u.includes('cgi-bin/message/send')) { sent.push(u); return { ok: true, json: async () => ({ errcode: 0 }) }; }
    if (u.includes('cgi-bin/gettoken')) return { ok: true, json: async () => ({ access_token: 'mock-token', expires_in: 7200 }) };
    return realFetch(url);
  };
  try {
    const reply = await sendText('确认', 'n4g3', 1700000027, 'm-test-4g3', { ctx });
    if (!reply.includes('已安排发布')) throw new Error('确认应立即回已安排发布: ' + reply);
    if (jobs.length !== 1) throw new Error('应注册 1 个后台任务: ' + jobs.length);
    await jobs[0];
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || res.ok !== false) throw new Error('后台失败结果应落 KV: ' + JSON.stringify(res));
    /* 失败必须让人知道——走 message/send 主动推，不受 5 秒窗口限制 */
    if (sent.length !== 1) throw new Error('后台失败应主动推 1 条: ' + sent.length);
  } finally { globalThis.fetch = realFetch; }
  await env.KV.put('pending', '[]');
});

/* 4d3. 「结果」指令：能查到上次发布的成败；原始报错只在这里展开 */
await check('结果：查询上次发布结果 + 原始报错', async () => {
  const r = await sendText('结果', 'n4r1', 1700000030, 'm-test-4r1');
  if (!r.includes('上次发布失败')) throw new Error('应报失败: ' + r);
  if (!r.includes('network down')) throw new Error('应展开原始报错: ' + r);
  await env.KV.delete('pubres:userid-abc');
  const r2 = await sendText('结果', 'n4r2', 1700000031, 'm-test-4r2');
  if (!r2.includes('没有发布记录')) throw new Error('无记录时提示不对: ' + r2);
  await env.KV.delete('pubfail:userid-abc'); // 隔离：免得后面用例每条回复都被补播前缀
});

/* 4d4. 主站拆分结构 flush 成功路径：文章=列表+正文文件，瞬间=只写当年卷+days+watch-meta */
await check('确认：主站拆分结构发布（posts C 方案 + 瞬间年分卷）', async () => {
  await env.KV.put('pending', '[]');
  const FIX = {
    'data/posts.js': '// 文章列表（由管理后台/发文bot维护；正文在 data/content/<slug>.js 按需加载）\nwindow.POSTS = ' + JSON.stringify([
      { slug: 'old', title: '旧文', date: '2026-01-01', categories: [], tags: [], cover: '', excerpt: '旧摘要' },
    ]) + ';\n',
    'data/moments.js': '// 瞬间分卷清单（bot/后台维护；各年正文在 data/moments-YYYY.js）\nwindow.MOMENTS_YEARS = ["2026"];\n',
    'data/moments-2026.js': '// 瞬间数据 2026 年卷（由管理后台/发文bot维护）\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2026"] = ' + JSON.stringify([
      { date: '2026/10/01 12:00:00', content: '<p>旧</p>', type: 'movie', kind: 'movie', title: '旧片', runtime: 90, poster: 'https://image.tmdb.org/t/p/w500/abc.jpg' },
    ]) + ';\n',
  };
  const blobs = {}; let blobSeq = 0;
  const shaOfPath = {}; Object.keys(FIX).forEach((p, i) => (shaOfPath[p] = 'FIXBLOB' + i));
  const pathOfSha = Object.fromEntries(Object.entries(shaOfPath).map(([p, s]) => [s, p]));
  const puts = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url).replace(/https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    if (u === '/git/ref/heads/main') return { ok: true, json: async () => ({ object: { sha: 'HEADSHA' } }) };
    if (u === '/git/commits/HEADSHA') return { ok: true, json: async () => ({ tree: { sha: 'BASETREE' } }) };
    if (u.startsWith('/git/trees/BASETREE')) return { ok: true, json: async () => ({ tree: Object.keys(FIX).map((path) => ({ path, sha: shaOfPath[path] })) }) };
    if (u.startsWith('/git/blobs/')) {
      const sha = u.slice('/git/blobs/'.length);
      const path = pathOfSha[sha];
      return { ok: true, json: async () => ({ content: b64(FIX[path]) }) };
    }
    if (u === '/git/blobs' && init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const sha = 'NEWBLOB' + (++blobSeq);
      blobs[sha] = Buffer.from(body.content, 'base64').toString('utf8');
      return { ok: true, json: async () => ({ sha }) };
    }
    if (u === '/git/trees' && init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      body.tree.forEach((t) => { if (t.sha) puts[t.path] = blobs[t.sha]; });
      return { ok: true, json: async () => ({ sha: 'NEWTREE' }) };
    }
    if (u === '/git/commits' && init && init.method === 'POST') return { ok: true, json: async () => ({ sha: 'NEWCOMMIT' }) };
    if (u === '/git/refs/heads/main' && init && init.method === 'PATCH') return { ok: true, json: async () => ({}) };
    if (u.includes('api.themoviedb.org')) return { ok: true, json: async () => ({ results: [] }) };
    if (u.includes('www.googleapis.com/books')) return { ok: true, json: async () => ({ items: [] }) };
    throw new Error('mock 未覆盖: ' + u);
  };
  try {
    await sendText('文\nFlush Test\n正文第一段\nhttps://img.example.com/file/abc.jpg', 'n4h1', 1700000040, 'm-test-4h1');
    const rMoment = await sendText('瞬\n一条测试瞬间', 'n4h2', 1700000041, 'm-test-4h2');
    if (!rMoment.includes('已按纯文字随笔暂存')) throw new Error('瞬应按随笔暂存: ' + rMoment);
    await sendText('发', 'n4h3', 1700000042, 'm-test-4h3');
    const reply = await sendText('确认', 'n4h4', 1700000043, 'm-test-4h4');
    /* 成功路径回空串（用户规则：成功静默，自己刷页面），结果落 KV 供「结果」查询 */
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok || res.n !== 2) throw new Error('应成功发布2条: ' + reply + ' | ' + JSON.stringify(res));

    const listText = puts['data/posts.js'];
    if (!listText) throw new Error('应写回 data/posts.js');
    const list = JSON.parse(listText.slice(listText.indexOf('['), listText.lastIndexOf(']') + 1));
    if (list.length !== 2 || list[0].slug !== 'flush-test') throw new Error('列表应新文在前: ' + listText.slice(0, 200));
    if ('content' in list[0]) throw new Error('列表不应再带正文');
    if (!/img\.example\.com\/file\/abc\.jpg/.test(list[0].cover)) throw new Error('封面应取正文第一张图: ' + list[0].cover);

    const enc = encodeURIComponent('flush-test');
    const contentText = puts[`data/content/${enc}.js`];
    if (!contentText) throw new Error('应新建正文文件 data/content/' + enc + '.js，实际: ' + Object.keys(puts).join(','));
    if (!contentText.includes('window.POST_CONTENT["flush-test"]')) throw new Error('正文文件键不对: ' + contentText.slice(0, 120));

    const volText = puts['data/moments-2026.js'];
    if (!volText) throw new Error('应重写 2026 年卷');
    const vol = JSON.parse(volText.slice(volText.indexOf('= [') + 2, volText.lastIndexOf(']') + 1));
    if (vol.length !== 2) throw new Error('2026 卷应有 2 条: ' + vol.length);
    /* 断言不能写死日期（今天发的瞬间日期=当天，隔天跑就红）：只验证排序——新的在前 */
    if (!(String(vol[0].date) > String(vol[1].date))) throw new Error('新瞬间应在最前: ' + vol[0].date + ' vs ' + vol[1].date);

    const metaText = puts['data/watch-meta.js'];
    if (!metaText || !metaText.includes('"total":2')) throw new Error('watch-meta 应重算 total=2: ' + (metaText || '').slice(0, 200));
    const catText = puts['data/catalog.js'];
    if (!catText || !catText.includes('MOMENT_CATALOG')) throw new Error('发布瞬间应重算查重名录');
    const catObj = JSON.parse(catText.slice(catText.indexOf('{'), catText.lastIndexOf('}') + 1));
    if (!Object.values(catObj).flat().includes('旧片')) throw new Error('名录应含已有片名: ' + catText.slice(0, 200));
    const daysText = puts['data/days-2026.js'];
    if (!daysText || !daysText.includes('"2026-10-01"')) throw new Error('受影响年份的 days 应重算并含旧观影日: ' + (daysText || '').slice(0, 200));
    if (puts['data/moments.js']) throw new Error('没有新年份不应重写 manifest');
    if (Object.keys(puts).some((p) => p === 'data/days.js' || p.startsWith('data/moments-202'))) {
      if (Object.keys(puts).some((p) => p !== 'data/moments-2026.js' && /^data\/moments-20\d\d\.js$/.test(p))) throw new Error('不该写其他年份卷');
    }
  } finally { globalThis.fetch = realFetch; await env.KV.put('pending', '[]'); }
});

/* 4e. D1 存储模式：绑 env.DB 后发布 → 全程零 GitHub 调用，文件内容写入 files 表。
   这是 2026-11 数据迁移（方案 B）的主路径：GitHub 只剩代码仓库，数据在 D1。 */
function mockD1() {
  const rows = new Map(); const log = { exec: [], batch: 0 };
  return {
    rows, log,
    exec(sql) { log.exec.push(sql); },
    prepare(sql) {
      let args = [];
      const api = {
        get _sql() { return sql; }, get _args() { return args; },
        /* 真实 D1 语义：bind() 只绑定参数、返回不可 await 的语句对象，
           必须接 .first()/.all()/.run()（或进 batch）才执行——
           千万别把 bind 做成 thenable，否则掩盖漏写 .run() 的 bug */
        bind(...a) { args = a; return api; },
        async run() {
          if (sql.startsWith('DELETE')) { rows.delete(args[0]); return { success: true }; }
          if (sql.startsWith('INSERT')) { rows.set(args[0], { body: args[1], updated_at: args[2] }); return { success: true }; }
          throw new Error('mockD1 未覆盖 run: ' + sql);
        },
        async first() {
          if (/FROM files WHERE path/.test(sql)) { const r = rows.get(args[0]); return r ? { body: r.body, updated_at: r.updated_at } : null; }
          if (/COUNT\(\*\)/.test(sql)) return { n: rows.size };
          throw new Error('mockD1 未覆盖 first: ' + sql);
        },
        async all() {
          if (/SELECT path, body FROM files ORDER BY path LIMIT/.test(sql)) {
            const [limit, off] = args;
            const list = [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
              .slice(off, off + limit).map(([path, r]) => ({ path, body: r.body }));
            return { results: list };
          }
          if (/^SELECT path FROM files$/.test(sql)) return { results: [...rows.keys()].map((path) => ({ path })) };
          throw new Error('mockD1 未覆盖 all: ' + sql);
        },
      };
      return api;
    },
    async batch(stmts) {
      log.batch++;
      for (const s of stmts) {
        const sql = s._sql, args = s._args;
        if (sql.startsWith('DELETE')) rows.delete(args[0]);
        else if (sql.startsWith('INSERT')) rows.set(args[0], { body: args[1], updated_at: args[2] });
        else throw new Error('mockD1 未覆盖 batch: ' + sql);
      }
    },
  };
}

await check('D1 模式：发布走 files 表，零 GitHub 调用，读也优先 D1', async () => {
  await env.KV.put('pending', '[]');
  const db = mockD1();
  const FIX = {
    'data/posts.js': '// 文章列表\nwindow.POSTS = ' + JSON.stringify([
      { slug: 'old', title: '旧文', date: '2026-01-01', categories: [], tags: [], cover: '', excerpt: '旧摘要' },
    ]) + ';\n',
    'data/moments.js': '// 瞬间分卷清单\nwindow.MOMENTS_YEARS = ["2026"];\n',
    'data/moments-2026.js': '// 瞬间数据 2026 年卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2026"] = ' + JSON.stringify([
      { date: '2026/10/01 12:00:00', content: '<p>旧</p>', type: 'movie', kind: 'movie', title: '旧片', runtime: 90, poster: '' },
    ]) + ';\n',
  };
  for (const [p, body] of Object.entries(FIX)) db.rows.set(p, { body, updated_at: 1 });
  env.DB = db;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.github.com')) throw new Error('D1 模式不应访问 GitHub: ' + url);
    if (String(url).includes('api.themoviedb.org')) return { ok: true, json: async () => ({ results: [] }) }; // 瞬会查海报，空结果走随笔
    if (String(url).includes('www.googleapis.com/books')) return { ok: true, json: async () => ({ items: [] }) };
    throw new Error('D1 模式不应外呼: ' + url);
  };
  try {
    await sendText('文\nD1 Test\nD1 正文', 'ne1', 1700000050, 'm-d1-1');
    await sendText('瞬\nD1 瞬间测试', 'ne2', 1700000051, 'm-d1-2');
    const reply = await sendText('发', 'ne3', 1700000052, 'm-d1-3');
    await sendText('确认', 'ne4', 1700000053, 'm-d1-4');
    /* 成功静默（用户规则）：结果落 pubres KV。回话若非空只可能是失败话术 */
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok || res.n !== 2) throw new Error('应成功发布 2 条: ' + reply + ' | ' + JSON.stringify(res));
    if (db.log.batch < 1) throw new Error('应有 D1 batch 写入');

    const listText = (db.rows.get('data/posts.js') || {}).body;
    if (!listText) throw new Error('posts.js 应 upsert 进 D1');
    const list = JSON.parse(listText.slice(listText.indexOf('['), listText.lastIndexOf(']') + 1));
    if (list.length !== 2 || list[0].slug !== 'd1-test') throw new Error('新文应在最前: ' + listText.slice(0, 200));
    if (!db.rows.get('data/content/d1-test.js')) throw new Error('正文应一篇一行进 D1');

    const volText = (db.rows.get('data/moments-2026.js') || {}).body;
    if (!volText) throw new Error('2026 卷应重写');
    const vol = JSON.parse(volText.slice(volText.indexOf('= [') + 2, volText.lastIndexOf(']') + 1));
    if (vol.length !== 2 || !(String(vol[0].date) > String(vol[1].date))) throw new Error('新瞬间应在最前: ' + volText.slice(0, 200));
    if (!db.rows.get('data/catalog.js') || !db.rows.get('data/watch-meta.js')) throw new Error('名录/watch-meta 应随瞬间重算');

    /* 读路径：发布后再「查」应直接命中 D1（此时 GitHub mock 会炸，能查通即证明读的是 D1） */
    await sendText('查文 D1 Test', 'ne5', 1700000054, 'm-d1-5');
  } finally {
    delete env.DB;
    globalThis.fetch = realFetch;
    await env.KV.put('pending', '[]');
  }
});

/* 图片消息辅助 */
async function sendImage(mediaId, msgId, fetchMock) {
  const realFetch = globalThis.fetch;
  if (fetchMock) globalThis.fetch = fetchMock;
  try {
    const ts = Math.floor(Date.now() / 1000), nonce = 'ni' + Math.random().toString(36).slice(2, 8);
    const msgXml = `<xml>${xmlTag('ToUserName', env.CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'image')}${xmlTag('MediaId', mediaId)}${xmlTag('MsgId', msgId)}</xml>`;
    const { enc, sig } = await encEnvelope(env, msgXml, nonce, ts);
    const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
    const req = new Request(`https://x/wecom?${qs({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
    const res = await worker.fetch(req, env, {});
    return await decryptReply(env, res);
  } finally { globalThis.fetch = realFetch; }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const ERR60020 = new TextEncoder().encode('{"errcode":60020,"errmsg":"not allow to access from your ip, hint: [x], from ip: 104.23.168.74, more info at https://open.work.weixin.qq.com/devtool/query?e=60020"}');

function mockWecom(imgBytes, calls) {
  return async (url, init) => {
    const u = String(url);
    calls.push(u.slice(0, 80));
    if (u.includes('gettoken')) return new Response(JSON.stringify({ access_token: 'TESTTOK', expires_in: 7200 }), { status: 200 });
    if (u.includes('media/get')) return new Response(imgBytes, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    if (u.includes('img.example.com/upload')) return new Response(JSON.stringify([{ src: '/file/mock-ok' }]), { status: 200 });
    throw new Error('mock 未覆盖: ' + u);
  };
}

/* 5a. 回归：微信下载媒体出错时 HTTP 也是 200 + JSON，绝不能把错误 JSON 当图片传到图床 */
await check('图片消息：微信拒绝(60020) → 明确报错，不上传图床', async () => {
  await env.KV.put('pending', '[]'); // 清掉前面用例的暂存
  await env.KV.delete('wecom_token');
  const calls = [];
  const reply = await sendImage('MEDIA_BAD', 'm-test-imgbad', mockWecom(ERR60020, calls));
  if (!reply.includes('60020') || !reply.includes('链接')) throw new Error('应提示 60020 并引导发链接: ' + reply);
  if (calls.some((u) => u.includes('img.example.com/upload'))) throw new Error('错误 JSON 不应被上传到图床');
  const pending = JSON.parse(await env.KV.get('pending'));
  if (pending.length) throw new Error('失败不应入暂存: ' + JSON.stringify(pending));
});

/* 5b. 正常 JPEG → 上传图床并入暂存 */
await check('图片消息：正常 JPEG → 上传并暂存', async () => {
  await env.KV.delete('wecom_token');
  const calls = [];
  const reply = await sendImage('MEDIA_OK', 'm-test-imgok', mockWecom(JPEG, calls));
  if (!reply.includes('已暂存图片 https://img.example.com/file/mock-ok')) throw new Error('回复不对: ' + reply);
  if (!calls.some((u) => u.includes('img.example.com/upload'))) throw new Error('应调用图床上传');
  const pending = JSON.parse(await env.KV.get('pending'));
  if (!pending.length || pending[pending.length - 1].item.src !== 'https://img.example.com/file/mock-ok') throw new Error('暂存不对: ' + JSON.stringify(pending));
  await env.KV.delete('pending');
});

/* 5c. 非图片内容（如 HTML）→ 拒绝 */
await check('图片消息：内容不是图片 → 拒绝', async () => {
  await env.KV.delete('wecom_token');
  const calls = [];
  const html = new TextEncoder().encode('<html>not an image</html>');
  const reply = await sendImage('MEDIA_HTML', 'm-test-imghtml', mockWecom(html, calls));
  if (!reply.includes('不是图片')) throw new Error('应提示非图片: ' + reply);
  if (calls.some((u) => u.includes('img.example.com/upload'))) throw new Error('非图片不应上传');
});

/* 4e. 清空暂存 */
await check('清空：丢弃全部暂存', async () => {
  await sendText('图\nhttps://x/1.jpg', 'n4e1', 1700000014, 'm-test-4e1');
  const reply = await sendText('清空', 'n4e2', 1700000015, 'm-test-4e2');
  if (!reply.includes('已清空')) throw new Error('回复不对: ' + reply);
  const pending = JSON.parse(await env.KV.get('pending'));
  if (pending.length !== 0) throw new Error('应清空，实际: ' + JSON.stringify(pending));
});

/* 4f. 文章正文裸链接自动识别 */
await check('文章：正文混排链接自动识别（图/📎/网址）', async () => {
  const reply = await sendText('文\n富文本测试\n图前文字 https://img.example.com/file/MhZ7DD 图后文字\nhttps://x.com/manual.pdf\n参考 https://ksh.example.com/。完', 'n4f', 1700000016, 'm-test-4f');
  if (!reply.includes('已暂存文章《富文本测试》')) throw new Error('回复不对: ' + reply);
  const pending = JSON.parse(await env.KV.get('pending'));
  const c = pending[pending.length - 1].item.content;
  if (!c.includes('<img src="https://img.example.com/file/MhZ7DD"')) throw new Error('图床链接应成 <img>: ' + c);
  if (!c.includes('图前文字') || !c.includes('图后文字')) throw new Error('图前后的文字应保留: ' + c);
  if (!c.includes('📎 manual.pdf')) throw new Error('pdf 应成 📎 链接: ' + c);
  if (!c.includes('<a href="https://ksh.example.com/"')) throw new Error('网址应成 <a>: ' + c);
  if (c.includes('https://ksh.example.com/。')) throw new Error('中文句号不应被吞进链接: ' + c);
  await env.KV.put('pending', '[]');
});

/* 4g. 视频/音频链接内嵌播放器 */
await check('文章：视频/音频链接 → 内嵌播放器', async () => {
  await sendText('文\n媒体测试\n演示 https://img.example.com/file/demo.mp4 完成\n音频 https://x.com/song.mp3 听', 'n4g', 1700000017, 'm-test-4g');
  const pending = JSON.parse(await env.KV.get('pending'));
  const c = pending[pending.length - 1].item.content;
  if (!c.includes('<video src="https://img.example.com/file/demo.mp4" controls')) throw new Error('mp4 应成 <video>: ' + c);
  if (!c.includes('<audio src="https://x.com/song.mp3" controls')) throw new Error('mp3 应成 <audio>: ' + c);
  if (c.includes('📎 demo.mp4')) throw new Error('视频不应再当附件: ' + c);
  await env.KV.put('pending', '[]');
});

/* 5. 签名错误要拒收 */
await check('安全：错误签名被拒绝（回 success）', async () => {
  const nonce = 'n5', ts = 1700000004;
  const { enc } = await encEnvelope(env, '<xml/>', nonce, ts);
  const body = `<xml>${xmlTag('Encrypt', enc)}${xmlTag('MsgSignature', 'deadbeef')}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x/wecom?${qs({ msg_signature: 'deadbeef', timestamp: ts, nonce })}`, { method: 'POST', headers: H, body });
  const res = await worker.fetch(req, env, {});
  const t = await res.text();
  if (t !== 'success') throw new Error('应回 success，实际: ' + t.slice(0, 60));
});

/* 6. 未注册路径返回 404 */
await check('未注册路径返回 404', async () => {
  const res = await worker.fetch(new Request('https://x/wecom3?diag=1'), env, {});
  if (res.status !== 404) throw new Error('应 404，实际: ' + res.status);
});

await check('markdown：文 暂存内容支持标题/引用/列表/粗体/代码', async () => {
  const r = await sendText('文\nMD测试\n## 参数\n- 一 **加粗**\n- 二\n> 引用一句\n正文段`代码`尾', 'n9c', 1700000052, 'm-test-9c');
  if (!r.includes('已暂存文章《MD测试》')) throw new Error('回复不对: ' + r);
  const pending = JSON.parse(env.KV._s['pending']);
  const c = pending[pending.length - 1].item.content;
  for (const seg of ['<h3 style="">参数</h3>', '<li>一 <strong>加粗</strong></li>', '<blockquote style="">引用一句</blockquote>', '<code>代码</code>', '<p style="">正文段']) {
    if (!c.includes(seg)) throw new Error('缺 ' + seg + ' in ' + c);
  }
  env.KV._s['pending'] = '[]';
});

await check('markdown：标题剥 # 记号、摘要为纯文本（主站）', async () => {
  const r = await sendText('文\n# 微信发文章 Bot·小白部署指南\n> **这是什么**：说明文字\n---\n| 需要 | 去哪拿 |\n|---|---|\n| 企微权限 | 后台 |\n- 要点 **一**\n`worker.js` 正文', 'n9d', 1700000053, 'm-test-9d');
  if (!r.includes('已暂存文章《微信发文章 Bot·小白部署指南》')) throw new Error('标题没剥#: ' + r);
  const pending = JSON.parse(env.KV._s['pending']);
  const it = pending[pending.length - 1].item;
  if (/[#*`]/.test(it.title)) throw new Error('title 仍含记号: ' + it.title);
  for (const bad of ['>', '**', '|', '---', '`', '#']) {
    if (it.excerpt.includes(bad)) throw new Error('excerpt 含 ' + bad + ': ' + it.excerpt);
  }
  if (!it.excerpt.includes('这是什么') || !it.excerpt.includes('企微权限')) throw new Error('excerpt 内容缺失: ' + it.excerpt);
  env.KV._s['pending'] = '[]';
});

/* 4e. 瞬间查重：同名已记录 → 提醒待「二刷」，不自动暂存；二刷回复后正常暂存 */
await check('瞬确认查重：提醒已记录，回复「二刷」才暂存；发布后索引失效', async () => {
  const FIX = {
    'data/moments.js': '// 瞬间分卷清单\nwindow.MOMENTS_YEARS = ["2026","1900"];\n',
    'data/moments-2026.js': 'window.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2026"] = [{"date":"2026/05/01 12:00:00","content":"<p>旧记录</p>","type":"movie","title":"空枪","runtime":100,"poster":"p","kind":"movie"}];\n',
    'data/moments-1900.js': 'window.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["1900"] = [{"date":"1900/01/01 12:00:00","content":"","type":"movie","title":"老片","undated":true}];\n',
  };
  const blobs = {}; let blobSeq = 0; const puts = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url).replace(/https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    if (u === '/git/ref/heads/main') return { ok: true, json: async () => ({ object: { sha: 'HEAD2' } }) };
    if (u === '/git/commits/HEAD2') return { ok: true, json: async () => ({ tree: { sha: 'TREE2' } }) };
    if (u.startsWith('/git/trees/TREE2')) return { ok: true, json: async () => ({ tree: Object.keys(FIX).map((p) => ({ path: p, sha: 'B2_' + p.replace(/\//g, '_') })) }) };
    if (u.startsWith('/git/blobs/B2_')) {
      const path = Object.keys(FIX).find((p) => 'B2_' + p.replace(/\//g, '_') === u.slice('/git/blobs/'.length));
      return { ok: true, json: async () => ({ content: b64(FIX[path]) }) };
    }
    if (u === '/git/blobs' && init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const sha = 'NB2_' + (++blobSeq);
      blobs[sha] = Buffer.from(body.content, 'base64').toString('utf8');
      return { ok: true, json: async () => ({ sha }) };
    }
    if (u === '/git/trees' && init && init.method === 'POST') {
      JSON.parse(init.body).tree.forEach((t) => { if (t.sha) puts[t.path] = blobs[t.sha]; });
      return { ok: true, json: async () => ({ sha: 'NT2' }) };
    }
    if (u === '/git/commits' && init && init.method === 'POST') return { ok: true, json: async () => ({ sha: 'NC2' }) };
    if (u === '/git/refs/heads/main' && init && init.method === 'PATCH') return { ok: true, json: async () => ({}) };
    if (u.includes('api.themoviedb.org/3/search/multi')) return { ok: true, json: async () => ({ results: [{ media_type: 'movie', id: 77, title: '空枪', release_date: '2026-01-01', poster_path: '/k.jpg', vote_average: 6.8 }] }) };
    if (/api\.themoviedb\.org\/3\/movie\/77\?/.test(u)) return { ok: true, json: async () => ({ title: '空枪', runtime: 96 }) };
    throw new Error('mock 未覆盖: ' + u);
  };
  try {
    env.KV._s['pending'] = '[]'; env.KV._s['momentsIdx'] = '';
    const r1 = await sendText('瞬\n空枪\n二刷测试', 'n5a1', 1700000060, 'm-test-5a1');
    if (!r1.includes('找到这些')) throw new Error('应回候选列表: ' + r1);
    const r2 = await sendText('1', 'n5a2', 1700000061, 'm-test-5a2');
    if (!r2.includes('已有记录')) throw new Error('应提醒已记录(含年份): ' + r2);
    if (!r2.includes('二刷')) throw new Error('应提示回复二刷: ' + r2);
    if (JSON.parse(env.KV._s['pending'] || '[]').length) throw new Error('查重提醒时不应暂存');
    const r3 = await sendText('二刷', 'n5a3', 1700000062, 'm-test-5a3');
    if (!r3.includes('已暂存《空枪》')) throw new Error('二刷后应暂存: ' + r3);
    if (JSON.parse(env.KV._s['pending'] || '[]').length !== 1) throw new Error('二刷应暂存 1 条');
    await sendText('发', 'n5a4', 1700000063, 'm-test-5a4');
    await sendText('确认', 'n5a5', 1700000064, 'm-test-5a5');
    const res = JSON.parse(env.KV._s['pubres:userid-abc'] || 'null');
    if (!res || !res.ok) throw new Error('发布应成功: ' + JSON.stringify(res));
    if (!puts['data/moments-2026.js'] || !puts['data/watch-meta.js']) throw new Error('应重写 2026 卷与 watch-meta');
    if (env.KV._s['momentsIdx'] !== undefined && env.KV._s['momentsIdx'] !== null) throw new Error('发布后应清掉查重索引: ' + env.KV._s['momentsIdx']);
    env.KV._s['pending'] = '[]';
  } finally { globalThis.fetch = realFetch; }
});

/* 4e2. 查重名录优先：data/catalog.js 存在时仅 1 次 GitHub 请求完成查重 */
await check('查重名录优先：catalog 存在时仅 1 次 GitHub 请求', async () => {
  let ghCalls = 0;
  const realFetch = globalThis.fetch;
  const catalogText = '// 瞬间名录\nwindow.MOMENT_CATALOG = {"2020":["钢铁侠3"],"2026":["空枪"]};\n';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/contents/data/catalog.js')) {
      ghCalls++;
      return { ok: true, json: async () => ({ content: Buffer.from(catalogText, 'utf8').toString('base64'), encoding: 'base64' }) };
    }
    if (u.includes('api.themoviedb.org/3/search/multi')) return { ok: true, json: async () => ({ results: [{ media_type: 'movie', id: 88, title: '空枪', release_date: '2026-01-01', poster_path: '/k.jpg', vote_average: 6.8 }] }) };
    if (/api\.themoviedb\.org\/3\/movie\/88\?/.test(u)) return { ok: true, json: async () => ({ title: '空枪', runtime: 96 }) };
    throw new Error('名录模式下不应有其他请求: ' + u);
  };
  try {
    env.KV._s['pending'] = '[]'; env.KV._s['momentsIdx'] = '';
    const r1 = await sendText('瞬\n空枪\n名录测试', 'n5b1', 1700000070, 'm-test-5b1');
    if (!r1.includes('找到这些')) throw new Error('应回候选列表: ' + r1);
    const r2 = await sendText('1', 'n5b2', 1700000071, 'm-test-5b2');
    if (!r2.includes('2026 年已有记录')) throw new Error('应按名录提醒: ' + r2);
    if (!r2.includes('是否再刷一遍')) throw new Error('应含「是否再刷一遍」: ' + r2);
    if (ghCalls !== 1) throw new Error('应只发 1 次 GitHub 请求: ' + ghCalls);
    if (JSON.parse(env.KV._s['pending'] || '[]').length) throw new Error('查重提醒时不应暂存');
    env.KV._s['pending'] = '[]';
  } finally { globalThis.fetch = realFetch; }
});

/* 4f. 搜索代理端点：缺参 400 / 正常转发带 CORS / id 净化 / gbooks */
await check('搜索代理：/tmdb /tmdb/detail /gbooks 转发与校验', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('api.themoviedb.org')) return { ok: true, status: 200, text: async () => '{"ok":true}' };
    if (String(url).includes('googleapis.com/books')) return { ok: true, status: 200, text: async () => '{"books":true}' };
    throw new Error('不应请求其他域: ' + url);
  };
  try {
    const pe = Object.assign({}, env, { TMDB_KEY: env.TMDB_KEY || 'testkey' });
    const r1 = await worker.fetch(new Request('https://x/tmdb'), pe, {});
    if (r1.status !== 400) throw new Error('缺 q 应 400: ' + r1.status);
    const r2 = await worker.fetch(new Request('https://x/tmdb?q=' + encodeURIComponent('空枪')), pe, {});
    if (r2.status !== 200) throw new Error('转发应 200: ' + r2.status);
    if (r2.headers.get('Access-Control-Allow-Origin') !== '*') throw new Error('缺 CORS 头');
    if (!seen[seen.length - 1].includes('language=zh-CN')) throw new Error('应保留 zh-CN: ' + seen[seen.length - 1]);
    const r3 = await worker.fetch(new Request('https://x/tmdb/detail?kind=movie&id=77abc'), pe, {});
    if (r3.status !== 200) throw new Error('detail 应 200: ' + r3.status);
    if (!/\/movie\/77\?/.test(seen[seen.length - 1])) throw new Error('id 应净化为纯数字: ' + seen[seen.length - 1]);
    const r4 = await worker.fetch(new Request('https://x/gbooks?q=x'), pe, {});
    if (r4.status !== 200) throw new Error('gbooks 应 200: ' + r4.status);
    const r5 = await worker.fetch(new Request('https://x/gbooks'), pe, {});
    if (r5.status !== 400) throw new Error('gbooks 缺 q 应 400: ' + r5.status);
  } finally { globalThis.fetch = realFetch; }
});

/* ============ 主站 bot CRUD：查/删/改/待办 ============ */

/* 通用 GitHub mock：FIX=仓库现有文件；puts/deleted 记录写入与删除；opts 定制 TMDB */
function mkGhMock(FIX, blobs, puts, deleted, opts = {}) {
  const shaOfPath = {}; Object.keys(FIX).forEach((p, i) => (shaOfPath[p] = 'FIXBLOB' + i));
  const pathOfSha = Object.fromEntries(Object.entries(shaOfPath).map(([p, s]) => [s, p]));
  let blobSeq = 0;
  return async (url, init) => {
    const u = String(url).replace(/https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    if (u === '/git/ref/heads/main') return { ok: true, json: async () => ({ object: { sha: 'HEADSHA' } }) };
    if (u === '/git/commits/HEADSHA') return { ok: true, json: async () => ({ tree: { sha: 'BASETREE' } }) };
    if (u.startsWith('/git/trees/BASETREE')) return { ok: true, json: async () => ({ tree: Object.keys(FIX).map((path) => ({ path, sha: shaOfPath[path] })) }) };
    if (u.startsWith('/git/blobs/')) {
      const sha = u.slice('/git/blobs/'.length);
      const path = pathOfSha[sha];
      return { ok: true, json: async () => ({ content: b64(FIX[path]) }) };
    }
    if (u.startsWith('/contents/')) {
      const p = decodeURIComponent(u.slice('/contents/'.length).split('?')[0]);
      if (FIX[p] !== undefined) return { ok: true, json: async () => ({ content: b64(FIX[p]) }) };
    }
    if (u.startsWith('/contents/data/catalog.js')) {
      const text = FIX['data/catalog.js'] || '';
      return { ok: true, json: async () => ({ content: b64(text) }) };
    }
    if (u === '/git/blobs' && init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const sha = 'NEWBLOB' + (++blobSeq);
      blobs[sha] = Buffer.from(body.content, 'base64').toString('utf8');
      return { ok: true, json: async () => ({ sha }) };
    }
    if (u === '/git/trees' && init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      body.tree.forEach((t) => { if (t.sha) puts[t.path] = blobs[t.sha]; else if (t.sha === null) deleted.push(t.path); });
      return { ok: true, json: async () => ({ sha: 'NEWTREE' }) };
    }
    if (u === '/git/commits' && init && init.method === 'POST') return { ok: true, json: async () => ({ sha: 'NEWCOMMIT' }) };
    if (u === '/git/refs/heads/main' && init && init.method === 'PATCH') return { ok: true, json: async () => ({}) };
    if (u.includes('api.themoviedb.org')) {
      if (u.includes('/search/multi')) return { ok: true, json: async () => ({ results: opts.tmdbSearch || [] }) };
      if (opts.tmdbDetail && (u.includes('/3/movie/') || u.includes('/3/tv/'))) return { ok: true, json: async () => opts.tmdbDetail };
      return { ok: true, json: async () => ({}) };
    }
    if (u.includes('www.googleapis.com/books')) return { ok: true, json: async () => ({ items: [] }) };
    throw new Error('mock 未覆盖: ' + u);
  };
}
async function withMock(FIX, opts, fn) {
  const blobs = {}, puts = {}, deleted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mkGhMock(FIX, blobs, puts, deleted, opts);
  try { await fn(puts, deleted); }
  finally { globalThis.fetch = realFetch; await env.KV.put('pending', '[]'); }
}

const M = (date, title, extra = '') => ({ date, content: `<p style="">${title}${extra}</p>`, type: 'movie', kind: 'movie', title, runtime: 90, poster: '' });

/* 35. 查 → 选中瞬间 → 删 → 确认 */
await check('CRUD：查→选中瞬间→删→确认（卷/days/catalog/meta 重算）', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {"2026":["旧片","空枪"],"2015":["老片A"]};\n',
    'data/moments.js': '// manifest\nwindow.MOMENTS_YEARS = ["2026","2015"];\n',
    'data/moments-2026.js': '// 2026卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2026"] = ' + JSON.stringify([M('2026/05/01 10:00:00', '旧片'), M('2026/04/01 10:00:00', '空枪')]) + ';\n',
    'data/moments-2015.js': '// 2015卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2015"] = ' + JSON.stringify([M('2015/03/01 10:00:00', '老片A')]) + ';\n',
  }, {}, async (puts) => {
    const r1 = await sendText('查 旧片', 'nc1', 1700000100, 'm-c1');
    if (!r1.includes('回复序号选中') || !r1.includes('[瞬] 旧片')) throw new Error('查结果不对: ' + r1);
    const r2 = await sendText('1', 'nc2', 1700000101, 'm-c2');
    if (!r2.includes('已选中') || !r2.includes('「删」')) throw new Error('选中菜单不对: ' + r2);
    const r3 = await sendText('删', 'nc3', 1700000102, 'm-c3');
    if (!r3.includes('已暂存删除')) throw new Error('删除应暂存: ' + r3);
    const r4 = await sendText('发', 'nc4', 1700000103, 'm-c4');
    if (!r4.includes('删瞬间 《旧片》')) throw new Error('预览应含删瞬间: ' + r4);
    await sendText('确认', 'nc5', 1700000104, 'm-c5');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('删除应成功: ' + JSON.stringify(res));
    const vol = JSON.parse(puts['data/moments-2026.js'].slice(puts['data/moments-2026.js'].indexOf('= [') + 2, puts['data/moments-2026.js'].lastIndexOf(']') + 1));
    if (vol.length !== 1 || vol[0].title === '旧片') throw new Error('旧片应被删除: ' + puts['data/moments-2026.js']);
    if (!puts['data/days-2026.js']) throw new Error('应重算 days-2026');
    const cat = puts['data/catalog.js'];
    if (cat.includes('"旧片"') || !cat.includes('"空枪"')) throw new Error('名录应去掉旧片保留空枪: ' + cat);
    if (!puts['data/watch-meta.js'].includes('"total":2')) throw new Error('meta total=2: ' + puts['data/watch-meta.js']);
  });
});

/* 36. 查 → 选中文章 → 删 → 确认（正文文件一并删除） */
await check('CRUD：查→选中文章→删→确认（正文文件删除）', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
    'data/posts.js': '// 列表\nwindow.POSTS = ' + JSON.stringify([{ slug: 'old', title: '旧文一篇', date: '2026-01-01', categories: [], tags: [], cover: '', excerpt: 'x' }]) + ';\n',
  }, {}, async (puts, deleted) => {
    await sendText('查 旧文一篇', 'nc6', 1700000110, 'm-c6');
    await sendText('1', 'nc7', 1700000111, 'm-c7');
    await sendText('删', 'nc8', 1700000112, 'm-c8');
    await sendText('发', 'nc9', 1700000113, 'm-c9');
    await sendText('确认', 'nc10', 1700000114, 'm-c10');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('删除应成功: ' + JSON.stringify(res));
    const list = JSON.parse(puts['data/posts.js'].slice(puts['data/posts.js'].indexOf('['), puts['data/posts.js'].lastIndexOf(']') + 1));
    if (list.length !== 0) throw new Error('文章应被删空: ' + puts['data/posts.js']);
    if (!deleted.includes('data/content/old.js')) throw new Error('正文文件应删除: ' + JSON.stringify(deleted));
  });
});

/* 36b. 中文 slug 的正文文件必须写成原始文件名（不能 %XX 转义），否则前台详情页取不到 */
await check('正文文件路径：中文 slug 用原始名，不做 %XX 转义', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
    'data/posts.js': '// 列表\nwindow.POSTS = [];\n',
  }, {}, async (puts) => {
    await sendText('文\n中文标题测试\n正文第一段', 'nz1', 1700000900, 'm-z1');
    await sendText('发', 'nz2', 1700000901, 'm-z2');
    await sendText('确认', 'nz3', 1700000902, 'm-z3');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('发布应成功: ' + JSON.stringify(res));
    const key = Object.keys(puts).find((k) => k.startsWith('data/content/'));
    if (key !== 'data/content/中文标题测试.js') throw new Error('正文路径应为原始 slug，实际: ' + JSON.stringify(Object.keys(puts)));
    if (/%[0-9A-F]{2}/i.test(key)) throw new Error('正文路径不应出现 %XX 转义: ' + key);
    if (!puts[key].includes('window.POST_CONTENT["中文标题测试"]')) throw new Error('正文文件内容键不对: ' + puts[key].slice(0, 120));
  });
});

/* 37. 改瞬间：文案（图保留）+ 改日期跨年 */
await check('CRUD：改瞬间文案（图保留）+ 改日期跨年（双卷+manifest 重写）', async () => {
  await env.KV.put('pending', '[]');
  const FIX = {
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {"2026":["旧片"],"2015":["老片A"]};\n',
    'data/moments.js': '// manifest\nwindow.MOMENTS_YEARS = ["2026","2015"];\n',
    'data/moments-2026.js': '// 2026卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2026"] = ' + JSON.stringify([{ date: '2026/05/01 10:00:00', content: '<p style="">旧片 · 90 分钟</p><p style="">原文案</p><div class="moment-imgs"><img src="https://image.tmdb.org/t/p/w500/p.jpg"></div>', type: 'movie', kind: 'movie', title: '旧片', runtime: 90, poster: '' }]) + ';\n',
    'data/moments-2015.js': '// 2015卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2015"] = ' + JSON.stringify([M('2015/03/01 10:00:00', '老片A')]) + ';\n',
  };
  await withMock(FIX, {}, async (puts) => {
    // 改文案
    await sendText('查 旧片', 'nc11', 1700000120, 'm-c11');
    await sendText('1', 'nc12', 1700000121, 'm-c12');
    await sendText('改', 'nc13', 1700000122, 'm-c13');
    const r = await sendText('新文案第一行\n第二行', 'nc14', 1700000123, 'm-c14');
    if (!r.includes('已暂存改文案')) throw new Error('改文案应暂存: ' + r);
    // 改日期（同一条，跨年）
    await sendText('查 旧片', 'nc15', 1700000124, 'm-c15');
    await sendText('1', 'nc16', 1700000125, 'm-c16');
    await sendText('改', 'nc17', 1700000126, 'm-c17');
    const r2 = await sendText('改日期 2015-06-01', 'nc18', 1700000127, 'm-c18');
    if (!r2.includes('已暂存改日期')) throw new Error('改日期应暂存: ' + r2);
    await sendText('发', 'nc19', 1700000128, 'm-c19');
    await sendText('确认', 'nc20', 1700000129, 'm-c20');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('修改应成功: ' + JSON.stringify(res));
    // 2026 卷应空（唯一条目改到 2015），manifest 只剩 2015
    const vol26 = JSON.parse(puts['data/moments-2026.js'].slice(puts['data/moments-2026.js'].indexOf('= [') + 2, puts['data/moments-2026.js'].lastIndexOf(']') + 1));
    if (vol26.length !== 0) throw new Error('2026 卷应空: ' + puts['data/moments-2026.js']);
    const vol15 = JSON.parse(puts['data/moments-2015.js'].slice(puts['data/moments-2015.js'].indexOf('= [') + 2, puts['data/moments-2015.js'].lastIndexOf(']') + 1));
    const moved = vol15.find((m) => m.title === '旧片');
    if (!moved) throw new Error('旧片应移到 2015 卷: ' + puts['data/moments-2015.js']);
    if (!moved.date.startsWith('2015/06/01')) throw new Error('日期应改: ' + moved.date);
    if (!moved.content.includes('新文案第一行') || moved.content.includes('原文案')) throw new Error('文案应替换: ' + moved.content);
    if (!moved.content.includes('moment-imgs') || !moved.content.includes('w500/p.jpg')) throw new Error('图片应保留: ' + moved.content);
    if (!moved.content.includes('旧片 · 90 分钟')) throw new Error('片名行应保留: ' + moved.content);
    const mf = puts['data/moments.js'];
    if (!mf || !mf.includes('["2015"]')) throw new Error('manifest 应去掉 2026: ' + (mf || '未写'));
    if (!puts['data/days-2026.js'].includes('{}')) throw new Error('2026 days 应清空');
  });
});

/* 38. 改文章正文 */
await check('CRUD：改文章正文（只重写正文文件）', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
    'data/posts.js': '// 列表\nwindow.POSTS = ' + JSON.stringify([{ slug: 'old', title: '旧文一篇', date: '2026-01-01', categories: [], tags: [], cover: '', excerpt: 'x' }]) + ';\n',
  }, {}, async (puts) => {
    await sendText('查 旧文一篇', 'nc21', 1700000130, 'm-c21');
    await sendText('1', 'nc22', 1700000131, 'm-c22');
    await sendText('改', 'nc23', 1700000132, 'm-c23');
    const r = await sendText('## 新标题\n新正文', 'nc24', 1700000133, 'm-c24');
    if (!r.includes('已暂存修改正文')) throw new Error('改正文应暂存: ' + r);
    await sendText('发', 'nc25', 1700000134, 'm-c25');
    await sendText('确认', 'nc26', 1700000135, 'm-c26');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('修改应成功: ' + JSON.stringify(res));
    const c = puts['data/content/old.js'];
    if (!c || !c.includes('POST_CONTENT["old"]') || !c.includes('新标题')) throw new Error('正文应重写: ' + (c || '未写'));
    if (puts['data/posts.js']) throw new Error('列表不应重写');
  });
});

/* 39. 待办：增（TMDB 候选/日常兜底）、列表、完成（查重→强完）、废弃（不删除） */
await check('CRUD：待办 增查完废（完成同步生成瞬间+查重拦截→强完）', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {"2025":["星际穿越"]};\n',
    'data/todos.js': '// 待办\nwindow.TODOS = ' + JSON.stringify([
      { id: 't1', kind: 'movie', title: '星际穿越', note: '', poster: '', runtime: 169, createdAt: '2026-10-31 12:00:00', done: false, doneAt: null },
      { id: 't2', kind: 'note', title: '', note: '旧日常', poster: '', runtime: 0, createdAt: '2026-10-30 12:00:00', done: false, doneAt: null },
    ]) + ';\n',
    'data/moments.js': '// manifest\nwindow.MOMENTS_YEARS = ["2025"];\n',
    'data/moments-2025.js': '// 2025卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2025"] = ' + JSON.stringify([M('2025/11/10 10:00:00', '星际穿越')]) + ';\n',
  }, {}, async (puts) => {
    // 日常兜底：搜不到电影/图书 → 日常待办
    const r1 = await sendText('待办\n明天修电脑', 'nc27', 1700000140, 'm-c27');
    if (!r1.includes('已暂存日常待办')) throw new Error('日常待办: ' + r1);
    // 列表
    const r2 = await sendText('待办列表', 'nc28', 1700000141, 'm-c28');
    if (!r2.includes('星际穿越') || !r2.includes('旧日常')) throw new Error('待办列表: ' + r2);
    // 完 1：查重命中 → 拦截
    const r3 = await sendText('完 1', 'nc29', 1700000142, 'm-c29');
    if (!r3.includes('已有记录') || !r3.includes('强完')) throw new Error('完成应查重拦截: ' + r3);
    // 强完 1：放行，暂存 done + 瞬间
    const r4 = await sendText('强完 1', 'nc30', 1700000143, 'm-c30');
    if (!r4.includes('已暂存完成') || !r4.includes('瞬间')) throw new Error('强完应暂存: ' + r4);
    // 改待办 2（序号按未完成列表：1=星际穿越 2=旧日常）→ 废（废弃即归档，不删除）
    const r5 = await sendText('改待办 2', 'nc31', 1700000144, 'm-c31');
    if (!r5.includes('已选中') || !r5.includes('「废」')) throw new Error('改待办应选中并列废选项: ' + r5);
    const r5b = await sendText('废', 'nc31b', 1700000144, 'm-c31b');
    if (!r5b.includes('已暂存废弃')) throw new Error('废弃: ' + r5b);
    await sendText('发', 'nc32', 1700000145, 'm-c32');
    const pv = await sendText('确认', 'nc33', 1700000146, 'm-c33');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok || res.n !== 4) throw new Error('应发布4条(日常+done+瞬间+drop): ' + pv + ' | ' + JSON.stringify(res));
    const todos = JSON.parse(puts['data/todos.js'].slice(puts['data/todos.js'].indexOf('['), puts['data/todos.js'].lastIndexOf(']') + 1));
    const t1 = todos.find((t) => t.id === 't1');
    if (!t1 || !t1.done || !t1.doneAt) throw new Error('t1 应标记完成: ' + puts['data/todos.js']);
    const t2 = todos.find((t) => t.id === 't2');
    if (!t2 || !t2.dropped || !t2.droppedAt) throw new Error('t2 应标记废弃: ' + JSON.stringify(t2));
    if (!todos.some((t) => t.note === '明天修电脑')) throw new Error('新日常应在: ' + puts['data/todos.js']);
    /* 完成瞬间日期=今天 → 落在 2026 卷（2025 卷无变化不重写） */
    if (puts['data/moments-2025.js']) throw new Error('2025 卷不应重写');
    const vol26 = puts['data/moments-2026.js'];
    if (!vol26 || JSON.parse(vol26.slice(vol26.indexOf('= [') + 2, vol26.lastIndexOf(']') + 1)).filter((m) => m.title === '星际穿越').length !== 1) throw new Error('应新增一条星际穿越瞬间(2026卷): ' + (vol26 || '未写'));
    const cat2 = puts['data/catalog.js'];
    if (!cat2 || (cat2.match(/星际穿越/g) || []).length !== 2) throw new Error('名录应含两条星际穿越(2025+2026): ' + (cat2 || '未写'));
  });
});

/* 40. 待办：待办电影 搜TMDB候选 → 序号选中入待办；待办 日常直接记；待办书 直接新增 */
await check('CRUD：待办电影 搜TMDB候选 → 选中入清单；待办/待办书 直接新增', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/todos.js': '// 待办\nwindow.TODOS = [];\n',
  }, {
    tmdbSearch: [{ media_type: 'movie', id: 123, title: '沙丘', release_date: '2021-10-22' }],
    tmdbDetail: { title: '沙丘', runtime: 155, poster_path: '/dune.jpg' },
  }, async (puts) => {
    const r0 = await sendText('待办\n明天修电脑', 'nc60', 1700000149, 'm-c60');
    if (!r0.includes('已暂存日常待办') || !r0.includes('明天修电脑')) throw new Error('待办日常应直接记: ' + r0);
    const r1 = await sendText('待办电影 沙丘', 'nc61', 1700000150, 'm-c61');
    if (!r1.includes('回复序号加入待办')) throw new Error('应出候选: ' + r1);
    const r2 = await sendText('1', 'nc62', 1700000151, 'm-c62');
    if (!r2.includes('已暂存待办') || !r2.includes('沙丘')) throw new Error('选中应入待办: ' + r2);
    const r2b = await sendText('待办书 逻辑哲学论', 'nc63', 1700000151, 'm-c63');
    if (!r2b.includes('已暂存图书待办')) throw new Error('待办书应直接新增: ' + r2b);
    await sendText('发', 'nc64', 1700000152, 'm-c64');
    await sendText('确认', 'nc65', 1700000153, 'm-c65');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('应发布: ' + JSON.stringify(res));
    const todos = JSON.parse(puts['data/todos.js'].slice(puts['data/todos.js'].indexOf('['), puts['data/todos.js'].lastIndexOf(']') + 1));
    const t = todos.find((x) => x.kind === 'movie');
    if (!t || t.title !== '沙丘' || t.runtime !== 155 || t.done !== false || t.tmdbId !== 123) throw new Error('待办字段不对: ' + JSON.stringify(t));
    const b = todos.find((x) => x.kind === 'book');
    if (!b || b.title !== '逻辑哲学论' || b.poster) throw new Error('待办书应无刮削直接新增: ' + JSON.stringify(b));
    if (!todos.some((x) => x.note === '明天修电脑')) throw new Error('日常待办应在: ' + JSON.stringify(todos));
  });
});

/* 41. 图片墙：查 → 删 */
await check('CRUD：图片墙查删', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
    'data/photos.js': '// 图片墙\nwindow.PHOTO_WALL = ' + JSON.stringify([{ src: 'https://img.example.com/file/a.jpg', note: '海边', date: '2026-10-01' }, { src: 'https://img.example.com/file/b.jpg', note: '', date: '2026-10-02' }]) + ';\n',
  }, {}, async (puts) => {
    const r1 = await sendText('查 海边', 'nc38', 1700000160, 'm-c38');
    if (!r1.includes('[图]')) throw new Error('应搜到图片: ' + r1);
    await sendText('1', 'nc39', 1700000161, 'm-c39');
    const r3 = await sendText('删', 'nc41', 1700000163, 'm-c41');
    if (!r3.includes('已暂存删除')) throw new Error('删除应暂存: ' + r3);
    await sendText('发', 'nc42', 1700000164, 'm-c42');
    await sendText('确认', 'nc43', 1700000165, 'm-c43');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('应发布: ' + JSON.stringify(res));
    const arr = JSON.parse(puts['data/photos.js'].slice(puts['data/photos.js'].indexOf('['), puts['data/photos.js'].lastIndexOf(']') + 1));
    if (arr.length !== 1 || arr[0].note === '海边') throw new Error('海边应被删: ' + puts['data/photos.js']);
  });
});

/* 42. 删 关键词：唯一命中直接暂存（省两步）；多命中序号选中 → 再回「删」确认（防误选） */
await check('CRUD：删 关键词（唯一命中直达 / 多命中需确认）', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {"2026":["旧片","空枪"],"2015":["老片A"]};\n',
    'data/moments.js': '// manifest\nwindow.MOMENTS_YEARS = ["2026","2015"];\n',
    'data/moments-2026.js': '// 2026卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2026"] = ' + JSON.stringify([M('2026/05/01 10:00:00', '旧片'), M('2026/04/01 10:00:00', '空枪')]) + ';\n',
    'data/moments-2015.js': '// 2015卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2015"] = ' + JSON.stringify([M('2015/03/01 10:00:00', '老片A')]) + ';\n',
  }, {}, async (puts) => {
    // 唯一命中：直接暂存删除
    const r1 = await sendText('删 老片A', 'nc44', 1700000170, 'm-c44');
    if (!r1.includes('已暂存删除') || !r1.includes('老片A')) throw new Error('唯一命中应直达删除: ' + r1);
    // 多命中：回序号只是选中，需再回「删」才暂存（「片」命中 旧片/老片A 两条）
    const r2 = await sendText('删 片', 'nc45', 1700000171, 'm-c45');
    if (!r2.includes('回复序号') || !r2.includes('找到 2 条')) throw new Error('多命中应列候选: ' + r2);
    const r3 = await sendText('2', 'nc46', 1700000172, 'm-c46');
    if (!r3.includes('已选中') || !r3.includes('老片A') || !r3.includes('「删」')) throw new Error('选中应只进菜单不删除: ' + r3);
    const r4 = await sendText('删', 'nc47', 1700000173, 'm-c47');
    if (!r4.includes('已暂存删除') || !r4.includes('老片A')) throw new Error('确认后应删除: ' + r4);
    // 定向搜索
    const r5 = await sendText('查瞬 旧片', 'nc48', 1700000174, 'm-c48');
    if (!r5.includes('[瞬] 旧片') || r5.includes('[文]')) throw new Error('查瞬应只出瞬间: ' + r5);
  });
});

/* 43. 改待办：序号选中 → 完/废；查待办=未完成列表（可关键词筛选）/ 查待办完成=已完成列表；改待办 关键词 三态兜底 */
await check('CRUD：改待办 完/废/开 + 查待办/查待办完成 列表', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/todos.js': '// 待办\nwindow.TODOS = ' + JSON.stringify([
      { id: 'tA', kind: 'note', title: '', note: '周末大扫除', poster: '', runtime: 0, createdAt: '2026-10-01 12:00:00', done: false, doneAt: null },
      { id: 'tB', kind: 'book', title: '旧书', note: '', poster: '', runtime: 0, createdAt: '2026-09-01 12:00:00', done: true, doneAt: '2026-10-02 12:00:00' },
      { id: 'tC', kind: 'movie', title: '改看的电影B', note: '', poster: '', runtime: 0, createdAt: '2026-08-01 12:00:00', done: false, doneAt: null, dropped: true, droppedAt: '2026-08-02 21:00:00' },
    ]) + ';\n',
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
  }, {}, async (puts) => {
    // 查待办 = 未完成列表（不含已完成/已废弃）
    const r1 = await sendText('查待办', 'nc50', 1700000180, 'm-c50');
    if (!r1.includes('大扫除') || r1.includes('旧书') || r1.includes('改看的电影B')) throw new Error('查待办应只列未完成: ' + r1);
    // 查待办 关键词筛选；未完成没有 → 提示去改待办搜
    const r1b = await sendText('查待办 大扫除', 'nc50b', 1700000180, 'm-c50b');
    if (!r1b.includes('大扫除')) throw new Error('查待办筛选应命中: ' + r1b);
    const r1c = await sendText('查待办 旧书', 'nc50c', 1700000180, 'm-c50c');
    if (!r1c.includes('没找到') || !r1c.includes('改待办')) throw new Error('查待办未完成没有应提示: ' + r1c);
    // 查待办完成 = 已完成列表
    const r1d = await sendText('查待办完成', 'nc50d', 1700000180, 'm-c50d');
    if (!r1d.includes('旧书') || r1d.includes('大扫除')) throw new Error('查待办完成应列已完成: ' + r1d);
    // 改待办 序号 → 完（日常，无查重）
    const r2 = await sendText('改待办 1', 'nc51', 1700000181, 'm-c51');
    if (!r2.includes('大扫除') || !r2.includes('「完」') || !r2.includes('「废」')) throw new Error('改待办应选中并列完/废: ' + r2);
    const r3 = await sendText('完', 'nc52', 1700000182, 'm-c52');
    if (!r3.includes('已暂存完成') || !r3.includes('大扫除')) throw new Error('完应暂存: ' + r3);
    // 改待办 关键词（已完成兜底搜到）→ 开 恢复
    const r4 = await sendText('改待办 旧书', 'nc53', 1700000183, 'm-c53');
    if (!r4.includes('旧书') || !r4.includes('已完成')) throw new Error('改待办应搜到已完成: ' + r4);
    // 改待办 关键词（已废弃兜底搜到）→ 开 恢复（同时清 dropped）
    const r6 = await sendText('改待办 改看的电影B', 'nc57', 1700000187, 'm-c57');
    if (!r6.includes('改看的电影B') || !r6.includes('已废弃')) throw new Error('改待办应搜到已废弃: ' + r6);
    const r6b = await sendText('开', 'nc58', 1700000188, 'm-c58');
    if (!r6b.includes('已暂存恢复未完成')) throw new Error('开应暂存恢复: ' + r6b);
    // 推送并校验落盘：完(大扫除) + 恢复(电影B)
    await sendText('发', 'nc55', 1700000185, 'm-c55');
    await sendText('确认', 'nc56', 1700000186, 'm-c56');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok) throw new Error('应发布: ' + JSON.stringify(res));
    const todos = JSON.parse(puts['data/todos.js'].slice(puts['data/todos.js'].indexOf('['), puts['data/todos.js'].lastIndexOf(']') + 1));
    const a = todos.find((x) => x.id === 'tA');
    const c = todos.find((x) => x.id === 'tC');
    if (!a || a.done !== true || !a.doneAt) throw new Error('tA 应完成: ' + JSON.stringify(todos));
    if (!c || c.dropped !== false || c.droppedAt !== null || c.done !== false) throw new Error('tC 应恢复未完成(清dropped): ' + JSON.stringify(todos));
  });
});

/* 44. 分页：查待办 15/页 + 下页；查瞬 多结果跨页 + 全局序号选中 */
await check('分页：下页翻页 + 跨页序号选中', async () => {
  await env.KV.put('pending', '[]');
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, kind: 'note', title: '', note: '日常事项' + (i + 1), poster: '', runtime: 0, createdAt: '2026-10-01 12:00:00', done: false, doneAt: null }));
  await withMock({
    'data/todos.js': '// 待办\nwindow.TODOS = ' + JSON.stringify(many) + ';\n',
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {"2026":["瞬变","空枪"]};\n',
    'data/moments.js': '// manifest\nwindow.MOMENTS_YEARS = ["2026"];\n',
    'data/moments-2026.js': '// 2026卷\nwindow.MOMENTS_PARTS = window.MOMENTS_PARTS || {};\nwindow.MOMENTS_PARTS["2026"] = ' + JSON.stringify([M('2026/05/01 10:00:00', '瞬变'), M('2026/04/01 10:00:00', '空枪')]) + ';\n',
    'data/posts.js': '// 文章\nwindow.POSTS = [];\n',
    'data/photos.js': '// 图片\nwindow.PHOTOS = [];\n',
  }, {}, async () => {
    // 查待办：20 条 → 第 1 页 15 条 + 翻页提示
    const r1 = await sendText('查待办', 'nc80', 1700000190, 'm-c80');
    if (!r1.includes('15. ✍️ 日常事项15') || !r1.includes('第 1/2 页') || !r1.includes('下页')) throw new Error('第1页应15条+翻页提示: ' + r1);
    // 下页：后 5 条，全局序号 16~20
    const r2 = await sendText('下页', 'nc81', 1700000191, 'm-c81');
    if (!r2.includes('16. ✍️ 日常事项16') || !r2.includes('第 2/2 页') || !r2.includes('已到末页')) throw new Error('下页应显示16~20: ' + r2);
    // 再下页：已在末页
    const r3 = await sendText('下页', 'nc82', 1700000192, 'm-c82');
    if (!r3.includes('已到末页')) throw new Error('末页再下页应提示: ' + r3);
    // 查瞬：2 条 → 单页不显示翻页提示；结果存 conv，跨页序号=全局序号
    const r4 = await sendText('查瞬 瞬变', 'nc83', 1700000193, 'm-c83');
    if (!r4.includes('[瞬] 瞬变') || r4.includes('下页」看后面')) throw new Error('单页结果不应有翻页提示: ' + r4);
    await sendText('1', 'nc84', 1700000194, 'm-c84');
    const r5 = await sendText('删', 'nc85', 1700000195, 'm-c85');
    if (!r5.includes('已暂存删除') || !r5.includes('瞬变')) throw new Error('跨页序号选中应可删: ' + r5);
    // 带类型字但不带空格 → 空格提示
    const r6 = await sendText('查瞬空枪', 'nc86', 1700000196, 'm-c86');
    if (!r6.includes('空格')) throw new Error('连写应有空格提示: ' + r6);
  });
});

/* 主站：查待办 序号选中 → 完；待办完/待办强完 改名直达 */
await check('CRUD：查待办 序号选中 → 完；待办完/待办强完 直达', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/todos.js': '// 待办\nwindow.TODOS = ' + JSON.stringify([
      { id: 'tX', kind: 'note', title: '', note: '任务甲', poster: '', runtime: 0, createdAt: '2026-10-01 12:00:00', done: false, doneAt: null },
      { id: 'tY', kind: 'note', title: '', note: '任务乙', poster: '', runtime: 0, createdAt: '2026-10-02 12:00:00', done: false, doneAt: null },
    ]) + ';\n',
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
  }, {}, async () => {
    // 查待办 → 序号 1 选中 → 完
    const r1 = await sendText('查待办', 'nd90', 1700000230, 'm-d90');
    if (!r1.includes('回复序号选中')) throw new Error('查待办应可选中: ' + r1);
    const r2 = await sendText('1', 'nd91', 1700000231, 'm-d91');
    if (!r2.includes('任务甲') || !r2.includes('「完」')) throw new Error('序号1应选中任务甲: ' + r2);
    const r3 = await sendText('完', 'nd92', 1700000232, 'm-d92');
    if (!r3.includes('已暂存完成')) throw new Error('完应暂存: ' + r3);
    await env.KV.put('pending', '[]');
    // 待办完 1 直达（改名兼容老 完 N）
    const r4 = await sendText('待办完 1', 'nd93', 1700000233, 'm-d93');
    if (!r4.includes('已暂存完成') || !r4.includes('任务甲')) throw new Error('待办完应直达暂存: ' + r4);
    await env.KV.put('pending', '[]');
    const r5 = await sendText('完 2', 'nd94', 1700000234, 'm-d94');
    if (!r5.includes('已暂存完成') || !r5.includes('任务乙')) throw new Error('老写法 完 2 应兼容: ' + r5);
  });
});

/* 搜索容错：源请求失败要如实报错，不能假报「没找到」（真实事故：查 间谍 因 catalog 拉失败静默返回空） */
await check('搜索：源失败报「请求失败」而非「没找到」', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {"2026":["瞬变"]};\n',
  }, {}, async () => {
    const r = await sendText('查 不存在的词', 'ne1', 1700000240, 'm-e1');
    if (!r.includes('搜索请求失败')) throw new Error('源失败应报请求失败: ' + r);
  });
  // 源齐全但真没命中 → 正常「没找到」
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {"2026":["瞬变"]};\n',
    'data/posts.js': '// 文章\nwindow.POSTS = [];\n',
    'data/photos.js': '// 图片\nwindow.PHOTOS = [];\n',
    'data/todos.js': '// 待办\nwindow.TODOS = [];\n',
  }, {}, async () => {
    const r2 = await sendText('查 不存在的词', 'ne2', 1700000241, 'm-e2');
    if (!r2.includes('没找到') || r2.includes('请求失败')) throw new Error('源齐全应报没找到: ' + r2);
  });
});

/* 图片地址展示：仓库相对路径拼站点域名（可点开），图床绝对链接原样返回；删除仍比对原始 src */
await check('查图：相对路径拼站点域名 + 图床链接原样', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
    'data/posts.js': '// 文章\nwindow.POSTS = [];\n',
    'data/todos.js': '// 待办\nwindow.TODOS = [];\n',
    'data/photos.js': '// 图片\nwindow.PHOTO_WALL = ' + JSON.stringify([
      { src: 'photos/gallery/20261029-s5wmzm.webp', note: '仓库图', date: '2026-10-29' },
      { src: 'https://img.example.com/file/MhZ7DD', note: '图床图', date: '2026-10-30' },
    ]) + ';\n',
  }, {}, async () => {
    const r1 = await sendText('查图 仓库图', 'nf1', 1700000250, 'm-f1');
    if (!r1.includes('https://your-site.pages.dev/photos/gallery/20261029-s5wmzm.webp')) throw new Error('相对路径应拼域名: ' + r1);
    // 选中相对路径那张 → 删：展示用 URL，暂存里必须存原始 src（否则发布时定位校验失败）
    await sendText('1', 'nf3', 1700000252, 'm-f3');
    const r4 = await sendText('删', 'nf4', 1700000253, 'm-f4');
    if (!r4.includes('已暂存删除')) throw new Error('应暂存删除: ' + r4);
    const pend = JSON.parse(await env.KV.get('pending') || '[]');
    const op = pend.find((o) => o.file === 'phdel');
    if (!op || op.item.src !== 'photos/gallery/20261029-s5wmzm.webp') throw new Error('暂存应存原始 src: ' + JSON.stringify(op));
    const r2 = await sendText('查图 图床图', 'nf2', 1700000251, 'm-f2');
    if (!r2.includes('https://img.example.com/file/MhZ7DD') || r2.includes('your-site.pages.dev')) throw new Error('图床链接应原样: ' + r2);
  });
});

/* 查图按日期：专用查图认 10-29 / 20261029；全库搜不启用（否则「查 2026」被整年的图灌满） */
await check('查图：可按日期搜，全库搜不启用', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/catalog.js': '// 名录\nwindow.MOMENT_CATALOG = {};\n',
    'data/posts.js': '// 文章\nwindow.POSTS = [];\n',
    'data/todos.js': '// 待办\nwindow.TODOS = [];\n',
    'data/photos.js': '// 图片\nwindow.PHOTO_WALL = ' + JSON.stringify([
      { src: 'https://img.example.com/file/AAA111', note: '', date: '2026-10-29' },
      { src: 'https://img.example.com/file/BBB222', note: '', date: '2026-11-02' },
    ]) + ';\n',
  }, {}, async () => {
    const r1 = await sendText('查图 10-29', 'np1', 1700000500, 'm-q1');
    if (!r1.includes('AAA111') || r1.includes('BBB222')) throw new Error('按日期应只命中 10-29: ' + r1);
    const r2 = await sendText('查图 20261029', 'np2', 1700000501, 'm-q2');
    if (!r2.includes('AAA111')) throw new Error('紧凑日期也应命中: ' + r2);
    const r3 = await sendText('查 10-29', 'np3', 1700000502, 'm-q3');
    if (r3.includes('AAA111')) throw new Error('全库搜不应按日期匹配图片: ' + r3);
  });
});

/* 置顶：顶 关键词（文章）/ 选中图片回「顶」→ 发布后移到数组最前；新内容仍插最前 */
await check('置顶：顶 关键词 / 图片选中回「顶」→ 数组最前', async () => {
  await env.KV.put('pending', '[]');
  const posts = [
    { slug: 'p1', title: '最新一篇', date: '2026-10-30', excerpt: '' },
    { slug: 'p2', title: '老文章甲', date: '2026-01-01', excerpt: '' },
    { slug: 'p3', title: '老文章乙', date: '2026-02-01', excerpt: '' },
  ];
  await withMock({
    'data/posts.js': '// 文章\nwindow.POSTS = ' + JSON.stringify(posts) + ';\n',
    'data/photos.js': '// 图片\nwindow.PHOTO_WALL = ' + JSON.stringify([
      { src: 'https://img.example.com/file/N1', note: '', date: '2026-10-30' },
      { src: 'https://img.example.com/file/O1', note: '', date: '2026-10-20' },
    ]) + ';\n',
  }, {}, async (puts) => {
    // 顶 关键词：唯一命中 → 直接暂存
    const r1 = await sendText('顶 老文章甲', 'ng1', 1700000260, 'm-g1');
    if (!r1.includes('已暂存置顶') || !r1.includes('老文章甲')) throw new Error('应暂存置顶: ' + r1);
    // 预览里能看到置顶
    const r2 = await sendText('发', 'ng2', 1700000261, 'm-g2');
    if (!r2.includes('文章置顶')) throw new Error('预览应有置顶: ' + r2);
    await sendText('确认', 'ng3', 1700000262, 'm-g3');
    const arr = JSON.parse(puts['data/posts.js'].slice(puts['data/posts.js'].indexOf('['), puts['data/posts.js'].lastIndexOf(']') + 1));
    if (arr[0].slug !== 'p2') throw new Error('顶完应在最前: ' + JSON.stringify(arr.map((p) => p.slug)));
    if (arr.length !== 3) throw new Error('置顶不应增删条目: ' + arr.length);

    // 图片：查图 → 选中 → 顶
    await env.KV.put('pending', '[]');
    const r3 = await sendText('查图 O1', 'ng4', 1700000263, 'm-g4');
    if (!r3.includes('[图]')) throw new Error('应搜到图片: ' + r3);
    await sendText('1', 'ng5', 1700000264, 'm-g5');
    const r4 = await sendText('顶', 'ng6', 1700000265, 'm-g6');
    if (!r4.includes('已暂存置顶')) throw new Error('图片应可置顶: ' + r4);
    await sendText('发', 'ng7', 1700000266, 'm-g7');
    await sendText('确认', 'ng8', 1700000267, 'm-g8');
    const ph = JSON.parse(puts['data/photos.js'].slice(puts['data/photos.js'].indexOf('['), puts['data/photos.js'].lastIndexOf(']') + 1));
    if (ph[0].src !== 'https://img.example.com/file/O1') throw new Error('图片顶完应在最前: ' + JSON.stringify(ph.map((p) => p.src)));
  });
});

/* 保持顶：确认顶 → 本批新增排在原第 1 条之后；默认仍插最前 */
await check('保持顶：确认顶 → 新文章排在原第 1 篇之后', async () => {
  const posts = [
    { slug: 'a1', title: '文章一', date: '2026-10-01', excerpt: '' },
    { slug: 'a2', title: '文章二', date: '2026-09-01', excerpt: '' },
    { slug: 'a3', title: '文章三', date: '2026-08-01', excerpt: '' },
  ];
  const readPosts = (t) => JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
  await withMock({ 'data/posts.js': '// 文章\nwindow.POSTS = ' + JSON.stringify(posts) + ';\n' }, {}, async (puts) => {
    await env.KV.put('pending', '[]');
    const r0 = await sendText('文\n文章五\n正文', 'nk1', 1700000300, 'm-k1');
    if (!r0.includes('已暂存文章《文章五》')) throw new Error('应暂存文章: ' + r0);
    const r1 = await sendText('发', 'nk2', 1700000301, 'm-k2');
    if (!r1.includes('确认顶')) throw new Error('含新增时预览应有「保持顶」提示: ' + r1);
    await sendText('确认顶', 'nk3', 1700000302, 'm-k3');
    const t1 = readPosts(puts['data/posts.js']).map((p) => p.title).join(',');
    if (t1 !== '文章一,文章五,文章二,文章三') throw new Error('保持顶后应为 文章一→文章五→…: ' + t1);

    // 默认（不带后缀）：新内容仍插最前
    await env.KV.put('pending', '[]');
    await sendText('文\n文章六\n正文', 'nk4', 1700000303, 'm-k4');
    await sendText('发', 'nk5', 1700000304, 'm-k5');
    await sendText('确认', 'nk6', 1700000305, 'm-k6');
    const t2 = readPosts(puts['data/posts.js']).map((p) => p.title).join(',');
    if (t2 !== '文章六,文章一,文章二,文章三') throw new Error('默认应插最前: ' + t2);
  });
});

/* 回归（2026-11-03 审计 B1）：同批「发文 + 置顶/删文」。
   posts 分支与 pdel/pin 分支曾各自读发布前快照再各自写回 data/posts.js，
   后写覆盖前写 → 本批新文章丢失。现合并为一个分支读一次写一次。 */
await check('同批发文+置顶：新文章不被旧快照覆盖', async () => {
  const posts = [
    { slug: 'a1', title: '文章一', date: '2026-10-01', excerpt: '' },
    { slug: 'a2', title: '文章二', date: '2026-09-01', excerpt: '' },
    { slug: 'a3', title: '文章三', date: '2026-08-01', excerpt: '' },
  ];
  const readPosts = (t) => JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
  await withMock({ 'data/posts.js': '// 文章\nwindow.POSTS = ' + JSON.stringify(posts) + ';\n' }, {}, async (puts, deleted) => {
    await env.KV.put('pending', '[]');
    await sendText('文\n文章五\n正文', 'nrb1', 1700000320, 'm-rb1');
    const rp = await sendText('顶 文章二', 'nrb2', 1700000321, 'm-rb2');
    if (!rp.includes('暂存')) throw new Error('顶唯一命中应直达暂存: ' + rp);
    await sendText('发', 'nrb3', 1700000322, 'm-rb3');
    const reply = await sendText('确认', 'nrb4', 1700000323, 'm-rb4');
    const res = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res || !res.ok || res.n !== 2) throw new Error('应成功发布2条: ' + reply + ' | ' + JSON.stringify(res));
    const titles = readPosts(puts['data/posts.js']).map((p) => p.title).join(',');
    if (titles !== '文章二,文章五,文章一,文章三') throw new Error('应含新文章且置顶最前: ' + titles);
    if (!puts['data/content/文章五.js']) throw new Error('新文章正文文件应写入');

    /* 同批 文+删：删除发生在合并后的数组上，新文章不受影响 */
    await env.KV.put('pending', '[]');
    await sendText('文\n文章六\n正文', 'nrb5', 1700000324, 'm-rb5');
    await sendText('删 文章三', 'nrb6', 1700000325, 'm-rb6');
    await sendText('发', 'nrb7', 1700000326, 'm-rb7');
    const reply2 = await sendText('确认', 'nrb8', 1700000327, 'm-rb8');
    const res2 = JSON.parse(await env.KV.get('pubres:userid-abc') || 'null');
    if (!res2 || !res2.ok || res2.n !== 2) throw new Error('应成功发布2条: ' + reply2 + ' | ' + JSON.stringify(res2));
    const titles2 = readPosts(puts['data/posts.js']).map((p) => p.title).join(',');
    if (titles2 !== '文章六,文章一,文章二') throw new Error('应含新文章且删掉旧文: ' + titles2);
    if (!deleted.includes('data/content/a3.js')) throw new Error('被删文章正文应删除: ' + JSON.stringify(deleted));
  });
});

await check('保持顶：图片新增排到原第 1 张之后', async () => {
  const photos = [
    { src: 'https://img.example.com/file/P1', note: '', date: '2026-10-30' },
    { src: 'https://img.example.com/file/P2', note: '', date: '2026-10-20' },
  ];
  await withMock({ 'data/photos.js': '// 图片\nwindow.PHOTO_WALL = ' + JSON.stringify(photos) + ';\n' }, {}, async (puts) => {
    await env.KV.put('pending', '[]');
    await sendText('图\nhttps://img.example.com/file/NEW', 'np1', 1700000320, 'm-p1');
    await sendText('发', 'np2', 1700000321, 'm-p2');
    await sendText('确认顶', 'np3', 1700000322, 'm-p3');
    const t = puts['data/photos.js'];
    const arr = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
    const order = arr.map((p) => p.src.split('/').pop()).join(',');
    if (order !== 'P1,NEW,P2') throw new Error('图片保持顶顺序不对: ' + order);
  });
});

/* 结果为图片时底部提示必须是「删/顶」，不能出现「改」；唯一命中时直接回动词等于选中执行 */
await check('主站：图片结果提示删/顶，且唯一命可直接回「顶」', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/photos.js': '// 图片\nwindow.PHOTO_WALL = ' + JSON.stringify([
      { src: 'https://img.example.com/file/IMGONLY', note: '风景照', date: '2026-10-29' },
    ]) + ';\n',
  }, {}, async () => {
    const r1 = await sendText('查图 风景照', 'nr1', 1700000600, 'm-r1');
    if (r1.includes('「改」修改')) throw new Error('图片结果不该提示「改」: ' + r1);
    if (!r1.includes('顶 1')) throw new Error('图片结果应提示「顶 1」: ' + r1);
    const r2 = await sendText('顶', 'nr2', 1700000601, 'm-r2');
    if (!r2.includes('已暂存置顶')) throw new Error('唯一命中应直接置顶: ' + r2);
  });
});

await check('主站：多命中时直接回动词 → 提示先回序号', async () => {
  await env.KV.put('pending', '[]');
  await withMock({
    'data/posts.js': '// 文章\nwindow.POSTS = ' + JSON.stringify([
      { slug: 'q1', title: '测试甲', date: '2026-10-02', excerpt: '' },
      { slug: 'q2', title: '测试乙', date: '2026-10-01', excerpt: '' },
    ]) + ';\n',
  }, {}, async () => {
    const r1 = await sendText('查文 测试', 'nr3', 1700000602, 'm-r3');
    if (!r1.includes('测试甲')) throw new Error('应搜到两条: ' + r1);
    const r2 = await sendText('顶', 'nr4', 1700000603, 'm-r4');
    if (!r2.includes('先回复序号选中')) throw new Error('多命中应提示先回序号: ' + r2);
  });
});

/* 发布清单出口：清空 = 丢弃全部暂存 + 关闭发布闸门（放最后，避免污染其他用例） */
await check('清空：预览态回清空 → 暂存丢弃 + 闸门关闭', async () => {
  await withMock({ 'data/posts.js': '// 文章\nwindow.POSTS = ' + JSON.stringify([
    { slug: '甲文章', title: '甲文章', date: '2026-10-01', excerpt: '' },
  ]) + ';\n' }, {}, async () => {
    await env.KV.put('pending', '[]');
    await sendText('顶 甲文章', 'nq1', 1700000801, 'm-cl1');
    const prev = await sendText('发', 'nq2', 1700000802, 'm-cl2');
    if (!prev.includes('回「确认」—— 推送到线上')) throw new Error('无新增时确认应按单行写法: ' + prev);
    if (!prev.includes('回「清空」—— 全部丢弃，不可恢复')) throw new Error('无新增时也应给清空出口: ' + prev);
    const r = await sendText('清空', 'nq3', 1700000803, 'm-cl3');
    if (!r.includes('已清空暂存区')) throw new Error('清空回话不对: ' + r);
    const pending = JSON.parse(await env.KV.get('pending'));
    if (pending.length !== 0) throw new Error('清空后暂存应为空: ' + JSON.stringify(pending));
    const gate = await env.KV.get('pubok:userid-abc');
    if (gate) throw new Error('清空后发布闸门应关闭: ' + gate);
  });
});

await check('同标题重发：主站自动加时间戳副标题（不撞 slug、不失败）', async () => {
  const posts = [
    { slug: '测试顶和说明', title: '测试顶和说明', date: '2026-10-31', excerpt: '内容如题' },
    { slug: 'a2', title: '文章二', date: '2026-09-01', excerpt: '' },
  ];
  const readPosts = (t) => JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
  await withMock({ 'data/posts.js': '// 文章\nwindow.POSTS = ' + JSON.stringify(posts) + ';\n' }, {}, async (puts, ctx) => {
    await env.KV.put('pending', '[]');
    const r0 = await sendText('文\n测试顶和说明\n正文重发', 'nt1', 1700000900, 'm-t1');
    if (!r0.includes('已暂存文章《测试顶和说明》')) throw new Error('应暂存文章: ' + r0);
    await sendText('发', 'nt2', 1700000901, 'm-t2');
    await sendText('确认', 'nt3', 1700000902, 'm-t3');
    const arr = readPosts(puts['data/posts.js']);
    if (arr.length !== 3) throw new Error('应新增 1 篇（共 3 篇）: ' + JSON.stringify(arr.map((p) => p.slug)));
    const nw = arr[0];
    if (!/^测试顶和说明-\d{2}-\d{2}-\d{4}$/.test(nw.slug)) throw new Error('重名 slug 应带时间戳后缀: ' + nw.slug);
    if (!/^测试顶和说明 · \d{2}-\d{2} \d{2}:\d{2}$/.test(nw.title)) throw new Error('重名标题应带时间戳副标题: ' + nw.title);
    if (!arr.some((p) => p.slug === '测试顶和说明')) throw new Error('原有同名文章不能被覆盖');
    /* 正文文件必须落在新 slug 上（原始中文名，不 %XX 转义） */
    const cpath = Object.keys(puts).find((k) => k.startsWith('data/content/') && k.includes(nw.slug));
    if (!cpath) throw new Error('新正文文件缺失: ' + Object.keys(puts).join(','));
    if (/data\/content\/%/.test(cpath)) throw new Error('正文路径不应带 %XX: ' + cpath);
  });
});

await check('失败原因补播：推送没送到时，下一条指令开头带原因（只播一次）', async () => {
  await env.KV.put('pending', '[]');
  await env.KV.delete('pubfail:userid-abc');
  await sendText('文\n补播测试文章\n正文', 'bp1', 1700001100, 'm-bp1');
  await sendText('发', 'bp2', 1700001101, 'm-bp2');
  const jobs = [];
  const ctx = { waitUntil: (p) => jobs.push(p) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.github.com')) throw new Error('slug 冲突：补播测试文章 已存在');
    /* 主动推送也失败：模拟应用消息被可信 IP 拦（正是用户这次没收到通知的原因） */
    if (u.includes('cgi-bin/gettoken')) return { ok: true, json: async () => ({ access_token: 'mock', expires_in: 7200 }) };
    if (u.includes('cgi-bin/message/send')) return { ok: true, json: async () => ({ errcode: 60020, errmsg: 'not allow to access from your ip' }) };
    return realFetch(url);
  };
  try {
    const reply = await sendText('确认', 'bp3', 1700001102, 'm-bp3', { ctx });
    if (!reply.includes('已安排发布')) throw new Error('应立即回已安排发布: ' + reply);
    await jobs[0];
  } finally { globalThis.fetch = realFetch; }
  const r2 = await sendText('帮助', 'bp4', 1700001103, 'm-bp4');
  if (!r2.includes('⚠️ 上次发布失败：slug 冲突')) throw new Error('下一条指令应补播失败原因: ' + r2.slice(0, 200));
  if (!r2.includes('【')) throw new Error('补播不能吞掉原本的回复: ' + r2.slice(0, 300));
  const r3 = await sendText('帮助', 'bp5', 1700001104, 'm-bp5');
  if (r3.includes('上次发布失败')) throw new Error('补播只播一次: ' + r3.slice(0, 120));
  await env.KV.put('pending', '[]');
});

/* 45. 同名暂存提醒 + 「发」清单逐条编号 + 撤回 序号 */
await check('同名暂存提醒 / 清单编号 / 撤回 序号（删指定条而非最后一条）', async () => {
  await withMock({}, {}, async () => {
    const r1 = await sendText('文\n同名测试\n正文一', 'dq1', 1700001200, 'm-dq1');
    if (r1.includes('⚠️ 暂存区里已有同名')) throw new Error('第一条不该提醒重名: ' + r1);
    const r2 = await sendText('文\n同名测试\n正文二', 'dq2', 1700001201, 'm-dq2');
    if (!r2.includes('⚠️ 暂存区里已有同名')) throw new Error('同标题第二次应提醒重名: ' + r2);
    if (!r2.includes('撤回 序号')) throw new Error('提醒里要说明怎么删（撤回 序号）: ' + r2);
    const r3 = await sendText('发', 'dq3', 1700001202, 'm-dq3');
    if (!r3.includes('将发布 2 条')) throw new Error('清单条数不对: ' + r3);
    if (!/1\. 新增文章 《同名测试》/.test(r3) || !/2\. 新增文章 《同名测试》/.test(r3)) throw new Error('清单应逐条编号: ' + r3);
    if (!r3.includes('回「撤回 序号」删掉其中一条')) throw new Error('清单要给撤回入口: ' + r3);
    const r4 = await sendText('撤回 1', 'dq4', 1700001203, 'm-dq4');
    if (!r4.includes('已撤回第 1 条')) throw new Error('撤回 1 应回执第 1 条: ' + r4);
    const pend = JSON.parse(await env.KV.get('pending'));
    if (pend.length !== 1) throw new Error('应剩 1 条: ' + JSON.stringify(pend));
    if (!String(pend[0].item.content).includes('正文二')) throw new Error('撤回 1 应删掉先存的那条，留下的应是正文二: ' + JSON.stringify(pend[0].item));
    const r5 = await sendText('撤回 5', 'dq5', 1700001204, 'm-dq5');
    if (!r5.includes('序号超出范围')) throw new Error('越界应提示范围: ' + r5);
    const r6 = await sendText('撤回', 'dq6', 1700001205, 'm-dq6');
    if (!r6.includes('已撤回第 1 条') || !r6.includes('暂存区已空')) throw new Error('裸撤回应撤最后一条并说明已空: ' + r6);
  });
});

/* 46. 批量选中：1.2 选中 → 删；以及一步到位「1.2 删除」 */
await check('批量选中删除：多序号选中后一次删，改/顶仍单选', async () => {
  const POSTS3 = '{"slug":"批量a","title":"批量A","date":"2026-10-30","categories":[],"tags":[],"cover":"","excerpt":"a"},'
    + '{"slug":"批量b","title":"批量B","date":"2026-10-29","categories":[],"tags":[],"cover":"","excerpt":"b"},'
    + '{"slug":"批量c","title":"批量C","date":"2026-10-28","categories":[],"tags":[],"cover":"","excerpt":"c"}';
  await withMock({ 'data/posts.js': '// 列表\nwindow.POSTS = [' + POSTS3 + '];' }, {}, async () => {
    const r1 = await sendText('查文 批量', 'md1', 1700001210, 'm-md1');
    if (!r1.includes('3. [文] 批量C')) throw new Error('应列出 3 篇: ' + r1);
    const r2 = await sendText('1.2', 'md2', 1700001211, 'm-md2');
    if (!r2.includes('已选中 2 条')) throw new Error('多序号应一次选中 2 条: ' + r2);
    if (!r2.includes('删 1,2')) throw new Error('应说明可以一次到位「删 1,2」: ' + r2);
    const r3 = await sendText('删', 'md3', 1700001212, 'm-md3');
    if (!r3.includes('已暂存删除 2 条')) throw new Error('应批量暂存删除: ' + r3);
    let pend = JSON.parse(await env.KV.get('pending'));
    if (pend.length !== 2 || pend.some((o) => o.file !== 'pdel')) throw new Error('应暂存 2 条删文章: ' + JSON.stringify(pend));
    const r4 = await sendText('发', 'md4', 1700001213, 'm-md4');
    if (!r4.includes('将发布 2 条') || !r4.includes('删文章 《批量A》')) throw new Error('清单应含 2 条删文章: ' + r4);
    await env.KV.put('pending', '[]');
    /* 一步到位：序号 + 删除 一起发 */
    const r5 = await sendText('查文 批量', 'md5', 1700001214, 'm-md5');
    if (!r5.includes('回复序号选中')) throw new Error('应回列表: ' + r5);
    const r6 = await sendText('删 1,3', 'md6', 1700001215, 'm-md6');
    if (!r6.includes('已暂存删除 2 条')) throw new Error('「删 1,3」应直接批量删: ' + r6);
    pend = JSON.parse(await env.KV.get('pending'));
    const titles = pend.map((o) => o.item.title).sort().join(',');
    if (titles !== '批量A,批量C') throw new Error('删的应是 A 和 C: ' + titles);
  });
});

/* 47. 选中态下回「发」不该被选中菜单拦住 */
await check('选中态下全局命令放行：回「发」直接出清单', async () => {
  const P = '{"slug":"pa","title":"探针A","date":"2026-10-30","categories":[],"tags":[],"cover":"","excerpt":"a"}';
  await withMock({ 'data/posts.js': '// 列表\nwindow.POSTS = [' + P + '];' }, {}, async () => {
    await sendText('查文 探针', 'gg1', 1700001500, 'm-gg1');
    await sendText('1', 'gg2', 1700001501, 'm-gg2');
    const r = await sendText('发', 'gg3', 1700001502, 'm-gg3');
    if (r.includes('当前选中')) throw new Error('选中态不该拦住「发」: ' + r.slice(0, 160));
    if (!/暂存区是空的|将发布/.test(r)) throw new Error('应正常执行「发」: ' + r.slice(0, 160));
  });
});

/* 48. 待办批量：多选后 完/废/开 都生效；与内容条目不许混批 */
await check('待办批量：多选后 完/废/开；混选被拒', async () => {
  const TODOS = JSON.stringify([
    { id: 'td1', note: '买牛奶', kind: 'note', done: false, createdAt: '2026-10-30' },
    { id: 'td2', note: '整理桌面', kind: 'note', done: false, createdAt: '2026-10-29' },
    { id: 'td3', title: '沙丘', kind: 'movie', done: false, createdAt: '2026-10-28' },
  ]);
  const P = '{"slug":"pa","title":"探针A","date":"2026-10-30","categories":[],"tags":[],"cover":"","excerpt":"a"}';
  await withMock({ 'data/todos.js': '// 待办\nwindow.TODOS = ' + TODOS + ';', 'data/posts.js': '// 列表\nwindow.POSTS = [' + P + '];' }, {}, async () => {
    const r1 = await sendText('查待办', 'tb1', 1700001700, 'm-tb1');
    if (!r1.includes('回复序号选中')) throw new Error('应回待办列表: ' + r1);
    const r2 = await sendText('1.2', 'tb2', 1700001701, 'm-tb2');
    if (!r2.includes('已选中 2 条待办')) throw new Error('多序号应选中 2 条待办: ' + r2);
    if (!r2.includes('「完」完成')) throw new Error('待办多选菜单应有完/废/开: ' + r2);
    const r3 = await sendText('废', 'tb3', 1700001702, 'm-tb3');
    if (!r3.includes('已暂存废弃 2 条')) throw new Error('应批量暂存废弃: ' + r3);
    let pend = JSON.parse(await env.KV.get('pending'));
    if (pend.length !== 2 || pend.some((o) => o.file !== 'todos' || o.op !== 'drop')) throw new Error('应 2 条 drop: ' + JSON.stringify(pend));
    await env.KV.put('pending', '[]');
    /* 完：含 1 条电影，应同时暂存一条瞬间 */
    await sendText('查待办', 'tb4', 1700001703, 'm-tb4');
    const r5 = await sendText('2.3', 'tb5', 1700001704, 'm-tb5');
    if (!r5.includes('已选中 2 条待办')) throw new Error('应选中 2 条: ' + r5);
    const r6 = await sendText('完', 'tb6', 1700001705, 'm-tb6');
    if (!r6.includes('已暂存完成 2 条')) throw new Error('应批量完成 2 条: ' + r6);
    if (!r6.includes('影视/图书已同时暂存瞬间')) throw new Error('影视完成应说明同时记瞬间: ' + r6);
    pend = JSON.parse(await env.KV.get('pending'));
    if (pend.filter((o) => o.file === 'todos' && o.op === 'done').length !== 2) throw new Error('应 2 条 done: ' + JSON.stringify(pend));
    if (pend.filter((o) => o.file === 'moments').length !== 1) throw new Error('电影应同时暂存 1 条瞬间: ' + JSON.stringify(pend));
    await env.KV.put('pending', '[]');
    /* 开：恢复未完成 */
    await sendText('查待办', 'tb7', 1700001706, 'm-tb7');
    await sendText('1.2', 'tb8', 1700001707, 'm-tb8');
    const r9 = await sendText('开', 'tb9', 1700001708, 'm-tb9');
    if (!r9.includes('已暂存恢复未完成 2 条')) throw new Error('应批量恢复: ' + r9);
    await env.KV.put('pending', '[]');
    /* 一步到位：「1.2 废」 */
    await sendText('查待办', 'tb9b', 1700001708, 'm-tb9b');
    const r9c = await sendText('废 1,2', 'tb9c', 1700001709, 'm-tb9c');
    if (!r9c.includes('已暂存废弃 2 条')) throw new Error('「废 1,2」应直接批量废弃: ' + r9c);
    await env.KV.put('pending', '[]');
  });
  /* 混选：一次搜索里既有待办又有文章 → 不许混批 */
  const TODOS2 = JSON.stringify([{ id: 'td9', note: '探针待办', kind: 'note', done: false, createdAt: '2026-10-30' }]);
  await withMock({ 'data/todos.js': '// 待办\nwindow.TODOS = ' + TODOS2 + ';', 'data/posts.js': '// 列表\nwindow.POSTS = [' + P + '];' }, {}, async () => {
    const r = await sendText('查 探针', 'tb10', 1700001709, 'm-tb10');
    if (!r.includes('回复序号选中')) throw new Error('应回混合结果: ' + r);
    const r2 = await sendText('1.2', 'tb11', 1700001710, 'm-tb11');
    if (!r2.includes('不能混在一批')) throw new Error('混选应被拒绝并说明: ' + r2);
  });
});

/* 统一命令格式：动作在前 + 序号（删 1,2 / 完 1,2 / 废 1,2 / 开 1,2），旧的「1,2 删」给提示 */
await check('统一格式：删 1,2 一步到位；旧写法「1.2 删」提示动作在前', async () => {
  const POSTS5 = '{"slug":"ge-a","title":"格A","date":"2026-10-30","categories":[],"tags":[],"cover":"","excerpt":"a"},'
    + '{"slug":"ge-b","title":"格B","date":"2026-10-29","categories":[],"tags":[],"cover":"","excerpt":"b"},'
    + '{"slug":"ge-c","title":"格C","date":"2026-10-28","categories":[],"tags":[],"cover":"","excerpt":"c"}';
  await withMock({ 'data/posts.js': '// 列表\nwindow.POSTS = [' + POSTS5 + '];' }, {}, async () => {
    await sendText('查文 格', 'mk01', 1700002000, 'm-mk01');
    const a = await sendText('1.2 删', 'mk02', 1700002001, 'm-mk02');
    if (!a.includes('动作写在前面')) throw new Error('旧写法应被提示改成「删 1,2」: ' + a);
    /* 旧写法只提示不执行，列表还在，可以按新格式继续 */
    const b = await sendText('删 1,2', 'mk03', 1700002002, 'm-mk03');
    if (!b.includes('已暂存删除 2 条')) throw new Error('「删 1,2」应直接批量删: ' + b);
    const pd = JSON.parse(await env.KV.get('pending'));
    if (pd.length !== 2 || pd.some((o) => o.file !== 'pdel')) throw new Error('应暂存 2 条 pdel: ' + JSON.stringify(pd));
    await env.KV.put('pending', '[]');
    /* 单条也写序号（唯一命中列表里也支持）：删 1 */
    await sendText('查文 格A', 'mk04', 1700002003, 'm-mk04');
    const c = await sendText('删 1', 'mk05', 1700002004, 'm-mk05');
    if (!c.includes('已暂存删除')) throw new Error('单条「删 1」应直达暂存: ' + c);
    await env.KV.put('pending', '[]');
  });
  const TODOS3 = JSON.stringify([
    { id: 'mk1', note: '甲事', kind: 'note', done: false, createdAt: '2026-10-30' },
    { id: 'mk2', note: '乙事', kind: 'note', done: false, createdAt: '2026-10-29' },
    { id: 'mk3', title: '沙丘2', kind: 'movie', done: false, createdAt: '2026-10-28' },
  ]);
  await withMock({ 'data/todos.js': '// 待办\nwindow.TODOS = ' + TODOS3 + ';' }, {}, async () => {
    /* 待办：查待办 → 完 1,2 一步到位 */
    await sendText('查待办', 'mk06', 1700002010, 'm-mk06');
    const d = await sendText('完 1,2', 'mk07', 1700002011, 'm-mk07');
    if (!d.includes('已暂存完成 2 条')) throw new Error('「完 1,2」应批量完成: ' + d);
    await env.KV.put('pending', '[]');
    /* 单条影视：完 3 要同时记一条瞬间 */
    await sendText('查待办', 'mk08', 1700002012, 'm-mk08');
    const e = await sendText('完 3', 'mk09', 1700002013, 'm-mk09');
    if (!e.includes('已同时暂存一条瞬间')) throw new Error('「完 3」应记瞬间: ' + e);
    const pe = JSON.parse(await env.KV.get('pending'));
    if (pe.filter((o) => o.file === 'moments').length !== 1) throw new Error('应 1 条瞬间: ' + JSON.stringify(pe));
    await env.KV.put('pending', '[]');
  });
  await withMock({ 'data/todos.js': '// 待办\nwindow.TODOS = ' + TODOS3 + ';' }, {}, async () => {
    /* 没有列表（无 conv）时，废/开 也直接对着「查待办」的编号来 */
    const f = await sendText('废 1,2', 'mk10', 1700002020, 'm-mk10');
    if (!f.includes('已暂存废弃 2 条')) throw new Error('「废 1,2」应批量废弃: ' + f);
    await env.KV.put('pending', '[]');
  });
});

/* ---- 导入D1：读 data-import.json 快照（raw 模式） ---- */


await check('导入D1：主站读 data-import.json 并打 __meta/imported 标记', async () => {
  const db = mockD1();
  const e = { ...env, DB: db };
  const manifest = JSON.stringify({ generated: '2026-11-02T00:00:00Z', totalBytes: 100, files: [
    { path: 'data/posts.js', body: 'window.POSTS = [];' },
  ] });
  const realFetch = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/contents/data-import.json')) { hits.push(u); return { ok: true, text: async () => manifest }; }
    throw new Error('不应外呼: ' + u);
  };
  try {
    const reply = await sendText('导入D1', 'ni1', 1700000070, 'm-imp-1', { env: e });
    if (!reply.includes('导入完成')) throw new Error('回话不对: ' + reply);
    if (!db.rows.get('data/posts.js')) throw new Error('快照行应入库');
    if (!db.rows.get('__meta/imported')) throw new Error('应打已导入标记');
    if (!hits[0].includes('your-name/your-repo')) throw new Error('应读主站仓库: ' + hits[0]);
  } finally { globalThis.fetch = realFetch; }
});

/* 「备份D1」测试：GitHub Git Data API mock（ref/refs/commits/trees/blobs） */
function ghBackupMock(state) {
  const blobSha = (buf) => {
    const h = nodeCrypto.createHash('sha1');
    h.update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf]));
    return h.digest('hex');
  };
  return async (u, init) => {
    const url = String(u);
    if (!url.includes('api.github.com')) throw new Error('备份不应外呼非 GitHub: ' + url);
    const method = (init && init.method) || 'GET';
    const path = url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const json = (obj, status = 200) => ({ ok: true, status, json: async () => obj, text: async () => JSON.stringify(obj) });
    const nf = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' });
    state.calls.push(method + ' ' + path);
    if (method === 'GET' && path === '/git/ref/heads/data-backup') {
      if (!state.created) return nf();
      return json({ object: { sha: state.commits[state.commits.length - 1] } });
    }
    if (method === 'GET' && path === '/git/ref/heads/main') return json({ object: { sha: 'c0' } });
    if (method === 'POST' && path === '/git/refs') { state.created = true; return json({}, 201); }
    if (method === 'GET' && path === '/git/commits/c0') return json({ tree: { sha: 't0' } });
    if (method === 'GET' && /^\/git\/commits\/c\d+$/.test(path)) return json({ tree: { sha: 't' + path.slice(12) } });
    if (method === 'GET' && path.startsWith('/git/trees/')) return json({ tree: state.tree });
    if (method === 'POST' && path === '/git/blobs') {
      const buf = Buffer.from(JSON.parse(init.body).content, 'base64');
      return json({ sha: blobSha(buf) });
    }
    if (method === 'POST' && path === '/git/trees') {
      const items = JSON.parse(init.body).tree;
      const map = new Map(state.tree.map((t) => [t.path, t]));
      for (const it of items) { if (it.sha === null) map.delete(it.path); else map.set(it.path, it); }
      state.tree = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
      state.lastTreeItems = items;
      return json({ sha: 't' + (++state.treeN) });
    }
    if (method === 'POST' && path === '/git/commits') { const c = 'c' + (++state.commitN); state.commits.push(c); return json({ sha: c }); }
    if (method === 'PATCH' && path === '/git/refs/heads/data-backup') { state.patched = true; return json({}); }
    throw new Error('ghBackupMock 未覆盖: ' + method + ' ' + path);
  };
}

await check('备份D1：首次从 main 建 data-backup 分支并全量提交', async () => {
  const db = mockD1();
  db.rows.set('data/posts.js', { body: 'var POSTS = [1];', updated_at: 1 });
  db.rows.set('data/meta.js', { body: 'var META = {};', updated_at: 1 });
  db.rows.set('__meta/imported', { body: '2026-11-02', updated_at: 1 });
  const state = { calls: [], tree: [], commits: ['c0'], commitN: 0, treeN: 0, created: false, patched: false, lastTreeItems: [] };
  const e2 = { ...env, DB: db, GH_TOKEN: 'tk', REPO: 'o/r' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ghBackupMock(state);
  try {
    const r1 = await sendText('备份D1', 'nb1', 1700000070, 'm-bk-1', { env: e2 });
    if (!r1.includes('已备份到 data-backup 分支')) throw new Error('回话不对: ' + r1);
    if (!r1.includes('2 新增')) throw new Error('应新增 2 个（__meta 不导出）: ' + r1);
    if (!state.created || !state.patched) throw new Error('应建分支并前移 ref');
    const paths = state.tree.map((t) => t.path).sort().join(',');
    if (paths !== 'data/meta.js,data/posts.js') throw new Error('备份分支内容不对: ' + paths);
    // 第二次：无变化 → 不产生新提交
    const cBefore = state.commits.length;
    const r2 = await sendText('备份D1', 'nb2', 1700000071, 'm-bk-2', { env: e2 });
    if (!r2.includes('已是最新')) throw new Error('第二次应提示无变化: ' + r2);
    if (state.commits.length !== cBefore) throw new Error('无变化不应新提交');
    // 第三次：D1 删了一个文件 → 备份分支同步删除
    db.rows.delete('data/meta.js');
    const r3 = await sendText('备份D1', 'nb3', 1700000072, 'm-bk-3', { env: e2 });
    if (!r3.includes('1 删除')) throw new Error('应同步删除: ' + r3);
    if (state.tree.some((t) => t.path === 'data/meta.js')) throw new Error('meta.js 应从备份分支消失');
  } finally { globalThis.fetch = realFetch; }
});

await check('admin/source：GET 报当前源，POST 互斥切换（删/写权威标记），无 key 401', async () => {
  const db = mockD1();
  db.rows.set('data/posts.js', { body: 'var POSTS=[];', updated_at: 1 });
  db.rows.set('__meta/imported', { body: 'x', updated_at: 1 });
  const e = { ...env, ADMIN_KEY: 'kk', DB: db };
  const H = { 'x-admin-key': 'kk' };
  let r = await worker.fetch(new Request('https://x/api/admin/source', { headers: H }), e, {});
  let o = await r.json();
  if (o.source !== 'd1' || o.files !== 1) throw new Error('GET 状态不对: ' + JSON.stringify(o));
  r = await worker.fetch(new Request('https://x/api/admin/source', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'github' }) }), e, {});
  o = await r.json();
  if (!o.ok || db.rows.has('__meta/imported')) throw new Error('切 GitHub 失败: ' + JSON.stringify(o));
  r = await worker.fetch(new Request('https://x/api/admin/source', { headers: H }), e, {});
  if ((await r.json()).source !== 'github') throw new Error('切后应为 github');
  r = await worker.fetch(new Request('https://x/api/admin/source', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'd1' }) }), e, {});
  o = await r.json();
  if (!o.ok || !db.rows.has('__meta/imported')) throw new Error('切回 D1 失败: ' + JSON.stringify(o));
  r = await worker.fetch(new Request('https://x/api/admin/source'), e, {});
  if (r.status !== 401) throw new Error('无 key 应 401: ' + r.status);
});

await check('CORS 预检：OPTIONS 返回 204 且带 Allow-Headers（admin D1 直写的前置条件）', async () => {
  const r = await worker.fetch(new Request('https://x/api/admin/write', { method: 'OPTIONS' }), env, {});
  if (r.status !== 204) throw new Error('应 204: ' + r.status);
  if (r.headers.get('Access-Control-Allow-Origin') !== '*') throw new Error('缺 ACAO');
  if (!/x-admin-key/i.test(r.headers.get('Access-Control-Allow-Headers') || '')) throw new Error('缺 Allow-Headers: x-admin-key');
  if (!/POST/i.test(r.headers.get('Access-Control-Allow-Methods') || '')) throw new Error('缺 Allow-Methods');
});

await check('admin/write：data/ 路径写 DB（后台 D1 直写链路）', async () => {
  const db = mockD1();
  const e = { ...env, ADMIN_KEY: 'kk', DB: db };
  const r = await worker.fetch(new Request('https://x/api/admin/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': 'kk' },
    body: JSON.stringify({ files: [{ path: 'data/posts.js', body: 'window.POSTS = [];' }, { path: 'data/content/x.js', deleted: true }] }),
  }), e, {});
  if (r.status !== 200) throw new Error('应 200: ' + r.status + ' ' + await r.text());
  if (!db.rows.has('data/posts.js')) throw new Error('data/posts.js 应写入 DB');
  if (db.rows.has('data/content/x.js')) throw new Error('deleted 的文件不应存在');
});

await check('备份D1：分支已存在且 D1 内容有更新 → 差量提交（首备失败后重跑的场景）', async () => {
  const db = mockD1();
  const NEW = 'var DATA_VERSION = "202611021524";\nvar POSTS = [{"id":46}];';
  const OLD = 'var DATA_VERSION = "202610310236";\nvar POSTS = [];';
  db.rows.set('data/posts.js', { body: NEW, updated_at: 2 });
  db.rows.set('data/content/p46.js', { body: '// 正文', updated_at: 2 });
  // 旧 blob sha（复刻分支里已有的旧版文件）
  const blobShaOf = (s) => nodeCrypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + Buffer.byteLength(s) + '\0'), Buffer.from(s)])).digest('hex');
  const state = { calls: [], tree: [
    { path: 'data/posts.js', mode: '100644', type: 'blob', sha: blobShaOf(OLD) },
    { path: 'js/main.js', mode: '100644', type: 'blob', sha: blobShaOf('// code') },
  ], commits: ['c0'], commitN: 0, treeN: 0, created: false, patched: false, lastTreeItems: [] };
  const e2 = { ...env, DB: db, GH_TOKEN: 'tk', REPO: 'o/r' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ghBackupMock(state);
  try {
    const r = await sendText('备份D1', 'nb5', 1700000074, 'm-bk-5', { env: e2 });
    if (!r.includes('1 新增 / 1 更新')) throw new Error('应 1 新增(content/p46) 1 更新(posts.js): ' + r);
    if (!state.patched) throw new Error('ref 应前移');
    const dataItem = state.tree.find((t) => t.path === 'data/posts.js');
    if (dataItem.sha !== blobShaOf(NEW)) throw new Error('posts.js 应更新为新内容');
    if (!state.tree.some((t) => t.path === 'js/main.js')) throw new Error('代码文件不应被动');
  } finally { globalThis.fetch = realFetch; }
});

await check('备份D1：后台模式结果落 KV（bkres），推送被拦时「备份结果」可查', async () => {
  await env.KV.put('pending', '[]');
  const db = mockD1();
  db.rows.set('data/posts.js', { body: 'window.POSTS = [];', updated_at: 1 });
  const e2 = { ...env, DB: db, GH_TOKEN: 'tk2', REPO: 'o/r' };
  const realFetch = globalThis.fetch;
  const jobs = [];
  const ctx = { waitUntil: (p) => jobs.push(p) };
  try {
    // 成功路径：微信推送被拦（60020 场景）也不影响 bkres 落库
    const state = { calls: [], tree: [], commits: ['c0'], commitN: 0, treeN: 0, created: false, patched: false };
    globalThis.fetch = async (u, init) => {
      const url = String(u);
      if (url.includes('api.github.com')) return ghBackupMock(state)(u, init);
      if (url.includes('qyapi.weixin.qq.com')) throw new Error('模拟推送被 IP 白名单拦截');
      throw new Error('不应外呼: ' + url);
    };
    const r = await sendText('备份D1', 'nb6', 1700000075, 'm-bk-6', { env: e2, ctx });
    if (!r.includes('备份已安排')) throw new Error('应立即回执: ' + r);
    await Promise.all(jobs);
    const rec = JSON.parse(await env.KV.get('bkres:userid-abc') || '{}');
    if (!rec.ok) throw new Error('bkres 应成功: ' + JSON.stringify(rec));
    if (!String(rec.raw).includes('已备份到 data-backup 分支')) throw new Error('raw 不对: ' + rec.raw);

    // 失败路径：GitHub 全挂 → bkres.ok=false，错误原文可查
    jobs.length = 0;
    globalThis.fetch = async (u) => {
      if (String(u).includes('api.github.com')) throw new Error('模拟 GitHub 502');
      throw new Error('不应外呼: ' + u);
    };
    await sendText('备份D1', 'nb7', 1700000076, 'm-bk-7', { env: e2, ctx });
    await Promise.all(jobs);
    const bad = JSON.parse(await env.KV.get('bkres:userid-abc') || '{}');
    if (bad.ok !== false) throw new Error('失败路径 bkres.ok 应为 false: ' + JSON.stringify(bad));
    if (!String(bad.raw).includes('模拟 GitHub 502')) throw new Error('失败原文未落 KV: ' + JSON.stringify(bad));
  } finally {
    globalThis.fetch = realFetch;
    await env.KV.put('pending', '[]');
  }
});

await check('备份D1：差异文件超过 30 个 → 分批续传（免费版 50 子请求上限）', async () => {
  await env.KV.put('pending', '[]');
  const db = mockD1();
  for (let i = 1; i <= 35; i++) db.rows.set('data/content/c' + i + '.js', { body: '// 文件' + i, updated_at: i });
  db.rows.set('__meta/imported', { body: '1', updated_at: 0 });
  const e2 = { ...env, DB: db, GH_TOKEN: 'tk2', REPO: 'o/r' };
  const realFetch = globalThis.fetch;
  const state = { calls: [], tree: [], commits: ['c0'], commitN: 0, treeN: 0, created: false, patched: false, lastTreeItems: [] };
  let runCalls = 0; // 统计单次调用的 GitHub 请求数（真环境=子请求）
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes('api.github.com')) { runCalls++; return ghBackupMock(state)(u, init); }
    if (url.includes('qyapi.weixin.qq.com')) throw new Error('模拟推送被拦');
    throw new Error('不应外呼: ' + url);
  };
  try {
    const r1 = await sendText('备份D1', 'nb8', 1700000077, 'm-bk-8', { env: e2 });
    if (!r1.includes('已备份 30/35') || !r1.includes('续传')) throw new Error('第一批应提示续传: ' + r1);
    if (runCalls > 45) throw new Error('第一批 GitHub 请求数应 ≤45（真环境对应 50 子请求上限）: ' + runCalls);
    const blobCalls1 = state.calls.filter((c) => c.startsWith('POST /git/blobs')).length;
    if (blobCalls1 !== 30) throw new Error('第一批应只传 30 个 blob: ' + blobCalls1);
    if (state.tree.length !== 30) throw new Error('分支应已有 30 个文件: ' + state.tree.length);

    runCalls = 0;
    const r2 = await sendText('备份D1', 'nb9', 1700000078, 'm-bk-9', { env: e2 });
    if (!r2.includes('已备份到 data-backup 分支') || !r2.includes('续传完成')) throw new Error('第二批应收尾: ' + r2);
    if (state.tree.length !== 35) throw new Error('最终分支应有全部 35 个文件: ' + state.tree.length);
    if (!state.tree.every((t) => t.path.startsWith('data/content/'))) throw new Error('不应误伤其他路径');
    // 收尾后再跑：全无变化，不产生新提交
    const cBefore = state.commits.length;
    const r3 = await sendText('备份D1', 'nb10', 1700000079, 'm-bk-10', { env: e2 });
    if (!r3.includes('已是最新')) throw new Error('续传完成后再跑应无变化: ' + r3);
    if (state.commits.length !== cBefore) throw new Error('无变化不应新提交');
  } finally {
    globalThis.fetch = realFetch;
    await env.KV.put('pending', '[]');
    await env.KV.delete('bkcurs').catch(() => {});
  }
});

await check('备份D1：CRLF 自动归一 LF（autocrlf 仓库导入后 D1 全 CRLF 的根因修复）', async () => {
  await env.KV.put('pending', '[]');
  const db = mockD1();
  db.rows.set('data/posts.js', { body: 'window.POSTS = [];\r\nvar X = 1;\r\n', updated_at: 1 }); // D1 侧 CRLF
  const e2 = { ...env, DB: db, GH_TOKEN: 'tk2', REPO: 'o/r' };
  const realFetch = globalThis.fetch;
  // 分支上已有 LF 版本（仓库规范存储）
  const lf = Buffer.from('window.POSTS = [];\nvar X = 1;\n');
  const lfSha = nodeCrypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + lf.length + '\0'), lf])).digest('hex');
  const state = { calls: [], tree: [{ path: 'data/posts.js', mode: '100644', type: 'blob', sha: lfSha }], commits: ['c0'], commitN: 0, treeN: 0, created: true, patched: false, lastTreeItems: [] };
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes('api.github.com')) return ghBackupMock(state)(u, init);
    if (url.includes('qyapi.weixin.qq.com')) throw new Error('模拟推送被拦');
    throw new Error('不应外呼: ' + url);
  };
  try {
    const r = await sendText('备份D1', 'nb11', 1700000080, 'm-bk-11', { env: e2 });
    if (!r.includes('已是最新')) throw new Error('CRLF 应归一识别为无变化: ' + r);
    if (state.calls.some((c) => c.startsWith('POST /git/blobs'))) throw new Error('零上传才对');
  } finally {
    globalThis.fetch = realFetch;
    await env.KV.put('pending', '[]');
  }
});

await check('恢复D1：从 data-backup 分支灌回（含多余文件删除 + 权威标记），数据源可查', async () => {
  await env.KV.put('pending', '[]');
  const db = mockD1();
  db.rows.set('data/posts.js', { body: 'window.POSTS = 旧;', updated_at: 1 });
  db.rows.set('data/content/stale.js', { body: '// 多余', updated_at: 1 }); // 分支没有 → 恢复时应删
  const e2 = { ...env, DB: db, GH_TOKEN: 'tk2', REPO: 'o/r' };
  const realFetch = globalThis.fetch;
  const jobs = [];
  const rawFiles = { 'data/posts.js': 'window.POSTS = 新;', 'data/content/c1.js': '// 备份正文' };
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (!url.includes('api.github.com')) throw new Error('不应外呼: ' + url);
    if (url.includes('/commits?sha=data-backup')) return new Response(JSON.stringify([{ sha: 'abc1234def', commit: { message: 'D1 每日备份 2026-11-02 09:19 UTC（1 文件）' } }]), { status: 200 });
    if (url.endsWith('/git/ref/heads/data-backup')) return Response.json({ object: { sha: 'rb1' } });
    if (url.endsWith('/git/commits/rb1')) return Response.json({ tree: { sha: 'rt1' } });
    if (url.includes('/git/trees/rt1')) return Response.json({ tree: [
      { type: 'blob', path: 'data/posts.js' }, { type: 'blob', path: 'data/content/c1.js' }, { type: 'blob', path: 'js/main.js' },
    ] });
    for (const [p, body] of Object.entries(rawFiles)) if (url.includes('/contents/' + p + '?ref=data-backup')) return new Response(body, { status: 200 });
    throw new Error('恢复 mock 未覆盖: ' + url);
  };
  try {
    const r = await sendText('恢复D1', 'nr1', 1700000081, 'm-rs-1', { env: e2, ctx: { waitUntil: (p) => jobs.push(p) } });
    if (!r.includes('恢复已安排')) throw new Error('应立即回执: ' + r);
    await Promise.all(jobs);
    const rec = JSON.parse(await env.KV.get('bkres:userid-abc') || '{}');
    if (!rec.ok || rec.op !== '恢复') throw new Error('bkres 应恢复成功: ' + JSON.stringify(rec));
    if (!db.rows.get('data/posts.js').body.includes('新')) throw new Error('data/posts.js 应更新为备份版');
    if (!db.rows.has('data/content/c1.js')) throw new Error('c1.js 应灌回');
    if (db.rows.has('data/content/stale.js')) throw new Error('多余文件应删除');
    if (!db.rows.has('__meta/imported')) throw new Error('权威标记应刷新');
    // 「数据源」：极简两行——当前源 + 切换命令
    const r2 = await sendText('数据源', 'nr2', 1700000082, 'm-rs-2', { env: e2 });
    if (!r2.includes('当前数据源：D1') || !r2.includes('备份') || !r2.includes('abc1234')) throw new Error('数据源回复不对: ' + r2);
    // 「数据源GitHub」→ 删标记；「数据源D1」→ 重写标记（来回切换）
    const r3 = await sendText('数据源GitHub', 'nr3', 1700000083, 'm-rs-3', { env: e2 });
    if (!r3.includes('已切到 GitHub')) throw new Error('切 GitHub 回复不对: ' + r3);
    if (db.rows.has('__meta/imported')) throw new Error('切 GitHub 后标记应删除');
    const r4 = await sendText('数据源', 'nr4', 1700000084, 'm-rs-4', { env: e2 });
    if (!r4.includes('当前数据源：GitHub 静态')) throw new Error('切后状态不对: ' + r4);
    const r5 = await sendText('数据源D1', 'nr5', 1700000085, 'm-rs-5', { env: e2 });
    if (!r5.includes('已切回 D1')) throw new Error('切 D1 回复不对: ' + r5);
    if (!db.rows.has('__meta/imported')) throw new Error('切回 D1 后标记应在');
    const r6 = await sendText('数据源', 'nr6', 1700000086, 'm-rs-6', { env: e2 });
    if (!r6.includes('当前数据源：D1')) throw new Error('切回后状态不对: ' + r6);
  } finally {
    globalThis.fetch = realFetch;
    await env.KV.put('pending', '[]');
    await env.KV.delete('rscurs').catch(() => {});
  }
});

/* HELP 必须在微信被动回复 2048 字节上限内（留余量 1950）——主站曾因 2505 字节被截掉末尾的【数据与灾备】段（2026-11-02，已录 PITFALLS） */
{
  const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  for (const name of ['HELP']) {
    const m = src.match(new RegExp('const ' + name + ' = (\\[.*?\\])\\.join'));
    if (!m) { fail++; console.log('✗ HELP 长度检查：worker.js 里找不到 ' + name); continue; }
    const bytes = Buffer.byteLength(eval(m[1]).join('\n'), 'utf8');
    if (bytes > 1950) { fail++; console.log(`✗ ${name} ${bytes} 字节，超微信 2048 上限，尾部会被截断`); }
    else { pass++; console.log(`✓ ${name} ${bytes} 字节（≤1950 限内）`); }
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
