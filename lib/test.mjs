/**
 * Host-shell tests: drive the REAL apply() with fake transport/bridge modules,
 * a stub Cordis context, and a temp DSH_HOME. Covers R2-R5 end to end plus the
 * degradation path while transport/ and harness/ are still absent.
 *
 *   node test.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Neutral fixtures only: never a real bot id, openid or account id. These are
// named constants because several assertions below pin the EXACT masked form,
// and that form is derived from these strings (`<6 chars>…<last 4>`).
const BOT_ID = 'wx_example_bot_id';            // -> masked as 'wx_exa…t_id'
const OWNER_USER_ID = 'owner@im.wechat';       // -> masked as 'owner@…chat'

const ACCOUNT_CONFIG = JSON.stringify({
  version: 1,
  accounts: [{
    botId: BOT_ID,
    accountId: 'abc@im.bot',
    tokenRef: 'DSH_WEIXIN_BOT_TOKEN_TEST',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    ownerUserId: OWNER_USER_ID,
  }],
});

// Every case gets its own DSH_HOME: the switch state lives in one file under it,
// so sharing a home would leak the previous case's selection into the next one.
const homes = [];
let homeCounter = 0;
async function newHome() {
  homeCounter += 1;
  const dir = await mkdtemp(join(tmpdir(), `wechat-box-host-${homeCounter}-`));
  homes.push(dir);
  process.env.DSH_HOME = dir;
  await mkdir(join(dir, 'integrations', 'dsh-weixin'), { recursive: true });
  await writeFile(join(dir, 'integrations', 'dsh-weixin', 'config.json'), ACCOUNT_CONFIG, 'utf8');
  return dir;
}

const mod = await import('./index.js');

/**
 * Fresh state + real apply(): the normal entry point for a case.
 *
 * `accountFile` seeds `storages/wechat-box-account.json` before apply, which is
 * how "this plugin already bound an account by scanning" is expressed -- and the
 * reason a scan survives a restart. `home` is returned because the tests that
 * assert the file was written need the path it was written to.
 */
async function boot(h, config, { accountFile } = {}) {
  const home = await newHome();
  if (accountFile !== undefined) {
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages', 'wechat-box-account.json'), JSON.stringify(accountFile), 'utf8');
  }
  h.home = home;
  h.accountFile = join(home, 'storages', 'wechat-box-account.json');
  return applyBox(h.ctx, h.services, config ?? { modules: h.loaders, weixinEnabled: true });
}

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };

const SESSIONS = [
  { id: 'session-1', title: '文档整理', cwd: 'D:\\workspace', running: false },
  { id: 'session-2', title: '桥接联调', cwd: 'D:\\workspace', running: true },
  { id: 'session-3', title: '小游戏原型', cwd: 'D:\\workspace\\project-b', running: false },
];

function makeHarness() {
  const sent = [];
  const files = [];
  const submitted = [];
  const routes = new Map();
  let onMessage = null;
  let onTurn = null;
  let started = false;

  const transport = {
    async start(handler) { started = true; onMessage = handler; },
    async stop() {},
    async sendText(userId, text) { sent.push({ userId, text }); return { ok: true }; },
    async sendFile(userId, filePath) {
      files.push({ userId, filePath });
      return { ok: true, fileName: filePath.split(/[\\/]/).pop() };
    },
    status() { return { connected: true }; },
  };

  const bridge = {
    listSessions: async () => SESSIONS.map((s) => ({ ...s })),
    submitUserText: async (sessionId, text) => { submitted.push({ sessionId, text }); },
    isSessionRunning: () => false,
    dispose() {},
  };

  const ctxListeners = [];
  const services = {};
  // A case can flip one of these before apply(). The harness normally mounts a
  // credentials provider; the "the record cannot be written" case needs the other
  // composition, where `inject(['credentials'])` never yields a service.
  //
  // `workspaceRegistry` is the same kind of switch: `/new` falls back to the
  // cwds of recent conversations when the registry is not there, and the only way
  // to see that fallback is to remove the service.
  const flags = { credentials: true, workspaceRegistry: true };

  // --- the two host services `/new` is built on -----------------------------
  // `sessionController.create(request)` returns `{ sessionId }` and nothing else
  // (host source: dsh-api-session-controller/lib/index.js:686-714 -> 2971), so
  // the fake returns exactly that: a test must not be able to depend on a richer
  // shape than the host actually hands over.
  const created = [];
  const createFailure = { message: null };
  const sessionController = {
    async create(request) {
      if (createFailure.message) throw new Error(createFailure.message);
      const sessionId = `session-new-${created.length + 1}`;
      created.push({ ...request, sessionId });
      return { sessionId };
    },
  };
  // The registry rows carry `path` plus the fields the real entity exposes, so a
  // test that reads one of the others would notice it was never wired.
  const workspaces = ['D:\\workspace', 'D:\\workspace\\project-b'];
  const workspaceRegistry = {
    list: () => workspaces.map((path, index) => ({
      id: `ws-${index + 1}`, path, title: path, sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  };
  // Records the same way the real seam does: modifyRecord is the only write
  // path, and the mutation runs against the value as of that write. A binding
  // test that cannot see the record cannot tell "stored" from "dropped".
  const credentialRecords = new Map();
  const credentialWrites = [];
  const credentials = {
    async readRecord(key) { return credentialRecords.get(key); },
    async modifyRecord(key, mutate) {
      const next = await mutate(credentialRecords.get(key));
      credentialWrites.push({ key, next });
      if (next === undefined) return credentialRecords.get(key);
      credentialRecords.set(key, next);
      return next;
    },
    async deleteRecord(key) { credentialRecords.delete(key); },
    async describeRecord(key) {
      return credentialRecords.has(key)
        ? { configured: true, kind: credentialRecords.get(key)?.kind, writable: true }
        : { configured: false, writable: true };
    },
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(type, handler, options) {
      ctxListeners.push({ type, handler, options });
      return () => {
        const i = ctxListeners.findIndex((l) => l.handler === handler);
        if (i >= 0) ctxListeners.splice(i, 1);
      };
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    provide(name, value) { services[name] = value; },
    inject(deps, cb) {
      const ready = {};
      if (deps.includes('webServer')) {
        ready.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => {}; } };
        ready.effect = (fn) => { fn(); return () => {}; };
      }
      if (deps.includes('credentials') && flags.credentials) ready.credentials = credentials;
      if (deps.includes('sessionController')) ready.sessionController = sessionController;
      if (deps.includes('workspaceRegistry') && flags.workspaceRegistry) ready.workspaceRegistry = workspaceRegistry;
      cb(ready);
    },
  };

  const loaders = {
    transport: async () => transport,
    bridge: async ({ onTurnComplete }) => { onTurn = onTurnComplete; return bridge; },
  };

  const harness = {
    ctx, loaders, transport, bridge, sent, submitted, files, routes, ctxListeners, services, flags,
    credentials, credentialRecords, credentialWrites,
    sessionController, workspaceRegistry, workspaces, created, createFailure,
    // Every transport the plugin has built, in order: [booted, activated, ...].
    // Activation replaces the transport, so a test that only sees one object
    // cannot tell "swapped" from "reused".
    transports: [],
    transportOptions: [],
    get started() { return started; },
    questionHandlers: () => ctxListeners.filter((l) => l.type === 'user-questions/request'),
    approvalHandlers: () => ctxListeners.filter((l) => l.type === 'approval/request'),
    // No handler means transport.start() never ran; delivering an inbound
    // message then must be a no-op rather than a crash. Returns the handler's
    // promise so callers can await the async routing.
    inbound: (text, userId = 'owner@im.wechat') => {
      if (!onMessage) return undefined;
      return onMessage({ userId, text, messageId: String(Math.random()) });
    },
    turn: (sessionId, text) => onTurn({ sessionId, text, turn: 1 }),
  };

  /**
   * A factory that builds a FRESH transport per call, so the boot transport and
   * the activated one are distinguishable. `harness.transport` follows the live
   * one, which is what the older cases manipulate (`h.transport.sendText = ...`).
   */
  const buildTransport = ({ account } = {}) => {
    const index = harness.transports.length;
    harness.transportOptions.push({ account });
    let localStarted = false;
    let handler = null;
    const instance = {
      index,
      accountId: account?.accountId ?? null,
      started: false,
      stopped: 0,
      async start(nextHandler) { localStarted = true; handler = nextHandler; this.started = true; started = true; onMessage = nextHandler; },
      async stop() { this.stopped += 1; this.started = false; localStarted = false; },
      async sendText(userId, text) { sent.push({ userId, text }); return { ok: true }; },
      async sendFile(userId, filePath) {
        files.push({ userId, filePath });
        return { ok: true, fileName: filePath.split(/[\\/]/).pop() };
      },
      status() { return { connected: localStarted }; },
    };
    harness.transports.push(instance);
    harness.transport = instance;
    return instance;
  };
  harness.buildTransport = buildTransport;
  harness.loaders.transport = async (options) => buildTransport(options);

  return harness;
}

/**
 * Apply the plugin the way Cordis does, and hand back the debug surface.
 *
 * Cordis feeds a plugin's return value through its effect machinery, which
 * accepts ONLY a function, null/undefined, a thenable or an iterable of
 * disposers -- anything else is `TypeError: Invalid effect`, and that throw
 * disposes the whole fiber (routes included). So apply() returns nothing and the
 * inspection surface is the `wechatBox` service instead. This helper asserts
 * that contract on every call, because breaking it is invisible from inside the
 * plugin and costs a restart to notice.
 */
async function applyBox(ctx, services, config) {
  const returned = await mod.apply(ctx, config);
  assert.equal(
    returned, undefined,
    'apply() must return undefined: Cordis throws "Invalid effect" for any other object',
  );
  return services.wechatBox?.internals?.() ?? {};
}

async function call(handler, { method = 'GET', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const request = {
    method,
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
  let status = 0;
  let payload = null;
  const response = {
    destroyed: false,
    writableEnded: false,
    writeHead(code) { status = code; },
    end(text) { payload = text; this.writableEnded = true; },
  };
  await handler(request, response);
  return { status, json: payload ? JSON.parse(payload) : null };
}

// --- R5: free text with nothing selected answers with the numbered list -----
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('随便说点什么');
  assert.equal(h.sent.length, 1, 'one reply');
  const text = h.sent[0].text;
  assert.match(text, /选择一个对话/);
  assert.match(text, /^1\. ○ 文档整理（D:\\workspace）$/m);
  assert.match(text, /^2\. ○ .*运行中$/m);
  assert.match(text, /回复数字/);
  ok('R5 free text -> numbered list, rows carry cwd and running flag');
}

// --- R4: a bare number selects, turns that switch ON, and confirms ----------
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('2');
  // Three messages by design: the confirmation, the copy hint, then the id
  // alone -- WeChat text cannot carry a copy button, so isolating the value in
  // its own message is the closest the platform allows.
  assert.equal(h.sent.length, 3);
  assert.match(h.sent[0].text, /已切到 2\. 桥接联调/);
  assert.match(h.sent[0].text, /开关已自动打开/);
  assert.match(h.sent[1].text, /长按|复制/, 'the hint explains how to copy');
  // The value is fenced: WeChat renders a triple-backtick fence as a block with
  // its own copy affordance, which is the copy button the user asked for.
  assert.equal(h.sent[2].text, '```\nsession-2\n```', 'the id is fenced so the client can copy it');
  assert.match(h.sent[2].text, /session-2/);
  const snap = await applied.router.snapshot();
  assert.equal(snap.selectedId, 'session-2');
  assert.deepEqual(await applied.router.enabledIds(), ['session-2'], 'exactly one conversation is ON');
  ok('R4 replying 2 selects session-2, turns its switch on, confirms');
}

// --- single-selection: picking another turns the first one off --------------
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('2');
  await h.inbound('3');
  assert.deepEqual(await applied.router.enabledIds(), ['session-2', 'session-3'], 'switching to 3 does not close 2');
  ok('R4 selection is single: picking 3 turns 2 off');
}

// --- out of range is reported, not silently ignored -------------------------
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('9');
  assert.match(h.sent[0].text, /没有第 9 个对话，只有 1–3/);
  assert.equal((await applied.router.snapshot()).selectedId, null);
  ok('out-of-range number is reported back');
}

