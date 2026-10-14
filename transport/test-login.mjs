/**
 * test-login.mjs — login.mjs（微信 iLink 扫码登录）的离线测试套件。
 *
 * **全部用例都打桩 fetch，绝不发真实网络请求**，也绝不碰真实微信服务。
 * 跑法：<node 绝对路径> <repo>\transport\test-login.mjs
 *
 * 覆盖：
 *   1. 导出契约、8 个状态、节奏常量、超时封顶（resolveTimeoutMs）
 *   2. beginLogin：POST get_bot_qrcode 的 URL/请求头/请求体/返回值
 *   3. wait → confirmed：两个原语串起来拿到完整凭据
 *   4. expired / scaned / need_verifycode / verify_code_blocked / binded_redirect
 *   5. scaned_but_redirect：redirect_host → 换 baseUrl 继续轮询
 *   6. 脏响应：缺字段、状态不认识、非 JSON、不受信任的 URL、平台拒绝
 *   7. HTTP 非 2xx / 网络抛错 / 超时 / signal 取消
 *   8. token 不落 stdout/stderr（含 console.* 与 process.std*.write）
 */

import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  createWeixinLogin,
  DEFAULT_BOT_TYPE,
  DEFAULT_QR_BASE_URL,
  LOGIN_STATUSES,
  MAX_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  QR_TTL_MS,
  resolveTimeoutMs,
} from './login.mjs';

// ---------------------------------------------------------------------------
// 迷你运行器（风格对齐 harness/test-questions.mjs，外加"失败不中断"）
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };

