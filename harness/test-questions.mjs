/**
 * Tests for the WeChat question bridge (R7 core, offline).
 *   node test-questions.mjs
 */
import assert from 'node:assert/strict';
import {
  validHarnessQuestion,
  questionText,
  questionsText,
  answerForQuestion,
  isListRequest,
  createQuestionBridge,
} from './questions.mjs';

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };
const flush = () => new Promise((r) => setTimeout(r, 0));

const Q = {
  id: 'q1',
  header: '选个方案',
  question: '你更倾向哪种？',
  detail: '两者代价不同。',
  options: [
    { label: '快但糙', description: '先上线' },
    { label: '慢但稳', description: '多花一天' },
  ],
};

// --- shape validation -------------------------------------------------------
{
  assert.equal(validHarnessQuestion(Q), true);
  assert.equal(validHarnessQuestion({ id: 'a', question: 'b' }), true, 'options are optional');
  assert.equal(validHarnessQuestion({ question: 'b' }), false, 'id is required');
  assert.equal(validHarnessQuestion({ id: 'a' }), false, 'question text is required');
  assert.equal(validHarnessQuestion({ id: 'a', question: 'b', multiSelect: 'yes' }), false);
  assert.equal(validHarnessQuestion({ id: 'a', question: 'b', options: [{ label: 1 }] }), false);
  assert.equal(validHarnessQuestion(null), false);
  ok('validHarnessQuestion accepts the real shape and rejects junk');
}

// --- rendering --------------------------------------------------------------
{
  const text = questionText(Q, 0, 1);
  assert.match(text, /需要你补充信息/);
  assert.match(text, /选个方案/);
  assert.match(text, /你更倾向哪种？/);
  assert.match(text, /两者代价不同。/);
  assert.match(text, /^1\. 快但糙 — 先上线$/m);
  assert.match(text, /^2\. 慢但稳 — 多花一天$/m);
  assert.match(text, /请回复一个选项序号或文字/);
  assert.ok(!text.includes('（1/1）'), 'a single question has no progress marker');

  const multi = questionText({ ...Q, multiSelect: true }, 1, 3);
  assert.match(multi, /（2\/3）/, 'progress marker for a batch');
  assert.match(multi, /多选用逗号分隔/);

  const free = questionText({ id: 'x', question: '随便说说' });
  assert.match(free, /请直接回复你的答案/);
  assert.ok(!free.includes('\n\n\n'), 'no runaway blank lines');
  ok('questionText renders header, body, detail, numbered options and hints');

  const batch = questionsText([Q, { id: 'q2', question: '第二个问题' }]);
  assert.match(batch, /（1\/2）/);
  assert.match(batch, /（2\/2）/);
  assert.match(batch, /———/, 'questions are visually separated');
  ok('questionsText batches several questions with progress');
}

// --- text -> answer ---------------------------------------------------------
{
  assert.deepEqual(answerForQuestion(Q, '1'), { id: 'q1', selected: ['快但糙'] });
  assert.deepEqual(answerForQuestion(Q, ' 2 '), { id: 'q1', selected: ['慢但稳'] });
  assert.deepEqual(answerForQuestion(Q, '快但糙'), { id: 'q1', selected: ['快但糙'] }, 'exact label works');
  assert.deepEqual(answerForQuestion(Q, '9'), { id: 'q1', selected: [], custom: '9' }, 'out of range is custom');
  assert.deepEqual(answerForQuestion(Q, '都不选，我自己来'), { id: 'q1', selected: [], custom: '都不选，我自己来' });
  assert.deepEqual(answerForQuestion({ id: 'x', question: 'q' }, '随便'), { id: 'x', selected: [], custom: '随便' });

  const multi = { ...Q, multiSelect: true };
  assert.deepEqual(answerForQuestion(multi, '1，2'), { id: 'q1', selected: ['快但糙', '慢但稳'] });
  assert.deepEqual(answerForQuestion(multi, '1，快但糙'), { id: 'q1', selected: ['快但糙'] }, 'dedupes repeats');
  assert.deepEqual(answerForQuestion(multi, '1，另外加一条'), { id: 'q1', selected: ['快但糙'], custom: '另外加一条' });
  ok('answerForQuestion maps numbers to labels, keeps custom text, handles multiSelect');

  assert.equal(isListRequest('/list'), true);
  assert.equal(isListRequest('?'), true);
  assert.equal(isListRequest('选项'), true);
  assert.equal(isListRequest('1'), false);
  ok('isListRequest recognises the re-send trigger');
}

// --- the bridge: happy path -------------------------------------------------
{
  const sent = [];
  const bridge = createQuestionBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const request = { questions: [Q], signal: new AbortController().signal };
  const promise = bridge.handle(request, () => new Promise(() => {}));
  await flush();
  assert.equal(sent.length, 1, 'the question was pushed to WeChat');
  assert.match(sent[0], /你更倾向哪种/);
  assert.equal(bridge.hasPending(), true);

  const consumed = await bridge.handleReply('2');
  assert.equal(consumed, true, 'the reply was consumed as an answer');
  assert.equal(bridge.hasPending(), false, 'the pending is cleared once answered');
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['慢但稳'] }] });
  ok('bridge pushes the question and resolves with the host answer shape');
}