// --- R2/R3: text goes into the selected conversation ------------------------
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('2');
  await h.inbound('帮我把这段代码改一下');
  assert.equal(h.submitted.length, 1, 'exactly one submission');
  assert.equal(h.submitted[0].sessionId, 'session-2');
  assert.equal(h.submitted[0].text, '帮我把这段代码改一下');
  ok('R2 free text is fed into the selected conversation');
}

// --- R2: only an ON conversation mirrors its finished turn back -------------
{
  const h = makeHarness();
  await boot(h);
  await h.turn('session-1', '这是没开的对话的结果');
  assert.equal(h.sent.length, 0, 'OFF conversation must not mirror');

  await h.inbound('2');
  h.sent.length = 0;
  await h.turn('session-2', '这是开着的对话的最终回答');
  assert.equal(h.sent.length, 1, 'ON conversation mirrors its final answer');
  // The mirrored answer is prefixed with the fenced `/session <id>` block, so it
  // is asserted by its suffix rather than strict equality.
  assert.match(h.sent[0].text, /改?这是开着的对话的最终回答$/);
  assert.match(h.sent[0].text, /^```\n\/session session-2\n```\n/, 'every message carries the copyable /session block');
  assert.equal(h.sent[0].userId, 'owner@im.wechat');
  ok('R2/R3 OFF stays silent, ON mirrors the final answer to WeChat');
}

// --- a switched-off conversation forwards NOTHING (regression) --------------
// Reported from real use: after turning the switch off in the web UI, WeChat
// messages were still forwarded into that conversation. The inbound path checked
// only "is a conversation selected", never "is its switch on" -- and selection
// survives turning the switch off. The switch is the contract.
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('2');                       // select session-2: switch auto-ON
  await h.inbound('开着的对话');
  assert.equal(h.submitted.length, 1, 'forwarded while the switch is ON');

  const off = await call(h.routes.get(mod.TOGGLE_PATH), {
    method: 'POST', body: { sessionId: 'session-2', enabled: false },
  });
  assert.equal(off.json.enabled, false, 'the switch is now off');

  await h.inbound('关着的时候发的');
  assert.equal(
    h.submitted.length, 1,
    'a switched-off conversation must receive nothing, even though it is still selected',
  );
  // Disabling the selected conversation also clears the selection, so the next
  // message is answered with the picker rather than forwarded. Either reply is
  // acceptable; what must not happen is a forward.
  assert.match(
    h.sent.at(-1).text,
    /选择一个对话|开关是关着的/,
    'and the user is told what to do instead of silence',
  );
  ok('a switched-off conversation forwards nothing (regression)');
}
// --- a push must not silently open a switched-off conversation ---------------
// router.select() flips the target's switch ON (and every other one OFF), so
// auto-binding without checking would enable a conversation the user had closed.
// A push may move the pointer; it may not open a switch.
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('2');                                  // session-2 ON + selected
  assert.deepEqual(await applied.router.enabledIds(), ['session-2']);

  // Push about session-3, whose switch is OFF.
  await call(h.routes.get(mod.PUSH_PATH), { method: 'POST', body: { text: '通知', sessionId: 'session-3' } });
  assert.deepEqual(
    await applied.router.enabledIds(), ['session-2'],
    'pushing about a closed conversation must not turn its switch on',
  );
  assert.equal((await applied.router.snapshot()).selectedId, 'session-2', 'and the pointer stays put');
  ok('a push cannot silently enable a switched-off conversation');
}

// --- file route: send a file from disk to WeChat ----------------------------
{
  const h = makeHarness();
  const applied = await boot(h);

  const sent = await call(h.routes.get(mod.FILE_PATH), {
    method: 'POST', body: { path: 'D:\\out\\报告.pdf' },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.ok, true);
  assert.deepEqual(h.files, [{ userId: 'owner@im.wechat', filePath: 'D:\\out\\报告.pdf' },
  ], 'the path goes to the transport verbatim');
  assert.equal(sent.json.result.fileName, '报告.pdf');

  // A path is mandatory: guessing one is never right.
  const noPath = await call(h.routes.get(mod.FILE_PATH), { method: 'POST', body: {} });
  assert.equal(noPath.status, 400);
  const blankPath = await call(h.routes.get(mod.FILE_PATH), { method: 'POST', body: { path: '   ' } });
  assert.equal(blankPath.status, 400, 'whitespace is not a path');

  // Wrong verb.
  const getAttempt = await call(h.routes.get(mod.FILE_PATH), { method: 'GET' });
  assert.equal(getAttempt.status, 405);

  // The binding rule: a file about a CLOSED conversation may not open its switch.
  await h.inbound('2');                                   // session-2 is on, pointer here
  assert.deepEqual(await applied.router.enabledIds(), ['session-2']);
  await call(h.routes.get(mod.FILE_PATH), {
    method: 'POST', body: { path: 'D:\\out\\a.pdf', sessionId: 'session-3' },
  });
  assert.deepEqual(
    await applied.router.enabledIds(), ['session-2'],
    'pushing a file about a closed conversation must not turn its switch on',
  );
  assert.equal((await applied.router.snapshot()).selectedId, 'session-2', 'and the pointer stays put');

  // A file about an ON conversation does move the pointer, like a text push.
  await applied.router.setEnabled('session-3', true, 'third');
  await call(h.routes.get(mod.FILE_PATH), {
    method: 'POST', body: { path: 'D:\\out\\b.pdf', sessionId: 'session-3' },
  });
  assert.equal((await applied.router.snapshot()).selectedId, 'session-3');
  ok('the file route sends a file, validates its path, and obeys the binding rule');
}
// --- outbound binds the channel ---------------------------------------------
// Whichever conversation just sent something to WeChat is where the next WeChat
// message goes. Without this the user had to re-select after every push.
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('2');                                   // bind channel to session-2
  assert.equal((await applied.router.snapshot()).selectedId, 'session-2');
  // session-3 is ON too; its turn completing must move the channel to session-3.
  await applied.router.setEnabled('session-3', true, 'third');
  await h.turn('session-3', '第三个对话的回答');
  assert.equal(
    (await applied.router.snapshot()).selectedId, 'session-3',
    'the conversation that just spoke to WeChat owns the replies',
  );
  ok('a mirrored turn rebinds the channel to its own conversation');
}
// --- a long answer is chunked to fit the platform ceiling -------------------
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('2');
  h.sent.length = 0;
  const long = Array.from({ length: 400 }, (_v, i) => `第 ${i} 行：这是一段足够长的回答内容。`).join('\n');
  assert.ok(long.length > 1800, 'fixture is longer than one message');
  await h.turn('session-2', long);
  assert.ok(h.sent.length > 1, `a long answer must become several messages, got ${h.sent.length}`);
  for (const entry of h.sent) {
    assert.ok(entry.text.length <= 1800, `chunk of ${entry.text.length} chars exceeds the platform ceiling`);
  }
  const strip = (s) => s.replace(/\n/g, '');
  const joined = h.sent.map((e) => strip(e.text)).join('');
  // The first chunk carries the fenced `/session <id>` header, so the payload is
  // compared by suffix: the answer itself must survive chunking intact.
  assert.ok(joined.endsWith(strip(long)), 'nothing is lost or duplicated across the chunks');
  assert.ok(joined.includes('/session session-2'), 'the first chunk carries the copyable /session block');
  ok(`long answer is split into ${h.sent.length} messages, none over 1800 chars`);
}

// --- a failing chunk aborts the rest instead of silently truncating ---------
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('2');
  h.sent.length = 0;
  let calls = 0;
  const original = h.transport.sendText;
  h.transport.sendText = async (userId, text) => {
    calls += 1;
    if (calls === 2) return { ok: false, code: 'send-rejected' };
    return original(userId, text);
  };
  const long = Array.from({ length: 400 }, (_v, i) => `第 ${i} 行：这是一段足够长的回答内容。`).join('\n');
  await h.turn('session-2', long);
  assert.equal(calls, 2, 'stops at the first rejected chunk');
  ok('a rejected chunk stops the sequence (partial reply is not presented as complete)');
}

// --- /off disconnects and the next free text re-lists -----------------------
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('2');
  h.sent.length = 0;
  await h.inbound('/off');
  assert.match(h.sent[0].text, /已断开/);
  assert.deepEqual(await applied.router.enabledIds(), []);
  h.sent.length = 0;
  await h.inbound('在吗');
  assert.match(h.sent[0].text, /选择一个对话/, 'after /off the next text re-lists');
  ok('/off disconnects; next free text re-lists');
}

// --- /list always re-lists, and marks the connected row ---------------------
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('2');
  h.sent.length = 0;
  await h.inbound('/list');
  assert.match(h.sent[0].text, /^2\. ● /m, 'the connected row uses the filled mark');
  ok('/list re-lists and marks the connected row');
}

// --- /new step 1: the numbered workspace list --------------------------------
{
  const h = makeHarness();
  await boot(h);
  h.sent.length = 0;
  await h.inbound('/new');
  assert.equal(h.sent.length, 1, 'exactly one reply');
  const lines = h.sent[0].text.split('\n');
  assert.equal(lines[0], '在哪个工作区新建对话？');
  assert.equal(lines[1], '1. D:\\workspace', 'the registry order is the order shown');
  assert.equal(lines[2], '2. D:\\workspace\\project-b');
  assert.match(h.sent[0].text, /回复数字即可/);
  assert.match(h.sent[0].text, /2 分钟/);
  // Nothing has been created yet: step 1 asks, it does not act.
  assert.equal(h.created.length, 0, 'the list alone creates nothing');
  ok('/new replies with the numbered workspace list and creates nothing yet');
}

