/* 临时冒烟测试：模拟 CF Pages Function 环境调用 onRequestPost/onRequestOptions */
const { onRequestPost, onRequestOptions } = await import('../functions/api/proxy.js');

let failures = 0;
function assert(name, cond, extra = '') {
  if (cond) console.log(`✅ ${name}`);
  else { failures++; console.log(`❌ ${name} ${extra}`); }
}

const ENV = { PROXY_TOKEN: 'test-token' };

async function call(payload, { token = 'test-token', ip = '1.2.3.4', method = 'POST' } = {}) {
  const headers = { 'x-proxy-token': token, 'cf-connecting-ip': ip, 'content-type': 'application/json' };
  const req = new Request('https://example.com/api/proxy', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  });
  return onRequestPost({ request: req, env: ENV });
}

// 1. 缺 token -> 401
let r = await call({ url: 'https://pc-api.uc.cn/x' }, { token: '' });
assert('缺 token -> 401', r.status === 401, `got ${r.status}`);

// 2. token 错 -> 401
r = await call({ url: 'https://pc-api.uc.cn/x' }, { token: 'wrong' });
assert('token 错 -> 401', r.status === 401, `got ${r.status}`);

// 3. 白名单外域名 -> 403
r = await call({ url: 'https://evil.com/x' });
assert('白名单外 -> 403', r.status === 403, `got ${r.status}`);

// 4. 非法 URL -> 400
r = await call({ url: 'not-a-url' });
assert('非法 URL -> 400', r.status === 400, `got ${r.status}`);

// 5. 内嵌凭据 URL -> 400
r = await call({ url: 'https://user:pass@pc-api.uc.cn/x' });
assert('内嵌凭据 -> 400', r.status === 400, `got ${r.status}`);

// 6. 坏 body -> 400
r = await call(null, {});
assert('坏 body -> 400', r.status === 400, `got ${r.status}`);

// 7. 限频：v1.3.2 放宽到 120/min —— 前 120 次放行，第 121 次 429
let last = null;
for (let i = 0; i < 120; i++) {
  last = await call({ url: 'https://pc-api.uc.cn/x' }, { ip: '9.9.9.9' });
}
assert('限频：前 120 次未触发 429', last.status !== 429, `got ${last.status}`);
last = await call({ url: 'https://pc-api.uc.cn/x' }, { ip: '9.9.9.9' });
assert('限频 121 次 -> 429', last.status === 429, `got ${last.status}`);
// 换 IP 不受影响
r = await call({ url: 'https://pc-api.uc.cn/x' }, { ip: '8.8.8.8' });
assert('换 IP 放行', r.status !== 429 && r.status !== 401 && r.status !== 403, `got ${r.status}`);

// 8. 正常转发：mock 上游
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert('转发目标 URL 正确', String(url) === 'https://pc-api.uc.cn/1/clouddrive/share?pr=UCBrowser', String(url));
  assert('转发 method 正确', init.method === 'POST', init.method);
  assert('转发 body 正确', init.body === '{"a":1}', String(init.body));
  // v1.3.1 修正（旧断言已过期）：cookie / authorization 自 v1.1.9（夸克登录态）与 v1.2.x（alipan
  // Bearer 登录态）起**有意放行**（见 proxy-core 文件头「边界」与 forwardHeaders），不再丢弃；
  // 这里改成断言「白名单外的头被丢弃」，保留原意图（只转发必要头）。
  assert('丢弃白名单外的头', !('x-evil' in init.headers) && !('x-forwarded-for' in init.headers), JSON.stringify(init.headers));
  assert('放行 cookie（v1.1.9 夸克登录态）', 'cookie' in init.headers, JSON.stringify(init.headers));
  assert('放行 authorization（v1.2.x alipan 登录态）', 'authorization' in init.headers, JSON.stringify(init.headers));
  return new Response('{"code":0,"data":{"ok":true}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
r = await call({
  url: 'https://pc-api.uc.cn/1/clouddrive/share?pr=UCBrowser',
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: 'session=abc', authorization: 'Bearer x', accept: '*/*', 'x-evil': '1', 'x-forwarded-for': '1.2.3.4' },
  body: '{"a":1}',
});
assert('转发成功透传 200', r.status === 200, `got ${r.status}`);
assert('透传 body', (await r.text()) === '{"code":0,"data":{"ok":true}}');
assert('CORS 头', r.headers.get('access-control-allow-origin') === '*');
assert('透传 content-type', (r.headers.get('content-type') || '').includes('application/json'));
globalThis.fetch = realFetch;