async function section(title, fn) {
  console.log(`\n# ${title}`);
  try {
    await fn();
  } catch (error) {
    failed += 1;
    failures.push({ title, error });
    console.log(`  FAIL ${title}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------------------
// 打桩：一个可路由的 fetch 替身（与 transport/test.mjs 同一套写法）
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(text); },
    async text() { return text; },
  };
}

/** 返回 200 但 body 不是合法 JSON —— 模拟被截断/污染的响应。 */
function brokenJsonResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new SyntaxError('Unexpected token < in JSON'); },
  };
}

function makeAbortError() {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** 永不 resolve，直到 signal 被 abort —— 模拟被服务端 hold 住的长轮询。 */
function hang(record) {
  return new Promise((resolve, reject) => {
    const signal = record?.signal;
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
  });
}

function createServer(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const parsed = new URL(href);
    const record = {
      url: href,
      host: parsed.host,
      path: parsed.pathname,
      query: parsed.search,
      method: init.method,
      headers: { ...(init.headers ?? {}) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      redirect: init.redirect,
      signal: init.signal,
    };
    calls.push(record);
    return handler(record, calls.length - 1);
  };
  return { fetchImpl, calls };
}

/**
 * 按 path 路由：值可以是 `(record) => response`，也可以是响应数组（按顺序取，最后一个重复）。
 * 未打桩的路径直接断言失败 —— 保证测试里的每一次请求都是显式预期的。
 */
function createRouter(routes) {
  const counters = new Map();
  const server = createServer((record) => {
    const route = routes[record.path];
    assert.ok(route, `未打桩的请求路径：${record.path}`);
    if (typeof route === 'function') return route(record);
    const index = counters.get(record.path) ?? 0;
    counters.set(record.path, index + 1);
    return route[Math.min(index, route.length - 1)];
  });
  return server;
}

const QR_PATH = '/ilink/bot/get_bot_qrcode';
const STATUS_PATH = '/ilink/bot/get_qrcode_status';

/** 抓住 console.* 与 process.std*.write，验证"绝不打印 token"（安全红线 S1）。 */
async function captureOutput(run) {
  const captured = [];
  const original = {
    log: console.log, warn: console.warn, error: console.error,
    info: console.info, debug: console.debug,
    stdoutWrite: process.stdout.write, stderrWrite: process.stderr.write,
  };
  const record = (...args) => {
    captured.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '));
    return true;
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  console.info = record;
  console.debug = record;
  process.stdout.write = record;
  process.stderr.write = record;
  try {
    return { value: await run(), captured };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    console.debug = original.debug;
    process.stdout.write = original.stdoutWrite;
    process.stderr.write = original.stderrWrite;
  }
}

/**
 * 断言被取消（而不是以某个业务 code 失败），返回捕获到的异常。
 * 注意：取消走的是 DOMException（name='AbortError'），它只有**数字**遗留码 20（ABORT_ERR），
 * 业务错误才有字符串 code —— 这里就是要盯住"取消别被误报成 timeout"。
 */
const BUSINESS_CODES = new Set([
  'timeout', 'http-error', 'network-error', 'invalid-response', 'invalid-qr',
  'invalid-login-status', 'incomplete-login', 'qr-request-rejected',
  'untrusted-qr', 'invalid-base-url', 'untrusted-base-url', 'untrusted-endpoint',
]);

async function cancellation(promiseFactory, { name = 'AbortError' } = {}) {
  let caught = null;
  try {
    await promiseFactory();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, '期望被取消，但调用成功了');
  if (name !== null) assert.equal(caught.name, name, '取消必须是 AbortError');
  assert.ok(!BUSINESS_CODES.has(caught.code), `取消不能被误报成业务错误（实际 code=${caught.code}）`);
  return caught;
}

/** 断言某个 async 调用以指定 code 拒绝，并把错误交回调用方细看。 */
async function rejection(promiseFactory, expectedCode) {
  let caught = null;
  try {
    await promiseFactory();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `期望抛错（code=${expectedCode}），但调用成功了`);
  assert.equal(caught.code, expectedCode, `期望 code=${expectedCode}，实际 code=${caught.code}（${caught.message}）`);
  return caught;
}

// ---------------------------------------------------------------------------
// 1. 导出契约与常量
// ---------------------------------------------------------------------------

await section('导出契约、状态集合、节奏常量、超时封顶', async () => {
  assert.equal(typeof createWeixinLogin, 'function');
  assert.throws(() => createWeixinLogin({ fetchImpl: 'nope' }), TypeError, 'fetchImpl 必须是函数');
  assert.equal(typeof createWeixinLogin().beginLogin, 'function', '不传 fetchImpl 也能构造（默认 globalThis.fetch）');

  const login = createWeixinLogin({ fetchImpl: async () => jsonResponse({}) });
  assert.deepEqual(
    Object.keys(login).sort(),
    ['DEFAULT_QR_BASE_URL', 'LOGIN_STATUSES', 'beginLogin', 'pollLogin'],
    'createWeixinLogin() 的返回就这四个键',
  );
  assert.equal(login.DEFAULT_QR_BASE_URL, 'https://ilinkai.weixin.qq.com/');
  assert.equal(DEFAULT_QR_BASE_URL, 'https://ilinkai.weixin.qq.com/');
  assert.equal(DEFAULT_BOT_TYPE, '3');
  assert.equal(POLL_INTERVAL_MS, 1_000, '控制器 1s 轮一次');
  assert.equal(QR_TTL_MS, 5 * 60_000, '二维码 5 分钟作废');
  assert.equal(MAX_TIMEOUT_MS, 120_000);

  const statuses = [...login.LOGIN_STATUSES].sort();
  assert.deepEqual(statuses, [
    'binded_redirect',
    'confirmed',
    'expired',
    'need_verifycode',
    'scaned',
    'scaned_but_redirect',
    'verify_code_blocked',
    'wait',
  ], '8 个状态与参考实现逐字一致');
  assert.equal(LOGIN_STATUSES.size, 8);
  ok('导出契约（beginLogin/pollLogin/LOGIN_STATUSES/DEFAULT_QR_BASE_URL）与 8 个状态');

  assert.equal(resolveTimeoutMs(undefined, 35_000), 35_000, '未配置 → 默认值');
  assert.equal(resolveTimeoutMs(25, 35_000), 25, '小值照用（测试靠它跑得快）');
  assert.equal(resolveTimeoutMs('500', 35_000), 500, '数字字符串照用');
  assert.equal(resolveTimeoutMs(1e12, 35_000), MAX_TIMEOUT_MS, '大值被硬性封顶');
  assert.equal(resolveTimeoutMs(Number.POSITIVE_INFINITY, 35_000), 35_000, 'Infinity 回落默认值');
  assert.equal(resolveTimeoutMs(Number.NaN, 35_000), 35_000);
  assert.equal(resolveTimeoutMs(0, 35_000), 35_000, '0 / 负数不允许把超时关掉');
  assert.equal(resolveTimeoutMs(-5, 35_000), 35_000);
  assert.equal(resolveTimeoutMs('abc', 35_000), 35_000);
  ok('超时永远有上限、有默认值，且不会被非法输入关掉');
});

// ---------------------------------------------------------------------------
// 2. beginLogin：请求形状
// ---------------------------------------------------------------------------

await section('beginLogin：POST get_bot_qrcode 的 URL / 请求头 / 请求体 / 返回值', async () => {
  const page = { qrcode: 'QR-TOKEN-1', qrcode_img_content: 'https://weixin.qq.com/x/abc?t=1' };
  const server = createRouter({ [QR_PATH]: [jsonResponse(page)] });
  const login = createWeixinLogin({ fetchImpl: server.fetchImpl });

  const result = await login.beginLogin();

  assert.equal(server.calls.length, 1);
  const call = server.calls[0];
  assert.equal(call.method, 'POST', '参考实现是 POST（任务书里的 GET 是描述笔误）');
  assert.equal(call.host, 'ilinkai.weixin.qq.com');
  assert.equal(call.path, QR_PATH);
  assert.equal(call.query, '?bot_type=3', '默认 bot_type=3');
  assert.equal(call.redirect, 'error');
  assert.ok(call.signal instanceof AbortSignal, '带了可取消的 signal');

  assert.deepEqual(Object.keys(call.headers).sort(), [
    'AuthorizationType',
    'X-WECHAT-UIN',
    'content-type',
    'iLink-App-ClientVersion',
    'iLink-App-Id',
  ], '请求头集合与参考实现完全一致（多一个少一个都算错）');
  assert.equal(call.headers['iLink-App-Id'], 'bot');
  assert.equal(call.headers['iLink-App-ClientVersion'], '132102');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers.AuthorizationType, 'ilink_bot_token', '不是 Authorization-Type');
  assert.equal(call.headers.Authorization, undefined, '拉二维码时还没有凭据，不带 Authorization');
  assert.match(Buffer.from(call.headers['X-WECHAT-UIN'], 'base64').toString('utf8'), /^\d{1,10}$/,
    'X-WECHAT-UIN = base64(随机 uint32 十进制串)');

  assert.deepEqual(call.body, { local_token_list: [] }, '不传 localTokens 就是空列表');
  assert.deepEqual(result, {
    qrcode: 'QR-TOKEN-1',
    qrcodeUrl: 'https://weixin.qq.com/x/abc?t=1',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
  });
  ok('beginLogin 的 method/路径/查询/bot 头/body/返回值全部符合协议');

  const many = Array.from({ length: 12 }, (_, index) => `tok-${index}`);
  const multi = createRouter({ [QR_PATH]: [jsonResponse(page), jsonResponse(page), jsonResponse(page)] });
  const multiLogin = createWeixinLogin({ fetchImpl: multi.fetchImpl });
  await multiLogin.beginLogin({ botType: '5', localTokens: [' a ', 'a', '', null, ...many] });
  assert.equal(multi.calls[0].query, '?bot_type=5', 'botType 可覆盖');
  assert.deepEqual(multi.calls[0].body.local_token_list, many.slice(-10), '去重 + trim + 最多留最后 10 个');
  await multiLogin.beginLogin({ botType: '' });
  assert.equal(multi.calls[1].query, '?bot_type=3', '空 botType 回落默认值');
  await multiLogin.beginLogin({ botType: 7 });
  assert.equal(multi.calls[2].query, '?bot_type=7', '数字 botType 也能用');
  ok('botType 覆盖/回落与 localTokens 去重截断（照抄 weixin-api.mjs:638）');
});

// ---------------------------------------------------------------------------
// 3. wait → confirmed 全流程（含"不打印 token"）
// ---------------------------------------------------------------------------

await section('wait → confirmed：拿到完整凭据，且全程不打印任何东西', async () => {
  const TOKEN = 'bot-token-SECRET-abc123';
  const ACCOUNT = 'wx_bot_1';
  const OWNER = 'owner@im.wechat';
  const server = createRouter({
    [QR_PATH]: [jsonResponse({
      qrcode: 'QR-TOKEN-1',
      qrcode_img_content: 'https://weixin.qq.com/x/abc',
    })],
    [STATUS_PATH]: [
      jsonResponse({ status: 'wait' }),
      jsonResponse({
        status: 'confirmed',
        bot_token: TOKEN,
        ilink_bot_id: ACCOUNT,
        ilink_user_id: OWNER,
        baseurl: 'ilinkai2.weixin.qq.com',
        extra_field: 'still here',
      }),
    ],
  });
  const login = createWeixinLogin({ fetchImpl: server.fetchImpl });

  const { captured, value } = await captureOutput(async () => {
    const begin = await login.beginLogin();
    const first = await login.pollLogin({ qrcode: begin.qrcode, baseUrl: begin.baseUrl });
    const second = await login.pollLogin({ qrcode: begin.qrcode, baseUrl: begin.baseUrl });
    return { begin, first, second };
  });

  assert.equal(value.first.status, 'wait');
  assert.equal('credentials' in value.first, false, 'wait 不带凭据');
  assert.equal(value.second.status, 'confirmed');
  assert.deepEqual(value.second.credentials, {
    token: TOKEN,
    accountId: ACCOUNT,
    ownerUserId: OWNER,
    baseUrl: 'https://ilinkai2.weixin.qq.com/',
  }, 'confirmed 的四个凭据字段名与取值（baseurl 归一化 + 补 https://）');
  assert.equal(value.second.bot_token, TOKEN, '原始响应字段原样保留（参考实现同样直接回传响应）');
  assert.equal(value.second.extra_field, 'still here');
  ok('wait → confirmed 两轮轮询拿到完整凭据，原始字段原样透传');

  assert.equal(server.calls.length, 3, '1 次拉码 + 2 次轮询');
  const poll = server.calls[1];
  assert.equal(poll.method, 'GET');
  assert.equal(poll.path, STATUS_PATH);
  assert.equal(poll.query, '?qrcode=QR-TOKEN-1');
  assert.deepEqual(poll.headers, {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '132102',
  }, 'get_qrcode_status 只有两个 iLink 头（参考实现 authenticated:false）');
  assert.equal(poll.body, null, 'GET 没有请求体');
  ok('轮询请求是 GET，且只带两个 iLink 头（无 Authorization / X-WECHAT-UIN / content-type）');

  const printed = captured.join('\n');
  assert.equal(captured.length, 0, `登录流程不该往 stdout/stderr 写任何东西，实际写了：${printed}`);
  assert.ok(!printed.includes(TOKEN), 'token 绝不能出现在输出里');
  ok('全程零输出：token 不落 stdout/stderr（console.* 与 process.std*.write 都被拦了）');
});

// ---------------------------------------------------------------------------
// 4. 其余状态
// ---------------------------------------------------------------------------

await section('expired / scaned / need_verifycode / verify_code_blocked / binded_redirect', async () => {
  const statuses = ['expired', 'scaned', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'];
  const server = createRouter({
    [STATUS_PATH]: statuses.map((status, index) => jsonResponse({ status, extra: index })),
  });
  const login = createWeixinLogin({ fetchImpl: server.fetchImpl });

  for (const [index, status] of statuses.entries()) {
    const result = await login.pollLogin({ qrcode: 'QR-1' });
    assert.equal(result.status, status);
    assert.equal('credentials' in result, false, `${status} 不该带凭据`);
    assert.equal('baseUrl' in result, false, `${status} 不该带派生 baseUrl`);
    assert.equal(result.extra, index, '原始字段透传');
  }
  ok('五个状态（含两个终止状态）原样透传，且不擅自派生字段');
});

await section('need_verifycode：verify_code 查询参数', async () => {
  const server = createRouter({ [STATUS_PATH]: [jsonResponse({ status: 'wait' })] });
  const login = createWeixinLogin({ fetchImpl: server.fetchImpl });

  await login.pollLogin({ qrcode: 'QR-1', verifyCode: '1234' });
  assert.equal(server.calls[0].query, '?qrcode=QR-1&verify_code=1234');
  await login.pollLogin({ qrcode: 'QR-1', verifyCode: ' 5678 ' });
  assert.equal(server.calls[1].query, '?qrcode=QR-1&verify_code=5678', 'verifyCode 会 trim');
  await login.pollLogin({ qrcode: 'QR-1', verifyCode: '   ' });
  assert.equal(server.calls[2].query, '?qrcode=QR-1', '空白 verifyCode 等于没传');
  await login.pollLogin({ qrcode: 'QR-1', verifyCode: '12&34' });
  assert.equal(server.calls[3].query, '?qrcode=QR-1&verify_code=12%2634', 'verifyCode 做 URL 编码');
  await login.pollLogin({ qrcode: 'a b&c' });
  assert.equal(server.calls[4].query, '?qrcode=a%20b%26c', 'qrcode 做 URL 编码');
  ok('verify_code / qrcode 的拼装与转义（&verify_code=… 追加，trim 后为空则省略）');
});

// ---------------------------------------------------------------------------
// 5. scaned_but_redirect
// ---------------------------------------------------------------------------

await section('scaned_but_redirect：redirect_host → 换 baseUrl 继续轮询', async () => {
  const server = createRouter({
    [STATUS_PATH]: [
      jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'ilinkai3.weixin.qq.com' }),
      jsonResponse({ status: 'scaned' }),
      jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'https://ilinkai4.weixin.qq.com' }),
      jsonResponse({ status: 'scaned_but_redirect', redirect_host: '' }),
    ],
  });
  const login = createWeixinLogin({ fetchImpl: server.fetchImpl });

  const redirected = await login.pollLogin({ qrcode: 'QR-1' });
  assert.equal(redirected.status, 'scaned_but_redirect');
  assert.equal(redirected.redirect_host, 'ilinkai3.weixin.qq.com', '原始字段保留');
  assert.equal(redirected.baseUrl, 'https://ilinkai3.weixin.qq.com/', '裸域名自动补 https:// 并归一化');

  const next = await login.pollLogin({ qrcode: 'QR-1', baseUrl: redirected.baseUrl });
  assert.equal(next.status, 'scaned', '换线后继续轮询');
  assert.equal(server.calls[1].host, 'ilinkai3.weixin.qq.com', '第二次请求真的打到新接入点');
  assert.equal(server.calls[1].query, '?qrcode=QR-1', '换线不丢查询参数');
  ok('scaned_but_redirect 换 baseUrl 后继续轮询（裸域名 / 带 scheme 都归一化）');

  const scheme = await login.pollLogin({ qrcode: 'QR-1' });
  assert.equal(scheme.baseUrl, 'https://ilinkai4.weixin.qq.com/', '带 scheme 的 redirect_host 直接用');

  const before = server.calls.length;
  const fallback = await login.pollLogin({ qrcode: 'QR-1' });
  assert.equal(fallback.baseUrl, 'https://ilinkai.weixin.qq.com/', 'redirect_host 为空 → 回落当前 baseUrl（apiBaseFromServer）');
  assert.equal(server.calls.length, before + 1);
  ok('redirect_host 为空时回落到当前接入点');

  const callsBefore = server.calls.length;
  const evil = await rejection(
    () => login.pollLogin({ qrcode: 'QR-1', baseUrl: 'evil.example.com' }),
    'invalid-base-url',
  );
  assert.ok(evil.message.length > 0);
  await rejection(() => login.pollLogin({ qrcode: 'QR-1', baseUrl: 'https://evil.example.com' }), 'untrusted-base-url');
  await rejection(() => login.pollLogin({ qrcode: 'QR-1', baseUrl: 'http://ilinkai.weixin.qq.com/' }), 'untrusted-base-url');
  assert.equal(server.calls.length, callsBefore, '不受信任的基址在发请求之前就被拒绝');
  ok('不受信任 / 非 https 的 baseUrl 在联网前被拒（invalid-base-url / untrusted-base-url）');
});

// ---------------------------------------------------------------------------
// 6. 脏响应与缺字段
// ---------------------------------------------------------------------------

await section('beginLogin 的脏响应', async () => {
  const page = 'https://weixin.qq.com/x/abc';
  const cases = [
    [{}, 'invalid-qr', '没有 qrcode 令牌'],
    [{ qrcode: 'q' }, 'invalid-qr', '有令牌但没扫码地址'],
    [{ qrcode: 'q', qrcode_img_content: '' }, 'invalid-qr', '扫码地址为空串'],
    [{ qrcode: 'q', qrcode_img_content: 'not a url' }, 'invalid-qr', '扫码地址不是 URL'],
    [{ qrcode: 'q', qrcode_img_content: 'http://weixin.qq.com/x' }, 'untrusted-qr', '扫码地址不是 https'],
    [{ qrcode: 'q', qrcode_img_content: 'https://evil.example.com/x' }, 'untrusted-qr', '扫码地址不是微信域名'],
    [{ errcode: 4, errmsg: 'bad bot_type' }, 'qr-request-rejected', '平台 errcode 拒绝'],
    [{ ret: '5', qrcode: 'q', qrcode_img_content: page }, 'qr-request-rejected', '平台 ret 拒绝'],
    [null, 'invalid-qr', '响应是 null'],
    ['nope', 'invalid-qr', '响应是字符串'],
  ];
  for (const [body, code, label] of cases) {
    const server = createRouter({ [QR_PATH]: [jsonResponse(body)] });
    const login = createWeixinLogin({ fetchImpl: server.fetchImpl });
    const error = await rejection(() => login.beginLogin(), code);
    assert.equal(error.name, 'WeixinTransportError', `${label}：错误类型`);
    assert.ok(!(error instanceof TypeError), `${label}：不该是裸 TypeError`);
  }
  assert.equal(cases.length, 10);

  const providerServer = createRouter({ [QR_PATH]: [jsonResponse({ errcode: 4, errmsg: 'bad bot_type' })] });
  const providerError = await rejection(
    () => createWeixinLogin({ fetchImpl: providerServer.fetchImpl }).beginLogin(),
    'qr-request-rejected',
  );
  assert.equal(providerError.providerCode, '4', 'providerCode 带上平台返回值');
  const retServer = createRouter({ [QR_PATH]: [jsonResponse({ ret: '5' })] });
  assert.equal(
    (await rejection(() => createWeixinLogin({ fetchImpl: retServer.fetchImpl }).beginLogin(), 'qr-request-rejected')).providerCode,
    '5',
  );
  ok('10 种脏 beginLogin 响应各自落到正确的 code（含 qr-request-rejected + providerCode）');
});

await section('pollLogin 的脏响应与缺字段', async () => {
  const cases = [
    [{}, 'invalid-login-status', '没有 status'],
    [{ status: 'nope' }, 'invalid-login-status', 'status 不认识'],
    [{ status: 'WAIT' }, 'invalid-login-status', 'status 大小写敏感'],
    [{ status: null }, 'invalid-login-status', 'status 是 null'],
    [{ status: 3 }, 'invalid-login-status', 'status 是数字'],
    ['wait', 'invalid-login-status', '响应是字符串'],
    [[{ status: 'wait' }], 'invalid-login-status', '响应是数组'],
  ];
  for (const [body, code, label] of cases) {
    const server = createRouter({ [STATUS_PATH]: [jsonResponse(body)] });
    const login = createWeixinLogin({ fetchImpl: server.fetchImpl });
    const error = await rejection(() => login.pollLogin({ qrcode: 'QR-1' }), code);
    assert.equal(error.name, 'WeixinTransportError', `${label}：错误类型`);
  }
  assert.equal(cases.length, 7);

  const truncated = createRouter({ [STATUS_PATH]: [brokenJsonResponse()] });
  await rejection(() => createWeixinLogin({ fetchImpl: truncated.fetchImpl }).pollLogin({ qrcode: 'QR-1' }), 'invalid-response');
  const truncatedBegin = createRouter({ [QR_PATH]: [brokenJsonResponse()] });
  await rejection(() => createWeixinLogin({ fetchImpl: truncatedBegin.fetchImpl }).beginLogin(), 'invalid-response');
  ok('7 种脏 pollLogin 响应 → invalid-login-status；非 JSON → invalid-response');

  const missing = [
    [{ status: 'confirmed', ilink_bot_id: 'b', ilink_user_id: 'u' }, 'bot_token'],
    [{ status: 'confirmed', bot_token: 'SECRET-TOKEN-VALUE', ilink_user_id: 'u' }, 'ilink_bot_id'],
    [{ status: 'confirmed', bot_token: 'SECRET-TOKEN-VALUE', ilink_bot_id: 'b' }, 'ilink_user_id'],
    [{ status: 'confirmed', bot_token: '   ', ilink_bot_id: 'b', ilink_user_id: 'u' }, 'bot_token'],
  ];
  for (const [body, field] of missing) {
    const server = createRouter({ [STATUS_PATH]: [jsonResponse(body)] });
    const login = createWeixinLogin({ fetchImpl: server.fetchImpl });
    const error = await rejection(() => login.pollLogin({ qrcode: 'QR-1' }), 'incomplete-login');
    assert.match(error.message, new RegExp(field), `错误消息点出缺的字段名：${field}`);
    assert.ok(!error.message.includes('SECRET-TOKEN-VALUE'), '错误消息里绝不能出现 token 值');
  }
  ok('confirmed 缺任一凭据字段 → incomplete-login，且错误消息只报字段名不报值');

  const fallback = createRouter({
    [STATUS_PATH]: [jsonResponse({
      status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'u', baseurl: '',
    })],
  });
  const result = await createWeixinLogin({ fetchImpl: fallback.fetchImpl })
    .pollLogin({ qrcode: 'QR-1', baseUrl: 'https://ilinkai2.weixin.qq.com/' });
  assert.equal(result.credentials.baseUrl, 'https://ilinkai2.weixin.qq.com/', 'baseurl 为空时回落当前接入点');
  ok('confirmed 缺 baseurl 时回落到轮询用的 baseUrl（apiBaseFromServer 语义）');

  const bare = createWeixinLogin({ fetchImpl: async () => jsonResponse({ status: 'wait' }) });
  await rejection(() => bare.pollLogin({}), 'invalid-qr');
  await rejection(() => bare.pollLogin({ qrcode: '   ' }), 'invalid-qr');
  await rejection(() => bare.pollLogin({ qrcode: 12345 }), 'invalid-qr');
  ok('pollLogin 缺 qrcode 参数 → invalid-qr（不是裸 TypeError，偏离 D3）');
});

// ---------------------------------------------------------------------------
// 7. HTTP / 网络 / 超时 / 取消
// ---------------------------------------------------------------------------

await section('HTTP 非 2xx 与网络抛错', async () => {
  const begin500 = createRouter({ [QR_PATH]: [jsonResponse({}, 500)] });
  const error500 = await rejection(() => createWeixinLogin({ fetchImpl: begin500.fetchImpl }).beginLogin(), 'http-error');
  assert.equal(error500.status, 500, 'HTTP 状态原样带上');

  const poll404 = createRouter({ [STATUS_PATH]: [jsonResponse({}, 404)] });
  const error404 = await rejection(() => createWeixinLogin({ fetchImpl: poll404.fetchImpl }).pollLogin({ qrcode: 'q' }), 'http-error');
  assert.equal(error404.status, 404);
  assert.ok(typeof error404.durationMs === 'number', '失败也带 durationMs');

  const poll403 = createRouter({ [STATUS_PATH]: [jsonResponse({}, 403)] });
  assert.equal((await rejection(() => createWeixinLogin({ fetchImpl: poll403.fetchImpl }).pollLogin({ qrcode: 'q' }), 'http-error')).status, 403);
  ok('HTTP 500/404/403 → http-error + .status + .durationMs');

  const boom = new TypeError('fetch failed');
  const offline = createServer(() => { throw boom; });
  const network = await rejection(() => createWeixinLogin({ fetchImpl: offline.fetchImpl }).beginLogin(), 'network-error');
  assert.equal(network.cause, boom, '原始错误挂在 cause 上');
  ok('fetch 抛错 → network-error（cause 保留原异常）');
});

await section('超时与 signal 取消', async () => {
  const hangServer = createServer(hang);
  const slowPoll = createWeixinLogin({ fetchImpl: hangServer.fetchImpl, pollTimeoutMs: 25 });
  const timeout = await rejection(() => slowPoll.pollLogin({ qrcode: 'q' }), 'timeout');
  assert.equal(timeout.timeoutMs, 25, '错误里带回本次生效的超时值');
  assert.ok(typeof timeout.durationMs === 'number' && timeout.durationMs >= 25);
  assert.ok(hangServer.calls[0].signal.aborted, '超时走的是 abort 通道，请求确实被中断了');
  ok('轮询超时 → timeout（可配置、带 timeoutMs，且真的中断了在途请求）');

  const slowBegin = createWeixinLogin({ fetchImpl: createServer(hang).fetchImpl, beginTimeoutMs: 25 });
  assert.equal((await rejection(() => slowBegin.beginLogin(), 'timeout')).timeoutMs, 25);
  ok('拉二维码超时 → timeout（默认 10s，可配置）');

  const abortServer = createServer(hang);
  const login = createWeixinLogin({ fetchImpl: abortServer.fetchImpl, pollTimeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = login.pollLogin({ qrcode: 'q', signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const aborted = await cancellation(() => pending);
  assert.equal(aborted.name, 'AbortError', 'signal 取消 → AbortError，不是 timeout');
  assert.ok(abortServer.calls[0].signal.aborted);
  ok('signal 取消抛出 AbortError（与 timeout 严格区分）');

  const reasonServer = createServer(hang);
  const reasonLogin = createWeixinLogin({ fetchImpl: reasonServer.fetchImpl, pollTimeoutMs: 5_000 });
  const reasonController = new AbortController();
  const custom = new Error('用户关掉了扫码窗口');
  const pendingReason = reasonLogin.pollLogin({ qrcode: 'q', signal: reasonController.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  reasonController.abort(custom);
  assert.equal(await cancellation(() => pendingReason, { name: null }), custom, 'signal.reason 是 Error 就原样抛出');
  ok('signal.reason 是 Error 时原样抛出（参考实现 abortError 语义）');

  const preAborted = createServer(() => jsonResponse({ status: 'wait' }));
  const preLogin = createWeixinLogin({ fetchImpl: preAborted.fetchImpl });
  const preController = new AbortController();
  preController.abort();
  const immediate = await cancellation(() => preLogin.pollLogin({ qrcode: 'q', signal: preController.signal }));
  assert.equal(immediate.name, 'AbortError');
  assert.equal(preAborted.calls.length, 0, '已经取消的 signal 不会再发请求');
  await cancellation(() => preLogin.beginLogin({ signal: preController.signal }));
  assert.equal(preAborted.calls.length, 0, 'beginLogin 同理');
  ok('调用前就已取消的 signal → 立刻 AbortError，且一个请求都不发');
});

// ---------------------------------------------------------------------------

console.log('');
if (failed > 0) {
  console.log(`${failed} 个用例组失败：`);
  for (const { title, error } of failures) {
    console.log(`  - ${title}`);
    console.log(`    ${(error?.stack ?? String(error)).split('\n').slice(0, 3).join('\n    ')}`);
  }
  process.exitCode = 1;
  console.log(`transport login: ${passed} checks passed, ${failed} sections failed`);
} else {
  console.log(`transport login: ${passed} checks passed`);
}