// --- /new step 2: the digit creates in THAT workspace, then selects it -------
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('/new');
  h.sent.length = 0;
  await h.inbound('2');
  assert.equal(h.created.length, 1, 'one conversation was created');
    assert.deepEqual(h.created[0], { workspaceId: 'ws-2', sessionId: 'session-new-1' },
      'the second workspace is addressed BY ID: only create({workspaceId}) makes the host attach the session to its workspace, which is what groups it in the GUI. Creating by cwd alone produced a 未分组 session.');
  const state = await applied.router.snapshot();
  assert.equal(state.selectedId, 'session-new-1', 'the new conversation is selected');
  assert.equal(await applied.router.isEnabled('session-new-1'), true, 'and its switch is ON');
  assert.match(h.sent[0].text, /已新建对话|新建对话/);
  assert.match(h.sent[0].text, /D:\\workspace\\project-b/);
  assert.match(h.sent[0].text, /会话 ID：session-new-1/);
  assert.match(h.sent[0].text, /(新对话，还没有标题)/, 'a brand-new conversation has no title yet, and says so');
  // Consumed: a second bare number must not create a second conversation.
  h.sent.length = 0;
  await h.inbound('1');
  assert.equal(h.created.length, 1, 'the pending choice was consumed by the first answer');
  assert.match(h.sent[0].text, /已切到 1\./, 'the digit falls back to the conversation picker');
  ok('/new + a digit creates the conversation in that workspace, selects it, and consumes the choice');
}

// --- the pending choice OUTRANKS the conversation picker --------------------
// The regression this exists for: replying "2" while a workspace list is open
// would otherwise select the 2nd EXISTING conversation -- a real switch flip with
// a real side effect -- instead of creating one in the 2nd workspace.
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('/new');
  h.sent.length = 0;
  await h.inbound('3');
  assert.equal(h.created.length, 0, 'the picker did not select anything: 3 is not a conversation index either');
  assert.match(h.sent[0].text, /没有第 3 个工作区，只有 1–2/, 'the WORKSPACE list judged the number');
  const state = await applied.router.snapshot();
  assert.equal(state.selectedId, null, 'nothing was selected behind the pending choice');
  assert.deepEqual(await applied.router.enabledIds(), [], 'and no switch was flipped');

  // The slot is still open, so the typo can simply be retyped.
  h.sent.length = 0;
  await h.inbound('1');
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].workspaceId, 'ws-1', 'addressed by id, so the host groups it under that workspace');
  ok('a pending /new choice outranks the conversation picker, and an out-of-range digit can be retyped');
}

// --- the pending choice is cancelled by any other command -------------------
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('/new');
  h.sent.length = 0;
  await h.inbound('/list');
  assert.match(h.sent[0].text, /已取消新建对话。/, 'the cancellation is announced, never silent');
  assert.match(h.sent[1].text, /选择一个对话/, 'and the command that cancelled it still runs');
  // Cancelled means cancelled: the next bare number is the conversation picker's.
  h.sent.length = 0;
  await h.inbound('2');
  assert.equal(h.created.length, 0, 'the cancelled choice cannot create anything');
  assert.match(h.sent[0].text, /已切到 2\./, 'the digit is a conversation selection again');
  ok('any other command cancels a pending /new, visibly, and still takes effect');
}

// --- plain text cancels a pending /new too, and is then handled normally -----
// "Send anything else" has to include chat: otherwise a user who changes their
// mind mid-answer would have their next real message swallowed by the question.
{
  const h = makeHarness();
  await boot(h);
  await h.inbound('2');                                    // connect to session-2
  await h.inbound('/new');
  h.sent.length = 0;
  await h.inbound('帮我看看这段代码');
  assert.match(h.sent[0].text, /已取消新建对话。/);
  assert.equal(h.submitted.length, 1, 'the message itself still went into the connected conversation');
  assert.deepEqual(h.submitted[0], { sessionId: 'session-2', text: '帮我看看这段代码' });
  assert.equal(h.created.length, 0);
  ok('plain text cancels a pending /new and is still forwarded normally');
}

// --- the pending choice expires -------------------------------------------------
// The TTL is the bound on "a later, unrelated 2 creates a conversation the user
// never asked for". Real time, tiny window (config.newChoice.ttlMs is the seam).
{
  const h = makeHarness();
  await boot(h, { modules: h.loaders, weixinEnabled: true, newChoice: { ttlMs: 30 } });
  await h.inbound('/new');
  h.sent.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await h.inbound('1');
  assert.equal(h.created.length, 0, 'an expired choice creates nothing');
  assert.match(h.sent[0].text, /已切到 1\./, 'and the digit is an ordinary conversation selection again');
  ok('a pending /new expires and stops answering numbers');
}

// --- /new with nothing to offer is reported, not left hanging ----------------
{
  const h = makeHarness();
  h.flags.workspaceRegistry = false;                 // no registry
  h.bridge.listSessions = async () => [];            // and no conversation carries a cwd
  await boot(h);
  h.sent.length = 0;
  await h.inbound('/new');
  assert.match(h.sent[0].text, /没有可用的工作区/);
  assert.equal(h.sent.length, 1, 'exactly one message: no empty numbered list follows');
  h.sent.length = 0;
  await h.inbound('1');
  assert.equal(h.created.length, 0, 'no choice was opened, so no number can create anything');
  assert.match(h.sent[0].text, /选择一个对话|没有可选的对话/, 'the number stayed with the conversation picker');
  ok('/new with no workspaces says so and opens no pending choice');
}

// --- without a registry, workspaces come from the conversations' cwd ---------
// The fallback that matters in practice: a directory opened without ever being
// registered as a workspace still has to be offered.
{
  const h = makeHarness();
  h.flags.workspaceRegistry = false;
  await boot(h);
  h.sent.length = 0;
  await h.inbound('/new');
  const lines = h.sent[0].text.split('\n');
  assert.equal(lines[1], '1. D:\\workspace');
  assert.equal(lines[2], '2. D:\\workspace\\project-b');
  assert.equal(lines.length, 5, 'two rows, no duplicates: session-1 and session-2 share D:\\workspace');
  ok('without a workspace registry, /new falls back to the recent conversations’ cwd');
}

// --- /new reports a failing create instead of going quiet --------------------
{
  const h = makeHarness();
  h.createFailure.message = 'workspace/not-found: workspace "x" not found';
  const applied = await boot(h);
  await h.inbound('/new');
  h.sent.length = 0;
  await h.inbound('1');
  assert.match(h.sent[0].text, /新建对话失败/, 'the failure is answered in WeChat');
  assert.match(h.sent[0].text, /workspace\/not-found/, 'and carries the host reason');
  const r = await call(h.routes.get(mod.STATE_PATH));
  assert.match(r.json.newSession.lastError, /workspace\/not-found/, 'and the state route can explain it too');
  assert.equal(r.json.newSession.canCreate, true, 'the service itself is present');
  assert.equal((await applied.router.snapshot()).selectedId, null, 'nothing was selected on a failed create');
  ok('/new surfaces a failed create in WeChat and on the state route');
}

// --- /new without sessionController degrades with a readable reason ----------
{
  const h = makeHarness();
  const applied = await boot(h);
  // Remove the service AFTER apply, which is the only way to model a host that
  // composed the plugin without a session controller. `hostServices` is the live
  // object the plugin holds, not a copy.
  applied.hostServices.sessionController = undefined;
  h.sent.length = 0;
  await h.inbound('/new');
  await h.inbound('1');
  assert.match(h.sent.at(-1).text, /宿主没有提供 sessionController\.create/);
  assert.equal(h.created.length, 0);
  ok('/new without sessionController reports the missing service instead of pretending');
}

// --- /session <id> open / close ---------------------------------------------
{
  const h = makeHarness();
  const applied = await boot(h);
  // open: switch ON and the pointer moves there.
  h.sent.length = 0;
  await h.inbound('/session session-3 open');
  assert.equal(await applied.router.isEnabled('session-3'), true, 'open turns the switch ON');
  assert.equal(await applied.router.selectedId(), 'session-3', 'open moves the pointer');
  assert.match(h.sent[0].text, /已打开 小游戏原型 的微信连接/);

  // close: switch OFF, and the pointer is released because it was here.
  h.sent.length = 0;
  await h.inbound('/session session-3 close');
  assert.equal(await applied.router.isEnabled('session-3'), false, 'close turns the switch OFF');
  assert.equal(await applied.router.selectedId(), null, 'closing the pointed-at conversation clears the pointer');
  assert.match(h.sent[0].text, /已关闭 小游戏原型 的微信连接/);

  // After close, free text must NOT be forwarded into it.
  h.sent.length = 0;
  await h.inbound('在吗');
  assert.equal(h.submitted.length, 0, 'a closed conversation receives nothing');
  assert.match(h.sent[0].text, /选择一个对话/, 'and the user is offered the list');

  // Closing a conversation the pointer is NOT on must not move the pointer.
  await h.inbound('1');                                    // select session-1
  h.sent.length = 0;
  await h.inbound('/session session-2 close');
  assert.equal(await applied.router.selectedId(), 'session-1', 'closing another conversation leaves the pointer alone');
  assert.equal(await applied.router.isEnabled('session-1'), true);
  ok('/session <id> open and close move the switch both ways and keep the pointer honest');
}

// --- /session <id> open|close with an unknown id -----------------------------
{
  const h = makeHarness();
  const applied = await boot(h);
  await h.inbound('2');                                    // some real state to protect
  h.sent.length = 0;
  await h.inbound('/session does-not-exist open');
  assert.equal(h.sent[0].text, '没有找到会话 does-not-exist。发任意消息可以看到编号列表。');
  await h.inbound('/session does-not-exist close');
  assert.match(h.sent[1].text, /没有找到会话 does-not-exist/);
  assert.equal(await applied.router.selectedId(), 'session-2', 'an unknown id changes nothing');
  assert.equal(await applied.router.isEnabled('session-2'), true);
  ok('an unknown session id is reported and changes no state');
}

// --- the bare /session <id> keeps its old semantics --------------------------
{
  const h = makeHarness();
  const applied = await boot(h);
  h.sent.length = 0;
  await h.inbound('/session session-3');
  assert.equal(await applied.router.isEnabled('session-3'), true, 'bare form still opens the switch');
  assert.equal(await applied.router.selectedId(), 'session-3', 'and still moves the pointer');
  assert.match(h.sent[0].text, /已切到 3\. 小游戏原型/, 'with the same confirmation as before');
  h.sent.length = 0;
  await h.inbound('/session nope');
  assert.equal(h.sent[0].text, '没有找到会话 nope。发任意消息可以看到编号列表。');
  ok('the bare /session <id> form is unchanged (select + open)');
}

// --- the state route reports the /new capability ----------------------------
{
  const h = makeHarness();
  await boot(h);
  const r = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(r.json.newSession.canCreate, true);
  assert.equal(r.json.newSession.sessionController, 'create');
  assert.equal(r.json.newSession.workspaceRegistry, 'present');
  assert.equal(r.json.newSession.workspaceSource, 'registry');
  assert.deepEqual(r.json.newSession.workspaces, ['D:\\workspace', 'D:\\workspace\\project-b']);
  assert.equal(r.json.newSession.pending, false);
  assert.equal(r.json.newSession.maxChoices, 9);
  assert.equal(r.json.newSession.ttlMs, 120_000);
  // And `pending` follows the live slot, which is what makes the precedence
  // rule observable from outside.
  await h.inbound('/new');
  const r2 = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(r2.json.newSession.pending, true);
  ok('the state route reports whether /new can create, and where the workspaces came from');
}