// --- a `/list` reply re-sends without consuming -----------------------------
{
  const sent = [];
  const bridge = createQuestionBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const promise = bridge.handle({ questions: [Q] }, () => new Promise(() => {}));
  await flush();
  assert.equal(await bridge.handleReply('/list'), true);
  assert.equal(sent.length, 2, 'the question is re-sent');
  assert.equal(bridge.hasPending(), true, 'still waiting');
  await bridge.handleReply('1');
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['快但糙'] }] });
  ok('/list re-sends the question and keeps waiting');
}

// --- a blank reply re-asks rather than consuming ----------------------------
{
  const sent = [];
  const bridge = createQuestionBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const promise = bridge.handle({ questions: [Q] }, () => new Promise(() => {}));
  await flush();
  assert.equal(await bridge.handleReply('   '), true);
  assert.equal(sent.length, 2, 're-asked');
  assert.equal(bridge.hasPending(), true);
  await bridge.handleReply('1');
  await promise;
  ok('a blank reply re-asks instead of being swallowed');
}

// --- multi-question ask: one WeChat message per question --------------------
{
  const sent = [];
  const bridge = createQuestionBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const second = { id: 'q2', question: '第二个问题', options: [{ label: '是' }, { label: '否' }] };
  const promise = bridge.handle({ questions: [Q, second] }, () => new Promise(() => {}));
  await flush();
  assert.equal(sent.length, 1, 'the batch is pushed once up front');

  await bridge.handleReply('1');
  assert.equal(bridge.hasPending(), true, 'still waiting for the second answer');
  assert.equal(sent.length, 2, 'the next question is asked');
  assert.match(sent[1], /第二个问题/);

  await bridge.handleReply('否');
  assert.deepEqual(await promise, {
    answers: [{ id: 'q1', selected: ['快但糙'] }, { id: 'q2', selected: ['否'] }],
  });
  ok('a multi-question ask collects answers in order');
}

// --- the host's own answerer wins the race ----------------------------------
{
  const sent = [];
  const bridge = createQuestionBridge({ send: async (t) => { sent.push(t); }, log: { warn() {} } });
  const promise = bridge.handle({ questions: [Q] }, async () => ({ answers: [{ id: 'q1', selected: ['慢但稳'] }] }));
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['慢但稳'] }] }, 'the host answer is returned');
  await flush();
  assert.equal(bridge.hasPending(), false, 'the WeChat pending was dropped when the host answered');
  assert.equal(await bridge.handleReply('1'), false, 'a late WeChat reply is not swallowed');
  ok("the host's own answerer wins and the stale WeChat pending is dropped");
}

// --- a second ask while one is open goes to the host ------------------------
{
  const bridge = createQuestionBridge({ send: async () => {}, log: { warn() {} } });
  let nextCalled = false;
  const first = bridge.handle({ questions: [Q] }, () => new Promise(() => {}));
  await flush();
  const second = bridge.handle({ questions: [Q] }, async () => { nextCalled = true; return { answers: [] }; });
  assert.deepEqual(await second, { answers: [] });
  assert.equal(nextCalled, true, 'the interleaved ask was handed to the host');
  await bridge.handleReply('1');
  await first;
  ok('a second ask while one is open is handed back instead of interleaving');
}

// --- abort and timeout release the pending ----------------------------------
{
  const controller = new AbortController();
  const bridge = createQuestionBridge({ send: async () => {}, log: { warn() {} } });
  const promise = bridge.handle({ questions: [Q], signal: controller.signal }, () => new Promise(() => {}));
  await flush();
  controller.abort();
  await assert.rejects(() => promise, (error) => error.code === 'ASK_ABORTED');
  assert.equal(bridge.hasPending(), false, 'an aborted question stops accepting replies');
  ok('aborting the question releases the pending with ASK_ABORTED');

  const bridge2 = createQuestionBridge({ send: async () => {}, log: { warn() {} }, timeoutMs: 10 });
  const p2 = bridge2.handle({ questions: [Q] }, () => new Promise(() => {}));
  await assert.rejects(() => p2, (error) => error.code === 'ASK_ABORTED' && /timed out/.test(error.message));
  assert.equal(bridge2.hasPending(), false);
  ok('an unanswered question times out and releases the pending');

  const bridge3 = createQuestionBridge({ send: async () => {}, log: { warn() {} } });
  const p3 = bridge3.handle({ questions: [Q] }, () => new Promise(() => {}));
  await flush();
  assert.equal(bridge3.dismissAll('shutting down'), true);
  await assert.rejects(() => p3, (error) => error.code === 'ASK_ABORTED');
  ok('dismissAll releases the pending on teardown');
}

// --- degenerate input goes straight to the host -----------------------------
{
  const bridge = createQuestionBridge({ send: async () => {}, log: { warn() {} } });
  let calls = 0;
  const next = async () => { calls += 1; return { answers: [] }; };
  assert.deepEqual(await bridge.handle({ questions: [] }, next), { answers: [] }, 'no questions -> host');
  assert.deepEqual(await bridge.handle({}, next), { answers: [] }, 'missing questions -> host');
  assert.deepEqual(await bridge.handle({ questions: [{ id: 1 }] }, next), { answers: [] }, 'invalid question -> host');
  assert.equal(calls, 3);
  assert.equal(bridge.hasPending(), false);
  ok('asks with nothing renderable are handed to the host untouched');
}

console.log(`\nquestions bridge: ${passed} checks passed`);
