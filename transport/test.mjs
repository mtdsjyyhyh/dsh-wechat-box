/**
 * test.mjs — weixin.mjs 传输层的离线测试套件。
 *
 * 全部用例都通过 `fetchImpl` 打桩，**绝不真连网**，也绝不真给微信发消息。
 * 跑法：<node 绝对路径> <repo>\transport\test.mjs
 *
 * 覆盖：
 *   1. 长轮询循环拿到消息并回调 onMessage，结构符合契约
 *   2. 同 messageId 重复投递只回调一次（批内 / 跨批 / 跨重启）
 *   3. sendText 的请求体与请求头正确（含 context_token），成功与失败两条路径
 *   4. 网络异常 → 退避重试不崩；长轮询超时视为正常；平台判死则停轮询
 *   5. context_token 持久化 + 重启恢复 + 单调性护栏
 *   6. stop() 后不再有回调、在途请求被中断、定时器清空
 *   7. 凭据读取：env 优先，其次极简 YAML 解析（含引号值）
 *   8. 纯函数边界：extractYamlScalar / weixinMessageTimestampMs / classifyError / orderWeixinMessages
 */

import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyError,
  createWeixinTransport,
  extractYamlScalar,
  orderWeixinMessages,
  weixinMessageTimestampMs,
} from './weixin.mjs';

// ---------------------------------------------------------------------------
// 迷你测试运行器
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

function waitFor(predicate, { timeout = 3_000, interval = 5, label = '条件' } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt > timeout) {
        reject(new Error(`waitFor 超时（${timeout}ms）：${label}`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 打桩：一个可路由的 fetch 替身
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

/** 二进制上传的响应体为空，只需要一个 2xx。 */
function emptyResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return {}; },
    async text() { return ''; },
  };
}

/** CDN 上传的回执在响应头里（x-encrypted-param），body 是空的。 */
function headerResponse(status, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async json() { return {}; },
    async text() { return ''; },
  };
}