// --- http routes: state / toggle / beacon ----------------------------------
{
  const h = makeHarness();
  await boot(h);
  assert.ok(h.routes.has(mod.STATE_PATH), 'state route registered');
  assert.ok(h.routes.has(mod.TOGGLE_PATH), 'toggle route registered');
  assert.ok(h.routes.has(mod.BEACON_PATH), 'beacon route registered');

  let r = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.transportReady, true);
  assert.equal(r.json.available.length, 3, 'the client can see the conversation list');

  r = await call(h.routes.get(mod.TOGGLE_PATH), { method: 'POST', body: { sessionId: 'session-3', enabled: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.selectedId, 'session-3');
  assert.deepEqual(r.json.sessions['session-3'].enabled, true);

  r = await call(h.routes.get(mod.TOGGLE_PATH), { method: 'POST', body: { enabled: true } });
  assert.equal(r.status, 400, 'missing sessionId is rejected');

  await call(h.routes.get(mod.BEACON_PATH), { method: 'POST', body: { stage: 'eval', detail: 'no-boot' } });
  await call(h.routes.get(mod.BEACON_PATH), { method: 'POST', body: { stage: 'registered', detail: null } });
  r = await call(h.routes.get(mod.BEACON_PATH));
  assert.equal(r.json.count, 2);
  assert.equal(r.json.beacons[0].stage, 'registered', 'newest beacon first');
  ok('state / toggle / beacon routes behave, including validation');
}

// --- degradation: a module that fails to load must not break the host -------
// Deliberately NOT `modules: {}` -- that would load the real transport and dial
// WeChat from a unit test. A loader that throws models the same condition
// hermetically.
{
  const h = makeHarness();
  const applied = await boot(h, {
    modules: {
      transport: async () => { throw new Error('module not found'); },
      bridge: async () => { throw new Error('module not found'); },
    },
  });
  assert.equal(applied.transport, null);
  assert.equal(applied.bridge, null);
  const r = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(r.status, 200, 'the switch must still answer while the bridge is down');
  assert.equal(r.json.transportReady, false);
  assert.equal(r.json.hasTransport, false, 'no transport object was built');
  // The whole setup block is contained; the failure surfaces as applyError so a
  // broken plugin can still explain itself over the diagnostic routes.
  assert.match(String(r.json.applyError), /module not found/, 'the failure is reported, not swallowed');
  ok('modules that fail to load degrade gracefully and are reported, host stays up');
}

// --- the safety valve: transport stays down unless weixinEnabled ------------
// While dsh-im is still mounted it polls the same bot; two consumers steal each
// other's messages. So the default must be "loaded but not connected".
{
  const h = makeHarness();
  const freshHome = await newHome();
  const applied = await applyBox(h.ctx, h.services, { modules: h.loaders });   // no weixinEnabled
  assert.ok(applied.transport !== null, 'the transport object is constructed');
  const r = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(r.status, 200);
  assert.equal(r.json.transportReady, false, 'the transport must NOT be connected by default');
  assert.match(String(r.json.transportError), /disabled by config/);
  // and nothing was dialled: the fake transport records whether start() ran
  assert.equal(h.started, false, 'transport.start() must not be called');
  // The switch still works, and the bridge still observes turns.
  await h.inbound('你好');
  assert.equal(h.sent.length, 0, 'no inbound handling while the transport is down');
  await rm(freshHome, { recursive: true, force: true });
  ok('safety valve: weixinEnabled absent -> transport loaded but not started');
}

// --- routes are registered BEFORE the risky setup (regression guard) --------
// A previous version registered them after loading the transport/bridge. When
// that setup threw, apply() aborted, every route 401'd, and the client half was
// still announced -- so the failure was invisible from outside.
{
  const h = makeHarness();
  const applied = await boot(h, {
    weixinEnabled: true,
    modules: { transport: async () => { throw new Error('kaboom'); } },
  });
  assert.ok(h.routes.has(mod.STATE_PATH), 'state route exists despite setup failure');
  assert.ok(h.routes.has(mod.TOGGLE_PATH), 'toggle route exists despite setup failure');
  assert.ok(h.routes.has(mod.BEACON_PATH), 'beacon route exists despite setup failure');
  const r = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(r.status, 200);
  assert.match(String(r.json.applyError), /kaboom/, 'the plugin can explain its own failure');
  assert.equal(applied.applyError.includes('kaboom'), true);
  ok('routes are registered before setup: a broken plugin still explains itself');
}

// --- a context with no webServer still fails soft ---------------------------
{
  const h = makeHarness();
  const bareServices = {};
  const bare = {
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {}; },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    provide(name, value) { bareServices[name] = value; },
  };
  const applied = await applyBox(bare, bareServices, { modules: {}, weixinEnabled: true });
  assert.ok(applied, 'the inspection surface is available even when setup failed');
  assert.ok(String(applied.applyError ?? '').length > 0, 'the missing web server is reported');
  ok('a context without webServer fails soft and reports why');
}

// --- R7: host questions are answered from WeChat ----------------------------
{
  const h = makeHarness();
  await boot(h);
  const handlers = h.questionHandlers();
  assert.equal(handlers.length, 1, 'exactly one user-questions/request handler');
  assert.deepEqual(handlers[0].options, { global: true, prepend: true }, 'takes the front of the waterfall');

  // R3/A5: a question belongs to a conversation, and it only reaches WeChat when
  // THAT conversation's switch is ON. The switch is opened through the same route
  // the Web UI's pill uses, so this is the real precondition, not a test bypass.
  const opened = await call(h.routes.get(mod.TOGGLE_PATH), {
    method: 'POST', body: { sessionId: 'session-1', enabled: true, title: '文档整理' },
  });
  assert.equal(opened.json.ok, true, 'the conversation switch was opened');
  h.sent.length = 0;
  const request = {
    questions: [{
      id: 'q1', header: '选方案', question: '你更倾向哪种？',
      options: [{ label: '快但糙' }, { label: '慢但稳' }],
    }],
    agent: { sessionId: 'session-1' },
    signal: new AbortController().signal,
  };
  let hostAnswered = false;
  const promise = handlers[0].handler(request, () => { hostAnswered = true; return new Promise(() => {}); });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(hostAnswered, true, 'the host answerer still gets its chance (they race)');
  assert.equal(h.sent.length, 1, 'the question went to WeChat');
  assert.match(h.sent[0].text, /你更倾向哪种/);
  assert.match(h.sent[0].text, /^2\. 慢但稳$/m);

  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.questionPending, true, 'the pending question is observable');
  assert.equal(state.json.questionsRegistered, true);

  // The reply is the ANSWER, not a new instruction -- the picker must not run.
  await h.inbound('2');
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['慢但稳'] }] });
  assert.equal(h.submitted.length, 0, 'the answer was not mistaken for a chat message');
  const after = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(after.json.questionPending, false);
  ok('R7 a host question is pushed to WeChat and the numbered reply answers it');
}

// --- R7/A5: an OFF conversation's question never reaches WeChat --------------
// The reported bug: with the plugin not switched on for the conversation, the
// question text AND its option labels were pushed anyway. The waterfall is
// registered `{ global: true }`, so it fires for every conversation; the
// per-conversation switch has to be enforced inside the handler.
{
  const h = makeHarness();
  await boot(h);
  const handler = h.questionHandlers()[0].handler;
  const question = (sessionId) => ({
    questions: [{
      id: 'q1', header: '选方案', question: '你更倾向哪种？',
      options: [{ label: '快但糙' }, { label: '慢但稳' }],
    }],
    ...(sessionId === undefined ? {} : { agent: { sessionId } }),
  });

  // 1. The conversation was never switched on.
  let handed = null;
  const denied = await handler(question('session-2'), async () => { handed = 'session-2'; return { answers: [] }; });
  assert.equal(handed, 'session-2', 'a question for an OFF conversation goes to the host');
  assert.deepEqual(denied, { answers: [] });
  assert.equal(h.sent.length, 0, 'nothing was pushed for an OFF conversation');
  const offState = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(offState.json.questionPending, false, 'and no pending was left to swallow the next message');

  // 2. A conversation that WAS on and has since been closed.
  await h.inbound('1');                       // opens session-1
  await h.inbound('/off');                    // closes it again
  h.sent.length = 0;
  handed = null;
  await handler(question('session-1'), async () => { handed = 'session-1'; return { answers: [] }; });
  assert.equal(handed, 'session-1', 'a question for a closed conversation goes to the host');
  assert.equal(h.sent.length, 0, 'nothing was pushed after the switch was closed');

  // 3. An unscoped question names no conversation, so it cannot be ours.
  handed = null;
  await handler(question(undefined), async () => { handed = 'unscoped'; return { answers: [] }; });
  assert.equal(handed, 'unscoped', 'an unscoped question goes to the host');
  assert.equal(h.sent.length, 0, 'an unscoped question is never pushed');
  ok('R7/A5 a question for a conversation whose switch is OFF is never pushed to WeChat');
}

// --- R7 must stay OFF while the safety valve is closed ----------------------
// dsh-im registers the same waterfall with prepend:true. Two answerers would
// both push the question to WeChat, so the valve has to gate it too.
{
  const h = makeHarness();
  await boot(h, { modules: h.loaders });          // no weixinEnabled
  assert.equal(h.questionHandlers().length, 0, 'no question handler while the valve is closed');
  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.questionsRegistered, false);
  assert.equal(state.json.questionPending, false);
  ok('R7 the question waterfall is not registered while the valve is closed');
}

// --- a second ask while one is open is handed to the host -------------------
{
  const h = makeHarness();
  await boot(h);
  // Open session-1 through the real route: the A5 gate needs an ON conversation.
  await call(h.routes.get(mod.TOGGLE_PATH), { method: 'POST', body: { sessionId: 'session-1', enabled: true } });
  const handler = h.questionHandlers()[0].handler;
  const question = {
    questions: [{ id: 'q1', question: '第一个' }],
    agent: { sessionId: 'session-1' },
    signal: new AbortController().signal,
  };
  const first = handler(question, () => new Promise(() => {}));
  await new Promise((r) => setTimeout(r, 5));
  let secondHandedOver = false;
  const second = handler({ questions: [{ id: 'q2', question: '第二个' }], agent: { sessionId: 'session-1' } },
    async () => { secondHandedOver = true; return { answers: [{ id: 'q2', selected: [], custom: 'host' }] }; });
  assert.equal(secondHandedOver, true, 'the second ask did not interleave');
  await second;
  await h.inbound('随便');
  await first;
  ok('a second concurrent ask is handed straight to the host');
}

