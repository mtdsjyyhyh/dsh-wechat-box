/**
 * dsh-wechat-box / harness bridge —— 离线单元测试
 * =================================================
 * 全程用桩 ctx，绝不连真宿主、不发网络请求、不读磁盘。
 *
 * 跑法：
 *   <node 绝对路径> <repo>\harness\test.mjs
 *
 * 覆盖：
 *   1. 桩 ctx 能装上不抛错（并检查 on / inject / effect 的注册形状）
 *   2. turn/start → assistant/message（两个 step，含一段 interrupted）→ turn/end(completed)
 *      恰好回调一次，文本是合并后的最终文本
 *   3. turn/end 的 reason 是 cancelled / aborted / interrupted / error / 缺失 时不回调
 *   4. 同一会话连续两个回合，文本不串味
 *   5. 两个不同会话交错的事件，不互相污染
 *   6. dispose() 后事件不再触发回调
 *   7. （附加）服务就绪 / 选路 / 优雅降级 / ctx.effect 清理
 */

import assert from 'node:assert/strict';
import {
  installHarnessBridge,
  TurnTextAccumulator,
  textFromContent,
  turnReasonKind,
} from './bridge.mjs';

/* ------------------------------------------------------------------ *
 * 迷你测试跑手
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${title}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✘ ${title}`);
    console.error(error);
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

/* ------------------------------------------------------------------ *
 * 桩：一个记录注册情况的假 Cordis ctx
 * ------------------------------------------------------------------ */

function createStubCtx() {
  const handlers = [];   // ctx.on 注册
  const injections = []; // ctx.inject 注册
  const effects = [];    // ctx.effect 注册

  const ctx = {
    logger: silentLogger,
    on(event, handler, options) {
      const entry = { event, handler, options, disposed: false };
      handlers.push(entry);
      return () => { entry.disposed = true; };
    },
    inject(deps, callback) {
      const entry = { deps, callback, called: false, disposed: false };
      injections.push(entry);
      return () => { entry.disposed = true; };
    },
    effect(fn, label) {
      const entry = { fn, label, disposed: false };
      effects.push(entry);
      return () => { entry.disposed = true; };
    },
  };

  return {
    ctx,
    handlers,
    injections,
    effects,

    /** 模拟宿主广播 session/event。 */
    emitSessionEvent(sessionId, event) {
      for (const entry of [...handlers]) {
        if (entry.event !== 'session/event' || entry.disposed) continue;
        entry.handler({ id: sessionId }, event);
      }
    },

    /**
     * 模拟 Cordis 服务就绪：把每个依赖都能满足的 inject 回调调起来，
     * 回调上下文里服务就是属性（真 Cordis 的语义）。
     */
    becomeReady(services) {
      for (const entry of injections) {
        if (entry.called) continue;
        if (!entry.deps.every((name) => name in services)) continue;
        entry.called = true;
        entry.callback({ ...services, get: (name) => services[name] });
      }
    },
  };
}

function mount(onTurnComplete = () => {}) {
  const stub = createStubCtx();
  const calls = [];
  const bridge = installHarnessBridge(stub.ctx, {
    onTurnComplete: (payload) => { calls.push(payload); onTurnComplete(payload); },
    logger: silentLogger,
  });
  return { stub, bridge, calls };
}

/* 造事件的几个小工厂（字段形状照抄宿主真实事件） */

const turnStart = (turn, seq) => ({ type: 'turn/start', seq, data: { turn } });

const stepStart = (turn, step, seq) => ({ type: 'step/start', seq, data: { turn, step } });

const stepEnd = (turn, step, seq) => ({ type: 'step/end', seq, data: { turn, step } });

const userMessage = (turn, seq, rpcId = 'rpc-1') => ({
  type: 'user/message',
  seq,
  surfaceOp: 'append',
  data: { turn, message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '用户说的话' }] }, source: { kind: 'user', rpcId } },
});

const assistantChunk = (turn, step, index, text, seq) => ({
  type: 'assistant/chunk',
  seq,
  data: { turn, step, chunk: { type: 'text-delta', index, text } },
});