/** 只在 body 真的是 JSON 时才解析，二进制体（文件上传）原样保留。 */
function tryParseJson(body) {
  if (typeof body !== 'string') return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function makeAbortError() {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** 永不 resolve，直到 signal 被 abort —— 模拟被服务端 hold 住的长轮询。 */
function hang(record, init) {
  return new Promise((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
  });
}

function createServer(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const path = new URL(href).pathname;
    const record = {
      url: href,
      path,
      method: init.method,
      headers: { ...(init.headers ?? {}) },
      // 上传是二进制体，JSON.parse 会炸；保留原字节供断言，并只在能解析时给出 body。
      rawBody: init.body ?? null,
      body: init.body && !(init.body instanceof Uint8Array) ? tryParseJson(init.body) : null,
      hasSignal: Boolean(init.signal),
      aborted: false,
      at: Date.now(),
    };
    init.signal?.addEventListener('abort', () => { record.aborted = true; }, { once: true });
    calls.push(record);
    const handler = routes[path];
    if (!handler) throw new Error(`测试桩收到未预期的请求：${init.method} ${path}`);
    return await handler(record, init);
  };
  fetchImpl.calls = calls;
  fetchImpl.callsTo = (path) => calls.filter((call) => call.path === path);
  return fetchImpl;
}

/** 依次返回给定的 getupdates 批次，用完之后一直 hold 住。 */
function scriptedUpdates(batches) {
  let index = 0;
  const handler = (record, init) => {
    if (index < batches.length) {
      const batch = batches[index];
      index += 1;
      return jsonResponse(batch);
    }
    return hang(record, init);
  };
  handler.served = () => index;
  return handler;
}

/** 永远返回固定 getupdates 响应（用于暂停循环、注入单条消息）。 */
function fixedUpdates(batch) {
  return () => jsonResponse(batch);
}

// ---------------------------------------------------------------------------
// 常量与夹具
// ---------------------------------------------------------------------------

const BASE_URL = 'https://ilinkai.weixin.qq.com/';
const BOT_ID = 'wx_example_bot_id';
const ACCOUNT_ID = 'abc@im.bot';
const OWNER = 'owner@im.wechat';
const TOKEN = 'test-token-0123456789abcdef';
const ENV_KEY = 'DSH_TEST_WEIXIN_TOKEN';

const ROUTE_START = '/ilink/bot/msg/notifystart';
const ROUTE_STOP = '/ilink/bot/msg/notifystop';
const ROUTE_UPDATES = '/ilink/bot/getupdates';
const ROUTE_SEND = '/ilink/bot/sendmessage';

function lifecycleRoutes() {
  return {
    [ROUTE_START]: () => jsonResponse({ ret: 0 }),
    [ROUTE_STOP]: () => jsonResponse({ ret: 0 }),
  };
}

let sequence = 0;
function inbound({
  id,
  from = OWNER,
  text = '你好',
  contextToken = null,
  createTimeMs = 1_700_000_000_000,
  seq = null,
  messageType = 1,
  itemList = undefined,
} = {}) {
  sequence += 1;
  const message = {
    message_id: id,
    from_user_id: from,
    message_type: messageType,
    seq: seq === null ? String(sequence) : String(seq),
    create_time_ms: createTimeMs,
    item_list: itemList ?? [{ type: 1, text_item: { text } }],
  };
  if (contextToken) message.context_token = contextToken;
  return message;
}

function recordingLogger() {
  const lines = [];
  const make = (level) => (...args) => {
    lines.push(`${level} ${args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')}`);
  };
  return { lines, info: make('info'), warn: make('warn'), error: make('error') };
}

const root = await mkdtemp(join(tmpdir(), 'weixin-transport-test-'));
let caseIndex = 0;
async function caseDir() {
  caseIndex += 1;
  const dir = join(root, `case-${caseIndex}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function envFor(token = TOKEN) {
  return { [ENV_KEY]: token };
}

function baseOptions(statePath, fetchImpl, extra = {}) {
  return {
    botId: BOT_ID,
    accountId: ACCOUNT_ID,
    baseUrl: BASE_URL,
    tokenRef: ENV_KEY,
    statePath,
    fetchImpl,
    env: envFor(),
    // 测试里把时间尺度全部压小，避免任何用例依赖真实秒级等待。
    longPollTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    backoffBaseMs: 20,
    backoffMaxMs: 60,
    ...extra,
  };
}

/** 跑完一个用例后务必调用：停轮询 + 释放定时器。 */
async function shutdown(transport) {
  try {
    await transport.stop();
  } catch {
    /* 清理阶段的异常不该掩盖用例本身的断言结果 */
  }
}

// ===========================================================================
// 1. 长轮询 + onMessage 契约
// ===========================================================================

await test('1. 长轮询拿到消息并按契约回调 onMessage（含排序与游标落盘）', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const logger = recordingLogger();

  const later = inbound({ id: '7514359851928797002', text: '第二条', seq: 2, createTimeMs: 1_700_000_000_500 });
  const earlier = inbound({ id: '7514359851928797001', text: '第一条', seq: 1, createTimeMs: 1_700_000_000_100 });
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [later, earlier], get_updates_buf: 'buf-1' },
    ]),
  });

  const received = [];
  const transport = createWeixinTransport(baseOptions(statePath, server, { logger }));
  try {
    const initial = await transport.start((msg) => received.push(msg));
    assert.equal(initial.connected, false, 'start() 返回时首次轮询尚未完成，connected 应为 false');
    assert.equal(initial.pollCount, 0);

    await waitFor(() => received.length === 2, { label: '两条消息回调' });

    // --- 契约字段 ---
    const first = received[0];
    assert.equal(first.kind, 'text');
    assert.equal(first.userId, OWNER);
    assert.equal(first.messageId, '7514359851928797001');
    assert.equal(first.text, '第一条');
    assert.equal(first.at, 1_700_000_000_100, 'at 应取 create_time_ms');
    assert.equal(typeof first.at, 'number');
    assert.equal(first.raw.message_id, '7514359851928797001', 'raw 应是原始载荷');
    assert.equal(first.raw.context_token, undefined);

    // 批内按 seq 升序派发（平台给的顺序是倒的）
    assert.deepEqual(received.map((msg) => msg.text), ['第一条', '第二条'], '应按 seq 升序派发');

    await waitFor(() => transport.status().connected === true, { label: 'connected=true' });
    const status = transport.status();
    assert.ok(status.pollCount >= 1, `pollCount 应 >= 1，实际 ${status.pollCount}`);
    assert.ok(status.lastInboundAt > 0, 'lastInboundAt 应被设置');
    assert.equal(status.lastError, null);

    // 请求体：游标 + base_info
    const pollCall = server.callsTo(ROUTE_UPDATES)[0];
    assert.equal(pollCall.method, 'POST');
    assert.equal(pollCall.body.get_updates_buf, '', '首次轮询游标应为空串');
    assert.equal(pollCall.body.base_info.channel_version, '2.4.6');
    assert.ok(pollCall.body.base_info.bot_agent, 'base_info 应带 bot_agent');
    assert.equal(
      pollCall.url,
      `${BASE_URL}ilink/bot/getupdates`,
      '端点必须是 ilink/bot/getupdates',
    );

    // 游标必须在本批处理完之后才落盘
    await waitFor(() => transport.stateSnapshot().getUpdatesBuf === 'buf-1', { label: '游标落盘' });
    assert.deepEqual(transport.stateSnapshot().seenMessageIds, [
      '7514359851928797001',
      '7514359851928797002',
    ]);
  } finally {
    await shutdown(transport);
  }
});

// ===========================================================================
// 2. 去重
// ===========================================================================

await test('2. 同 messageId 重复投递只回调一次（批内 + 跨批）', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const duplicate = inbound({ id: '7514359851928798001', text: '只该出现一次', seq: 1 });
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [duplicate, duplicate], get_updates_buf: 'buf-a' },
      { ret: 0, msgs: [duplicate], get_updates_buf: 'buf-b' },
      { ret: 0, msgs: [duplicate], get_updates_buf: 'buf-c' },
    ]),
  });

  const received = [];
  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start((msg) => received.push(msg));
    await waitFor(() => server.callsTo(ROUTE_UPDATES).length >= 3, { label: '三轮轮询' });
    await sleep(60);
    assert.equal(received.length, 1, `重复投递被去重，实际回调 ${received.length} 次`);
  } finally {
    await shutdown(transport);
  }
});

await test('2b. 出站回显（message_type=2）与无 id / 无发送者的消息一律不回调', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      {
        ret: 0,
        msgs: [
          inbound({ id: '7514359851928798002', text: '我自己发出去的', messageType: 2 }),
          // 既没有 message_id 也没有 client_id → 无法去重，必须整条丢弃
          { from_user_id: OWNER, item_list: [{ type: 1, text_item: { text: '没有 id' } }] },
          { message_id: '7514359851928798004', from_user_id: '', item_list: [{ type: 1, text_item: { text: '没有发送者' } }] },
          inbound({ id: '7514359851928798005', text: '唯一该回调的' }),
        ],
        get_updates_buf: 'buf',
      },
    ]),
  });

  const received = [];
  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start((msg) => received.push(msg));
    await waitFor(() => received.length >= 1, { label: '至少一条' });
    await sleep(40);
    assert.equal(received.length, 1);
    assert.equal(received[0].text, '唯一该回调的');
  } finally {
    await shutdown(transport);
  }
});

// ===========================================================================
// 3. sendText：请求体 / 请求头 / 成功与失败
// ===========================================================================

await test('3. sendText 请求体与请求头正确，成功路径返回 { ok: true }', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851928799001', contextToken: 'CT-AAA', seq: 1 })], get_updates_buf: 'buf' },
    ]),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start(() => {});
    await waitFor(() => transport.status().connected === true, { label: '首次轮询完成' });

    const result = await transport.sendText(OWNER, ' 你好，世界 ');
    assert.deepEqual({ ...result, response: undefined }, {
      ok: true,
      messageId: result.messageId,
      contextTokenUsed: true,
      response: undefined,
    });
    assert.match(result.messageId, /^dsh-weixin-[0-9a-f-]{36}$/, 'client_id 前缀必须是 dsh-weixin-');
    assert.ok(transport.status().lastOutboundAt > 0, 'lastOutboundAt 应被设置');

    const call = server.callsTo(ROUTE_SEND)[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${BASE_URL}ilink/bot/sendmessage`);

    // --- 请求头（weixin-api.mjs:289-305）---
    assert.equal(call.headers['iLink-App-Id'], 'bot');
    assert.equal(call.headers['iLink-App-ClientVersion'], '132102');
    assert.equal(call.headers.AuthorizationType, 'ilink_bot_token');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['content-type'], 'application/json');
    const uin = Buffer.from(call.headers['X-WECHAT-UIN'], 'base64').toString('utf8');
    assert.match(uin, /^\d{1,10}$/, `X-WECHAT-UIN 应是随机 uint32 的十进制 base64，实际解码为 ${uin}`);

    // --- 请求体 ---
    const msg = call.body.msg;
    assert.equal(msg.from_user_id, '', 'from_user_id 必须为空串（由平台填充）');
    assert.equal(msg.to_user_id, OWNER);
    assert.equal(msg.client_id, result.messageId);
    assert.equal(msg.message_type, 2, '出站固定 message_type=2');
    assert.equal(msg.message_state, 2);
    assert.deepEqual(msg.item_list, [{ type: 1, text_item: { text: '你好，世界' } }], '文本前后空白应被 trim');
    assert.equal(msg.context_token, 'CT-AAA', '必须带上该用户最新的 context_token');
    assert.equal(call.body.base_info.channel_version, '2.4.6');
  } finally {
    await shutdown(transport);
  }
});