// --- A11: host approvals are answered from WeChat ---------------------------
{
  const h = makeHarness();
  await boot(h);
  const handlers = h.approvalHandlers();
  assert.equal(handlers.length, 1, 'exactly one approval/request handler');
  assert.deepEqual(handlers[0].options, { global: true, prepend: true });

  await call(h.routes.get(mod.TOGGLE_PATH), { method: 'POST', body: { sessionId: 'session-1', enabled: true } });
  h.sent.length = 0;
  const request = {
    toolName: 'pwsh', callId: 'c1', reason: '要写沙箱外的文件',
    agent: { sessionId: 'session-1' },
    signal: new AbortController().signal,
  };
  const promise = handlers[0].handler(request, () => new Promise(() => {}));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.sent.length, 1, 'the approval went to WeChat');
  assert.match(h.sent[0].text, /要执行：pwsh/);
  assert.match(h.sent[0].text, /要写沙箱外的文件/);

  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.approvalPending, true);
  assert.equal(state.json.approvalsRegistered, true);

  await h.inbound('批准');
  assert.equal(await promise, 'allowed-once');
  assert.equal(h.submitted.length, 0, 'the approval reply was not routed as chat');
  ok('A11 an approval is pushed to WeChat and 「批准」 resolves it as allowed-once');

  // With no approval pending, 「拒绝」 is ordinary chat again. This conversation's
  // switch is ON (the A5 gate required it), so it is forwarded like any other
  // message -- the point is only that it is no longer consumed as an approval.
  await h.inbound('拒绝');
  assert.deepEqual(h.submitted.at(-1), { sessionId: 'session-1', text: '拒绝' },
    'a stray 拒绝 after settling is ordinary chat, not a second answer');
}

// --- A11/A5: an OFF conversation's approval never reaches WeChat -------------
{
  const h = makeHarness();
  await boot(h);
  const handler = h.approvalHandlers()[0].handler;
  // session-2 was never switched on, so its approval is the host's business.
  let handed = null;
  const outcome = await handler(
    { toolName: 'pwsh', reason: 'rm -rf', agent: { sessionId: 'session-2' } },
    async () => { handed = 'session-2'; return 'unavailable'; },
  );
  assert.equal(handed, 'session-2', 'an OFF conversation\'s approval goes to the host');
  assert.equal(outcome, 'unavailable');
  assert.equal(h.sent.length, 0, 'nothing was pushed for the OFF conversation');
  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.approvalPending, false, 'and no pending was left behind');
  ok('A11/A5 an approval for a conversation whose switch is OFF is never pushed');
}

// --- A11 must stay OFF while the safety valve is closed ---------------------
{
  const h = makeHarness();
  await boot(h, { modules: h.loaders });
  assert.equal(h.approvalHandlers().length, 0, 'no approval handler while the valve is closed');
  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.approvalsRegistered, false);
  assert.equal(state.json.approvalPending, false);
  ok('A11 the approval waterfall is not registered while the valve is closed');
}

// --- objective 7: the runtime switch, and it survives a restart -------------
{
  const h = makeHarness();
  await newHome();
  await boot(h, { modules: h.loaders, weixinEnabled: true });
  assert.equal(h.started, true, 'starts enabled when asked');

  let r = await call(h.routes.get(mod.ENABLED_PATH), { method: 'POST', body: { enabled: false } });
  assert.equal(r.status, 200);
  assert.equal(r.json.weixinEnabled, false);
  assert.equal(h.questionHandlers().length, 0, 'the question waterfall was detached');
  assert.equal(h.approvalHandlers().length, 0, 'the approval waterfall was detached');
  assert.equal(r.json.transportReady, false);

  r = await call(h.routes.get(mod.ENABLED_PATH), { method: 'POST', body: { enabled: true } });
  assert.equal(r.json.weixinEnabled, true);
  assert.equal(h.questionHandlers().length, 1, 'the question waterfall came back');
  assert.equal(h.approvalHandlers().length, 1, 'the approval waterfall came back');

  r = await call(h.routes.get(mod.ENABLED_PATH), { method: 'POST', body: { enabled: 'yes' } });
  assert.equal(r.status, 400, 'only a real boolean is accepted');

  // Persisted: a fresh apply must honour the stored choice, not the bundle default.
  await call(h.routes.get(mod.ENABLED_PATH), { method: 'POST', body: { enabled: false } });
  const h2 = makeHarness();
  await applyBox(h2.ctx, h2.services, { modules: h2.loaders });     // no weixinEnabled in the config
  const state2 = await call(h2.routes.get(mod.STATE_PATH));
  assert.equal(state2.json.weixinEnabled, false, 'the stored setting wins over the bundle default');
  assert.equal(state2.json.weixinEnabledSource, 'settings-file');
  assert.equal(h2.started, false, 'and the transport stayed down');
  ok('objective 7: the switch flips live, detaches the waterfalls, and persists');
}

// --- objective 6: the settings page can read the bound account, masked ------
{
  const h = makeHarness();
  await boot(h);
  const r = await call(h.routes.get(mod.STATE_PATH));
  const account = r.json.account;
  assert.ok(account, 'the state route reports the bound account');
  // Same-strength assertions as before, against the neutral fixture: the mask is
  // recognisable (exact head + exact tail, no longer than the mask contract), and
  // the full identifier appears nowhere in the payload.
  assert.ok(account.botId.startsWith('wx_exa'), `bot id is recognisable, got ${account.botId}`);
  assert.equal(account.botId, 'wx_exa…t_id', `the bot id is the exact 6+4 mask, got ${account.botId}`);
  assert.ok(!JSON.stringify(r.json).includes(BOT_ID), 'the full bot id never leaves the host');
  assert.ok(!JSON.stringify(r.json).includes(OWNER_USER_ID), 'the owner id never leaves the host');
  assert.equal(account.ownerUserId, 'owner@…chat', `the owner id is masked too, got ${account.ownerUserId}`);
  assert.equal(account.baseUrlHost, 'ilinkai.weixin.qq.com');
  assert.equal(account.tokenRef, 'DSH_WEIXIN_BOT_TOKEN_TEST', 'the ref name is safe to show');
  assert.ok(!JSON.stringify(r.json).includes('secret-value'), 'no secret is exposed');
  ok('objective 6: bound account is reported and every real identifier is masked');
}

// --- a throwing transport factory is contained, not fatal -------------------
{
  const h = makeHarness();
  const applied = await boot(h, {
    modules: {
      transport: async () => { throw new Error('boom'); },
      bridge: h.loaders.bridge,
    },
  });
  assert.equal(applied.transport, null);
  const r = await call(h.routes.get(mod.STATE_PATH));
  assert.match(String(r.json.applyError), /boom/);
  assert.equal(r.status, 200, 'the routes still answer after a contained failure');
  ok('a throwing transport factory is contained');
}

// --- no inbound handler before transport.start resolves ---------------------
{
  const h = makeHarness();
  const applied = await boot(h);
  assert.equal(applied.transport !== null, true);
  await h.inbound('你好');
  assert.equal(h.sent.length, 1, 'transport.start handed us the inbound handler');
  ok('transport.start receives the inbound handler');
}

// ===========================================================================
// QR binding (DESIGN.md 10): begin -> poll -> activate, with a real rollback.
//
// Everything below drives the flow with a stubbed login primitive. No test in
// this package may reach ilinkai.weixin.qq.com -- the only thing that would
// prove is that this machine has a network.
// ===========================================================================

/** A scripted login primitive; `pollCalls` lets a case assert what was sent. */
function makeLogin(script) {
  const pollCalls = [];
  let beginCalls = 0;
  const login = {
    pollCalls,
    beginCount: () => beginCalls,
    async beginLogin() {
      beginCalls += 1;
      return { qrcode: `qr-${beginCalls}`, qrcodeUrl: 'https://ilinkai.weixin.qq.com/qr/test.png', baseUrl: 'https://ilinkai.weixin.qq.com/' };
    },
    async pollLogin(options) {
      pollCalls.push(options);
      const step = script[Math.min(pollCalls.length - 1, script.length - 1)];
      return typeof step === 'function' ? step(options, pollCalls.length) : step;
    },
  };
  return login;
}

function qrConfig(h, login, extra = {}) {
  return {
    weixinEnabled: true,
    modules: { transport: h.loaders.transport, bridge: h.loaders.bridge, login: async () => login },
    login: { credentialsTimeoutMs: 50 },
    ...extra,
  };
}

const NEW_BOT = {
  token: 'bot-token-for-wx-new',
  accountId: 'wx_new',
  ownerUserId: 'owner-new@im.wechat',
  baseUrl: 'https://ilinkai.weixin.qq.com/',
};

// --- begin -> poll(wait) -> poll(confirmed): the whole activation chain -----
{
  const h = makeHarness();
  const login = makeLogin([{ status: 'wait' }, { status: 'confirmed', credentials: NEW_BOT }]);
  const applied = await boot(h, qrConfig(h, login));

  // The boot transport is the legacy dsh-im account.
  assert.equal(h.transports.length, 1, 'one transport exists before binding');
  assert.equal(h.transports[0].accountId, 'abc@im.bot', 'booted from the dsh-im config');
  assert.equal(h.transports[0].stopped, 0);

  let r = await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.qrcodeUrl, 'https://ilinkai.weixin.qq.com/qr/test.png', 'the browser gets the image address');
  assert.equal(typeof r.json.expiresAtMs, 'number');
  assert.ok(r.json.expiresAtMs > Date.now(), 'the QR has a future deadline');
  assert.ok(!JSON.stringify(r.json).includes('qr-1'), 'the polling token never leaves the host');

  r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, 'wait', 'an unscanned code is reported as-is');
  assert.deepEqual(r.json.account, undefined);

  r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, 'confirmed');
  // Identifiers are masked on their way out (`wx_new` is short, so only its head
  // survives) -- the settings page never needs the full id, and this route is
  // unauthenticated on localhost.
  assert.equal(r.json.account.botId, 'wx***', 'the bound bot is named, masked');
  assert.ok(!JSON.stringify(r.json).includes(NEW_BOT.token), 'the token is never echoed to the browser');

  // 1. the credential record: our own namespace, a grant, the raw token inside.
  const key = 'dsh-wechat-box/wx-new';
  assert.ok(h.credentialRecords.has(key), `the grant was stored under ${key}`);
  const record = h.credentialRecords.get(key);
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.token, NEW_BOT.token);
  assert.equal(record.payload.accountId, NEW_BOT.accountId);
  assert.equal(record.payload.ownerUserId, NEW_BOT.ownerUserId);
  assert.equal(record.payload.baseUrl, NEW_BOT.baseUrl);

  // 2. the account file, atomically written, with the identifiers -- and NO token.
  // The token's only home is the credential record checked above: this file is
  // guarded by ordinary ACLs (its `mode: 0600` is a no-op on Windows), so a token
  // in it would be effectively unprotected. Checked by KEY, not by string match.
  const written = JSON.parse(await readFile(h.accountFile, 'utf8'));
  assert.equal(written.botId, 'wx_new');
  assert.equal(written.accountId, 'wx_new');
  assert.equal(written.ownerUserId, NEW_BOT.ownerUserId);
  assert.equal(written.baseUrl, NEW_BOT.baseUrl);
  assert.equal(typeof written.updatedAt, 'number');
  assert.equal(Object.hasOwn(written, 'token'), false, 'the account file must not have a token field at all');
  assert.deepEqual(
    Object.keys(written).sort(),
    ['accountId', 'baseUrl', 'botId', 'ownerUserId', 'updatedAt', 'version'],
    'exactly the identity fields, nothing else',
  );
  assert.ok(!JSON.stringify(written).includes(NEW_BOT.token), 'and not the value under another name either');

  // 3+4. the transport was swapped: a NEW object, started, and the old one stopped.
  assert.equal(h.transports.length, 2, 'a new transport was built for the new account');
  const next = h.transports[1];
  assert.equal(next.accountId, 'wx_new');
  assert.equal(next.started, true, 'the new transport is running');
  assert.equal(h.transports[0].stopped, 1, 'the old transport was stopped');
  // The freshly scanned account has no reference anywhere, so the token itself is
  // what the new transport is built with -- and it is the token that just landed in
  // the record, not a second copy travelling beside it.
  const scanOptions = h.transportOptions.at(-1);
  assert.equal(scanOptions.account.token, NEW_BOT.token, 'the new transport is handed the scanned token');
  assert.equal(scanOptions.account.token, record.payload.token, 'exactly what the credential record holds');
  assert.equal(scanOptions.account.tokenRef, null, 'and no reference it could not resolve');
  assert.equal(scanOptions.account.credentialSource, 'credential-record', 'and the state route can say where it came from');
  // The inbound handler now belongs to the NEW transport: transport.start() is
  // what installs it, so an inbound message arriving through the new one is the
  // observable proof that the swap took.
  h.sent.length = 0;
  await h.inbound('/list');
  assert.ok(h.sent.length > 0, 'the new transport is wired to the router (a /list round-trip answered)');

  // and the state route agrees, including which file the account came from.
  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.account.botId, 'wx***', 'the activated account is the one reported');
  assert.equal(state.json.account.source, 'qr-login');
  assert.equal(state.json.account.credentialKind, 'token');
  assert.equal(state.json.login.pending, false, 'the pending QR was consumed');
  assert.equal(state.json.login.activationError, null);
  // A scan moves a live bot token through this process; the diagnostic surface is
  // what a curious page (or a log) would read, so it must never carry one.
  assert.equal(state.json.account.credentialKind, 'token', 'the panel knows there is a token');
  assert.ok(!state.json.account.token, 'but the token itself is not on the diagnostic route');
  assert.ok(!JSON.stringify(state.json).includes(NEW_BOT.token), 'and it is not anywhere else in the payload');
  ok('QR begin -> poll(wait) -> poll(confirmed): record + account file + transport swap');
}

