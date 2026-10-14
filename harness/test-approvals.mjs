/**
 * Tests for the WeChat approval bridge (A11, offline).
 *   node test-approvals.mjs
 */
import assert from 'node:assert/strict';
import { parseApprovalReply, approvalText, createApprovalBridge } from './approvals.mjs';

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };
const flush = () => new Promise((r) => setTimeout(r, 0));
const never = () => new Promise(() => {});

// --- reply parsing ----------------------------------------------------------
{
  for (const yes of ['批准', '同意', '可以', '好', '是', 'yes', 'Y', 'ok', '1', ' 批准 ']) {
    assert.equal(parseApprovalReply(yes), 'allowed-once', `"${yes}" should allow`);
  }
  for (const no of ['拒绝', '不同意', '不行', '不要', '否', 'no', 'N', 'reject', '2']) {
    assert.equal(parseApprovalReply(no), 'rejected', `"${no}" should reject`);
  }
  for (const unclear of ['', '   ', '再想想', 'maybe', '3', undefined]) {
    assert.equal(parseApprovalReply(unclear), null, `"${unclear}" is not an answer`);
  }
  ok('parseApprovalReply maps Chinese and English replies, and refuses to guess');
}

// --- prompt rendering -------------------------------------------------------
{
  const text = approvalText({ toolName: 'pwsh', reason: '需要在沙箱外写文件' });
  assert.match(text, /需要你的审批/);
  assert.match(text, /要执行：pwsh/);
  assert.match(text, /需要在沙箱外写文件/);
  assert.match(text, /回复「批准」/);

  const bare = approvalText({});
  assert.match(bare, /\(未知操作\)/);
  assert.ok(!bare.includes('undefined'), 'no undefined leaks into the prompt');
  ok('approvalText renders the tool, the reason, and the reply instructions');
}

// --- happy path: approved ---------------------------------------------------
{
  const sent = [];
  const bridge = createApprovalBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const request = { toolName: 'pwsh', callId: 'c1', reason: '写文件', signal: new AbortController().signal };
  const promise = bridge.handle(request, never);
  await flush();
  assert.equal(sent.length, 1, 'the approval was pushed to WeChat');
  assert.match(sent[0], /要执行：pwsh/);
  assert.equal(bridge.hasPending(), true);

  assert.equal(await bridge.handleReply('批准'), true, 'the reply was consumed');
  assert.equal(await promise, 'allowed-once');
  assert.equal(bridge.hasPending(), false, 'the pending is cleared');
  ok('an approval resolves as allowed-once when the user approves from WeChat');
}

// --- rejection --------------------------------------------------------------
{
  const bridge = createApprovalBridge({ send: async () => {}, log: { warn() {} } });
  const promise = bridge.handle({ toolName: 'rm', signal: new AbortController().signal }, never);
  await flush();
  assert.equal(await bridge.handleReply('拒绝'), true);
  assert.equal(await promise, 'rejected');
  ok('a rejection resolves as rejected');
}

// --- an unclear reply re-asks instead of guessing ---------------------------
{
  const sent = [];
  const bridge = createApprovalBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const promise = bridge.handle({ toolName: 'pwsh', signal: new AbortController().signal }, never);
  await flush();
  assert.equal(await bridge.handleReply('让我想想'), true, 'the message is consumed as part of the exchange');
  assert.equal(sent.length, 2, 'the prompt is repeated with a hint');
  assert.match(sent[1], /没看懂/);
  assert.equal(bridge.hasPending(), true, 'still waiting for a real answer');
  await bridge.handleReply('拒绝');
  assert.equal(await promise, 'rejected');
  ok('an unclear reply re-asks; it never silently becomes an approval');
}

// --- the host's own answerer wins the race ----------------------------------
{
  const bridge = createApprovalBridge({ send: async () => {}, log: { warn() {} } });
  const promise = bridge.handle({ toolName: 'pwsh', signal: new AbortController().signal },
    async () => 'rejected');
  assert.equal(await promise, 'rejected', 'the host answer is returned');
  await flush();
  assert.equal(bridge.hasPending(), false, 'our pending was dropped');
  assert.equal(await bridge.handleReply('批准'), false, 'a late WeChat reply is not swallowed');
  ok("the host's own answerer wins and the stale WeChat pending is dropped");
}

// --- a host answerer that says "nobody is there" keeps us waiting -----------
{
  const sent = [];
  const bridge = createApprovalBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const promise = bridge.handle({ toolName: 'pwsh', signal: new AbortController().signal },
    async () => 'unavailable');
  await flush();
  assert.equal(bridge.hasPending(), true, "'unavailable' is not an answer; WeChat still owns it");
  await bridge.handleReply('批准');
  assert.equal(await promise, 'allowed-once');
  ok("a native 'unavailable' keeps the WeChat pending open");
}

// --- a throwing host answerer keeps us waiting ------------------------------
{
  const bridge = createApprovalBridge({ send: async () => {}, log: { warn() {} } });
  const promise = bridge.handle({ toolName: 'pwsh', signal: new AbortController().signal },
    async () => { throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' }); });
  await flush();
  assert.equal(bridge.hasPending(), true, 'a failed native provider does not lose the approval');
  await bridge.handleReply('拒绝');
  assert.equal(await promise, 'rejected');
  ok('a failing native provider leaves the WeChat approval pending');
}

// --- a second concurrent approval goes to the host --------------------------
{
  const bridge = createApprovalBridge({ send: async () => {}, log: { warn() {} } });
  const first = bridge.handle({ toolName: 'a', signal: new AbortController().signal }, never);
  await flush();
  let handedOver = false;
  const second = bridge.handle({ toolName: 'b', signal: new AbortController().signal },
    async () => { handedOver = true; return 'rejected'; });
  assert.equal(await second, 'rejected');
  assert.equal(handedOver, true, 'the second approval was handed back to the host');
  await bridge.handleReply('批准');
  assert.equal(await first, 'allowed-once');
  ok('a second concurrent approval is handed straight to the host');
}

// --- abort, timeout and dismiss release the pending -------------------------
{
  const controller = new AbortController();
  const bridge = createApprovalBridge({ send: async () => {}, log: { warn() {} } });
  const promise = bridge.handle({ toolName: 'x', signal: controller.signal }, never);
  await flush();
  controller.abort();
  await assert.rejects(() => promise, (error) => error.code === 'APPROVAL_UNAVAILABLE');
  assert.equal(bridge.hasPending(), false);
  ok('aborting the approval releases the pending');

  const b2 = createApprovalBridge({ send: async () => {}, log: { warn() {} }, timeoutMs: 10 });
  const p2 = b2.handle({ toolName: 'x', signal: new AbortController().signal }, never);
  await assert.rejects(() => p2, (error) => error.code === 'APPROVAL_UNAVAILABLE' && /timed out/.test(error.message));
  assert.equal(b2.hasPending(), false);
  ok('an unanswered approval times out and releases the pending');

  const b3 = createApprovalBridge({ send: async () => {}, log: { warn() {} } });
  const p3 = b3.handle({ toolName: 'x', signal: new AbortController().signal }, never);
  await flush();
  assert.equal(b3.dismissAll('shutting down'), true);
  await assert.rejects(() => p3, (error) => error.code === 'APPROVAL_UNAVAILABLE');
  ok('dismissAll releases the pending on teardown');
}

console.log(`\napproval bridge: ${passed} checks passed`);
