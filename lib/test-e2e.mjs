/**
 * End-to-end test of the WeChat side: the REAL transport module + the REAL host
 * shell, with only the HTTP boundary stubbed (that is the correct seam -- no
 * test should dial ilinkai.weixin.qq.com) and the harness bridge faked (there is
 * no DSH host in a unit test).
 *
 * What it proves:
 *   inbound WeChat JSON -> router -> outbound sendmessage JSON
 *   i.e. "发任意消息 -> 编号列表", "回数字 -> 选中 + 开关自动打开",
 *   "选中后的话进该会话", and "回合结束只对开着的会话回传".
 *
 *   node test-e2e.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { createWeixinTransport } from '../transport/weixin.mjs';

const TOKEN_REF = 'DSH_WEIXIN_BOT_TOKEN_E2E';
const OWNER = 'owner@im.wechat';

// ---------------------------------------------------------------- fake wire

function wire() {
  const outbound = [];
  const outboundFiles = [];
  const inboundQueue = [];
  let getupdatesCalls = 0;
  let stopped = false;

  const uploads = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    // A file send POSTs raw ciphertext to the CDN; only JSON requests get parsed.
    const isBinary = init.body instanceof Uint8Array;
    const body = init.body && !isBinary ? JSON.parse(init.body) : {};
    if (isBinary) {
      uploads.push({ url: target, bytes: init.body, method: init.method });
      // 真正的下载参数在响应头里，body 是空的。
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'DOWNLOAD-PARAM-FROM-HEADER' },
      });
    }
    if (target.includes('getuploadurl')) {
      return json({
        ret: 0,
        upload_param: 'ENC-PARAM',
        upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/up?encrypted_query_param=ENC-PARAM&filekey=FK&taskid=TASK-1',
      });
    }
    if (target.includes('getupdates')) {
      getupdatesCalls += 1;
      // Small delay so the long-poll loop cannot spin the CPU flat out.
      await new Promise((r) => setTimeout(r, 5));
      const msgs = inboundQueue.splice(0, inboundQueue.length);
      return json({ ret: 0, msgs, get_updates_buf: `cursor-${getupdatesCalls}` });
    }
    if (target.includes('sendmessage')) {
      const item = body?.msg?.item_list?.[0];
      outbound.push(item?.text_item?.text ?? null);
      if (item?.type === 4) outboundFiles.push({ ...item.file_item, contextToken: body?.msg?.context_token });
      return json({ ret: 0 });
    }
    if (target.includes('notifystart') || target.includes('notifystop')) return json({ ret: 0 });
    return json({ ret: 0 });
  };

  return {
    fetchImpl, outbound, outboundFiles, uploads,
    push: (text, id) => inboundQueue.push({
      message_id: id,
      client_id: `c-${id}`,
      message_type: 1,
      from_user_id: OWNER,
      create_time_ms: Date.now(),
      seq: String(inboundQueue.length + 1),
      context_token: 'ctx-token-e2e',
      item_list: [{ type: 1, text_item: { text } }],
    }),
    getupdatesCalls: () => getupdatesCalls,
    markStopped: () => { stopped = true; },
    isStopped: () => stopped,
  };
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function waitFor(predicate, { timeoutMs = 4000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ------------------------------------------------------------------ fixture

const home = await mkdtemp(join(tmpdir(), 'wechat-box-e2e-'));
process.env.DSH_HOME = home;
process.env[TOKEN_REF] = 'abc@im.bot:secret-value';
await mkdir(join(home, 'integrations', 'dsh-weixin'), { recursive: true });
await writeFile(join(home, 'integrations', 'dsh-weixin', 'config.json'), JSON.stringify({
  version: 1,
  accounts: [{
    botId: 'wx_e2e',
    accountId: 'abc@im.bot',
    tokenRef: TOKEN_REF,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    ownerUserId: OWNER,
  }],
}), 'utf8');

const mod = await import('./index.js');

const SESSIONS = [
  { id: 'session-1', title: '文档整理', cwd: 'D:\\workspace', running: false },
  { id: 'session-2', title: '桥接联调', cwd: 'D:\\workspace', running: true },
];

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };

const w = wire();
const transport = createWeixinTransport({
  botId: 'wx_e2e',
  accountId: 'abc@im.bot',
  baseUrl: 'https://ilinkai.weixin.qq.com/',
  tokenRef: TOKEN_REF,
  credentialsPath: join(home, 'no-such-credentials.yaml'),
  statePath: join(home, 'transport-state.json'),
  fetchImpl: w.fetchImpl,
  logger: { info() {}, warn() {}, error() {} },
});

const submitted = [];
let turnHandler = null;
const bridge = {
  listSessions: async () => SESSIONS.map((s) => ({ ...s })),
  submitUserText: async (sessionId, text) => { submitted.push({ sessionId, text }); },
  isSessionRunning: () => false,
  dispose() {},
};

const routes = new Map();
const services = {};
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on() { return () => {}; },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  provide(name, value) { services[name] = value; },
  inject(deps, cb) {
    if (deps.includes('webServer')) {
      cb({
        webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
        effect: (fn) => { fn(); return () => {}; },
      });
    }
  },
};

// Cordis feeds a plugin's return value through its effect machinery, which
// accepts only a function / null / thenable / iterable of disposers; anything
// else is `TypeError: Invalid effect`, and that throw disposes the entire fiber
// (routes included) ~1ms after apply resolves. So apply() returns nothing and the
// inspection surface is the wechatBox service instead.
const returned = await mod.apply(ctx, {
  weixinEnabled: true,
  modules: {
    transport: async () => transport,
    bridge: async ({ onTurnComplete }) => { turnHandler = onTurnComplete; return bridge; },
  },
});
assert.equal(returned, undefined, 'apply() must return undefined or Cordis throws "Invalid effect"');
const applied = services.wechatBox.internals();

assert.equal(applied.transport, transport, 'the real transport is wired in');
ok('host shell boots against the REAL transport module');

// --- R5: a free-text WeChat message produces the numbered list --------------
{
  w.push('随便说点什么', '7514359851928797001');
  await waitFor(() => w.outbound.length >= 1, { label: 'the numbered list reply' });
  const reply = w.outbound[0];
  assert.match(reply, /选择一个对话/, 'the reply is the picker');
  assert.match(reply, /1\. ○ 文档整理/);
  assert.match(reply, /2\. ○ .*运行中/);
  assert.match(reply, /回复数字/);
  ok('R5 WeChat text -> real sendmessage carrying the numbered list');
}

// --- R4: replying a number selects and turns that switch ON -----------------
{
  w.outbound.length = 0;
  w.push('2', '7514359851928797002');
  await waitFor(() => w.outbound.length >= 1, { label: 'the selection confirmation' });
  assert.match(w.outbound[0], /已切到 2\. 桥接联调/);

  const state = routes.get(mod.STATE_PATH);
  const res = await call(state);
  assert.equal(res.json.selectedId, 'session-2', 'selection is persisted');
  assert.equal(res.json.sessions['session-2'].enabled, true, "that conversation's switch is ON");
  assert.equal(res.json.transportReady, true, 'transport reports ready');
  ok('R4 replying 2 selects it, flips its switch on, and confirms over the wire');
}

// --- R2: the next message is fed into the selected conversation -------------
{
  w.outbound.length = 0;
  w.push('帮我把这段代码改一下', '7514359851928797003');
  await waitFor(() => submitted.length >= 1, { label: 'the submission into the session' });
  assert.equal(submitted[0].sessionId, 'session-2');
  assert.equal(submitted[0].text, '帮我把这段代码改一下');
  assert.equal(w.outbound.length, 0, 'routing into a session must not echo a chat reply');
  ok('R2 free text is routed into the selected conversation, silently');
}

// --- R2/R3: only the ON conversation mirrors its finished turn --------------
{
  w.outbound.length = 0;
  await turnHandler({ sessionId: 'session-1', text: '没开的对话不该回传' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.outbound.length, 0, 'OFF conversation stays silent');

  await turnHandler({ sessionId: 'session-2', text: '这是最终回答' });
  await waitFor(() => w.outbound.length >= 1, { label: 'the mirrored final answer' });
  assert.match(w.outbound[0], /这是最终回答$/, 'the mirrored answer ends with the turn text (a /session fence is prefixed)');
  ok('R3/R2 OFF silent, ON mirrors the final answer over the wire');
}

// --- the transport really did long-poll ------------------------------------
{
  assert.ok(w.getupdatesCalls() >= 3, `expected several getupdates, saw ${w.getupdatesCalls()}`);
  ok(`transport long-polled the stubbed getupdates (${w.getupdatesCalls()} calls)`);
}

// --- clean shutdown stops the loop -----------------------------------------
{
  await transport.stop();
  await new Promise((r) => setTimeout(r, 30));
  const before = w.getupdatesCalls();
  await new Promise((r) => setTimeout(r, 60));
  const after = w.getupdatesCalls();
  assert.ok(after - before <= 1, `long-poll must stop after stop() (before=${before}, after=${after})`);
  ok('stop() halts the long-poll loop');
}

// --- no credentials -> transport.start throws, host still serves -----------
{
  const badHome = await mkdtemp(join(tmpdir(), 'wechat-box-e2e-bad-'));
  const savedHome = process.env.DSH_HOME;
  const savedToken = process.env[TOKEN_REF];
  process.env.DSH_HOME = badHome;
  delete process.env[TOKEN_REF];
  await mkdir(join(badHome, 'integrations', 'dsh-weixin'), { recursive: true });
  await writeFile(join(badHome, 'integrations', 'dsh-weixin', 'config.json'), JSON.stringify({
    version: 1,
    accounts: [{ botId: 'wx_e2e', accountId: 'abc@im.bot', tokenRef: TOKEN_REF, baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: OWNER }],
  }), 'utf8');

  const h2Routes = new Map();
  const services2 = {};
  const ctx2 = {
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {}; },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    provide(name, value) { services2[name] = value; },
    inject(deps, cb) {
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => { h2Routes.set(r.path, r.handler); return () => {}; } }, effect: (fn) => { fn(); return () => {}; } });
    },
  };
  const returned2 = await mod.apply(ctx2, {
    weixinEnabled: true,
    modules: { bridge: async ({ onTurnComplete }) => { turnHandler = onTurnComplete; return bridge; } },
  });
  assert.equal(returned2, undefined, 'apply() returns nothing here too');
  const applied2 = services2.wechatBox.internals();
  // The factory itself does not read the token -- start() does. So the object
  // exists and start() fails: that is the shape the host must survive.
  assert.ok(applied2.transport !== null, 'the transport object is constructed without reading the token');
  const res = await call(h2Routes.get(mod.STATE_PATH));
  assert.equal(res.status, 200, 'the switch still answers with no WeChat credentials');
  assert.equal(res.json.transportReady, false, 'a transport whose start() threw must NOT report ready');
  assert.match(
    String(res.json.applyError ?? res.json.transportError),
    /setup failed|token-missing|凭据/,
    'the start failure is reported rather than swallowed',
  );
  ok('missing credentials: host stays up, switch answers, error is reported');

  process.env.DSH_HOME = savedHome;
  process.env[TOKEN_REF] = savedToken;
  await rm(badHome, { recursive: true, force: true });
}

async function call(handler, { method = 'GET', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const request = { method, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  let status = 0;
  let payload = null;
  const response = {
    destroyed: false, writableEnded: false,
    writeHead(code) { status = code; },
    end(text) { payload = text; this.writableEnded = true; },
  };
  await handler(request, response);
  return { status, json: payload ? JSON.parse(payload) : null };
}

// --- file: a real file goes out as item type=4 over the real transport ------
{
  w.outbound.length = 0;
  const filePath = join(home, 'e2e 报告.txt');
  // Not a multiple of 16 bytes on purpose: exercises the PKCS#7 padding path.
  const content = '端到端文件正文 DeepSeek Harness';
  await writeFile(filePath, content, 'utf8');

  const res = await call(routes.get(mod.FILE_PATH), { method: 'POST', body: { path: filePath } });
  assert.equal(res.status, 200, `the file route should succeed: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.ok, true);

  assert.equal(w.uploads.length, 1, 'exactly one CDN upload happened');
  assert.ok(w.uploads[0].bytes instanceof Uint8Array, 'the CDN body is ciphertext bytes');

  assert.equal(w.outboundFiles.length, 1, 'exactly one file message went over the wire');
  const sentFile = w.outboundFiles[0];
  assert.equal(sentFile.file_name, 'e2e 报告.txt');
  // 官方 FileItem: { media, file_name, len }；引用来自响应头，不是 body 的 upload_param。
  assert.equal(sentFile.media.encrypt_query_param, 'DOWNLOAD-PARAM-FROM-HEADER');
  assert.equal(sentFile.media.encrypt_type, 1);
  assert.ok(sentFile.media.aes_key, 'the file reference carries the aes_key');
  assert.equal(sentFile.len, String(Buffer.byteLength(content, 'utf8')), 'len 是明文字节数的字符串');
  assert.ok(sentFile.contextToken, 'the file message carries the context_token');
  assert.equal(w.uploads[0].method, 'POST', 'CDN upload uses POST');
  assert.match(w.uploads[0].url, /taskid=TASK-1/, 'upload_full_url is used verbatim');
  assert.equal(w.outbound.at(-1), null, 'a file message has no text_item');
  ok('a file is uploaded, then sent as item type=4 with context_token (real transport)');
}

await rm(home, { recursive: true, force: true });
console.log(`\ne2e (real transport): ${passed} checks passed`);