// --- the rollback: a failure mid-activation puts the old account back -------
// This is the case the design calls out: no half-activated bridge. The failure
// is injected at step 2 (the account file), which is AFTER the credential record
// has already been stored -- so the test proves the record is undone too, not
// just that the transport survived.
{
  const h = makeHarness();
  const applied = await boot(h, qrConfig(h, makeLogin([{ status: 'confirmed', credentials: NEW_BOT }])));
  const oldTransport = h.transports[0];
  // A directory where the account file belongs: mkdir succeeds, the temp write
  // cannot become that file, and the rename can never succeed either. Nothing is
  // stubbed inside the plugin -- this is a real filesystem failure.
  await rm(h.accountFile, { force: true });
  await mkdir(h.accountFile, { recursive: true });

  await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  const r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, false, 'the bind reports failure');
  assert.equal(r.json.code, 'activation-failed');
  assert.equal(r.json.rolledBack, true, 'and says the rollback completed');

  assert.equal(h.transports.length, 1, 'no second transport was left running');
  assert.equal(oldTransport.stopped, 0, 'the old transport was never taken down');
  assert.equal(oldTransport.started, true, 'the old bridge is still up');
  assert.equal(applied.transport, oldTransport, 'the plugin still points at the old transport');
  assert.equal(
    h.credentialRecords.has('dsh-wechat-box/wx-new'), false,
    'the credential record written by the failed activation was removed again',
  );

  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.account.botId, 'wx_exa…t_id', 'the bound account is unchanged (masked)');
  assert.equal(state.json.account.source, 'dsh-im-config');
  assert.match(String(state.json.login.activationError), /activation failed/, 'and the reason is visible');
  assert.match(String(state.json.login.activationError), /undone/, 'including what was undone');

  // The old bridge still works: a push still goes out.
  await call(h.routes.get(mod.PUSH_PATH), { method: 'POST', body: { text: '还在吗' } });
  assert.equal(h.sent.length, 1, 'the surviving transport still sends');
  ok('a failed activation rolls back the account file and the credential record, old transport intact');
}

// --- the rollback: the old transport is BROUGHT BACK when the swap failed ----
// Here the failure is later: the credential record and the account file both
// land, the new transport is built, and its start() throws. The old transport has
// already been stopped by then, so getting back to a working bridge is the hard
// half of the rollback.
{
  const login = makeLogin([{ status: 'confirmed', credentials: NEW_BOT }]);
  const options = [];
  // A factory that fails the SECOND transport only. It is built on the harness
  // that owns the account, so `transports` records both attempts.
  const h2 = makeHarness();
  const factory = async (opts) => {
    options.push(opts?.account?.accountId ?? null);
    const instance = h2.buildTransport(opts);
    if (options.length === 2) instance.start = async () => { throw new Error('transport start refused'); };
    return instance;
  };
  const applied2 = await boot(h2, qrConfig(h2, login, { modules: { transport: factory, bridge: h2.loaders.bridge, login: async () => login } }));
  const booted = h2.transports[0];
  assert.equal(booted.started, true);
  await call(h2.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  const r = await call(h2.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.rolledBack, true, 'the rollback completed: ' + JSON.stringify(r.json.notUndone));
  assert.deepEqual(options, ['abc@im.bot', 'wx_new'], 'a transport was built for the new account');
  assert.equal(h2.transports.length, 2, 'boot + the failed new one; the old object was restored, not rebuilt');

  // The old transport object was kept and restarted: rebuilding it would lose
  // the in-process long-poll state for no reason.
  const bootAgain = h2.transports[0];
  assert.equal(bootAgain.started, true, 'the OLD transport was started again');
  assert.equal(bootAgain.stopped, 0, 'and it was never stopped, because the new one never came up');
  assert.equal(h2.transports[1].stopped >= 1, true, 'the failed transport was shut down');
  // The state route names the account again and reports a live bridge.
  assert.equal(h2.transports[0].accountId, 'abc@im.bot', 'the restored transport still belongs to the old account');
  const state = await call(h2.routes.get(mod.STATE_PATH));
  assert.equal(state.json.account.botId, 'wx_exa…t_id');
  assert.equal(state.json.transportReady, true, 'the bridge is reported ready again');
  assert.equal(state.json.transportError ?? null, null, 'and no failure is left on the transport');
  assert.equal(state.json.login.activationError === null, false, 'the failed activation is on the record');
  assert.equal(
    h2.credentialRecords.has('dsh-wechat-box/wx-new'), false,
    'the new credential record was removed',
  );
  // The restored file is written from an account object that has no token on this
  // path (the legacy one), and it must stay that way.
  const restored = JSON.parse(await readFile(h2.accountFile, 'utf8'));
  assert.equal(Object.hasOwn(restored, 'token'), false, 'the rollback writes no token');
  assert.equal(restored.botId, BOT_ID, 'and restores the previous account');
  ok('a transport that fails to start is rolled back: old account file, old transport, old record');
}

// --- the rollback: a token-bearing account object must not leak back to disk --
// The dangerous shape: the account being rolled back to was read from the
// credential record at boot, so it carries a live token IN MEMORY. Rolling back
// writes the account file from that object -- and if that writer took its fields
// from the object instead of a whitelist, the token would land on disk by the
// back door, exactly where this change removed it.
{
  const h = makeHarness();
  const OLD_TOKEN = 'record-token-for-wx-old';
  const OLD_ACCOUNT = {
    version: 1, botId: 'wx_old', accountId: 'wx_old',
    ownerUserId: 'old@im.wechat', baseUrl: 'https://ilinkai.weixin.qq.com/',
  };
  h.credentialRecords.set('dsh-wechat-box/wx-old', {
    kind: 'grant',
    payload: { token: OLD_TOKEN, accountId: 'wx_old', ownerUserId: 'old@im.wechat' },
  });
  const login = makeLogin([{ status: 'confirmed', credentials: NEW_BOT }]);
  const options = [];
  const factory = async (opts) => {
    options.push(opts?.account?.accountId ?? null);
    const instance = h.buildTransport(opts);
    if (options.length === 2) instance.start = async () => { throw new Error('transport start refused'); };
    return instance;
  };
  await boot(h, qrConfig(h, login, { modules: { transport: factory, bridge: h.loaders.bridge, login: async () => login } }), {
    accountFile: OLD_ACCOUNT,
  });
  assert.equal(h.transportOptions[0].account.token, OLD_TOKEN, 'the old account runs on the record token');

  await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  const r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.rolledBack, true, 'the rollback completed: ' + JSON.stringify(r.json.notUndone));

  const after = JSON.parse(await readFile(h.accountFile, 'utf8'));
  assert.equal(after.botId, 'wx_old', 'the account file is back to the old account');
  assert.equal(Object.hasOwn(after, 'token'), false, 'and the in-memory token did not ride along');
  assert.ok(!JSON.stringify(after).includes(OLD_TOKEN), 'not even as a value');
  assert.equal(h.credentialRecords.get('dsh-wechat-box/wx-old').payload.token, OLD_TOKEN, 'the old record is untouched');
  ok('a rollback restores the account file without a token, even when the old account holds one');
}

// --- need_verifycode: the status goes to the UI, the code comes back once ----
{
  const h = makeHarness();
  const login = makeLogin([
    { status: 'need_verifycode' },
    { status: 'confirmed', credentials: NEW_BOT },
  ]);
  await boot(h, qrConfig(h, login));
  await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });

  let r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.status, 'need_verifycode', 'the UI is told to ask for the code');
  assert.equal(login.pollCalls.length, 1);
  assert.equal(login.pollCalls[0].verifyCode, undefined, 'nothing was invented');

  // The next poll carries the code the user typed -- and only that poll.
  r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: { verifyCode: '123456' } });
  assert.equal(login.pollCalls[1].verifyCode, '123456', 'the code is passed through to the platform');
  assert.equal(r.json.status, 'confirmed');

  // A poll WITHOUT a code must not silently reuse the last one: the retry is
  // per-request state, not a sticky default.
  assert.equal(login.pollCalls[0].verifyCode, undefined);
  ok('need_verifycode is surfaced, and only the poll that carries the code sends it');
}

// --- binded_redirect with local credentials: activate, do not ask again -----
{
  const h = makeHarness();
  const login = makeLogin([{ status: 'binded_redirect' }]);
  const applied = await boot(h, qrConfig(h, login, { weixinEnabled: false }));
  assert.equal(h.transports[0].started, false, 'the bridge starts down for this case');

  await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  const r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, true, 'an already-bound WeChat id with local credentials is usable: ' + JSON.stringify(r.json));
  assert.equal(r.json.status, 'binded_redirect');
  assert.equal(r.json.account.botId, 'wx_exa…t_id');
  assert.equal(h.transports.length, 2, 'the existing credential was activated (steps 2-4)');
  assert.equal(h.transport.started, true, 'and the transport is running');
  // Nothing was re-written: this path reuses the record it already has.
  assert.equal(h.credentialRecords.size, 0, 'binded_redirect must not invent a new credential record');
  const written = JSON.parse(await readFile(h.accountFile, 'utf8'));
  assert.equal(written.botId, BOT_ID);
  assert.equal(written.tokenRef, undefined, 'the account file stores values, never a reference name');
  assert.equal(Object.hasOwn(written, 'token'), false, 'and never a token either, on this path or any other');
  ok('binded_redirect with local credentials activates the existing account');
}

