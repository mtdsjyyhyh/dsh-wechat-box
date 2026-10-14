/**
 * dsh-wechat-box -- interactive questions over WeChat (DESIGN.md R7).
 *
 * When the host asks the user something (`ask_user_question`), the question is
 * pushed to WeChat and the user's next message answers it. Verified API facts:
 *
 *   Waterfall hook (dsh-im plugin-src/host/modern-harness-api.mjs:282-286):
 *     ctx.on('user-questions/request', (request, next) => ..., { global: true, prepend: true })
 *   `request` carries { agent, signal, questions }.
 *   `next()` resolves with the answer the host's own surfaces (Web/CLI) produce.
 *   The answerer must resolve with { answers: [{ id, selected: [...], custom? }] }
 *     (shape confirmed at modern-harness-api.mjs:846-853).
 *   `selected` holds option LABELS, not indices
 *     (text-harness-bridge.mjs:1415 -> { id: current.id, selected: [option.label] }).
 *
 * The rendering and text-to-answer parsing below are ported from
 * @xmanrui/dsh-im v4.37.0 (MIT) `src/channels/shared/harness-question.mjs`
 * so the WeChat experience matches what the user already knows. The i18n
 * indirection is dropped: this plugin ships Simplified Chinese only.
 */

/** The question shape the host emits. Rejects anything we cannot render. */
export function validHarnessQuestion(question) {
  return Boolean(
    question
    && typeof question.id === 'string'
    && typeof question.question === 'string'
    && (question.header === undefined || typeof question.header === 'string')
    && (question.detail === undefined || typeof question.detail === 'string')
    && (question.multiSelect === undefined || typeof question.multiSelect === 'boolean')
    && (question.options === undefined || (Array.isArray(question.options)
      && question.options.every((option) => (
        option && typeof option.label === 'string'
        && (option.description === undefined || typeof option.description === 'string')
      )))),
  );
}

const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Render one question as the WeChat text the user replies to. */
export function questionText(question, index = 0, total = 1) {
  const lines = [];
  const progress = total > 1 ? `（${index + 1}/${total}）` : '';
  lines.push(`DeepSeek Harness 需要你补充信息${progress}：`);
  const header = trimmed(question?.header);
  if (header) lines.push('', header);
  lines.push('', trimmed(question?.question) ?? '请输入你的回答。');
  const detail = trimmed(question?.detail);
  if (detail) lines.push('', detail);

  const options = Array.isArray(question?.options) ? question.options : [];
  if (options.length > 0) {
    lines.push('');
    options.forEach((option, optionIndex) => {
      const label = typeof option?.label === 'string' ? option.label : '';
      const description = trimmed(option?.description);
      lines.push(`${optionIndex + 1}. ${label}${description ? ` — ${description}` : ''}`);
    });
    lines.push('', question.multiSelect === true
      ? '请回复选项序号或文字；多选用逗号分隔，也可补充其他内容。'
      : '请回复一个选项序号或文字，也可直接输入其他答案。');
  } else {
    lines.push('', '请直接回复你的答案。');
  }
  return lines.join('\n');
}

/** Whole batch of questions in one message, so the user sees the full context. */
export function questionsText(questions) {
  const total = questions.length;
  return questions.map((question, index) => questionText(question, index, total)).join('\n\n———\n\n');
}

function optionLabel(token, options) {
  const normalized = token.trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const option = options[Number(normalized) - 1];
    return typeof option?.label === 'string' ? option.label : null;
  }
  const exact = options.find((option) => option?.label === normalized);
  return typeof exact?.label === 'string' ? exact.label : null;
}

/**
 * Turn one free-text reply into the answer object the host expects.
 * A number picks the option at that position; exact label text also works;
 * anything else becomes a custom answer.
 */
export function answerForQuestion(question, text) {
  const options = Array.isArray(question.options) ? question.options : [];
  const value = typeof text === 'string' ? text : '';
  // Blank input is not an answer. Returning a whitespace `custom` here would
  // make the caller treat an accidental empty message as the user's choice.
  if (!value.trim()) return { id: question.id, selected: [] };
  if (options.length === 0) {
    return { id: question.id, selected: [], custom: value };
  }

  const wholeLabel = optionLabel(value, options);
  if (question.multiSelect !== true) {
    return wholeLabel
      ? { id: question.id, selected: [wholeLabel] }
      : { id: question.id, selected: [], custom: value };
  }
  if (wholeLabel) return { id: question.id, selected: [wholeLabel] };

  const selected = [];
  const custom = [];
  for (const token of value.split(/[,，、;；\n]+/)) {
    const item = token.trim();
    if (!item) continue;
    const label = optionLabel(item, options);
    if (label) {
      if (!selected.includes(label)) selected.push(label);
    } else {
      custom.push(item);
    }
  }
  return {
    id: question.id,
    selected,
    ...(custom.length > 0 ? { custom: custom.join('、') } : {}),
  };
}

/** True when the question has options and the user asked to see them again. */
export function isListRequest(text) {
  const value = typeof text === 'string' ? text.trim().toLowerCase() : '';
  return value === '/list' || value === '/?' || value === '?' || value === '选项';
}

/**
 * The pending-question table and the waterfall handler.
 *
 * One ask may carry several questions; they are answered in order, one WeChat
 * message each. Only ONE ask is tracked at a time: a second one while the first
 * is open is handed straight back to the host (`next()`), because interleaving
 * two question sets over a single chat would misroute the replies.
 *
 * `shouldPush(request)` is the valve. R3/A5 draw the line at the conversation's
 * switch: a conversation whose switch is OFF does not talk to WeChat, and that
 * covers a question's text and options exactly as it covers a finished turn.
 * Returning false hands the ask straight to the host, so the Web/CLI surfaces
 * answer it and WeChat stays silent. Absent valve = always push, which keeps
 * the bridge usable on its own (the host shell supplies the real one).
 */