await test('3b. sendText 失败路径：平台 ret/errcode 拒绝、HTTP 错误、参数非法', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  let sendMode = 'ret-reject';
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851928800001', contextToken: 'CT-BBB', seq: 1 })], get_updates_buf: 'buf' },
    ]),
    [ROUTE_SEND]: () => {
      if (sendMode === 'ret-reject') return jsonResponse({ ret: -1 });
      if (sendMode === 'errcode-reject') return jsonResponse({ ret: 0, errcode: 40001 });
      if (sendMode === 'http-500') return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse({ ret: 0 });
    },
  });

  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start(() => {});
    await waitFor(() => transport.status().connected === true, { label: '首次轮询完成' });

    const rejected = await transport.sendText(OWNER, 'hi');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'send-rejected');
    assert.equal(rejected.providerCode, '-1');
    assert.ok(rejected.message, '失败必须带可读 message');

    sendMode = 'errcode-reject';
    const errcode = await transport.sendText(OWNER, 'hi');
    assert.equal(errcode.ok, false);
    assert.equal(errcode.code, 'send-rejected');
    assert.equal(errcode.providerCode, '40001', 'errcode 非 0 同样算平台拒绝');

    sendMode = 'http-500';
    const httpFailed = await transport.sendText(OWNER, 'hi');
    assert.equal(httpFailed.ok, false);
    assert.equal(httpFailed.code, 'http-error');
    assert.equal(httpFailed.status, 500);
    assert.ok(transport.status().lastError, 'status().lastError 应反映发送失败');

    sendMode = 'ok';
    const ok = await transport.sendText(OWNER, 'hi');
    assert.equal(ok.ok, true);
    assert.equal(transport.status().lastError, null, '成功发送后 lastError 应清空');

    const blank = await transport.sendText(OWNER, '   ');
    assert.equal(blank.ok, false);
    assert.equal(blank.code, 'invalid-argument');
    const noUser = await transport.sendText('', 'hi');
    assert.equal(noUser.ok, false);
    assert.equal(noUser.code, 'invalid-argument');
  } finally {
    await shutdown(transport);
  }
});

await test('3c. 没有 context_token 时请求体省略该字段（不写空串）', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851928800101', seq: 1 })], get_updates_buf: 'buf' },
    ]),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start(() => {});
    await waitFor(() => transport.status().connected === true, { label: '首次轮询完成' });

    const result = await transport.sendText(OWNER, 'hi');
    assert.equal(result.ok, true);
    assert.equal(result.contextTokenUsed, false);
    const msg = server.callsTo(ROUTE_SEND)[0].body.msg;
    assert.ok(!Object.hasOwn(msg, 'context_token'), '未知对话能力时应省略 context_token 字段');
  } finally {
    await shutdown(transport);
  }
});

// ===========================================================================
// 3c. sendFile：getuploadurl → CDN PUT（AES-128-ECB）→ sendmessage(type=4)
// ===========================================================================

const ROUTE_UPLOAD_URL = '/ilink/bot/getuploadurl';
const CDN_HOST = '/cdn-upload';

