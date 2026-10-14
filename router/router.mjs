/**
 * dsh-wechat-box -- router: the per-conversation switch state and the
 * WeChat-side numbered picker.
 *
 * Pure-ish: the only side effect is reading/writing one JSON file. Everything
 * else is deterministic so it can be tested without a host, a network, or a
 * Cordis context.
 *
 * Semantics (see ../DESIGN.md R1-R5):
 *   R1  every conversation has its own switch, persisted by session id, default OFF
 *   R2  ON  -> that conversation is bridged both ways with WeChat
 *   R3  OFF -> WeChat may still pick it and push one message in; its output
 *              does NOT go back to WeChat
 *   R4  picking a conversation on the WeChat side turns its switch ON
 *   R5  any free-text WeChat message answers with a numbered conversation list;
 *       replying with a bare number selects
 *
 * Selection is SINGLE: picking N turns N on and everything else off, so at most
 * one conversation is bridged at a time. `selectedId` is that conversation.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATE_VERSION = 1;

/** Commands the WeChat side understands. Bare numbers are handled separately. */
export const COMMANDS = Object.freeze({
  list: ['/list', '/sessions', '/ls', '列表', 'list'],
  off: ['/off', '/stop', '停止', '关闭'],
  // `/new` starts the "create a conversation in a workspace" flow. Only the
  // exact command: a near-miss must stay ordinary chat text rather than
  // ambushing the user with a workspace list.
  new: ['/new'],
});

function emptyState() {
  return { version: STATE_VERSION, selectedId: null, sessions: {} };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const sessions = {};
  if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
    for (const [id, entry] of Object.entries(raw.sessions)) {
      if (typeof id !== 'string' || !id) continue;
      if (!entry || typeof entry !== 'object') continue;
      sessions[id] = {
        enabled: entry.enabled === true,
        ...(typeof entry.title === 'string' && entry.title ? { title: entry.title } : {}),
        ...(Number.isFinite(entry.updatedAt) ? { updatedAt: entry.updatedAt } : {}),
      };
    }
  }
  const selectedId = typeof raw.selectedId === 'string' && raw.selectedId ? raw.selectedId : null;
  return { version: STATE_VERSION, selectedId, sessions };
}

export function createRouter({ statePath, now = () => Date.now() }) {
  let state = null;

  async function load() {
    try {
      state = normalize(JSON.parse(await readFile(statePath, 'utf8')));
    } catch {
      state = emptyState();
    }
    // A selected id that is no longer enabled is a stale leftover: drop it.
    if (state.selectedId && !state.sessions[state.selectedId]?.enabled) state.selectedId = null;
    return state;
  }

  async function persist() {
    await mkdir(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, statePath);
  }

  async function ensure() {
    if (!state) await load();
    return state;
  }

  return Object.freeze({
    load,
    async snapshot() {
      const s = await ensure();
      return JSON.parse(JSON.stringify(s));
    },
    async isEnabled(sessionId) {
      const s = await ensure();
      return s.sessions[sessionId]?.enabled === true;
    },
    async selectedId() {
      return (await ensure()).selectedId;
    },
    /**
     * R4: point the channel at a conversation and make sure its switch is ON.
     *
     * This deliberately does NOT close the other switches. "Switch" and "pointer"
     * are two different things:
     *   - the switch says which conversations may talk to WeChat at all (many may
     *     be on at once: each one's finished turns are mirrored out);
     *   - the pointer says where an incoming WeChat message goes (exactly one).
     * Turning the target's switch off instead used to make the channel
     * single-selection, which contradicted "one switch per conversation". The
     * pointer's ambiguity is resolved elsewhere: whichever conversation spoke to
     * WeChat most recently owns the replies (see `bindTo` in the host).
     */
    async select(sessionId, title) {
      if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
      const s = await ensure();
      s.sessions[sessionId] = {
        enabled: true,
        ...(typeof title === 'string' && title ? { title } : (s.sessions[sessionId]?.title ? { title: s.sessions[sessionId].title } : {})),
        updatedAt: now(),
      };
      s.selectedId = sessionId;
      await persist();
      return s;
    },
    /** Explicit switch flip from the DSH web client. */
    async setEnabled(sessionId, enabled, title) {
      if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
      const s = await ensure();
      if (enabled) return this.select(sessionId, title);
      if (s.sessions[sessionId]) s.sessions[sessionId] = { ...s.sessions[sessionId], enabled: false, updatedAt: now() };
      if (s.selectedId === sessionId) s.selectedId = null;
      await persist();
      return s;
    },
    /** R3/`/off`: stop mirroring back, but remember nothing else. */
    async clearSelection() {
      const s = await ensure();
      if (s.selectedId && s.sessions[s.selectedId]) {
        s.sessions[s.selectedId] = { ...s.sessions[s.selectedId], enabled: false, updatedAt: now() };
      }
      s.selectedId = null;
      await persist();
      return s;
    },
    async enabledIds() {
      const s = await ensure();
      return Object.keys(s.sessions).filter((id) => s.sessions[id].enabled);
    },
  });
}