// --- binded_redirect without usable credentials: already-bound --------------
{
  const h = makeHarness();
  const login = makeLogin([{ status: 'binded_redirect' }]);
  // An account file that exists but carries no reachable credential: this is
  // "bound elsewhere, and this machine has nothing to log in with". With the
  // token no longer living in this file, "no reachable credential" is the normal
  // state of a file whose credential record is gone -- so the boot refuses the
  // transport outright, and `binded_redirect` has nothing to activate.
  await boot(h, qrConfig(h, login), {
    accountFile: { version: 1, botId: 'wx_ghost', accountId: 'wx_ghost', ownerUserId: 'ghost@im.wechat', baseUrl: 'https://ilinkai.weixin.qq.com/', token: null },
  });
  assert.equal(h.transports.length, 0, 'no credential record -> no transport at boot');
  await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  const r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'already-bound');
  assert.equal(r.json.status, 'binded_redirect');
  assert.ok(r.json.error, 'and the user is told what to do about it');
  assert.equal(h.transports.length, 0, 'nothing was activated');
  ok('binded_redirect without readable credentials reports already-bound (not a fake success)');
}

// --- readAccount(): the account file wins over the legacy config ------------
{
  const h = makeHarness();
  const login = makeLogin([{ status: 'confirmed', credentials: NEW_BOT }]);
  // Both files describe an account, with DIFFERENT ids. This is exactly the
  // state after a scan: the plugin's own file is authoritative, the dsh-im file
  // is history.
  //
  // The file also still carries a plaintext token (as every file written before
  // this change does) and the record holds a DIFFERENT one, so the assertions can
  // tell which of the two the transport was actually handed.
  h.credentialRecords.set('dsh-wechat-box/wx-from-file', {
    kind: 'grant',
    payload: { token: 'record-token-for-wx-from-file', accountId: 'wx_from_file', ownerUserId: 'file@im.wechat' },
  });
  const applied = await boot(h, qrConfig(h, login), {
    accountFile: { version: 1, botId: 'wx_from_file', accountId: 'wx_from_file', ownerUserId: 'file@im.wechat', baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token-from-file', updatedAt: 7 },
  });
  let state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.account.botId, 'wx_fro…file', 'the account file took priority (masked)');
  assert.equal(state.json.account.source, 'account-file');
  assert.equal(state.json.account.credentialKind, 'token');
  assert.equal(state.json.account.credentialSource, 'credential-record', 'the token came from the record');
  assert.equal(h.transports[0].accountId, 'wx_from_file', 'and the transport was built from it');
  assert.equal(
    h.transportOptions[0].account.token, 'record-token-for-wx-from-file',
    'the transport is handed the RECORD token, never the file one',
  );
  // The plaintext field is ignored AND erased on the way through.
  const cleaned = JSON.parse(await readFile(h.accountFile, 'utf8'));
  assert.equal(Object.hasOwn(cleaned, 'token'), false, 'the legacy token field was removed from the file');
  assert.equal(cleaned.botId, 'wx_from_file', 'the rest of the file survives the rewrite');

  // The record for the file's account is reused when the same scan redirects.
  await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(h.transports.length, 2);
  assert.equal(h.transports[1].accountId, 'wx_new', 'a scan still replaces it');
  assert.equal((await call(h.routes.get(mod.STATE_PATH))).json.account.botId, 'wx***');
  ok('readAccount() prefers the plugin account file and falls back to dsh-im config');
}

// ===========================================================================
// The token lives in the credential record, and ONLY there.
//
// The account file is guarded by ordinary ACLs on this platform (`mode: 0600` is
// a no-op on Windows), so it must not hold a secret: everything it says about
// credentials has to be re-derivable from `ctx.credentials` on the next boot.
// ===========================================================================

/** Read this case's boot trace (the channel that works even when routes do not). */
async function bootLog(h) {
  return readFile(join(h.home, 'wechat-box-boot.log'), 'utf8').catch(() => '');
}

// --- a restart: the token comes back out of the credential record -----------
{
  const h = makeHarness();
  const RECORD_TOKEN = 'record-token-for-wx-restart';
  // The state a crash-free install is in after a scan: identifiers in the file,
  // the secret in the record. `updatedAt: 4242` is deliberately not "now", so a
  // silent rewrite of the file would show up below.
  h.credentialRecords.set('dsh-wechat-box/wx-restart', {
    kind: 'grant',
    payload: { token: RECORD_TOKEN, accountId: 'wx_restart', ownerUserId: 'restart@im.wechat', baseUrl: 'https://ilinkai.weixin.qq.com/' },
  });
  const applied = await boot(h, { modules: h.loaders, weixinEnabled: true }, {
    accountFile: { version: 1, botId: 'wx_restart', accountId: 'wx_restart', ownerUserId: 'restart@im.wechat', baseUrl: 'https://ilinkai.weixin.qq.com/', updatedAt: 4242 },
  });

  assert.equal(h.transports.length, 1, 'the boot transport was built from the account file');
  const booted = h.transportOptions[0].account;
  assert.equal(booted.botId, 'wx_restart');
  assert.equal(booted.token, RECORD_TOKEN, 'the token handed to the transport comes from the credential record');
  assert.equal(booted.tokenRef, null, 'and no reference stands in for it');
  assert.equal(booted.credentialSource, 'credential-record');
  assert.equal(h.transports[0].started, true, 'and the transport actually started');
  assert.equal(applied.transport, h.transports[0]);

  // The file was read, not rewritten: nothing in it changed, and it still has no
  // token to hand out.
  const onDisk = JSON.parse(await readFile(h.accountFile, 'utf8'));
  assert.equal(onDisk.updatedAt, 4242, 'an account file without a legacy token is left exactly as it was');
  assert.equal(Object.hasOwn(onDisk, 'token'), false);

  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.json.transportReady, true);
  assert.equal(state.json.account.credentialKind, 'token');
  assert.equal(state.json.account.credentialSource, 'credential-record', 'the panel can say where the credential came from');
  assert.equal(state.json.login.accountError ?? null, null, 'nothing to report');
  assert.ok(!JSON.stringify(state.json).includes(RECORD_TOKEN), 'and the value is still not on the diagnostic route');
  assert.ok(!(await bootLog(h)).includes(RECORD_TOKEN), 'nor in the boot trace');
  ok('a restart reads the token out of the credential record and hands it to the transport');
}

// --- a legacy account file: the plaintext token is stripped, and ignored -----
{
  const h = makeHarness();
  const LEGACY_TOKEN = 'plaintext-token-left-by-an-older-version';
  const RECORD_TOKEN = 'authoritative-record-token';
  h.credentialRecords.set('dsh-wechat-box/wx-legacy', {
    kind: 'grant',
    payload: { token: RECORD_TOKEN, accountId: 'wx_legacy', ownerUserId: 'legacy@im.wechat' },
  });
  await boot(h, { modules: h.loaders, weixinEnabled: true }, {
    accountFile: {
      version: 1,
      botId: 'wx_legacy',
      accountId: 'wx_legacy',
      ownerUserId: 'legacy@im.wechat',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      token: LEGACY_TOKEN,
    },
  });

  // Ignored as a credential...
  assert.equal(h.transportOptions[0].account.token, RECORD_TOKEN, 'the file token is not the one that is used');
  // ...and erased from the file, which is the part that outlives this process.
  const cleaned = JSON.parse(await readFile(h.accountFile, 'utf8'));
  assert.equal(Object.hasOwn(cleaned, 'token'), false, 'the plaintext token field is gone (checked by key)');
  assert.ok(!JSON.stringify(cleaned).includes(LEGACY_TOKEN), 'and so is the value it held');
  assert.equal(cleaned.botId, 'wx_legacy', 'the identifiers are untouched');
  assert.equal(cleaned.accountId, 'wx_legacy');
  assert.equal(cleaned.ownerUserId, 'legacy@im.wechat');
  assert.equal(typeof cleaned.updatedAt, 'number', 'the file was rewritten in the current shape');

  const log = await bootLog(h);
  assert.match(log, /legacy-token-stripped/, 'the strip is on the record in the boot trace');
  assert.ok(!log.includes(LEGACY_TOKEN), 'which must not carry the token itself');
  assert.ok(!log.includes(RECORD_TOKEN), 'nor the one from the record');
  ok('a legacy account file with a plaintext token is stripped, and the record wins');
}

// --- no record at all: refuse the transport, loudly -------------------------
{
  const h = makeHarness();
  const applied = await boot(h, { modules: h.loaders, weixinEnabled: true }, {
    accountFile: { version: 1, botId: 'wx_norecord', accountId: 'wx_norecord', ownerUserId: 'n@im.wechat', baseUrl: 'https://ilinkai.weixin.qq.com/' },
  });

  // No transport object at all: building one with an empty token would start,
  // answer every call with `token-missing`, and read like a network fault.
  assert.equal(h.transports.length, 0, 'no transport was built');
  assert.equal(h.started, false, 'and nothing was started');
  assert.equal(applied.transport, null);

  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.equal(state.status, 200, 'the routes still answer');
  assert.equal(state.json.transportReady, false);
  assert.ok(state.json.login.accountError, 'the reason is reported, not swallowed');
  assert.match(String(state.json.login.accountError), /凭据记录/, 'and it names the missing record');
  assert.match(String(state.json.transportError), /凭据记录/, 'the settings page note carries it too');
  assert.equal(state.json.account.botId, 'wx_nor…cord', 'the account itself is still displayed (masked)');
  assert.match(await bootLog(h), /credential-missing/, 'and the boot trace says so');

  // The account file was NOT written a token to compensate.
  const onDisk = JSON.parse(await readFile(h.accountFile, 'utf8'));
  assert.equal(Object.hasOwn(onDisk, 'token'), false);
  ok('a missing credential record refuses the transport and reports why (never a silent empty token)');
}

// --- the record cannot be written: the activation is refused, not faked ------
// The counterpart of the case above at the other end of the lifecycle. Now that
// the account file no longer carries the token, an activation whose grant never
// reached the record would report success and lose the binding on the next
// restart -- so it fails here, and the previous account stays up.
{
  const h = makeHarness();
  h.flags.credentials = false;                     // no credentials service in reach
  const login = makeLogin([{ status: 'confirmed', credentials: NEW_BOT }]);
  const applied = await boot(h, qrConfig(h, login));
  assert.equal(h.transports.length, 1, 'the legacy account still boots');
  const booted = h.transports[0];

  await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'POST' });
  const r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.json.ok, false, 'the bind reports failure instead of a binding it cannot persist');
  assert.equal(r.json.code, 'activation-failed');
  assert.equal(r.json.rolledBack, true, 'and the rollback completed: ' + JSON.stringify(r.json.notUndone));
  assert.match(String(r.json.error), /凭据记录/, 'the reason names the record');
  assert.equal(h.transports.length, 1, 'no second transport was left behind');
  assert.equal(booted.stopped, 0, 'the old transport was never taken down');
  assert.equal(booted.started, true, 'the old bridge is still up');
  assert.equal(applied.transport, booted);

  const state = await call(h.routes.get(mod.STATE_PATH));
  assert.match(String(state.json.login.activationError), /activation failed/, 'and the failure is visible on the state route');
  const log = await bootLog(h);
  assert.match(log, /credentials-write-failed/, 'the write failure is traced');
  assert.ok(!log.includes(NEW_BOT.token), 'with no token in the trace');
  ok('an activation whose grant cannot be stored is rolled back instead of claimed as success');
}