await test('3e. sendFile 三步走：getuploadurl → 加密POST到CDN → sendmessage item type=4', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const filePath = join(dir, '报告 final.pdf');
  // 故意不是 16 字节的整数倍：会触发 PKCS#7 填充，顺带验证密文长度 = 填充后长度。
  const plain = Buffer.from('DeepSeek Harness 文件正文 hello world', 'utf8');
  await writeFile(filePath, plain);

  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851920000001', contextToken: 'CT-FILE', seq: 1 })], get_updates_buf: 'buf' },
    ]),
    [ROUTE_UPLOAD_URL]: () => jsonResponse({
      ret: 0,
      upload_param: 'ENC-QUERY-PARAM',
      // 真实响应里 URL 还带 taskid，客户端自己拼是拼不出来的 —— 所以必须原样使用。
      upload_full_url: `https://novac2c.cdn.weixin.qq.com${CDN_HOST}?encrypted_query_param=ENC-QUERY-PARAM&filekey=FK&taskid=TASK-1`,
    }),
    // CDN 把真正的下载参数放在响应头 x-encrypted-param 里。
    [CDN_HOST]: () => headerResponse(200, { 'x-encrypted-param': 'DOWNLOAD-PARAM-FROM-HEADER' }),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start(() => {});
    await waitFor(() => transport.status().connected === true, { label: '首次轮询完成' });

    const result = await transport.sendFile(OWNER, filePath);
    assert.equal(result.ok, true, `sendFile 应成功，实际 ${JSON.stringify(result)}`);
    assert.equal(result.fileName, '报告 final.pdf', '文件名要取 basename');
    assert.equal(result.fileSize, plain.length);
    assert.equal(result.contextTokenUsed, true);
    assert.match(result.messageId, /^dsh-weixin-[0-9a-f-]{36}$/);

    // --- 第 1 步：getuploadurl 的请求体（明文/密文两组字段都要对）---------
    const urlCall = server.callsTo(ROUTE_UPLOAD_URL)[0];
    assert.equal(urlCall.method, 'POST');
    assert.equal(urlCall.body.media_type, 3, '文件的上传槽位是 3（不是 item 的 4）');
    assert.equal(urlCall.body.to_user_id, OWNER);
    assert.equal(urlCall.body.rawsize, plain.length, 'rawsize 是明文大小');
    assert.equal(
      urlCall.body.rawfilemd5,
      createHash('md5').update(plain).digest('hex'),
      'rawfilemd5 是明文 MD5',
    );
    assert.equal(urlCall.body.no_need_thumb, true, '文件没有缩略图，必须显式声明');
    // filekey 是客户端现生成的随机 16 字节 hex，**不是**文件名。
    assert.match(urlCall.body.filekey, /^[0-9a-f]{32}$/, 'filekey 是随机 16 字节 hex');
    assert.notEqual(urlCall.body.filekey, '报告 final.pdf', 'filekey 不是文件名');
    // 官方 upload.ts 用 `aeskey.toString("hex")`：这里是 **hex**，不是 base64。
    assert.match(urlCall.body.aeskey, /^[0-9a-f]{32}$/, 'getuploadurl 的 aeskey 是 hex 字符串');
    const aesKey = Buffer.from(urlCall.body.aeskey, 'hex');
    assert.equal(aesKey.length, 16, 'aeskey 是 128 位密钥');
    const expectedCipherLength = Math.ceil((plain.length + 1) / 16) * 16;
    assert.equal(urlCall.body.filesize, expectedCipherLength, 'filesize 是填充后的密文长度');

    // --- 第 2 步：CDN **POST** 的就是那段密文 ------------------------------
    const putCall = server.callsTo(CDN_HOST)[0];
    assert.equal(putCall.method, 'POST', '官方 cdn-upload.ts 用的是 POST，不是 PUT');
    // upload_full_url 必须原样使用：里面带服务端签发的 taskid，自己拼不出来。
    assert.match(putCall.url, /taskid=TASK-1/, 'upload_full_url 必须原样使用（含服务端 taskid）');
    assert.match(putCall.url, /encrypted_query_param=ENC-QUERY-PARAM/);
    assert.ok(putCall.rawBody instanceof Uint8Array, '上传体必须是二进制');
    assert.equal(putCall.rawBody.length, expectedCipherLength);
    assert.equal(putCall.headers.Authorization, undefined, 'CDN 是预签名地址，不该带 Bearer');
    assert.equal(putCall.headers.AuthorizationType, undefined);
    // 用拿到的 aeskey 解回来，必须逐字节等于原文件。
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(putCall.rawBody)), decipher.final()]);
    assert.deepEqual(decrypted, plain, '密文必须能被 aeskey 解回原文');

    // --- 第 3 步：sendmessage 里是 type=4 + file_item ----------------------
    const sendCall = server.callsTo(ROUTE_SEND)[0];
    const msg = sendCall.body.msg;
    assert.equal(msg.from_user_id, '');
    assert.equal(msg.to_user_id, OWNER);
    assert.equal(msg.message_type, 2);
    assert.equal(msg.message_state, 2);
    assert.equal(msg.context_token, 'CT-FILE', '必须带 context_token，否则平台静默丢弃');
    assert.equal(msg.item_list.length, 1);
    const item = msg.item_list[0];
    assert.equal(item.type, 4, '文件消息的 item type 是 4');
    assert.equal(item.file_item.file_name, '报告 final.pdf');
    // 官方 FileItem: { media, file_name, len }。len 是**明文字节数的字符串**。
    assert.equal(item.file_item.len, String(plain.length), 'len 是明文字节数的字符串');
    assert.equal(typeof item.file_item.len, 'string', 'len 必须是字符串，不是数字');
    assert.equal(item.file_item.md5, undefined, '官方 FileItem 没有 md5 字段');
    assert.equal(item.file_item.media_id, undefined, 'media_id 是 hub 扩展，不是官方协议');
    // media 引用来自 CDN 响应头 x-encrypted-param，不是 body 的 upload_param。
    assert.equal(item.file_item.media.encrypt_query_param, 'DOWNLOAD-PARAM-FROM-HEADER');
    assert.equal(item.file_item.media.encrypt_type, 1);
    // aes_key 是 base64(hex 字符串) —— 与 getuploadurl 的纯 hex 不同。
    const decodedKey = Buffer.from(item.file_item.media.aes_key, 'base64').toString('utf8');
    assert.match(decodedKey, /^[0-9a-f]{32}$/, 'media.aes_key 是 base64 过的 hex 串');
    assert.equal(decodedKey, urlCall.body.aeskey, '两处编码不同，但必须是同一把密钥');
    assert.equal(item.text_item, undefined, '文件消息不该附带空 text_item');
  } finally {
    await shutdown(transport);
  }
});

await test('3f. sendFile 失败路径：文件不存在 / 过大 / 空文件 / 无 context_token', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const server = createServer({
    ...lifecycleRoutes(),
    // 不给任何 context_token：模拟「对方还没发过消息」
    [ROUTE_UPDATES]: scriptedUpdates([{ ret: 0, msgs: [], get_updates_buf: 'buf' }]),
    [ROUTE_UPLOAD_URL]: () => jsonResponse({ ret: 0, upload_param: 'P', upload_full_url: `https://novac2c.cdn.weixin.qq.com${CDN_HOST}` }),
    // CDN 把真正的下载参数放在响应头 x-encrypted-param 里。
    [CDN_HOST]: () => headerResponse(200, { 'x-encrypted-param': 'DOWNLOAD-PARAM-FROM-HEADER' }),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start(() => {});
    await waitFor(() => transport.status().connected === true, { label: '首次轮询完成' });

    const missing = await transport.sendFile(OWNER, join(dir, 'nope.pdf'));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'ENOENT', '不存在的文件要如实报 ENOENT');

    const emptyPath = join(dir, 'empty.txt');
    await writeFile(emptyPath, '');
    const empty = await transport.sendFile(OWNER, emptyPath);
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'empty-file');

    const dirAsFile = await transport.sendFile(OWNER, dir);
    assert.equal(dirAsFile.ok, false);
    assert.equal(dirAsFile.code, 'not-a-file');

    const badArgs = await transport.sendFile(OWNER, '');
    assert.equal(badArgs.ok, false);
    assert.equal(badArgs.code, 'invalid-argument');

    // 走到最后一步才缺 context_token：此时上传已经发生，但没有可投递的会话。
    const realPath = join(dir, 'ok.txt');
    await writeFile(realPath, 'x');
    const noToken = await transport.sendFile(OWNER, realPath);
    assert.equal(noToken.ok, false);
    assert.equal(noToken.code, 'no-context-token', '没有 context_token 就不能假装成功');
    assert.equal(server.callsTo(ROUTE_SEND).length, 0, '没有 context_token 不应真的去发消息');
  } finally {
    await shutdown(transport);
  }
});