// ------------------------------------------------------------------- picker

/**
 * Decide what an inbound WeChat text means.
 * @returns {{kind:'select', index:number}
 *          |{kind:'new'}
 *          |{kind:'bind', sessionId:string}
 *          |{kind:'session-open', sessionId:string}
 *          |{kind:'session-close', sessionId:string}
 *          |{kind:'list'}|{kind:'off'}|{kind:'text'}}
 */
export function classifyInbound(text, sessionCount = 0) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return { kind: 'text' };
  if (COMMANDS.new.includes(value.toLowerCase())) return { kind: 'new' };
  if (COMMANDS.list.includes(value.toLowerCase()) || COMMANDS.list.includes(value)) {
    return { kind: 'list' };
  }
  if (COMMANDS.off.includes(value.toLowerCase()) || COMMANDS.off.includes(value)) {
    return { kind: 'off' };
  }
  // `/session <id> [open|close]` -- the command every outbound message carries as
  // a fenced, copyable block. Pasting it back binds this chat to that exact
  // conversation, which is the fast path when the user already has an id in hand.
  // It used to be @xmanrui/dsh-im's command; nothing handled it after dsh-im was
  // retired, so the copied line silently became ordinary chat text.
  //
  // `open` / `close` extend it without changing the bare form: an explicit
  // direction instead of the bare form's "select + open". Only these two words
  // are accepted -- `on`/`off` would collide with the standalone `/off`, and a
  // near-miss like `/session abc def` must stay text (it addresses nothing).
  const bind = /^\/(?:session|s)\s+(\S+)(?:\s+(open|close))?$/i.exec(value);
  if (bind) {
    const action = bind[2]?.toLowerCase() ?? null;
    if (action === 'open') return { kind: 'session-open', sessionId: bind[1] };
    if (action === 'close') return { kind: 'session-close', sessionId: bind[1] };
    return { kind: 'bind', sessionId: bind[1] };
  }
  // A bare number selects, but only when it addresses a real row.
  if (/^\d{1,3}$/.test(value)) {
    const index = Number(value);
    if (index >= 1 && index <= sessionCount) return { kind: 'select', index };
    return { kind: 'select', index }; // out of range: caller reports it back
  }
  return { kind: 'text' };
}

/**
 * The bare 1-based number a pending choice consumes, or null.
 *
 * Deliberately NOT `classifyInbound`: a pending `/new` choice must intercept the
 * number BEFORE the conversation picker ever sees it, otherwise "2" would select
 * the 2nd existing conversation instead of the 2nd workspace. This is the whole
 * number test on its own, so the precedence is one explicit branch in the host
 * rather than an ordering accident inside the classifier.
 */
export function parseChoiceNumber(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!/^\d{1,3}$/.test(value)) return null;
  return Number(value);
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * R5: the numbered conversation list.
 * @param sessions [{ id, title, cwd, running }]
 */
export function formatSessionList(sessions, state = {}, { limit = 20 } = {}) {
  const rows = Array.isArray(sessions) ? sessions.slice(0, limit) : [];
  if (rows.length === 0) return '当前没有可选的对话。先在 DSH 里建一个会话再试。';

  const selected = state.selectedId ?? null;
  const enabled = state.sessions ?? {};
  const lines = rows.map((session, index) => {
    const on = session.id === selected || enabled[session.id]?.enabled === true;
    const mark = on ? '●' : '○';
    const where = session.cwd ? `（${truncate(session.cwd, 28)}）` : '';
    const busy = session.running ? ' · 运行中' : '';
    return `${index + 1}. ${mark} ${truncate(session.title || session.id, 40)}${where}${busy}`;
  });

  return [
    '选择一个对话：',
    ...lines,
    '',
    '回复数字即可切过去（● = 当前已连通，会自动打开它的开关）。',
    '发 /off 停止回传，发 /list 重新列一次。',
  ].join('\n');
}

