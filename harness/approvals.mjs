/**
 * dsh-wechat-box -- approvals over WeChat (DESIGN.md R7 / A11).
 *
 * Verified API facts (dsh-im plugin-src/host/modern-harness-api.mjs):
 *   Waterfall hook (:277-281):
 *     ctx.on('approval/request', (request, next) => ..., { global: true, prepend: true })
 *   `request` carries { agent, signal, toolName, callId?, reason? } (:648-692).
 *   The handler resolves with 'allowed-once' or 'rejected' (:725, :826) -- the
 *   same two values `next()` (the Web/CLI answerer) produces.
 *   Anything else ('unavailable', 'cancelled') means "nobody answered".
 *
 * Same shape as the question bridge: race the host's own surfaces against the
 * WeChat reply, first answer wins, and drop our pending if the host won so a
 * late WeChat message cannot answer something the model has moved past.
 */
const ALLOW = new Set([
  '批准', '同意', '允许', '可以', '好的', '好', '行', '是', '确认',
  'yes', 'y', 'ok', 'allow', 'approve', '1',
]);
const DENY = new Set([
  '拒绝', '不同意', '不允许', '不行', '不要', '否', '不',
  'no', 'n', 'deny', 'reject', '2',
]);

/** Map one free-text WeChat reply to an approval outcome, or null if unclear. */
export function parseApprovalReply(text) {
  const value = typeof text === 'string' ? text.trim().toLowerCase() : '';
  if (!value) return null;
  if (ALLOW.has(value)) return 'allowed-once';
  if (DENY.has(value)) return 'rejected';
  return null;
}

/** The prompt pushed to WeChat. */
export function approvalText({ toolName, reason } = {}) {
  const lines = ['DeepSeek Harness 需要你的审批：'];
  const tool = typeof toolName === 'string' && toolName.trim() ? toolName.trim() : '(未知操作)';
  lines.push('', `要执行：${tool}`);
  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  if (why) lines.push('', why);
  lines.push('', '回复「批准」执行一次，或回复「拒绝」。');
  return lines.join('\n');
}

export function createApprovalBridge({
  send,                       // (text) => Promise<unknown>
  log = console,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('createApprovalBridge requires send(text)');

  let current = null;

  function settle(outcome, value) {
    const entry = current;
    if (!entry) return false;
    current = null;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    if (outcome === 'answered') entry.resolve(value);
    else entry.reject(value);
    return true;
  }

  const unavailable = (message) => {
    const error = new Error(message);
    error.code = 'APPROVAL_UNAVAILABLE';
    return error;
  };

  return Object.freeze({
    hasPending: () => current !== null,
    pendingCount: () => (current ? 1 : 0),

    /** The `approval/request` waterfall handler. */
    handle(request, next) {
      if (typeof next !== 'function') throw new TypeError('approval waterfall handler requires next');
      if (current) return next();                  // never two approvals at once

      const signal = request?.signal;
      if (signal?.aborted) return Promise.reject(unavailable('the approval was aborted before it was asked'));

      let resolveFn;
      let rejectFn;
      const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });

      const entry = {
        request, signal, resolve: resolveFn, reject: rejectFn, timer: null,
        onAbort: () => settle('cancelled', unavailable('the approval was aborted before the user answered')),
      };
      current = entry;
      signal?.addEventListener?.('abort', entry.onAbort, { once: true });
      // NOT unref'd: an unref'd timer can fail to fire when nothing else holds
      // the event loop, leaving the approval pending forever.
      entry.timer = setTimeout(() => {
        settle('cancelled', unavailable('the approval timed out waiting for a WeChat answer'));
      }, timeoutMs);

      void Promise.resolve()
        .then(() => send(approvalText(request)))
        .catch((error) => log.warn?.(`[wechat-box] could not push the approval: ${error?.message ?? error}`));

      const native = Promise.resolve()
        .then(() => next())
        .then(
          (outcome) => {
            // The native answerer said nobody is there; keep waiting for WeChat.
            if (outcome !== 'allowed-once' && outcome !== 'rejected') return new Promise(() => {});
            return outcome;
          },
          (error) => {
            log.warn?.(`[wechat-box] the host approval answerer failed: ${error?.message ?? error}`);
            return new Promise(() => {});
          },
        );

      return Promise.race([native, promise]).finally(() => {
        if (current === entry) {
          current = null;
          if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
          signal?.removeEventListener?.('abort', entry.onAbort);
        }
      });
    },

    /**
     * Feed one inbound WeChat text to the open approval.
     * @returns {Promise<boolean>} true when the reply was consumed
     */
    async handleReply(text) {
      const entry = current;
      if (!entry) return false;
      const outcome = parseApprovalReply(text);
      if (!outcome) {
        // Unrecognised reply: re-ask rather than guessing "yes" or silently
        // consuming it -- an approval is not a place to be clever.
        await send(`${approvalText(entry.request)}\n\n（没看懂「${String(text).slice(0, 40)}」，请回复「批准」或「拒绝」。）`);
        return true;
      }
      settle('answered', outcome);
      return true;
    },

    dismissAll(reason = 'the approval bridge was closed') {
      if (!current) return false;
      return settle('cancelled', unavailable(reason));
    },
  });
}