// 9. 上游 502/超时：mock 上游抛错
globalThis.fetch = async () => { throw new Error('boom'); };
r = await call({ url: 'https://pc-api.uc.cn/x' }, { ip: '7.7.7.7' });
assert('上游失败 -> 502', r.status === 502, `got ${r.status}`);
globalThis.fetch = realFetch;

// 10. OPTIONS 预检
const pre = onRequestOptions();
assert('OPTIONS -> 204 + CORS', pre.status === 204 && pre.headers.get('access-control-allow-methods')?.includes('POST'));

// 11. env 未配置 -> fail-closed 503
r = await onRequestPost({ request: new Request('https://example.com/api/proxy', { method: 'POST', headers: { 'x-proxy-token': 'x', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://pc-api.uc.cn/x' }) }), env: {} });
assert('env 缺 PROXY_TOKEN -> 503', r.status === 503, `got ${r.status}`);

// 12. v1.4 迅雷：分类词表（与 backend/SPA 同表，防漂移）
const core = await import('../functions/api/_shared/proxy-core.js');
assert('分类 share 根 -> scan', core.classifyOperation('https://api-pan.xunlei.com/drive/v1/share?share_id=x') === 'scan');
assert('分类 share/detail -> scan', core.classifyOperation('https://api-pan.xunlei.com/drive/v1/share/detail?share_id=x') === 'scan');
assert('分类 share/restore -> restore（不被 scan 前缀吃）', core.classifyOperation('https://api-pan.xunlei.com/drive/v1/share/restore') === 'restore');
assert('分类 files/<id> -> download', core.classifyOperation('https://api-pan.xunlei.com/drive/v1/files/abc?space=&usage=CONSUME') === 'download');
assert('分类 captcha/init -> other', core.classifyOperation('https://xluser-ssl.xunlei.com/v1/shield/captcha/init') === 'other');
assert('proxy-core 不再导出 xunleiActionOf（透明注入已废弃）', core.xunleiActionOf === undefined);

// 13. 迅雷 scan 转发：白名单放行 + captcha 头透传（scan 仍由 SPA 本地发、走转发链路）
globalThis.fetch = async (url, init) => {
  assert('xunlei scan 转发目标正确', String(url).startsWith('https://api-pan.xunlei.com/drive/v1/share'), String(url));
  assert('x-captcha-token 透传上游（scan 本地自造）', init.headers['x-captcha-token'] === 'local-scan-tok', JSON.stringify(init.headers));
  assert('x-client-id 透传上游', init.headers['x-client-id'] === 'Xp6', JSON.stringify(init.headers));
  assert('白名单外头仍被丢弃', !('x-evil' in init.headers));
  return new Response('{"share_status":"OK"}', { status: 200, headers: { 'content-type': 'application/json' } });
};
r = await call({
  url: 'https://api-pan.xunlei.com/drive/v1/share?share_id=x',
  method: 'GET',
  headers: { 'x-captcha-token': 'local-scan-tok', 'x-client-id': 'Xp6', 'x-evil': '1' },
});
assert('xunlei 域放行（不再 403）', r.status === 200, `got ${r.status}`);
globalThis.fetch = realFetch;

// 14. 转发链路**不再**自动注入 captcha：restore 请求原样转发（不塞 x-captcha-token）
let fwdHeaders = null;
globalThis.fetch = async (url, init) => {
  fwdHeaders = init.headers;
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
};
r = await call({ url: 'https://api-pan.xunlei.com/drive/v1/share/restore', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"file_ids":[]}' });
assert('restore 转发 200（原样透传，不注入）', r.status === 200, `got ${r.status}`);
assert('转发头不含注入的 x-captcha-token', fwdHeaders !== null && !('x-captcha-token' in fwdHeaders), JSON.stringify(fwdHeaders));
globalThis.fetch = realFetch;

// 15. xunlei-op 自有路由（账号相关 ops 由 backend 代发；前端只发意图）
// v1.4：路由移到嵌套目录 → 真正的 /api/xunlei/op（旧 xunlei-op.js 会变 404）
const { onRequestPost: opPost, onRequestOptions: opOptions } = await import('../functions/api/xunlei/op.js');
async function opCall(payload, { token = 'test-token', ip = '5.5.5.5', env = { PROXY_TOKEN: 'test-token' } } = {}) {
  const req = new Request('https://example.com/api/xunlei/op', {
    method: 'POST',
    headers: { 'x-proxy-token': token, 'cf-connecting-ip': ip, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return opPost({ request: req, env });
}
r = await opCall({ op: 'download', fid: 'x' }, { token: '' });
assert('op 无令牌 -> 401', r.status === 401, `got ${r.status}`);
r = await opCall({ op: 'nope' });
assert('op 非法 op -> 400', r.status === 400, `got ${r.status}`);
r = await opCall({ op: 'download', fid: 'x' });
assert('op 未配置 BACKEND_URL -> 501', r.status === 501 && (await r.json()).error === 'BACKEND_NOT_CONFIGURED', `got ${r.status}`);
const opEnv = { PROXY_TOKEN: 'test-token', BACKEND_URL: 'http://backend.test' };
globalThis.fetch = async (url, init) => {
  assert('op 透传目标 = backend /api/xunlei/op', String(url) === 'http://backend.test/api/xunlei/op', String(url));
  assert('op 透传 X-Proxy-Token', init.headers['x-proxy-token'] === 'test-token');
  assert('op 透传请求体（op 名）', JSON.parse(init.body).op === 'download');
  return new Response(JSON.stringify({ ok: true, url: 'https://dl/x', expiresAt: 123 }), { status: 200, headers: { 'content-type': 'application/json' } });
};
r = await opCall({ op: 'download', fid: 'x' }, { env: opEnv });
const od = await r.json();
assert('op 原样透传 backend 结果', r.status === 200 && od.ok === true && od.url === 'https://dl/x' && od.expiresAt === 123, JSON.stringify(od));
globalThis.fetch = async () => { throw new Error('boom'); };
r = await opCall({ op: 'download', fid: 'x' }, { env: opEnv });
assert('op backend 不可达 -> 502', r.status === 502 && (await r.json()).error === 'BACKEND_UNREACHABLE', `got ${r.status}`);
globalThis.fetch = async () => new Response('not-json', { status: 200 });
r = await opCall({ op: 'download', fid: 'x' }, { env: opEnv });
assert('op backend 非 JSON -> 502', r.status === 502 && (await r.json()).error === 'BACKEND_BAD_RESPONSE', `got ${r.status}`);
globalThis.fetch = realFetch;
const opPre = opOptions();
assert('op OPTIONS -> 204 + CORS', opPre.status === 204 && opPre.headers.get('access-control-allow-methods')?.includes('POST'));

// 16. v1.4 op 探活 ping：透传到 backend（不打上游），且失败分支必带 CORS 头
globalThis.fetch = async (url, init) => {
  assert('ping 透传 backend /api/xunlei/op', String(url) === 'http://backend.test/api/xunlei/op', String(url));
  assert('ping 请求体 op=ping', JSON.parse(init.body).op === 'ping');
  return new Response(JSON.stringify({ ok: true, pong: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};
r = await opCall({ op: 'ping' }, { env: opEnv });
const pongBody = await r.json();
assert('ping -> 200 {ok:true}', r.status === 200 && pongBody.ok === true, JSON.stringify(pongBody));
globalThis.fetch = realFetch;

// 17. 异常兜底：handler 抛错也必须回带 CORS 头的 JSON（否则浏览器只见 CORS 错误）
globalThis.fetch = async () => { throw new Error('boom'); };
r = await opCall({ op: 'ping' }, { env: opEnv });
assert('handler 内异常 -> 带 CORS 头的 JSON（非裸 500）', r.headers.get('access-control-allow-origin') === '*' && (await r.json()).error !== undefined, `status=${r.status}`);
globalThis.fetch = realFetch;

console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