const assistantMessage = (turn, step, text, seq, extra = {}) => ({
  type: 'assistant/message',
  seq,
  surfaceOp: 'append', // 宿主 dsh-agent-loop 追加 assistant/message 时就是这么传的
  data: {
    turn,
    step,
    message: { id: `a${step}`, role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  },
});

const turnEnd = (turn, reason, seq) => ({ type: 'turn/end', seq, data: { turn, reason } });

/* ------------------------------------------------------------------ *
 * 1. 装得上
 * ------------------------------------------------------------------ */

await test('1) 桩 ctx 上能装上、不抛错，并正确注册 on / inject / effect', () => {
  const { stub, bridge, calls } = mount();

  assert.equal(typeof bridge.listSessions, 'function');
  assert.equal(typeof bridge.submitUserText, 'function');
  assert.equal(typeof bridge.isSessionRunning, 'function');
  assert.equal(typeof bridge.dispose, 'function');
  assert.ok(Object.isFrozen(bridge), 'bridge 应该是冻结对象');
  assert.deepEqual(calls, []);

  // ctx.on 的形状
  assert.equal(stub.handlers.length, 1);
  assert.equal(stub.handlers[0].event, 'session/event');
  assert.deepEqual(stub.handlers[0].options, { global: true });

  // ctx.inject 至少要了 sessionController 和 typertGateway
  const asked = stub.injections.flatMap((entry) => entry.deps);
  assert.ok(asked.includes('sessionController'), '应注入 sessionController');
  assert.ok(asked.includes('typertGateway'), '应注入 typertGateway');
  assert.ok(asked.includes('sessions'), '应注入 sessions');
  assert.ok(asked.includes('agents'), '应注入 agents');

  // ctx.effect 带了标签
  assert.equal(stub.effects.length, 1);
  assert.equal(stub.effects[0].label, 'dsh-wechat-box: Harness session bridge');

  // 服务一个都没就绪时也要能优雅降级，而不是崩
  assert.equal(bridge.isSessionRunning('whatever'), false);

  // 契约校验
  assert.throws(() => installHarnessBridge({}, { onTurnComplete() {} }), TypeError);
  assert.throws(() => installHarnessBridge(stub.ctx, {}), TypeError);

  bridge.dispose();
});

/* ------------------------------------------------------------------ *
 * 2. 一个成功回合：按 step 合并、丢掉 interrupted、只回调一次
 * ------------------------------------------------------------------ */

await test('2) turn/start → assistant/message（两个 step + 一段 interrupted）→ turn/end(completed)：恰好一次、文本合并正确', async () => {
  const { stub, bridge, calls } = mount();

  stub.emitSessionEvent('s1', turnStart(1, 1));
  stub.emitSessionEvent('s1', userMessage(1, 2));
  assert.equal(bridge.isSessionRunning('s1'), true, '回合进行中应为 running');

  stub.emitSessionEvent('s1', stepStart(1, 0, 3));
  // 流式增量：同一 (step, index) 的两段要拼起来
  stub.emitSessionEvent('s1', assistantChunk(1, 0, 0, '第一', 4));
  stub.emitSessionEvent('s1', assistantChunk(1, 0, 0, '段', 5));
  // canonical 定稿替换该 step（内容与增量一致）
  stub.emitSessionEvent('s1', assistantMessage(1, 0, '第一段', 6));
  stub.emitSessionEvent('s1', stepEnd(1, 0, 7));

  stub.emitSessionEvent('s1', stepStart(1, 1, 8));
  stub.emitSessionEvent('s1', assistantMessage(1, 1, '第二段', 9));
  stub.emitSessionEvent('s1', stepEnd(1, 1, 10));

  // 一段被中断的半截话：必须被丢掉
  stub.emitSessionEvent('s1', assistantMessage(1, 2, '这是被打断的半截话', 11, { interrupted: true }));

  assert.equal(calls.length, 0, 'turn/end 之前不该回调');
  stub.emitSessionEvent('s1', turnEnd(1, { kind: 'completed' }, 12));

  assert.equal(calls.length, 1, '一个成功回合恰好回调一次');
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].turn, 1);
  assert.equal(calls[0].text, '第一段\n\n第二段', '两个 step 之间用空行连接，interrupted 段被丢掉');
  assert.equal(bridge.isSessionRunning('s1'), false, '回合结束后不应再是 running');

  bridge.dispose();
});

/* ------------------------------------------------------------------ *
 * 3. 不成功的回合不回调
 * ------------------------------------------------------------------ */

