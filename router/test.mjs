/**
 * Router tests. Offline, temp-dir backed, no host and no network.
 *   node test.mjs
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  createRouter,
  classifyInbound,
  formatSessionList,
  formatSelected,
  formatOutOfRange,
  splitForWeChat,
  DEFAULT_MAX_MESSAGE_CHARS,
  // `/new` + `/session <id> open|close`
  parseChoiceNumber,
  createPendingChoice,
  workspaceKey,
  formatWorkspaceList,
  formatWorkspaceOutOfRange,
  formatNewSession,
  formatSessionNotFound,
  formatSessionOpened,
  formatSessionClosed,
  NEW_CANCELLED_TEXT,
  NO_WORKSPACES_TEXT,
  MAX_WORKSPACE_CHOICES,
  NEW_CHOICE_TTL_MS,
} from './router.mjs';

const dir = await mkdtemp(join(tmpdir(), 'wechat-box-router-'));
const statePath = join(dir, 'router.json');

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };

// --- R1: default OFF, state persists across a reload ------------------------
{
  const router = createRouter({ statePath });
  await router.load();
  assert.equal(await router.isEnabled('session-a'), false, 'new conversation defaults to OFF');
  await router.setEnabled('session-a', true, '会话 A');
  assert.equal(await router.isEnabled('session-a'), true);

  const fresh = createRouter({ statePath });
  await fresh.load();
  assert.equal(await fresh.isEnabled('session-a'), true, 'switch survives a reload');
  const snap = await fresh.snapshot();
  assert.equal(snap.sessions['session-a'].title, '会话 A');
  assert.equal(snap.version, 1);
  ok('R1 switch defaults OFF and persists across reload');
}

// --- R4: selection is single -- picking B turns A off -----------------------
{
  await rm(statePath, { force: true });
  const router = createRouter({ statePath });
  await router.load();
  await router.select('session-a', 'A');
  await router.select('session-b', 'B');
  // Multi-connect: selecting B points the channel at B but must NOT close A.
  assert.equal(await router.isEnabled('session-a'), true, 'selecting B leaves A on (many switches, one pointer)');
  assert.equal(await router.isEnabled('session-b'), true);
  assert.equal(await router.selectedId(), 'session-b');
  // Multi-connect: many switches may be ON; exactly one pointer decides where
  // incoming WeChat messages go.
  assert.deepEqual(await router.enabledIds(), ['session-a', 'session-b'], 'many switches may be ON');
  assert.equal(await router.selectedId(), 'session-b', 'but only one conversation owns the replies');
  ok('R4 selecting is single: one conversation bridged at a time');
}

// --- R3: /off stops mirroring ----------------------------------------------
{
  const router = createRouter({ statePath });
  await router.load();
  await router.clearSelection();
  assert.equal(await router.selectedId(), null);
    // only the conversation the pointer was on loses its switch
    assert.deepEqual(await router.enabledIds(), ['session-a']);
  ok('R3 /off clears the selection and stops the bridge');
}

// --- stale selectedId is dropped on load ------------------------------------
{
  await writeFile(statePath, JSON.stringify({
    version: 1,
    selectedId: 'session-gone',
    sessions: { 'session-gone': { enabled: false } },
  }), 'utf8');
  const router = createRouter({ statePath });
  await router.load();
  assert.equal(await router.selectedId(), null, 'a selected-but-disabled id is stale');
  ok('stale selectedId is dropped on load');
}

// --- corrupt state must not throw -------------------------------------------
{
  await writeFile(statePath, '{ this is not json', 'utf8');
  const router = createRouter({ statePath });
  await router.load();
  assert.equal(await router.selectedId(), null);
  assert.deepEqual(await router.enabledIds(), []);
  await router.setEnabled('session-x', true);   // and it still works afterwards
  assert.equal(await router.isEnabled('session-x'), true);
  ok('corrupt state file recovers to empty and stays writable');
}

// --- the switch can be flipped off explicitly -------------------------------
{
  await rm(statePath, { force: true });
  const router = createRouter({ statePath });
  await router.load();
  await router.setEnabled('s1', true);
  await router.setEnabled('s1', false);
  assert.equal(await router.isEnabled('s1'), false);
  assert.equal(await router.selectedId(), null, 'turning the selected switch off clears the selection');
  ok('explicit OFF from the DSH client clears the selection');
}

// --- classifyInbound --------------------------------------------------------
{
  const cases = [
    ['3', 5, { kind: 'select', index: 3 }],
    [' 1 ', 5, { kind: 'select', index: 1 }],
    ['9', 5, { kind: 'select', index: 9 }],          // out of range -> caller reports back
    ['/list', 5, { kind: 'list' }],
    ['列表', 5, { kind: 'list' }],
    ['/off', 5, { kind: 'off' }],
    ['关闭', 5, { kind: 'off' }],
    ['帮我改一下这段代码', 5, { kind: 'text' }],
    ['', 5, { kind: 'text' }],
    ['12abc', 5, { kind: 'text' }],
  ];
  for (const [input, count, expected] of cases) {
    assert.deepEqual(classifyInbound(input, count), expected, `classify(${JSON.stringify(input)})`);
  }
  ok(`classifyInbound handles ${cases.length} shapes`);
}

// --- formatSessionList ------------------------------------------------------
{
  const sessions = [
    { id: 's1', title: '桥接联调', cwd: 'D:\\workspace', running: true },
    { id: 's2', title: 'A very long conversation title that should be truncated somewhere sensible', cwd: 'D:\\papers' },
    { id: 's3' },
  ];
  const state = { selectedId: 's2', sessions: { s2: { enabled: true } } };
  const text = formatSessionList(sessions, state);
  const lines = text.split('\n');
  assert.match(lines[0], /选择一个对话/);
  assert.match(lines[1], /^1\. ○ /, 'unselected row uses the hollow mark');
  assert.match(lines[2], /^2\. ● /, 'selected row uses the filled mark');
  assert.match(lines[1], /运行中/, 'running flag is shown');
  assert.match(lines[3], /^3\. ○ /, 'a session without a title still gets a row');
  assert.ok(!text.includes('undefine'), 'no undefined leaks into the text');
  assert.equal(formatSessionList([], state), '当前没有可选的对话。先在 DSH 里建一个会话再试。');
  ok('formatSessionList numbers rows, marks the selected one, handles empty list');
}

// --- confirmation + error text ---------------------------------------------
{
  assert.match(formatSelected({ id: 's2', title: '文档整理' }, 2), /已切到 2\. 文档整理/);
  assert.match(formatSelected({ id: 's9' }, 1), /s9/);
  assert.match(formatOutOfRange(7, 3), /只有 1–3/);
  assert.match(formatOutOfRange(1, 0), /没有可选的对话/);
  ok('confirmation and out-of-range wording');
}

// --- concurrent-ish writes stay readable ------------------------------------
{
  await rm(statePath, { force: true });
  await mkdir(dir, { recursive: true });
  const router = createRouter({ statePath });
  await router.load();
  await Promise.all([
    router.setEnabled('a', true),
    router.setEnabled('b', true),
  ]).catch(() => {});
  const fresh = createRouter({ statePath });
  await fresh.load();                                  // must parse: no half-written file
  const snap = await fresh.snapshot();
  assert.ok(snap && typeof snap === 'object' && snap.sessions, 'file is always valid JSON after writes');
  ok('state file is never left half-written (atomic tmp+rename)');
}

// --- splitForWeChat: the 1800-char platform ceiling -------------------------
{
  assert.equal(DEFAULT_MAX_MESSAGE_CHARS, 1800, 'matches the platform limit');
  assert.deepEqual(splitForWeChat(''), [], 'empty text yields no message');
  assert.deepEqual(splitForWeChat('short'), ['short'], 'short text is one message');
  const exact = 'x'.repeat(1800);
  assert.deepEqual(splitForWeChat(exact), [exact], 'exactly at the limit is a single message');
  const over = 'x'.repeat(1801);
  assert.equal(splitForWeChat(over).length, 2, 'one char over the limit needs two messages');

  // Every chunk must fit, and nothing may be lost.
  const long = Array.from({ length: 400 }, (_v, i) => `第 ${i} 行内容`).join('\n');
  const chunks = splitForWeChat(long);
  assert.ok(chunks.length > 1, 'a long answer is split');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1800, `chunk of ${chunk.length} exceeds the limit`);
    assert.ok(chunk.length > 0, 'no empty chunks');
  }
  const strip = (s) => s.replace(/\n/g, '');
  assert.equal(
    chunks.map(strip).join(''),
    long.replace(/\n/g, ''),
    'concatenating the chunks reproduces the text (cut newlines are dropped)',
  );
  assert.ok(!chunks.slice(1).some((c) => c.startsWith('\n')), 'continuations drop leading newlines');

  // A newline late in the window is a good cut point; an early one is not.
  const lateBreak = `${'a'.repeat(1500)}\n${'b'.repeat(1000)}`;
  assert.equal(splitForWeChat(lateBreak)[0], 'a'.repeat(1500), 'cuts at a newline past the 60% mark');
  const earlyBreak = `${'a'.repeat(100)}\n${'b'.repeat(2000)}`;
  assert.equal(splitForWeChat(earlyBreak)[0].length, 1800, 'an early newline is ignored, hard cut instead');

  // Custom limits are honoured, and a bad limit falls back to the default.
  assert.equal(splitForWeChat('abcdef', 3).length, 2);
  assert.equal(splitForWeChat('x'.repeat(1801), 0).length, 2, 'limit 0 falls back to the default');
  ok('splitForWeChat enforces the 1800-char ceiling without losing text');
}

// --- `/session <id>`: the command every outbound message carries --------------
// Every WeChat message is prefixed with a fenced `/session <id>` block so the id
// can be copied in the client and pasted back to rebind. Nothing handled that
// command after dsh-im was retired, so a pasted line used to become chat text.
{
  assert.deepEqual(classifyInbound('/session abc-123', 5), { kind: 'bind', sessionId: 'abc-123' });
  assert.deepEqual(classifyInbound('/s abc-123', 5), { kind: 'bind', sessionId: 'abc-123' });
  assert.deepEqual(classifyInbound('/SESSION AbC', 5), { kind: 'bind', sessionId: 'AbC' });
  assert.deepEqual(classifyInbound('  /session   x-y_z  ', 5), { kind: 'bind', sessionId: 'x-y_z' });
  // Without an id it is not the command, and it must not shadow the other kinds.
  assert.deepEqual(classifyInbound('/session', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('/session abc def', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('/list', 5), { kind: 'list' });
  assert.deepEqual(classifyInbound('3', 5), { kind: 'select', index: 3 });
  ok('classifyInbound recognises `/session <id>` without shadowing the other kinds');
}

// --- `/session <id> open|close`: the direction is written out -----------------
// The bare form selects AND opens; `open`/`close` say which one is wanted. The
// bare form must be untouched -- it is what every outbound message carries.
{
  assert.deepEqual(classifyInbound('/session abc open', 5), { kind: 'session-open', sessionId: 'abc' });
  assert.deepEqual(classifyInbound('/session abc close', 5), { kind: 'session-close', sessionId: 'abc' });
  assert.deepEqual(classifyInbound('/session abc OPEN', 5), { kind: 'session-open', sessionId: 'abc' });
  assert.deepEqual(classifyInbound('  /session   abc   Close  ', 5), { kind: 'session-close', sessionId: 'abc' });
  assert.deepEqual(classifyInbound('/s abc open', 5), { kind: 'session-open', sessionId: 'abc' });
  // The old semantics, unchanged.
  assert.deepEqual(classifyInbound('/session abc', 5), { kind: 'bind', sessionId: 'abc' });
  assert.deepEqual(classifyInbound('/s abc', 5), { kind: 'bind', sessionId: 'abc' });
  // Only `open`/`close` are directions: `on`/`off` would collide with `/off`,
  // and any other trailing word addresses nothing, so it stays text.
  assert.deepEqual(classifyInbound('/session abc off', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('/session abc on', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('/session abc def', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('/session abc open close', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('/session abc open extra', 5), { kind: 'text' });
  // `/session <id> open` must not become the id "open" or leak the direction.
  assert.deepEqual(classifyInbound('/session open', 5), { kind: 'bind', sessionId: 'open' });
  ok('`/session <id> open|close` is recognised and the bare form is untouched');
}

// --- `/new` ------------------------------------------------------------------
{
  assert.deepEqual(classifyInbound('/new', 5), { kind: 'new' });
  assert.deepEqual(classifyInbound('  /NEW  ', 5), { kind: 'new' });
  // Near-misses must stay ordinary text: a stray `/new` must never ambush the
  // user with a workspace list.
  assert.deepEqual(classifyInbound('/new abc', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('/newx', 5), { kind: 'text' });
  assert.deepEqual(classifyInbound('new', 5), { kind: 'text' });
  ok('classifyInbound recognises `/new` and nothing that merely looks like it');
}

// --- parseChoiceNumber: what a pending choice consumes ------------------------
{
  assert.equal(parseChoiceNumber('2'), 2);
  assert.equal(parseChoiceNumber(' 07 '), 7);
  assert.equal(parseChoiceNumber('100'), 100);
  assert.equal(parseChoiceNumber('0'), 0);        // a number; range is the caller's job
  assert.equal(parseChoiceNumber('12abc'), null);
  assert.equal(parseChoiceNumber(''), null);
  assert.equal(parseChoiceNumber('一千'), null);
  assert.equal(parseChoiceNumber(undefined), null);
  assert.equal(parseChoiceNumber('/list'), null);
  ok('parseChoiceNumber takes a bare number and nothing else');
}

// --- workspaceKey: one directory, one row ------------------------------------
{
  assert.equal(workspaceKey('D:\\workspace\\'), workspaceKey('d:/workspace'));
  assert.equal(workspaceKey('D:\\workspace\\\\'), workspaceKey('D:\\workspace'));
  assert.notEqual(workspaceKey('D:\\workspace'), workspaceKey('D:\\workspace2'));
  assert.equal(workspaceKey(''), '');
  ok('workspaceKey folds case, separators and trailing slashes');
}

// --- formatWorkspaceList ------------------------------------------------------
{
  const paths = ['D:\\workspace', 'D:\\workspace\\project-b'];
  const text = formatWorkspaceList(paths);
  const lines = text.split('\n');
  assert.equal(lines[0], '在哪个工作区新建对话？');
  assert.equal(lines[1], '1. D:\\workspace');
  assert.equal(lines[2], '2. D:\\workspace\\project-b');
  assert.match(text, /回复数字即可/, 'the instruction is the one the user was told to expect');
  assert.match(text, /2 分钟/, 'the window is stated, not implied');

  // At most nine rows, numbered 1..9.
  const many = Array.from({ length: 15 }, (_v, i) => `D:\\w${i + 1}`);
  const capped = formatWorkspaceList(many).split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(capped.length, MAX_WORKSPACE_CHOICES);
  assert.equal(MAX_WORKSPACE_CHOICES, 9);
  assert.equal(capped.at(-1), '9. D:\\w9', 'the ninth is the last one offered');

  assert.equal(formatWorkspaceList([]), NO_WORKSPACES_TEXT);
  assert.equal(formatWorkspaceList(undefined), NO_WORKSPACES_TEXT);
  ok('formatWorkspaceList numbers up to nine workspaces and states the window');
}

// --- out of range: reported AND re-listed, in one message --------------------
{
  const paths = ['D:\\workspace', 'D:\\workspace\\project-b'];
  const text = formatWorkspaceOutOfRange(7, paths);
  assert.match(text, /没有第 7 个工作区，只有 1–2/);
  assert.match(text, /在哪个工作区新建对话？/, 'the list comes back so the retry needs no extra step');
  assert.equal(formatWorkspaceOutOfRange(1, []), NO_WORKSPACES_TEXT);
  assert.equal(NEW_CANCELLED_TEXT, '已取消新建对话。');
  ok('an out-of-range workspace number is reported and the list is re-sent');
}

// --- the /new and open/close wording -----------------------------------------
{
  const created = formatNewSession({ sessionId: 'session-new', cwd: 'D:\\workspace', title: '新任务' });
  assert.match(created, /已在 D:\\workspace 新建对话/);
  assert.match(created, /开关已打开/);
  assert.match(created, /标题：新任务/);
  assert.match(created, /会话 ID：session-new/);
  // A brand-new conversation usually has no title yet: the reply says so instead
  // of printing an empty field.
  const untitled = formatNewSession({ sessionId: 'session-new', cwd: 'D:\\workspace', title: null });
  assert.match(untitled, /标题：（新对话，还没有标题）/);
  assert.ok(!untitled.includes('null'), 'no null leaks into the text');

  assert.equal(formatSessionNotFound('nope'), '没有找到会话 nope。发任意消息可以看到编号列表。');
  assert.match(formatSessionOpened({ id: 's1', title: '文档整理' }), /已打开 文档整理 的微信连接/);
  assert.match(formatSessionClosed({ id: 's1', title: '文档整理' }), /已关闭 文档整理 的微信连接/);
  assert.match(formatSessionClosed({ id: 's9' }), /s9/, 'an untitled conversation still names itself');
  ok('/new, open, close and not-found wording');
}

// --- createPendingChoice: precedence, TTL, cancel, out-of-range --------------
{
  let clock = 1_000;
  const pending = createPendingChoice({ ttlMs: 2_000, now: () => clock });

  assert.equal(pending.peek(), null, 'nothing is pending until something opens it');
  assert.deepEqual(pending.resolve(1), { ok: false, code: 'no-pending', count: 0 });
  assert.equal(pending.cancel(), false, 'cancelling nothing reports nothing');

  const opened = pending.open(['D:\\workspace', 'D:\\workspace\\project-b']);
  assert.equal(opened.expiresAtMs, 3_000);
  const peeked = pending.peek();
  assert.deepEqual(peeked.options, ['D:\\workspace', 'D:\\workspace\\project-b'], 'the options are copied out, not shared');
  assert.equal(peeked.remainingMs, 2_000);
  // Mutating the caller's array must not reach into the slot.
  const mine = ['A'];
  pending.open(mine);
  mine.push('B');
  assert.deepEqual(pending.peek().options, ['A']);

  pending.open(['D:\\workspace', 'D:\\workspace\\project-b']);
  assert.deepEqual(pending.resolve(9), { ok: false, code: 'out-of-range', count: 2 });
  assert.notEqual(pending.peek(), null, 'an out-of-range digit leaves the choice open to retype');
  assert.deepEqual(pending.resolve(2), { ok: true, kind: 'workspace', value: 'D:\\workspace\\project-b' });
  assert.equal(pending.peek(), null, 'resolving consumes the choice');

  // TTL: the deadline is absolute, and reading past it drops the entry.
  pending.open(['A'], { kind: 'session' });
  clock += 2_000;
  assert.equal(pending.peek(), null, 'an expired choice is gone');
  assert.deepEqual(pending.resolve(1), { ok: false, code: 'no-pending', count: 0 });
  assert.equal(pending.cancel(), false, 'expiry already dropped it');

  // A pending choice is memory only: a fresh store knows nothing.
  clock = 5_000;
  pending.open(['A']);
  assert.notEqual(pending.peek(), null);
  assert.equal(createPendingChoice({ ttlMs: 2_000, now: () => clock }).peek(), null,
    'nothing survives into a new store, which is what a restart is');

  assert.equal(NEW_CHOICE_TTL_MS, 120_000, 'the default window is two minutes');
  const defaulted = createPendingChoice({ now: () => 0 });
  assert.equal(defaulted.open(['A']).expiresAtMs, NEW_CHOICE_TTL_MS);
  // A nonsense TTL falls back rather than making the choice immortal.
  assert.equal(createPendingChoice({ ttlMs: 0, now: () => 0 }).open(['A']).expiresAtMs, NEW_CHOICE_TTL_MS);
  assert.equal(createPendingChoice({ ttlMs: -5, now: () => 0 }).open(['A']).expiresAtMs, NEW_CHOICE_TTL_MS);
  ok('createPendingChoice prioritises the pending choice, expires, cancels, re-lists on out-of-range');
}
await rm(dir, { recursive: true, force: true });
console.log(`\nrouter: ${passed} checks passed`);