// --- the login routes exist, and say so when they cannot work ---------------
{
  const h = makeHarness();
  await boot(h);
  assert.ok(h.routes.has(mod.LOGIN_BEGIN_PATH), 'begin route registered');
  assert.ok(h.routes.has(mod.LOGIN_POLL_PATH), 'poll route registered');

  // No login loader and no real module load in this harness: the route must
  // answer with a reason, not hang and not 500.
  const r = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.code === 'no-pending-qr' || r.json.code === 'login-unavailable', `got ${r.json.code}`);

  const begin = await call(h.routes.get(mod.LOGIN_BEGIN_PATH), { method: 'GET' });
  assert.equal(begin.status, 405, 'GET is refused');
  const poll = await call(h.routes.get(mod.LOGIN_POLL_PATH), { method: 'GET' });
  assert.equal(poll.status, 405, 'GET is refused');
  ok('login routes are registered and degrade with a readable reason');
}

// ===========================================================================
// The settings page drives those routes: button -> <img> -> 1s poll -> the
// right words for every status. The bundle is loaded the way the DSH web client
// loads it (window.__ModuleLoader__ + react through `require`), so what is under
// test is the shipped file, not a copy of its logic.
// ===========================================================================
{
  const clientSource = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  assert.ok(
    !clientSource.includes('dangerouslySetInnerHTML'),
    'the QR is an <img src>, never markup injected into the page',
  );

  const fetches = [];
  const okJson = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  let statePayload = {
    ok: true, weixinEnabled: true,
    account: { botId: 'wx_exa…t_id', ownerUserId: 'owner@…chat', baseUrlHost: 'ilinkai.weixin.qq.com' },
    transport: { connected: true },
    login: { available: true, pending: false, error: null },
  };
  let pollCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    fetches.push({ url: target, method: init.method ?? 'GET', body });
    if (target === '/api/dsh-wechat-box/state') return okJson(statePayload);
    if (target === '/api/dsh-wechat-box/login/begin') {
      return okJson({ ok: true, qrcodeUrl: 'https://liteapp.weixin.qq.com/q/AbCd?qrcode=tok', qrImage: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', expiresAtMs: Date.now() + 300_000 });
    }
    if (target === '/api/dsh-wechat-box/login/poll') {
      pollCount += 1;
      if (pollCount === 1) return okJson({ ok: true, status: 'scaned' });
      if (pollCount === 2) return okJson({ ok: true, status: 'need_verifycode' });
      return okJson({ ok: true, status: 'confirmed', account: { botId: 'wx***', baseUrlHost: 'ilinkai.weixin.qq.com' } });
    }
    return okJson({ ok: true });                       // beacons and anything else
  };

  // A faithful-enough React store: every hook call site gets its OWN slot, in
  // call order, and keeps it across renders. That matters here because the panel
  // has two `useState` hooks and a handful of `useRef` boxes, and a single shared
  // slot made one hook's update overwrite the other's -- a stub artefact that
  // looked exactly like a bug in the panel.
  const hooks = { effects: [] };
  const slots = [];        // useState slots by hook index
  const refs = [];         // useRef boxes by hook index
  let hookIndex = 0;
  let lastSlot = null;     // the state the panel rendered with, for assertions
  const ReactStub = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useRef(initial) {
      const box = refs[hookIndex] ?? (refs[hookIndex] = { current: initial });
      hookIndex += 1;
      return box;
    },
    useState(initial) {
      const index = hookIndex;
      hookIndex += 1;
      if (slots[index] === undefined) {
        slots[index] = typeof initial === 'function' ? initial() : initial;
      }
      lastSlot = slots[index];
      const setter = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      };
      return [slots[index], setter];
    },
    useEffect(fn) { hooks.effects.push(fn); return undefined; },
  };
  let registration = null;
  globalThis.window = { __ModuleLoader__: { load(reg) { registration = reg; } } };
  await import('./client.js');
  const client = registration.factory((specifier) => {
    if (specifier === 'react') return ReactStub;
    throw new Error(`unexpected require: ${specifier}`);
  });

  const registered = [];
  const ctx = {
    slots: {
      inject(name, cb) { return cb(); },
      register(options, Component) { registered.push(Component); return () => {}; },
    },
    effect(fn) { fn(); return () => {}; },
  };
  client.apply(ctx);
  const Settings = registered[1];
  assert.equal(typeof Settings, 'function', 'the settings section is registered');

  const flatten = (node) => {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flatten).join(' ');
    return [flatten(node.children)].flat().filter(Boolean).join(' ');
  };
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) { const hit = find(child, predicate); if (hit) return hit; }
      return null;
    }
    if (predicate(node)) return node;
    return find(node.children, predicate);
  };

  // `render()` just renders the panel again; the stub keeps each hook's slot, so
  // this is the same call the renderer would make after a state update.
  const render = () => {
    hookIndex = 0;                // hooks are called in the same order every render
    return Settings({});
  };
  /** The QR flow's phase, as the panel last rendered with it. */
  const panel = () => lastSlot.login.phase;

  // First paint: the panel is idle and has asked for nothing yet.
  hooks.effects.length = 0;
  hookIndex = 0;
  Settings({});
  assert.equal(panel(), 'idle');
  // Effects are registered in source order on the first render -- [0] loads the
  // state, [1] is the (idle) poll loop, [2] maintains the alive flag.
  const mountEffect = hooks.effects[0];
  mountEffect();                                        // mount: GET the state route
  // Wait for that GET to settle BEFORE clicking. In the real page the button is
  // disabled until it does (`disabled: !ready`), so a click cannot land first --
  // and letting it land first would test a state the user can never produce.
  await new Promise((r) => setTimeout(r, 5));
  let tree = render();
  let text = flatten(tree);
  assert.match(text, /绑定新账号/, 'the section offers to bind a new account');
  const bindButton = find(tree, (n) => n.props?.['data-wechat-box-bind']);
  assert.equal(bindButton.props.disabled, false, 'the button is live when the host answers');
  assert.equal(find(tree, (n) => n.props?.['data-wechat-box-qr']), null, 'and no QR is shown before it is asked for');

  // Click: one POST to begin, then the image and the first status.
  bindButton.props.onClick();
  await new Promise((r) => setTimeout(r, 5));
  tree = render();
  const beginCall = fetches.find((f) => f.url === '/api/dsh-wechat-box/login/begin');
  assert.equal(beginCall.method, 'POST');
  const img = find(tree, (n) => n.props?.['data-wechat-box-qr']);
  assert.ok(img, 'the QR is rendered');
  assert.equal(img.type, 'img', 'as an image element');
    // NOT the platform URL: `qrcode_img_content` is the content the QR encodes
    // (an https landing page), so an <img> pointed at it returns text/html.
    assert.match(img.props.src, /^data:image\/svg\+xml;base64,/, 'showing the host-rendered QR');
  assert.match(flatten(tree), /等待扫码/, 'and the user is told to scan');

  // The render above registered this render's effects; the poll loop is the
  // second of the three, in source order (load, poll, alive).
  const effectsBeforePoll = hooks.effects.length;
  assert.equal(panel(), 'qr', 'the panel is in the scanning phase');
  assert.equal(effectsBeforePoll, 9, 'three effects per render');
  const pollEffect = hooks.effects[effectsBeforePoll - 2];
  assert.equal(
    String(pollEffect).includes("login.phase !== 'qr'"), true,
    'the effect picked is the poll loop, not the loader',
  );
  const cleanup = pollEffect();
  assert.equal(typeof cleanup, 'function', 'the poll loop can be stopped');
  // 1s between polls, and the loop checks its wake-up flag every 200ms.
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(pollCount, 1, 'the first tick polled');
  tree = render();
  assert.match(flatten(tree), /已扫码/, 'scaned is reported');
  assert.deepEqual(fetches.find((f) => f.url === '/api/dsh-wechat-box/login/poll').body, {}, 'no code was sent unprompted');

  // need_verifycode: an input appears, and the loop holds until it is filled in.
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(pollCount, 2, 'the second tick polled');
  tree = render();
  assert.match(flatten(tree), /配对码/, 'the user is asked for the pairing code');
  const codeInput = find(tree, (n) => n.props?.['data-wechat-box-verify']);
  assert.ok(codeInput, 'the code box is rendered');
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(pollCount, 2, 'polling pauses until a code is typed (no automatic retry)');

  // Typing the code resumes the loop and that poll carries it.
  codeInput.props.onChange({ target: { value: '123456' } });
  tree = render();
  const submit = find(tree, (n) => n.props?.['data-wechat-box-verify-submit']);
  assert.ok(submit, 'the code can be submitted');
  submit.props.onClick();
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(pollCount, 3, 'the code poll went out');
  const coded = fetches.filter((f) => f.url === '/api/dsh-wechat-box/login/poll').at(-1);
  assert.deepEqual(coded.body, { verifyCode: '123456' }, 'carrying exactly the typed code');

  // confirmed: the panel says so, drops the QR, and offers a fresh start.
  tree = render();
  assert.match(flatten(tree), /绑定成功/, 'success is reported');
  assert.equal(find(tree, (n) => n.props?.['data-wechat-box-qr']), null, 'the QR is gone once it is used');
  assert.ok(find(tree, (n) => n.props?.['data-wechat-box-relogin']), 'and a new scan can be started');
  assert.equal(
    fetches.filter((f) => f.url === '/api/dsh-wechat-box/state').length >= 2, true,
    'the account panel was reloaded after the bind',
  );

  // A dead host must be visible, not a panel that silently does nothing. This is
  // a fresh mount, so every hook slot starts over.
  statePayload = null;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  slots.length = 0;
  refs.length = 0;
  hooks.effects.length = 0;
  hookIndex = 0;
  Settings({});
  hooks.effects[0]();                                   // mount: the state GET 401s
  await new Promise((r) => setTimeout(r, 5));
  tree = render();
  text = flatten(tree);
  assert.match(text, /宿主半边未就绪/, 'a dead host is stated in words');
  const deadButton = find(tree, (n) => n.props?.['data-wechat-box-bind']);
  assert.equal(deadButton.props.disabled, true, 'and the bind button is disabled rather than lying');
  deadButton.props.onClick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(deadButton.props['data-wechat-box-bind'], 'not-ready');
  ok('settings page: button -> QR image -> 1s poll -> verify code -> confirmed, and 未就绪 when the host is down');
}

for (const dir of homes) await rm(dir, { recursive: true, force: true });
console.log(`\nhost shell: ${passed} checks passed`);