export function createQuestionBridge({
  send,                       // (text) => Promise<unknown>, the outbound channel
  shouldPush = () => true,    // (request) => boolean|Promise<boolean>, the R3/A5 valve
  log = console,
  timeoutMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (typeof send !== 'function') throw new TypeError('createQuestionBridge requires send(text)');

  let current = null;   // { questions, index, answers, resolve, reject, timer, settle }

  function clearTimer(entry) {
    if (entry?.timer) { clearTimeout(entry.timer); entry.timer = null; }
  }

  function settleCurrent(outcome, value) {
    const entry = current;
    if (!entry) return false;
    current = null;
    clearTimer(entry);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    if (outcome === 'answered') entry.resolve(value);
    else entry.reject(value);
    return true;
  }

  const abortError = (message) => {
    const error = new Error(message);
    error.code = 'ASK_ABORTED';
    return error;
  };

  return Object.freeze({
    hasPending: () => current !== null,
    pendingCount: () => (current ? 1 : 0),

    /** The `user-questions/request` waterfall handler. */
    async handle(request, next) {
      if (typeof next !== 'function') throw new TypeError('question waterfall handler requires next');
      if (current) return next();                     // never interleave two asks

      const questions = (Array.isArray(request?.questions) ? request.questions : [])
        .filter(validHarnessQuestion);
      if (questions.length === 0) return next();

      // The valve is checked BEFORE anything is tracked or sent. A question for
      // a conversation whose switch is OFF is not ours to answer: hand it to the
      // host untouched. This must not create a pending either -- a pending with
      // nothing pushed to WeChat would swallow the user's next real message as
      // an answer to a question they never saw.
      let wanted = false;
      try {
        wanted = (await shouldPush(request, questions)) !== false;
      } catch (error) {
        // A valve that throws must not decide in favour of sending: staying
        // silent is the safe failure, and the host still has its own surfaces.
        log.warn?.(`[wechat-box] the question gate failed, leaving this ask to the host: ${error?.message ?? error}`);
        wanted = false;
      }
      if (!wanted) return next();

      const signal = request?.signal;
      if (signal?.aborted) {
        return Promise.reject(abortError('the question was aborted before it was asked'));
      }

      let resolveFn;
      let rejectFn;
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });

      const entry = {
        questions, index: 0, answers: [], signal,
        resolve: resolveFn, reject: rejectFn, timer: null,
        onAbort: () => settleCurrent('cancelled', abortError('the question was aborted before the user answered')),
      };
      current = entry;
      signal?.addEventListener?.('abort', entry.onAbort, { once: true });
      entry.timer = setTimeout(() => {
        settleCurrent('cancelled', abortError('the question timed out waiting for a WeChat answer'));
      }, timeoutMs);
      // Deliberately NOT unref'd: an unref'd timer can fail to fire when nothing
      // else holds the event loop, which would leave a question pending forever.

      // Push the whole batch so the user has the full picture, then race the
      // host's own answerers (Web/CLI) against the WeChat reply: first wins.
      void Promise.resolve()
        .then(() => send(questionsText(questions)))
        .catch((error) => log.warn?.(`[wechat-box] could not push the question: ${error?.message ?? error}`));

      const native = Promise.resolve()
        .then(() => next())
        .catch((error) => {
          // A pure-IM session has no client attached, so the host rejects with
          // NO_PROVIDER; that is an expected state, not a failure. Stay open.
          if (error?.code !== 'NO_PROVIDER' && error?.code !== 'ASK_ABORTED') {
            log.warn?.(`[wechat-box] the host question answerer failed: ${error?.message ?? error}`);
          }
          return new Promise(() => {});
        });

      return Promise.race([native, promise]).finally(() => {
        // Losing-side cleanup: a host answer already settled this request, so
        // drop ours -- otherwise the next WeChat message would answer a question
        // the model has already moved past.
        if (current === entry) {
          current = null;
          clearTimer(entry);
          signal?.removeEventListener?.('abort', entry.onAbort);
        }
      });
    },

    /**
     * Feed one inbound WeChat text to the open question.
     * @returns {Promise<boolean>} true when the reply was consumed as an answer
     */
    async handleReply(text) {
      const entry = current;
      if (!entry) return false;

      const question = entry.questions[entry.index];
      if (isListRequest(text)) {
        await send(questionText(question, entry.index, entry.questions.length));
        return true;
      }

      const answer = answerForQuestion(question, typeof text === 'string' ? text : '');
      // Nothing recognised and nothing typed: re-ask instead of consuming it.
      if (answer.selected.length === 0 && !answer.custom) {
        await send(questionText(question, entry.index, entry.questions.length));
        return true;
      }

      entry.answers.push(answer);
      entry.index += 1;

      if (entry.index < entry.questions.length) {
        // More to go: ask the next one and keep waiting.
        await send(questionText(entry.questions[entry.index], entry.index, entry.questions.length));
        return true;
      }

      settleCurrent('answered', { answers: entry.answers });
      return true;
    },

    dismissAll(reason = 'the question bridge was closed') {
      if (!current) return false;
      return settleCurrent('cancelled', abortError(reason));
    },

    /** Test seam: when the current ask started. */
    startedAt: () => (current ? now() : null),
  });
}