/** Confirmation text after a successful selection (R4). */
export function formatSelected(session, index) {
  const title = truncate(session?.title || session?.id || '（未命名）', 40);
  return `已切到 ${index}. ${title}，开关已自动打开。\n现在你发的消息会进入这个对话，它的回答也会回到这里。`;
}

export function formatOutOfRange(index, count) {
  if (count === 0) return '当前没有可选的对话。';
  return `没有第 ${index} 个对话，只有 1–${count}。发 /list 看列表。`;
}

// ------------------------------------------------------- workspaces and /new

/**
 * How many workspaces the `/new` picker offers. One WeChat screenful: past nine
 * the list stops being something a person reads and starts being something they
 * scroll, and a two-digit reply is one keystroke away from a typo.
 */
export const MAX_WORKSPACE_CHOICES = 9;

/**
 * How long a pending `/new` choice stays open.
 *
 * Memory only, on purpose: a pending choice is a half-finished sentence, and
 * after a restart the user is looking at a fresh process that knows nothing
 * about the question they were answering. Expiring beats resurrecting.
 */
export const NEW_CHOICE_TTL_MS = 2 * 60_000;

/** One path equality key. Windows paths are case-insensitive and may use either slash. */
export function workspaceKey(path) {
  return String(path ?? '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

export const NO_WORKSPACES_TEXT = '没有可用的工作区：宿主既没有注册工作区，也没有任何会话带工作区路径。'
  + '先在 DSH 里打开一个文件夹，再发 /new。';

/**
 * The `/new` first step: the numbered workspace list.
 * @param paths workspace directories, already ordered and de-duplicated.
 */
export function formatWorkspaceList(paths, { limit = MAX_WORKSPACE_CHOICES } = {}) {
  const rows = (Array.isArray(paths) ? paths : []).slice(0, limit);
  if (rows.length === 0) return NO_WORKSPACES_TEXT;
  const minutes = Math.round(NEW_CHOICE_TTL_MS / 60_000);
  return [
    '在哪个工作区新建对话？',
    ...rows.map((path, index) => `${index + 1}. ${path}`),
    '',
    `回复数字即可（${minutes} 分钟内有效，发其它消息会取消）。`,
  ].join('\n');
}

/**
 * Out-of-range is reported AND the list is re-sent, in one message.
 *
 * The pending choice deliberately stays open across this (see
 * createPendingChoice.resolve): the user mistyped a digit, and making them
 * re-issue `/new` to fix a typo is the kind of small friction that makes a
 * feature feel broken. It still cannot run forever -- the TTL was set when the
 * list was first sent and is not extended here.
 */
export function formatWorkspaceOutOfRange(index, paths) {
  const count = Array.isArray(paths) ? paths.length : 0;
  if (count === 0) return NO_WORKSPACES_TEXT;
  return `没有第 ${index} 个工作区，只有 1–${count}。\n\n${formatWorkspaceList(paths)}`;
}

/** Sent when any other message cancels a pending `/new`. */
export const NEW_CANCELLED_TEXT = '已取消新建对话。';

/** Confirmation after `/new` step 2 succeeded. */
export function formatNewSession({ sessionId, cwd, title = null }) {
  const where = cwd ? `已在 ${cwd} 新建对话` : '已新建对话';
  return [
    `${where}，并切了过去（开关已打开）。`,
    `标题：${truncate(title || '', 40) || '（新对话，还没有标题）'}`,
    `会话 ID：${sessionId}`,
    '现在你发的消息会进入这个新对话，它的回答也会回到这里。',
  ].join('\n');
}

/** `/session <id>` was not found. Shared with the copy-pasted bind path. */
export function formatSessionNotFound(sessionId) {
  return `没有找到会话 ${sessionId}。发任意消息可以看到编号列表。`;
}

/** `/session <id> open`: switch ON and the pointer moved here. */
export function formatSessionOpened(session) {
  const name = truncate(session?.title || session?.id || '（未命名）', 40);
  return `已打开 ${name} 的微信连接，并切了过去。\n现在你发的消息会进入这个对话，它的回答也会回到这里。`;
}

/** `/session <id> close`: switch OFF; the pointer moves away if it was here. */
export function formatSessionClosed(session) {
  const name = truncate(session?.title || session?.id || '（未命名）', 40);
  return `已关闭 ${name} 的微信连接。\n它的回答不再发到微信；发 /list 可以重新选。`;
}

// ------------------------------------------------------------- pending choice

/**
 * The in-memory "I asked a question, the next number answers it" slot.
 *
 * Two properties matter and both are cheap to get wrong:
 *
 *  1. **Precedence.** While this is open, a bare number belongs to IT, not to
 *     the conversation picker. The host checks `peek()` before it classifies
 *     anything, so the ordering lives in one place instead of depending on which
 *     regex happened to match first.
 *  2. **Bounded lifetime.** A pending choice that outlives the question it came
 *     from turns a later, unrelated "2" into a session creation the user never
 *     asked for. Hence a TTL, an explicit cancel, and no persistence at all:
 *     a restart starts with no pending choice.
 *
 * `now` is injectable so the TTL is testable without sleeping.
 */
export function createPendingChoice({ ttlMs = NEW_CHOICE_TTL_MS, now = () => Date.now() } = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : NEW_CHOICE_TTL_MS;
  let entry = null;

  /** Drop the entry if its deadline has passed. @returns the live entry, or null. */
  function live() {
    if (entry === null) return null;
    if (now() >= entry.expiresAtMs) {
      entry = null;
      return null;
    }
    return entry;
  }

  return Object.freeze({
    /** Open (or replace) the slot over a fresh list of options. */
    open(options, { kind = 'workspace' } = {}) {
      const rows = Array.isArray(options) ? [...options] : [];
      const createdAtMs = now();
      entry = { kind, options: rows, createdAtMs, expiresAtMs: createdAtMs + ttl };
      return { kind: entry.kind, options: [...rows], expiresAtMs: entry.expiresAtMs };
    },
    /** The live entry, or null. Reading it also applies the TTL. */
    peek() {
      const current = live();
      if (current === null) return null;
      return {
        kind: current.kind,
        options: [...current.options],
        expiresAtMs: current.expiresAtMs,
        remainingMs: Math.max(0, current.expiresAtMs - now()),
      };
    },
    /** Drop the slot. @returns whether there was one to drop. */
    cancel() {
      const had = live() !== null;
      entry = null;
      return had;
    },
    /**
     * Resolve a 1-based index against the open options.
     *
     * Clears the slot on success. On `out-of-range` it stays open so the user can
     * retype the digit, and on `no-pending` there was nothing to resolve.
     * @returns {{ok:true, kind:string, value:any}
     *          |{ok:false, code:'no-pending'|'out-of-range', count:number}}
     */
    resolve(index) {
      const current = live();
      if (current === null) return { ok: false, code: 'no-pending', count: 0 };
      const at = Number(index);
      if (!Number.isSafeInteger(at) || at < 1 || at > current.options.length) {
        return { ok: false, code: 'out-of-range', count: current.options.length };
      }
      entry = null;
      return { ok: true, kind: current.kind, value: current.options[at - 1] };
    },
  });
}

/** WeChat's per-message ceiling (reference: DEFAULT_WEIXIN_MAX_MESSAGE_CHARS). */
export const DEFAULT_MAX_MESSAGE_CHARS = 1800;

/**
 * Split an outgoing reply into platform-sized chunks.
 *
 * The platform rejects a single message longer than 1800 characters, and a
 * mirrored assistant answer easily exceeds that. Same rule as the reference
 * implementation: cut at the last newline inside the window, but only when that
 * newline is at least 60% in -- otherwise a stray early newline would produce
 * lots of tiny messages. Continuation chunks drop the leading newlines.
 *
 * @returns {string[]} one element for short text; [] for empty text
 */
export function splitForWeChat(text, limit = DEFAULT_MAX_MESSAGE_CHARS) {
  const value = typeof text === 'string' ? text : '';
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_MAX_MESSAGE_CHARS;
  if (!value) return [];
  if (value.length <= max) return [value];

  const chunks = [];
  let rest = value;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const floor = Math.floor(max * 0.6);
    const newline = window.lastIndexOf('\n');
    const cut = newline >= floor ? newline : max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