await test('3) turn/end 的 reason 是 cancelled / aborted / interrupted / error / 缺失 时都不回调', () => {
  const cases = [
    ['字符串 cancelled', 'cancelled'],
    ['字符串 aborted', 'aborted'],
    ['对象 {kind:"interrupted"}', { kind: 'interrupted' }],
    ['对象 {kind:"error"}', { kind: 'error' }],
    ['字符串 stopped', 'stopped'],
    ['完全没有 reason', undefined],
  ];

  for (const [label, reason] of cases) {
    const { stub, bridge, calls } = mount();
    const sessionId = `s-${label}`;
    stub.emitSessionEvent(sessionId, turnStart(3, 1));
    stub.emitSessionEvent(sessionId, assistantMessage(3, 0, '这段文本不该被投递', 2));
    stub.emitSessionEvent(sessionId, turnEnd(3, reason, 3));
    assert.equal(calls.length, 0, `${label} 不该回调`);
    assert.equal(bridge.isSessionRunning(sessionId), false);
    bridge.dispose();
  }

  // 对照组：同一段文本，reason 恰好 completed 时才会回调
  const { stub, bridge, calls } = mount();
  stub.emitSessionEvent('s-ok', turnStart(3, 1));
  stub.emitSessionEvent('s-ok', assistantMessage(3, 0, '这段文本应当被投递', 2));
  stub.emitSessionEvent('s-ok', turnEnd(3, 'completed', 3));
  assert.equal(calls.length, 1, '字符串 "completed" 也必须认');
  assert.equal(calls[0].text, '这段文本应当被投递');
  bridge.dispose();
});

/* ------------------------------------------------------------------ *
 * 4. 同一会话连续两个回合
 * ------------------------------------------------------------------ */

await test('4) 同一会话连续两个回合，文本不串味（也不重复回调）', () => {
  const { stub, bridge, calls } = mount();

  stub.emitSessionEvent('s1', turnStart(1, 1));
  stub.emitSessionEvent('s1', assistantMessage(1, 0, '甲回合的答案', 2));
  stub.emitSessionEvent('s1', turnEnd(1, { kind: 'completed' }, 3));

  stub.emitSessionEvent('s1', turnStart(2, 4));
  stub.emitSessionEvent('s1', assistantMessage(2, 0, '乙回合的答案', 5));
  stub.emitSessionEvent('s1', turnEnd(2, { kind: 'completed' }, 6));

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.text), ['甲回合的答案', '乙回合的答案']);
  assert.deepEqual(calls.map((call) => call.turn), [1, 2]);
  assert.ok(!calls[1].text.includes('甲回合'), '第二个回合不该带上第一个回合的文本');

  bridge.dispose();
});

/* ------------------------------------------------------------------ *
 * 5. 两个会话交错
 * ------------------------------------------------------------------ */

await test('5) 两个不同会话交错的事件，不互相污染', () => {
  const { stub, bridge, calls } = mount();

  stub.emitSessionEvent('A', turnStart(1, 1));
  stub.emitSessionEvent('B', turnStart(7, 2));

  stub.emitSessionEvent('A', assistantMessage(1, 0, 'A 的答案', 3));
  stub.emitSessionEvent('B', assistantMessage(7, 0, 'B 的第一段', 4));
  stub.emitSessionEvent('A', assistantMessage(1, 1, 'A 的第二段', 5));
  stub.emitSessionEvent('B', assistantMessage(7, 1, 'B 的第二段', 6));

  stub.emitSessionEvent('B', turnEnd(7, { kind: 'completed' }, 7));
  stub.emitSessionEvent('A', turnEnd(1, { kind: 'completed' }, 8));

  assert.equal(calls.length, 2);
  const byId = new Map(calls.map((call) => [call.sessionId, call]));
  assert.equal(byId.get('A').text, 'A 的答案\n\nA 的第二段');
  assert.equal(byId.get('A').turn, 1);
  assert.equal(byId.get('B').text, 'B 的第一段\n\nB 的第二段');
  assert.equal(byId.get('B').turn, 7);
  assert.ok(!byId.get('A').text.includes('B'), 'A 的文本里不该混进 B 的内容');

  bridge.dispose();
});

/* ------------------------------------------------------------------ *
 * 6. dispose
 * ------------------------------------------------------------------ */