// ===========================================================================
// 4. 可靠性：退避重试 / 长轮询超时 / 致命错误
// ===========================================================================

await test('4. 网络异常 → 指数退避重试且不崩，成功后 status() 恢复正常', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const logger = recordingLogger();
  let attempts = 0;
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: (record, init) => {
      attempts += 1;
      if (attempts <= 2) throw new TypeError('fetch failed');           // 模拟 DNS/连接失败
      if (attempts === 3) {
        return jsonResponse({
          ret: 0,
          msgs: [inbound({ id: '7514359851928801001', text: '断线后收到', seq: 1 })],
          get_updates_buf: 'buf-recovered',
        });
      }
      return hang(record, init);
    },
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  const received = [];
  const transport = createWeixinTransport(baseOptions(statePath, server, { logger }));
  try {
    await transport.start((msg) => received.push(msg));
    await waitFor(() => received.length === 1, { label: '重试后拿到消息' });

    const pollCalls = server.callsTo(ROUTE_UPDATES);
    assert.ok(pollCalls.length >= 3, `应有 3 次以上轮询，实际 ${pollCalls.length}`);
    const gap1 = pollCalls[1].at - pollCalls[0].at;
    const gap2 = pollCalls[2].at - pollCalls[1].at;
    assert.ok(gap1 >= 15, `第一次退避应约等于 backoffBaseMs(20)，实际 ${gap1}ms`);
    assert.ok(gap2 >= 35, `第二次退避应按指数翻倍（约 40ms），实际 ${gap2}ms`);

    assert.ok(
      logger.lines.some((line) => line.includes('长轮询失败')),
      `应记录长轮询失败日志，实际日志：\n${logger.lines.join('\n')}`,
    );

    const status = transport.status();
    assert.equal(status.connected, true, '恢复后 connected 应为 true');
    assert.equal(status.consecutiveFailures, 0, '成功后连续失败计数应清零');
    assert.equal(status.lastError, null, '成功后 lastError 应清空');
    assert.ok(status.pollCount >= 3, `pollCount 应把失败轮次也计入，实际 ${status.pollCount}`);

    // 全链路：断线重连后仍能正常发消息
    const send = await transport.sendText(OWNER, 'ping');
    assert.equal(send.ok, true);
  } finally {
    await shutdown(transport);
  }
});

await test('4b. 长轮询客户端超时 ≠ 网络故障（保持 connected，游标不变）', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const logger = recordingLogger();
  // 永远 hold 住 → 只会由客户端 longPollTimeoutMs 超时收场
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: (record, init) => hang(record, init),
  });

  const transport = createWeixinTransport(baseOptions(statePath, server, { logger, longPollTimeoutMs: 40 }));
  try {
    await transport.start(() => {});
    await waitFor(() => transport.status().pollCount >= 2, { label: '至少两次超时轮次' });

    const status = transport.status();
    assert.equal(status.connected, true, '长轮询超时是正常现象，connected 必须保持 true');
    assert.equal(status.lastError, null, '超时不该被当成错误上报');
    assert.equal(
      status.lastErrorInfo,
      null,
      '超时不该产生 lastErrorInfo（若这里失败，说明把服务端 hold 当成了故障）',
    );
    assert.equal(
      logger.lines.filter((line) => line.includes('长轮询失败')).length,
      0,
      '超时不该产生失败日志',
    );
    // 超时时服务端不回包 → 游标保持原值
    assert.equal(transport.stateSnapshot().getUpdatesBuf, '');
  } finally {
    await shutdown(transport);
  }
});

await test('4c. 平台判死（ret/errcode = -14）→ 停止轮询并标记 fatal', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const logger = recordingLogger();
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: fixedUpdates({ ret: 0, errcode: -14, msgs: [] }),
  });

  const transport = createWeixinTransport(baseOptions(statePath, server, { logger }));
  try {
    await transport.start(() => {});
    await waitFor(() => transport.status().fatal === true, { label: '进入 fatal 状态' });

    const status = transport.status();
    assert.equal(status.connected, false);
    assert.equal(status.running, false, 'fatal 后轮询循环必须退出');
    assert.equal(status.lastErrorInfo.code, 'stale-token');
    assert.equal(status.lastErrorInfo.fatal, true);

    const callsAfterFatal = server.callsTo(ROUTE_UPDATES).length;
    await sleep(120);
    assert.equal(
      server.callsTo(ROUTE_UPDATES).length,
      callsAfterFatal,
      'fatal 之后不应再发起轮询（否则会拿失效 token 无限打服务端）',
    );
  } finally {
    await shutdown(transport);
  }
});

