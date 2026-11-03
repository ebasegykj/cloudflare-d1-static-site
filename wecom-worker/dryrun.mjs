/* 干跑：真实读取仓库 data/*.js，但把所有写操作（blob/tree/commit/ref）拦下来不真推
   目的：验证 flush 的路径拼装、JSON 重组、days 重算是否正确 */
import worker from './worker.js';
import nodeCrypto from 'node:crypto';

const CORP_ID = process.env.CORP_ID || 'ww2418465765df31d5';
const TOKEN = process.env.WECOM_TOKEN;
const AESKEY = process.env.WECOM_AESKEY;
const GH_TOKEN = process.env.GH_TOKEN;
if (!TOKEN || !AESKEY || !GH_TOKEN) {
  console.error('缺环境变量：WECOM_TOKEN / WECOM_AESKEY / GH_TOKEN');
  process.exit(1);
}
const RAWKEY = Buffer.from(AESKEY + '=', 'base64');

const env = {
  CORP_ID,
  AGENT_ID: '1000002',
  WECOM_TOKEN: TOKEN,
  WECOM_AESKEY: AESKEY,
  GH_TOKEN,
  REPO: 'your-name/your-repo',
  KV: {
    _s: {},
    async get(k) { return this._s[k] ?? null; },
    async put(k, v) { this._s[k] = String(v); },
    async delete(k) { delete this._s[k]; },
  },
};

/* ---------- 拦截 GitHub 写操作 ---------- */
const realFetch = globalThis.fetch;
const captured = { blobs: [], tree: null, commit: null, refPatch: null };
let blobN = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = ((init && init.method) || 'GET').toUpperCase();
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('api.github.com')) {
    if (method === 'POST' && u.endsWith('/git/blobs')) {
      const body = JSON.parse(init.body);
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      captured.blobs.push(text);
      return j({ sha: 'blob-' + (++blobN) });
    }
    if (method === 'POST' && u.endsWith('/git/trees')) { captured.tree = JSON.parse(init.body); return j({ sha: 'tree-1' }); }
    if (method === 'POST' && u.endsWith('/git/commits')) { captured.commit = JSON.parse(init.body); return j({ sha: 'commit-1' }); }
    if (method === 'PATCH' && u.includes('/git/refs/heads/main')) { captured.refPatch = JSON.parse(init.body); return j({ ok: true }); }
  }
  return realFetch(url, init);
};

/* ---------- 企业微信信封 ---------- */
function wecomEncrypt(msgBuf) {
  const rnd = nodeCrypto.randomBytes(16);
  const len = Buffer.alloc(4); len.writeUInt32BE(msgBuf.length);
  let buf = Buffer.concat([rnd, len, msgBuf, Buffer.from(CORP_ID)]);
  const padLen = 32 - (buf.length % 32);
  buf = Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
  const c = nodeCrypto.createCipheriv('aes-256-cbc', RAWKEY, RAWKEY.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]);
}
const xmlTag = (t, v) => `<${t}><![CDATA[${v}]]></${t}>`;

async function sendText(text, msgId) {
  const ts = Math.floor(Date.now() / 1000), nonce = 'n' + Math.random().toString(36).slice(2, 10);
  const msgXml = `<xml>${xmlTag('ToUserName', CORP_ID)}${xmlTag('FromUserName', 'userid-abc')}${xmlTag('CreateTime', ts)}${xmlTag('MsgType', 'text')}${xmlTag('Content', text)}${xmlTag('MsgId', msgId)}</xml>`;
  const b64 = wecomEncrypt(Buffer.from(msgXml, 'utf8')).toString('base64');
  const sig = nodeCrypto.createHash('sha1').update([TOKEN, String(ts), nonce, b64].sort().join('')).digest('hex');
  const body = `<xml>${xmlTag('Encrypt', b64)}${xmlTag('MsgSignature', sig)}${xmlTag('TimeStamp', ts)}${xmlTag('Nonce', nonce)}</xml>`;
  const req = new Request(`https://x/wecom?${new URLSearchParams({ msg_signature: sig, timestamp: ts, nonce })}`, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body });
  const res = await worker.fetch(req, env, {});
  const t = await res.text();
  const enc = t.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/)[1];
  const d = nodeCrypto.createDecipheriv('aes-256-cbc', RAWKEY, RAWKEY.subarray(0, 16));
  d.setAutoPadding(false);
  const pt = Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
  const pad = pt[pt.length - 1];
  const b = pt.subarray(0, pt.length - pad);
  return b.subarray(20, 20 + b.readUInt32BE(16)).toString('utf8');
}

/* ---------- 预置暂存 ---------- */
await env.KV.put('pending', JSON.stringify([
  { file: 'moments', item: { date: '2026/10/30 13:50:00', content: '<p style="">__干跑测试条目__</p>', type: 'movie', title: '__干跑测试条目__', runtime: 100, poster: '', kind: 'movie' } },
  { file: 'posts', item: { slug: '__dryrun-post__', title: '__干跑文章__', date: '2026-10-30', categories: [], tags: [], cover: '', excerpt: 'dryrun', content: '<p>x</p>' } },
  { file: 'photos', item: { src: 'https://img.example.com/file/__dryrun__', note: '', date: '2026-10-30' } },
]));

console.log('=== 发「发」 ===');
console.log(await sendText('发', 'm-' + Date.now()));
process.stdout.write('\n=== 发「确认」（写操作已被拦截，不会真推） ===\n');
console.log(await sendText('确认', 'm-' + (Date.now() + 1)));

console.log('\n=== 拦截结果 ===');
console.log('blob 数量:', captured.blobs.length);
captured.blobs.forEach((t, i) => {
  const name = (captured.tree && captured.tree.tree[i] && captured.tree.tree[i].path) || '?';
  console.log(`  [${i}] ${name}  ${t.length} 字节`);
  if (name.endsWith('moments.js') || name.endsWith('posts.js') || name.endsWith('photos.js')) {
    try {
      const arr = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
      console.log(`       解析 OK，条数 ${arr.length}，首条标题: ${arr[0].title || arr[0].src}`);
    } catch (e) { console.log('       ✗ JSON 解析失败:', e.message); }
  }
  if (name.endsWith('days.js')) {
    console.log('       含 WATCH_DAYS:', t.includes('window.WATCH_DAYS'), ' 含 WATCH_META:', t.includes('window.WATCH_META'));
    const m = t.match(/window\.WATCH_META = (\{.*\});/);
    if (m) { const meta = JSON.parse(m[1]); console.log(`       total=${meta.total} movie=${meta.movie} book=${meta.book} mins=${meta.mins}`); }
  }
});
console.log('tree 路径:', captured.tree && captured.tree.tree.map((x) => x.path));
console.log('commit message:', captured.commit && captured.commit.message);
console.log('ref patch sha:', captured.refPatch && captured.refPatch.sha);
console.log('暂存区剩余:', await env.KV.get('pending'));