await test('6) dispose() 之后事件不再触发回调，且监听被真正摘掉', () => {
  const { stub, bridge, calls } = mount();

  stub.emitSessionEvent('s1', turnStart(1, 1));
  stub.emitSessionEvent('s1', assistantMessage(1, 0, 'dispose 之前', 2));
  stub.emitSessionEvent('s1', turnEnd(1, { kind: 'completed' }, 3));
  assert.equal(calls.length, 1);

  bridge.dispose();
  assert.equal(stub.handlers[0].disposed, true, 'ctx.on 返回的 disposer 必须被调用');
  assert.equal(bridge.isSessionRunning('s1'), false);

  // dispose 之后再走一遍完整回合：一次都不该回调
  stub.emitSessionEvent('s1', turnStart(5, 4));
  stub.emitSessionEvent('s1', assistantMessage(5, 0, 'dispose 之后', 5));
  stub.emitSessionEvent('s1', turnEnd(5, { kind: 'completed' }, 6));
  assert.equal(calls.length, 1, 'dispose 后不该再有回调');

  // 幂等
  bridge.dispose();
  assert.equal(stub.handlers[0].disposed, true);
});

/* ------------------------------------------------------------------ *
 * 7. 附加：服务就绪 / 选路 / 降级 / ctx.effect 清理
 * ------------------------------------------------------------------ */

await test('7a) listSessions()：走 sessionController.list，字段映射正确', async () => {
  const { stub, bridge } = mount();
  stub.becomeReady({
    sessionController: {
      list: async () => ({
        items: [
          { sessionId: 's1', running: true, cwd: 'D:\\workspace', projections: { values: { title: '微信桥接' } } },
          { sessionId: 's2', running: false, projections: { values: {} } },
          { sessionId: '', running: false },
        ],
      }),
    },
  });

  const rows = await bridge.listSessions();
  assert.deepEqual(rows, [
    { id: 's1', title: '微信桥接', cwd: 'D:\\workspace', running: true },
    { id: 's2', title: null, cwd: null, running: false },
  ]);
  assert.equal(bridge.isSessionRunning('s1'), true, '列表里的 running 要同步进内存视图');
  bridge.dispose();
});

await test('7b) submitUserText()：走 sessionController.prompt，request 形状与宿主描述符一致', async () => {
  const seen = [];
  const { stub, bridge } = mount();
  stub.becomeReady({
    sessionController: {
      prompt: async (request) => { seen.push(request); return { accepted: true }; },
    },
  });

  await bridge.submitUserText('s1', '你好，帮我看看 D 盘');
  await bridge.submitUserText('s1', '第二条');

  assert.equal(seen.length, 2);
  assert.equal(seen[0].sessionId, 's1');
  assert.equal(seen[0].mode, 'queue');
  assert.deepEqual(seen[0].content, [{ type: 'text', text: '你好，帮我看看 D 盘' }]);
  assert.match(seen[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(seen[0].requestId, seen[1].requestId, '每次提交都要有独立 requestId');
  // 字段必须严格落在宿主描述符允许的集合里，多一个都会被 typert 网关拒掉
  for (const key of Object.keys(seen[0])) {
    assert.ok(
      ['requestId', 'sessionId', 'mode', 'content', 'clientTimeZone'].includes(key),
      `request 多出字段 ${key}，过不了宿主描述符`,
    );
  }

  await assert.rejects(() => bridge.submitUserText('', 'x'), TypeError);
  await assert.rejects(() => bridge.submitUserText('s1', '   '), TypeError);
  bridge.dispose();
});

await test('7c) submitUserText()：sessionController 缺席时降级走 typertGateway.invoke("session/prompt")', async () => {
  const seen = [];
  const { stub, bridge } = mount();
  stub.becomeReady({
    typertGateway: { invoke: async (request) => { seen.push(request); return { accepted: true }; } },
  });

  await bridge.submitUserText('s2', '走网关');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].namespace, 'session');
  assert.equal(seen[0].method, 'prompt');
  assert.equal(seen[0].args.request.sessionId, 's2');
  assert.equal(seen[0].args.request.mode, 'queue');
  assert.deepEqual(seen[0].args.request.content, [{ type: 'text', text: '走网关' }]);
  bridge.dispose();
});