await test('4d. notifystart 失败分类：可重试则退避后照常轮询；ret=-14 则 start() 直接失败', async () => {
  const dir = await caseDir();

  // --- 4d-1. notifystart 连续 503（可重试）→ start() 仍成功，长轮询照跑 ---
  const stateA = join(dir, 'a.json');
  const logger = recordingLogger();
  let startAttempts = 0;
  const serverA = createServer({
    [ROUTE_START]: () => {
      startAttempts += 1;
      return jsonResponse({ err: 'unavailable' }, 503);
    },
    [ROUTE_STOP]: () => jsonResponse({ ret: 0 }),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851928806001', text: '照常收到', seq: 1 })], get_updates_buf: 'b' },
    ]),
  });
  const received = [];
  const transportA = createWeixinTransport(baseOptions(stateA, serverA, {
    logger,
    startRetryDelaysMs: [5, 5, 5],
  }));
  try {
    const status = await transportA.start((msg) => received.push(msg));
    assert.equal(startAttempts, 4, `notifystart 应重试 3 次后放弃（共 4 次尝试），实际 ${startAttempts}`);
    assert.equal(status.running, true, 'notifystart 失败不该阻止轮询启动');
    await waitFor(() => received.length === 1, { label: 'notifystart 失败后仍能收到消息' });
    assert.ok(
      logger.lines.some((line) => line.includes('notifystart')),
      'notifystart 重试必须留下日志',
    );
  } finally {
    await shutdown(transportA);
  }

  // --- 4d-2. notifystart 返回 errcode -14（凭据失效）→ 致命，start() 抛错且不启动 ---
  const stateB = join(dir, 'b.json');
  let updatesB = 0;
  const serverB = createServer({
    [ROUTE_START]: () => jsonResponse({ ret: 0, errcode: -14 }),
    [ROUTE_STOP]: () => jsonResponse({ ret: 0 }),
    [ROUTE_UPDATES]: (record, init) => {
      updatesB += 1;
      return hang(record, init);
    },
  });
  const transportB = createWeixinTransport(baseOptions(stateB, serverB, { startRetryDelaysMs: [5, 5, 5] }));
  await assert.rejects(
    () => transportB.start(() => {}),
    (error) => {
      assert.equal(error.code, 'stale-token', 'notifystart 的 -14 必须被识别为凭据失效');
      return true;
    },
  );
  assert.equal(transportB.status().running, false, '致命启动错误后不得进入运行态');
  await sleep(30);
  assert.equal(updatesB, 0, '致命启动错误后不得开始长轮询');
  await shutdown(transportB);
});

await test('4e. 脏消息（畸形 seq / item_list）只丢自己，不打死轮询循环', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const logger = recordingLogger();
  const dirty = inbound({ id: '7514359851928807001', text: 'seq 是脏的' });
  dirty.seq = 'not-a-number';           // 会进 BigInt() 的输入
  dirty.context_token = 'CT-DIRTY';
  const dirtyItems = inbound({ id: '7514359851928807002' });
  dirtyItems.item_list = 'not-an-array'; // 类型完全不对

  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [dirty, dirtyItems], get_updates_buf: 'b1' },
      { ret: 0, msgs: [inbound({ id: '7514359851928807003', text: '循环还活着', seq: 1 })], get_updates_buf: 'b2' },
    ]),
  });

  const received = [];
  const transport = createWeixinTransport(baseOptions(statePath, server, { logger }));
  try {
    await transport.start((msg) => received.push(msg));
    await waitFor(() => received.some((msg) => msg.text === '循环还活着'), { label: '脏消息之后仍继续轮询' });
    assert.equal(transport.status().connected, true, '脏消息不得影响连接状态');
    assert.equal(logger.lines.filter((line) => line.startsWith('error')).length, 0, '经校验的脏字段不该抛异常');
    assert.equal(transport.stateSnapshot().contextTokens[OWNER].token, 'CT-DIRTY', 'seq 无效时仍应存下 token');
    assert.equal(transport.stateSnapshot().contextTokens[OWNER].seq, null);
  } finally {
    await shutdown(transport);
  }
});

// ===========================================================================
// 5. context_token 持久化 / 重启恢复 / 单调性
// ===========================================================================

await test('5. context_token 与游标持久化，重启后能恢复并用于发送', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const seenId = '7514359851928802001';

  // --- 第一次运行：收到一条带 context_token 的消息 ---
  const serverA = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      {
        ret: 0,
        msgs: [inbound({ id: seenId, contextToken: 'CT-PERSIST', seq: 7, createTimeMs: 1_700_000_000_000 })],
        get_updates_buf: 'buf-persist',
      },
    ]),
  });
  const transportA = createWeixinTransport(baseOptions(statePath, serverA));
  await transportA.start(() => {});
  await waitFor(() => transportA.stateSnapshot().getUpdatesBuf === 'buf-persist', { label: 'A 落盘游标' });
  await shutdown(transportA);

  // --- 磁盘上的状态文件必须含 context_token 与游标 ---
  const raw = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(raw.version, 1, '状态文件必须有 version');
  assert.equal(raw.getUpdatesBuf, 'buf-persist');
  assert.equal(raw.contextTokens[OWNER].token, 'CT-PERSIST');
  assert.equal(raw.contextTokens[OWNER].seq, '7');
  assert.equal(raw.contextTokens[OWNER].messageTimeMs, 1_700_000_000_000);
  assert.ok(typeof raw.contextTokens[OWNER].receivedAt === 'number');
  assert.match(raw.credentialHash, /^[a-f0-9]{64}$/, 'credentialHash 应是 sha256(token)');
  assert.ok(raw.seenMessageIds.includes(seenId));
  assert.ok(
    !JSON.stringify(raw).includes(TOKEN),
    '状态文件绝不能出现 bot token 明文（只允许 credentialHash）',
  );

  // --- 第二次运行：全新实例，同一个 statePath ---
  const serverB = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: (record, init) => hang(record, init),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });
  const transportB = createWeixinTransport(baseOptions(statePath, serverB));
  try {
    await transportB.start(() => {});
    await waitFor(() => serverB.callsTo(ROUTE_UPDATES).length >= 1, { label: 'B 发出首次轮询' });

    // 游标必须从磁盘恢复后原样回传，否则会重放/漏掉历史消息
    assert.equal(serverB.callsTo(ROUTE_UPDATES)[0].body.get_updates_buf, 'buf-persist');

    // 没有任何新的入站消息，也必须能用恢复出来的 context_token 主动发送
    const sent = await transportB.sendText(OWNER, '重启后的主动消息');
    assert.equal(sent.ok, true);
    assert.equal(sent.contextTokenUsed, true, '重启后应恢复 context_token');
    assert.equal(serverB.callsTo(ROUTE_SEND)[0].body.msg.context_token, 'CT-PERSIST');
  } finally {
    await shutdown(transportB);
  }
});

