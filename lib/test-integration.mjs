/**
 * Integration test: the REAL harness bridge + the REAL host shell + the REAL
 * router, with only two boundaries stubbed -- the WeChat HTTP transport and the
 * DSH session API.
 *
 * Why this exists: lib/test.mjs used a FAKE bridge and harness/test.mjs tested
 * the bridge in isolation, so the real bridge had never actually been driven
 * through the host shell. This closes that gap.
 *
 *   node test-integration.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const home = await mkdtemp(join(tmpdir(), 'wechat-box-integration-'));
process.env.DSH_HOME = home;
await mkdir(join(home, 'integrations', 'dsh-weixin'), { recursive: true });
await writeFile(join(home, 'integrations', 'dsh-weixin', 'config.json'), JSON.stringify({
  version: 1,
  accounts: [{
    botId: 'wx_int', accountId: 'int@im.bot',
    tokenRef: 'DSH_WEIXIN_BOT_TOKEN_INT',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    ownerUserId: 'owner@im.wechat',
  }],
}), 'utf8');

const mod = await import('./index.js');

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };
const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const OWNER = 'owner@im.wechat';
const SESSIONS = [
  { sessionId: 'session-1', running: false, cwd: 'D:\\workspace', projections: { values: { title: '文档整理' } } },
  { sessionId: 'session-2', running: true, cwd: 'D:\\workspace', projections: { values: { title: '桥接联调' } } },
];

// --- stub the two boundaries ------------------------------------------------
const prompts = [];
const sessionController = {
  async list() { return { items: SESSIONS.map((s) => ({ ...s })) }; },
  async prompt(request) {
    prompts.push(request);
    return { accepted: true };
  },
};

const sent = [];
let onInbound = null;
const transport = {
  async start(handler) { onInbound = handler; },
  async stop() {},
  async sendText(userId, text) { sent.push({ userId, text }); return { ok: true }; },
  status() { return { connected: true }; },
};

// --- a Cordis-ish context ---------------------------------------------------
const listeners = [];
let turnIndex = 0;
const services = {};
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(type, handler, options) {
    listeners.push({ type, handler, options });
    return () => {
      const i = listeners.findIndex((l) => l.handler === handler);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  provide(name, value) { services[name] = value; },
  inject(deps, cb) {
    const ready = {
      sessionController, sessions: { list: () => [] }, agents: { get: () => undefined },
      on: ctx.on, effect: ctx.effect, logger: ctx.logger,
    };
    if (deps.includes('webServer')) {
      ready.webServer = { register: () => () => {} };
    }
    cb(ready);
    return () => {};
  },
  // serviceFrom(ctx, name) reads the context directly too
  sessionController,
};

// Cordis feeds a plugin's return value through its effect machinery, which
// accepts only a function / null / thenable / iterable of disposers; anything
// else is `TypeError: Invalid effect`, and that throw disposes the entire fiber
// (routes included) ~1ms after apply resolves. So apply() returns nothing and the
// inspection surface is the wechatBox service instead.
const returned = await mod.apply(ctx, {
  weixinEnabled: true,
  modules: { transport: async () => transport },   // real bridge is imported
});
assert.equal(returned, undefined, 'apply() must return undefined or Cordis throws "Invalid effect"');
const applied = services.wechatBox.internals();

const emit = async (sessionId, event) => {
  turnIndex += 1;
  const withSeq = { seq: turnIndex, ...event };
  for (const l of [...listeners]) {
    if (l.type === 'session/event') l.handler({ id: sessionId }, withSeq);
  }
  await flush();
};

assert.ok(applied.bridge, 'the real harness bridge was installed');
const eventListeners = listeners.filter((l) => l.type === 'session/event');
assert.equal(eventListeners.length, 1, 'exactly one session/event listener');
assert.deepEqual(eventListeners[0].options, { global: true });
ok('real bridge installs one global session/event listener through the host shell');

const questionHandlers = listeners.filter((l) => l.type === 'user-questions/request');
assert.equal(questionHandlers.length, 1, 'R7 registers one question waterfall handler');
assert.deepEqual(questionHandlers[0].options, { global: true, prepend: true });
ok('R7 question waterfall is registered when the valve is open');

const approvalHandlers = listeners.filter((l) => l.type === 'approval/request');
assert.equal(approvalHandlers.length, 1, 'A11 registers one approval waterfall handler');
assert.deepEqual(approvalHandlers[0].options, { global: true, prepend: true });
ok('A11 approval waterfall is registered when the valve is open');

// --- the picker runs against the real bridge's listSessions() ---------------
await onInbound({ userId: OWNER, text: '你好', messageId: 'm1' });
await flush();
assert.equal(sent.length, 1, 'one reply to a free-text message');
assert.match(sent[0].text, /选择一个对话/);
assert.match(sent[0].text, /1\. ○ 文档整理（D:\\workspace）/);
assert.match(sent[0].text, /2\. ○ .*运行中/, 'running comes from the real summary field');
ok('picker lists real sessions from sessionController.list (mapped id/title/cwd/running)');

// --- selecting turns the switch on ------------------------------------------
sent.length = 0;
await onInbound({ userId: OWNER, text: '2', messageId: 'm2' });
await flush();
assert.match(sent[0].text, /已切到 2\. 桥接联调/);
const state = await applied.router.snapshot();
assert.equal(state.selectedId, 'session-2');
ok('replying 2 selects session-2 and opens its switch');

// --- free text is fed through the REAL bridge to sessionController.prompt ---
await onInbound({ userId: OWNER, text: '帮我看看这段代码', messageId: 'm3' });
await flush();
assert.equal(prompts.length, 1, 'the real bridge called sessionController.prompt');
const request = prompts[0];
assert.equal(request.sessionId, 'session-2');
assert.equal(request.mode, 'queue');
assert.deepEqual(request.content, [{ type: 'text', text: '帮我看看这段代码' }]);
assert.equal(typeof request.requestId, 'string');
assert.ok(request.requestId.length > 0, 'requestId gives the host its idempotency key');
ok('free text reaches the host through the real bridge (prompt/queue/requestId)');

// --- a completed turn mirrors back; an unfinished one does not --------------
sent.length = 0;
await emit('session-1', { type: 'turn/start', data: { turn: 1 } });
await emit('session-1', { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '没开的对话' }] } } });
await emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
assert.equal(sent.length, 0, 'an OFF conversation never mirrors');

sent.length = 0;
await emit('session-2', { type: 'turn/start', data: { turn: 5 } });
await emit('session-2', { type: 'assistant/message', surfaceOp: 'append', data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: '改完了，一共三处。' }] } } });
await emit('session-2', { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } });
await flush();
assert.equal(sent.length, 1, 'the ON conversation mirrors its completed turn');
assert.match(sent[0].text, /改完了，一共三处。$/, 'the mirrored answer ends with the turn text (a /session fence is prefixed)');
assert.equal(sent[0].userId, OWNER);
ok('real bridge + real host mirror a completed turn only for the ON conversation');

// --- a cancelled turn stays silent even when ON -----------------------------
sent.length = 0;
await emit('session-2', { type: 'turn/start', data: { turn: 6 } });
await emit('session-2', { type: 'assistant/message', surfaceOp: 'append', data: { turn: 6, step: 1, message: { content: [{ type: 'text', text: '半截' }] } } });
await emit('session-2', { type: 'turn/end', data: { turn: 6, reason: { kind: 'aborted', reason: 'user' } } });
assert.equal(sent.length, 0, 'a cancelled turn must not mirror');
ok('cancelled turn stays silent through the real bridge');

// --- a long answer is chunked on the way out --------------------------------
sent.length = 0;
const long = Array.from({ length: 400 }, (_v, i) => `第 ${i} 行：这是一段足够长的回答内容。`).join('\n');
await emit('session-2', { type: 'turn/start', data: { turn: 7 } });
await emit('session-2', { type: 'assistant/message', surfaceOp: 'append', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: long }] } } });
await emit('session-2', { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } });
await flush(40);
assert.ok(sent.length > 1, `long answer chunked, got ${sent.length} messages`);
assert.ok(sent.every((s) => s.text.length <= 1800), 'no chunk exceeds the platform ceiling');
ok(`long answer split into ${sent.length} messages through the real bridge`);

// --- /off then free text re-lists -------------------------------------------
sent.length = 0;
await onInbound({ userId: OWNER, text: '/off', messageId: 'm4' });
assert.match(sent[0].text, /已断开/);
sent.length = 0;
await onInbound({ userId: OWNER, text: '在吗', messageId: 'm5' });
assert.match(sent[0].text, /选择一个对话/);
assert.equal(prompts.length, 1, 'nothing is fed to a session while nothing is selected');
ok('/off disconnects; the next free text re-lists instead of guessing');

// --- R7 end to end: a host question answered from WeChat --------------------
{
  // A5: the question only reaches WeChat for a conversation whose switch is ON,
  // so open one first -- through the real inbound protocol, as a user would.
  sent.length = 0;
  await onInbound({ userId: OWNER, text: '2', messageId: 'm6' });
  assert.equal(await applied.router.isEnabled('session-2'), true, 'session-2 is now switched on');
  sent.length = 0;

  const request = {
    questions: [{
      id: 'q9', header: '部署方式', question: '要怎么发布？',
      options: [{ label: '直接上' }, { label: '先灰度' }],
    }],
    agent: { sessionId: 'session-2' },
    signal: new AbortController().signal,
  };
  let hostReached = false;
  const answering = questionHandlers[0].handler(request, () => { hostReached = true; return new Promise(() => {}); });
  await flush();

  assert.equal(hostReached, true, 'the host answerer is still offered the question');
  assert.equal(sent.length, 1, 'the question was pushed over the real outbound path');
  assert.match(sent[0].text, /要怎么发布/);
  assert.match(sent[0].text, /^2\. 先灰度$/m);

  // The reply is the answer, not a chat message: nothing may reach the session.
  await onInbound({ userId: OWNER, text: '2', messageId: 'q-answer' });
  assert.deepEqual(await answering, { answers: [{ id: 'q9', selected: ['先灰度'] }] });
  assert.equal(prompts.length, 1, 'the answer was not fed to a session as chat');
  ok('R7 a host question round-trips through the real host shell');
}

// --- R7/A5 end to end: an OFF conversation's question stays out of WeChat ----
{
  const h = applied.router;
  await h.setEnabled('session-2', false);        // close the switch again
  sent.length = 0;
  let hostReached = false;
  const answering = questionHandlers[0].handler({
    questions: [{ id: 'q10', question: '这个不该发出去', options: [{ label: 'A' }] }],
    agent: { sessionId: 'session-2' },
  }, async () => { hostReached = true; return { answers: [] }; });
  await flush();
  assert.equal(hostReached, true, 'the ask went to the host instead');
  assert.equal(sent.length, 0, 'nothing was pushed for the OFF conversation');
  await answering;
  ok('R7/A5 a question for an OFF conversation never reaches WeChat');
}

// --- A11 end to end: an approval answered from WeChat -----------------------
{
  // A5 again: the switch has to be ON for the approval to be pushed.
  await applied.router.setEnabled('session-2', true, '桥接联调');
  sent.length = 0;
  const request = {
    toolName: 'pwsh', callId: 'c9', reason: '要写沙箱外的文件',
    agent: { sessionId: 'session-2' },
    signal: new AbortController().signal,
  };
  const answering = approvalHandlers[0].handler(request, () => new Promise(() => {}));
  await flush();
  assert.equal(sent.length, 1, 'the approval was pushed over the real outbound path');
  assert.match(sent[0].text, /要执行：pwsh/);

  await onInbound({ userId: OWNER, text: '拒绝', messageId: 'a-answer' });
  assert.equal(await answering, 'rejected');
  assert.equal(prompts.length, 1, 'the approval reply was not fed to a session as chat');
  ok('A11 an approval round-trips through the real host shell');
}

// --- non-text inbound carries no routing ------------------------------------
sent.length = 0;
await onInbound({ userId: OWNER, kind: 'unsupported', text: '', itemTypes: [2], messageId: 'm6' });
assert.equal(sent.length, 0, 'an image message is not routed and not answered');
ok('non-text inbound is ignored, not misrouted');

await rm(home, { recursive: true, force: true });
console.log(`\nintegration (real bridge + real host): ${passed} checks passed`);