await test('7d) 两个服务都没有：listSessions() 返回空数组、submitUserText() 抛 harness-bridge-unavailable', async () => {
  const { stub, bridge } = mount();
  assert.deepEqual(await bridge.listSessions(), []);
  await assert.rejects(
    () => bridge.submitUserText('s1', 'hi'),
    (error) => error.code === 'harness-bridge-unavailable',
  );
  // dispose 之后同样拒绝
  bridge.dispose();
  await assert.rejects(
    () => bridge.submitUserText('s1', 'hi'),
    (error) => error.code === 'harness-bridge-unavailable',
  );
});

await test('7e) listSessions() 退路：只有 ctx.sessions 时，标题从 session/title 事件读', async () => {
  const { stub, bridge } = mount();
  stub.becomeReady({
    sessions: {
      list: () => [
        {
          id: 's9',
          header: { cwd: 'C:\\work' },
          snapshotEvents: () => [
            { type: 'user/message', seq: 0, data: {} },
            { type: 'session/title', seq: 1, data: { title: '标题来自事件' } },
          ],
        },
        { id: 's10', header: {}, events: [] },
      ],
    },
    agents: { get: (id) => (id === 's10' ? { status: 'running' } : undefined) },
  });

  const rows = await bridge.listSessions();
  assert.deepEqual(rows, [
    { id: 's9', title: '标题来自事件', cwd: 'C:\\work', running: false },
    { id: 's10', title: null, cwd: null, running: true },
  ]);
  assert.equal(bridge.isSessionRunning('s10'), true, 'agents.get(id).status === "running" 应生效');
  bridge.dispose();
});

await test('7f) ctx.effect 注册的清理函数真的会 dispose 掉桥接', () => {
  const { stub, bridge, calls } = mount();
  assert.equal(stub.effects.length, 1);
  const cleanup = stub.effects[0].fn();
  assert.equal(typeof cleanup, 'function', 'effect 应返回 dispose 作为清理函数');
  cleanup();

  stub.emitSessionEvent('s1', turnStart(1, 1));
  stub.emitSessionEvent('s1', assistantMessage(1, 0, '不该出现', 2));
  stub.emitSessionEvent('s1', turnEnd(1, { kind: 'completed' }, 3));
  assert.equal(calls.length, 0);
  assert.equal(stub.handlers[0].disposed, true);
  bridge.dispose();
});

await test('7g) 辅助导出：TurnTextAccumulator / textFromContent / turnReasonKind', () => {
  assert.equal(textFromContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'x' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(textFromContent(undefined), '');

  const accumulator = new TurnTextAccumulator();
  accumulator.appendDelta(1, 0, 'B');
  accumulator.appendDelta(0, 0, 'A');
  accumulator.setCanonical(2, 'C');
  accumulator.dropStep(1);
  assert.equal(accumulator.text, 'A\n\nC');

  assert.equal(turnReasonKind('completed'), 'completed');
  assert.equal(turnReasonKind({ kind: 'completed' }), 'completed');
  assert.equal(turnReasonKind(undefined), null);
});

/* ------------------------------------------------------------------ *
 * 回归：prompt 必须带 AbortSignal
 *
 * 宿主 sessionController 的签名是 (request, signal)，内部会无条件调
 * signal.throwIfAborted()。只传 request 时抛
 *   Cannot read properties of undefined (reading 'throwIfAborted')
 * 表现是：微信消息到了传输层、却没变成回合，两端都看不到任何痕迹。
 * ------------------------------------------------------------------ */
await test('8a) 回归：prompt 必须带 AbortSignal（宿主内部会调 signal.throwIfAborted）', async () => {
  let sawSignal = null;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
    provide() {},
    inject: (deps, cb) => {
      cb({
        sessionController: {
          list: async () => ({ items: [] }),
          // Emulate the host exactly: it calls throwIfAborted() unconditionally.
          prompt: async (request, signal) => { signal.throwIfAborted(); sawSignal = typeof signal; },
        },
        typertGateway: { invoke: async () => {} },
      });
      return () => {};
    },
  };
  const bridge = installHarnessBridge(ctx, { logger: ctx.logger, onTurnComplete() {} });
  try {
    await bridge.submitUserText('session-regress', 'hello');
  } finally {
    bridge.dispose();
  }
  assert.equal(sawSignal, 'object', 'a real AbortSignal must reach the host prompt');
});
/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log('');
if (failed === 0) {
  console.log(`全部通过：${passed} 项（0 失败）`);
  process.exitCode = 0;
} else {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exitCode = 1;
}