await test('5b. 乱序 / 重复批次不得用更旧的 context_token 覆盖较新的', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851928803001', contextToken: 'CT-NEW', seq: 10, createTimeMs: 2_000 })], get_updates_buf: 'b1' },
      // 迟到的旧批次：seq 更小
      { ret: 0, msgs: [inbound({ id: '7514359851928803002', contextToken: 'CT-OLD', seq: 4, createTimeMs: 1_000 })], get_updates_buf: 'b2' },
    ]),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  const received = [];
  const transport = createWeixinTransport(baseOptions(statePath, server));
  try {
    await transport.start((msg) => received.push(msg));
    await waitFor(() => received.length === 2, { label: '两条消息都回调' });
    await waitFor(() => transport.stateSnapshot().getUpdatesBuf === 'b2', { label: '游标前移' });

    assert.equal(
      transport.stateSnapshot().contextTokens[OWNER].token,
      'CT-NEW',
      '旧 seq 的 token 不得覆盖新 token',
    );

    const sent = await transport.sendText(OWNER, 'x');
    assert.equal(sent.ok, true);
    assert.equal(server.callsTo(ROUTE_SEND)[0].body.msg.context_token, 'CT-NEW');
  } finally {
    await shutdown(transport);
  }
});

await test('5c. token 变更后 context_token 缓存作废', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851928804001', contextToken: 'CT-TOKEN-A', seq: 1 })], get_updates_buf: 'b' },
    ]),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  const transportA = createWeixinTransport(baseOptions(statePath, server));
  await transportA.start(() => {});
  await waitFor(() => transportA.stateSnapshot().getUpdatesBuf === 'b', { label: '落盘' });
  await shutdown(transportA);

  // 换 token 重启：旧 context_token 属于旧登录，必须丢弃
  const serverB = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: (record, init) => hang(record, init),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });
  const transportB = createWeixinTransport(baseOptions(statePath, serverB, {
    env: { [ENV_KEY]: 'a-completely-different-token' },
  }));
  try {
    await transportB.start(() => {});
    await waitFor(() => serverB.callsTo(ROUTE_UPDATES).length >= 1, { label: 'B 首次轮询' });

    const sent = await transportB.sendText(OWNER, 'x');
    assert.equal(sent.ok, true);
    assert.equal(sent.contextTokenUsed, false, '换 token 后必须丢弃旧 context_token');
    assert.ok(!Object.hasOwn(serverB.callsTo(ROUTE_SEND)[0].body.msg, 'context_token'));
    await waitFor(
      () => Object.keys(transportB.stateSnapshot().contextTokens).length === 0,
      { label: '内存缓存已清空' },
    );
  } finally {
    await shutdown(transportB);
  }
});

// ===========================================================================
// 6. stop()
// ===========================================================================

await test('6. stop() 中断在途长轮询、清空定时器、之后不再有任何回调', async () => {
  const dir = await caseDir();
  const statePath = join(dir, 'state.json');
  const server = createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: scriptedUpdates([
      { ret: 0, msgs: [inbound({ id: '7514359851928805001', text: 'stop 之前', seq: 1 })], get_updates_buf: 'b1' },
    ]),
  });

  const received = [];
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const transport = createWeixinTransport(baseOptions(statePath, server));
  await transport.start((msg) => received.push(msg));
  await waitFor(() => received.length === 1, { label: '先收到一条' });

  // 此刻循环正卡在被 hold 住的长轮询上
  await waitFor(
    () => server.callsTo(ROUTE_UPDATES).some((call) => call.aborted === false && call.hasSignal),
    { label: '存在在途长轮询' },
  );
  const pollCallsAtStop = server.callsTo(ROUTE_UPDATES).length;

  await transport.stop();

  const status = transport.status();
  assert.equal(status.running, false, 'stop() 后 running 必须为 false');
  assert.equal(status.connected, false, 'stop() 后 connected 必须为 false');

  // 在途请求被 AbortController 干净掐断
  const inflight = server.callsTo(ROUTE_UPDATES).at(-1);
  assert.equal(inflight.aborted, true, 'stop() 必须 abort 在途长轮询请求');

  // 停止后平台再推送也不该有回调，也不该再有新请求
  const receivedAtStop = received.length;
  await sleep(150);
  assert.equal(received.length, receivedAtStop, 'stop() 之后不应再有 onMessage 回调');
  assert.equal(
    server.callsTo(ROUTE_UPDATES).length,
    pollCallsAtStop,
    'stop() 之后不应再发起长轮询',
  );

  // 定时器清空（长轮询超时定时器 + 退避定时器都必须释放）
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.ok(
    timersAfter <= timersBefore,
    `stop() 后残留定时器：before=${timersBefore} after=${timersAfter}`,
  );

  // 幂等：重复 stop 不炸
  await transport.stop();
  await transport.stop();

  // 可重启
  const restarted = await transport.start(() => {});
  assert.equal(restarted.running, true, 'stop() 之后应能重新 start()');
  await transport.stop();
});

// ===========================================================================
// 7. 凭据读取
// ===========================================================================

await test('7. 凭据解析：env 优先；无 env 时从极简 YAML 读取（含引号值）', async () => {
  const dir = await caseDir();
  const credentialsPath = join(dir, '.credentials.yaml');
  await writeFile(credentialsPath, [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: not-the-token',
    'refs:',
    `  "${ENV_KEY}": "yaml-quoted-token"`,
    '  DSH_TEST_WEIXIN_TOKEN_BARE: bare-token-value  # 行尾注释应被剥掉',
    '  DSH_TEST_WEIXIN_EMPTY:',
    '',
  ].join('\n'), 'utf8');

  const mkServer = () => createServer({
    ...lifecycleRoutes(),
    [ROUTE_UPDATES]: (record, init) => hang(record, init),
    [ROUTE_SEND]: () => jsonResponse({ ret: 0 }),
  });

  // 7a. 无 env → 走 YAML
  const serverA = mkServer();
  const transportA = createWeixinTransport(baseOptions(join(dir, 'a.json'), serverA, {
    credentialsPath,
    env: {},
  }));
  try {
    await transportA.start(() => {});
    await transportA.sendText(OWNER, 'x');
    assert.equal(
      serverA.callsTo(ROUTE_SEND)[0].headers.Authorization,
      'Bearer yaml-quoted-token',
      '应能从 YAML 的引号值里取出 token',
    );
  } finally {
    await shutdown(transportA);
  }

  // 7b. 有 env → env 优先
  const serverB = mkServer();
  const transportB = createWeixinTransport(baseOptions(join(dir, 'b.json'), serverB, {
    credentialsPath,
    env: { [ENV_KEY]: 'env-wins-token' },
  }));
  try {
    await transportB.start(() => {});
    await transportB.sendText(OWNER, 'x');
    assert.equal(serverB.callsTo(ROUTE_SEND)[0].headers.Authorization, 'Bearer env-wins-token');
  } finally {
    await shutdown(transportB);
  }

  // 7c. 裸值 + 行尾注释
  const serverC = mkServer();
  const transportC = createWeixinTransport(baseOptions(join(dir, 'c.json'), serverC, {
    credentialsPath,
    tokenRef: 'DSH_TEST_WEIXIN_TOKEN_BARE',
    env: {},
  }));
  try {
    await transportC.start(() => {});
    await transportC.sendText(OWNER, 'x');
    assert.equal(serverC.callsTo(ROUTE_SEND)[0].headers.Authorization, 'Bearer bare-token-value');
  } finally {
    await shutdown(transportC);
  }

  // 7d. 凭据找不到 → start() 明确报错，而不是拿空 token 去打服务端
  const transportD = createWeixinTransport(baseOptions(join(dir, 'd.json'), mkServer(), {
    credentialsPath: join(dir, 'missing.yaml'),
    tokenRef: 'DSH_TEST_DOES_NOT_EXIST',
    env: {},
  }));
  await assert.rejects(
    () => transportD.start(() => {}),
    (error) => {
      assert.equal(error.code, 'token-missing');
      assert.ok(!String(error.message).includes(TOKEN), '错误信息里不能夹带 token');
      return true;
    },
  );
});

// ===========================================================================
// 8. 纯函数边界
// ===========================================================================

await test('8. utils：extractYamlScalar / 消息 id 时间戳 / classifyError / 排序', async () => {
  // --- extractYamlScalar ---
  assert.equal(extractYamlScalar('a: 1\nFOO: bar\n', 'FOO'), 'bar');
  assert.equal(extractYamlScalar('FOO: "quoted"\n', 'FOO'), 'quoted');
  assert.equal(extractYamlScalar("FOO: 'sin''gle'\n", 'FOO'), "sin'gle");
  assert.equal(extractYamlScalar('FOO: bare # comment\n', 'FOO'), 'bare');
  assert.equal(extractYamlScalar('FOO: a#b\n', 'FOO'), 'a#b', '值中间的 # 属于 token，不能被当注释');
  assert.equal(extractYamlScalar('  "FOO": spaced\n', 'FOO'), 'spaced');
  assert.equal(extractYamlScalar('FOO:\n  nested: 1\n', 'FOO'), null, '块头不是标量');
  assert.equal(extractYamlScalar('FOOBAR: nope\n', 'FOO'), null, '前缀不得误匹配');
  assert.equal(extractYamlScalar('# FOO: commented\n', 'FOO'), null);
  assert.equal(extractYamlScalar('a: 1\n', 'MISSING'), null);

  // --- 64 位消息 id 里的毫秒时间戳（必须走 BigInt，Number 会精度丢失）---
  const stamp = 1_700_000_000_123;
  const encoded = ((BigInt(stamp) << 22n) | 7n).toString();
  assert.equal(weixinMessageTimestampMs(encoded), stamp);
  assert.equal(weixinMessageTimestampMs('123'), null, '太短的不是合法 id');
  assert.equal(weixinMessageTimestampMs('0000000000000000000'), null, '时间戳早于 2020 年应判无效');
  assert.equal(weixinMessageTimestampMs(null), null);

  // --- classifyError ---
  assert.deepEqual(classifyError({ code: 'network-error' }), { kind: 'offline', retryable: true, fatal: false });
  assert.deepEqual(classifyError({ code: 'timeout' }), { kind: 'timeout', retryable: true, fatal: false });
  assert.equal(classifyError({ code: 'http-error', status: 429 }).retryable, true);
  assert.equal(classifyError({ code: 'http-error', status: 503 }).retryable, true);
  assert.equal(classifyError({ code: 'http-error', status: 400 }).retryable, false);
  assert.equal(classifyError({ code: 'http-error', status: 403 }).fatal, false, 'HTTP 403 不足以断言 token 失效');
  assert.equal(classifyError({ code: 'stale-token' }).fatal, true);
  assert.equal(classifyError({ code: 'updates-rejected', providerCode: '-14' }).fatal, true);

  // --- orderWeixinMessages ---
  const listed = [{ seq: 3 }, { create_time_ms: 10 }, { seq: 1 }];
  assert.deepEqual(orderWeixinMessages(listed), listed, '字段不齐时保持原顺序，不乱排');
  assert.deepEqual(
    orderWeixinMessages([{ seq: '10' }, { seq: '2' }, { seq: '7' }]).map((m) => m.seq),
    ['2', '7', '10'],
    'seq 是字符串也要按数值排',
  );
  assert.deepEqual(
    orderWeixinMessages([{ create_time_ms: 5 }, { create_time_ms: 1 }]).map((m) => m.create_time_ms),
    [1, 5],
  );
  assert.deepEqual(orderWeixinMessages([]), []);
  assert.deepEqual(orderWeixinMessages(undefined), []);
});

// ---------------------------------------------------------------------------

await rm(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.log('');
  console.log(`${failures.length} 个用例失败：`);
  for (const { name, error } of failures) {
    console.log(`  - ${name}`);
    console.log(`    ${(error?.stack ?? String(error)).split('\n').slice(0, 4).join('\n    ')}`);
  }
  console.log(`weixin transport tests: ${passed} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`weixin transport tests: ${passed} passed, 0 failed`);
}
