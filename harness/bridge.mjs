/**
 * dsh-wechat-box —— Harness 会话桥接模块（独立、可测试，零新增依赖）
 * =====================================================================
 *
 * 职责：把「DSH 宿主里的某个会话」当成一个可寻址的远端对象，提供四件事：
 *   1. listSessions()                —— 枚举会话（微信侧编号列表用）
 *   2. submitUserText(id, text)      —— 把一段文字作为**用户输入**投喂给指定会话
 *   3. isSessionRunning(id)          —— 该会话当前是否有回合在跑
 *   4. dispose()                     —— 摘掉所有监听
 * 并在「一个回合成功完成」时回调 onTurnComplete({ sessionId, text, turn })。
 *
 * ---------------------------------------------------------------------
 * 出处声明（MIT）
 * ---------------------------------------------------------------------
 * 本文件**不 import 原插件包**，只用 node 内置模块 + 调用方传入的 Cordis ctx。
 * 但其行为契约与若干函数照抄/精简改写自第三方插件：
 *
 *   @xmanrui/dsh-im v4.37.0 (MIT, https://github.com/xmanrui/dsh-im)
 *   本机安装位置：<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im\
 *
 *   对照表（本文件 ← 原文件:行号）：
 *     textFromContent()          ← src/channels/shared/harness-client.mjs:354-360  textFromHarnessContent
 *     TurnTextAccumulator        ← src/channels/shared/harness-client.mjs:380-422  AssistantTextAccumulator
 *     turnReasonKind()           ← src/channels/shared/deferred-delivery.mjs:6-12   terminalOutcomeOf
 *     interrupted 段丢弃         ← src/channels/shared/deferred-delivery.mjs:56-61,72
 *     按 seq 去重的水位线        ← src/channels/shared/harness-client.mjs:663,695（`seq <= lastSeq` 跳过）
 *     surfaceOp 守卫             ← src/channels/feishu/bridge.mjs:4295（`surfaceOp === 'append'`）
 *     ctx.on('session/event')    ← plugin-src/host/session-title-prefix.mjs:99-114
 *     ctx.inject / ctx.effect    ← plugin-src/host/index.mjs:112-121 / session-title-prefix.mjs:112-114
 *     submitUserText 的 RPC 形状 ← plugin-src/host/modern-harness-api.mjs:230-235
 *
 * MIT 允许照抄；此处保留出处即是履行条款（原插件 LICENSE 见
 * node_modules\@xmanrui\dsh-im\LICENSE）。本文件与原插件没有任何运行时依赖关系。
 *
 * ---------------------------------------------------------------------
 * 宿主 API 的事实依据（在本机 DSH 4.x 的 app.asar 里逐条核对过，不是猜的）
 * ---------------------------------------------------------------------
 *   · sessionController 是一个注册名 "sessionController"、命名空间 "session" 的
 *     Cordis Service（@deepseek-ai/dsh-api-session-controller/lib/index.js
 *     `super(ctx, "sessionController", { namespace: "session" })`）。
 *     typert 网关的 `session/prompt` 最终就是 Reflect.apply 到这个对象的 prompt 上。
 *   · sessionController.prompt(request) 的 request 形状（typert 描述符原文）：
 *       { requestId: string, sessionId: string, mode: 'queue'|'steer',
 *         content: ({type:'text',text:string}
 *                  | {type:'image',mediaType,data,name?}
 *                  | {type:'file',receiptId:string})[],
 *         clientTimeZone?: string }
 *     结果 { accepted: true }。
 *     ★ 它内部做完了：resolveAgent（冷会话自动唤醒）、归档会话拒绝、requestId 幂等、
 *       附件/文件收据准入、图片模型能力校验，最后才 `agent.followup(message)`
 *       （同上 lib/index.js，prompt 方法体里 `if (request.mode === "steer") agent.steer(message);
 *         else agent.followup(message);`）。
 *   · sessionController.list(_request, signal) → { items: [...] }，
 *     item = { sessionId, updatedAt, running, blank, agentAvailable, cwd?,
 *              parentSessionId?, origin?, projections?: { values: { title?: string|null } } }
 *     （typert.host.js 的 session_list_result zod schema：title 走 projections）。
 *   · SessionHeader **没有** title 字段（只有 id/createdAt/cwd/parentSession/origin/…），
 *     所以退路里标题只能从会话自己的 `session/title` 事件读
 *     （原插件同样如此，session-title-prefix.mjs:71）。
 *   · Agent 接口确有 followup/steer/inject（dsh-agent 的 Agent 声明），
 *     但它们是**已唤醒会话**的收件箱入口，不负责唤醒冷会话、不做准入校验，
 *     所以本桥接只把 sessionController.prompt 当正路（见 submitUserText 注释）。
 */

import { randomUUID } from 'node:crypto';

/**
 * 建议插件声明的 Cordis 服务。
 * 只声明 `sessions`（核心会话表，一定在）：即便 sessionController / typertGateway
 * 缺失或晚到，插件也能装上，桥接自身用 ctx.inject 去等它们，
 * 拿不到就优雅降级（listSessions() 返回 []、submitUserText 抛 harness-bridge-unavailable），
 * 而不是让整个插件因缺服务而永不 apply。
 */
export const inject = ['sessions'];

const BRIDGE_LABEL = 'dsh-wechat-box: Harness session bridge';

function defaultLogger() {
  return {
    info: (...args) => console.info('[dsh-wechat-box]', ...args),
    warn: (...args) => console.warn('[dsh-wechat-box]', ...args),
    error: (...args) => console.error('[dsh-wechat-box]', ...args),
  };
}

/* ------------------------------------------------------------------ *
 * 文本提取 / 累计
 * ------------------------------------------------------------------ */

/**
 * 从一个 Harness 消息负载里只取可见文本块。
 * 逐行等价于 harness-client.mjs:354 `textFromHarnessContent`。
 */
export function textFromContent(content) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * 单回合助手文本累计器 —— dsh-im `AssistantTextAccumulator`（harness-client.mjs:380-422）
 * 的精简等价实现。语义逐条对应：
 *   · appendDelta(step, index, text) → 按 (step, partIndex) 累加流式增量；
 *   · setCanonical(step, text)       → 用定稿文本**整体替换**该 step（空白文本忽略）；
 *   · text                           → step 升序、part 升序，step 内 '\n' 连接，
 *                                      step 之间 '\n\n' 连接，逐段 trim 后丢掉空段。
 * 唯一新增的是 dropStep()，用于把 interrupted 的半截话整段抹掉（见其注释）。
 *
 * 注意：本类**不**在 tool/call 处清空。dsh-im 里那是另一条分支
 * （`accumulateFinalAssistantText` + finalAnswerOnly，harness-client.mjs:425-438），
 * 语义是「只要最后一个工具调用之后的文本」。本桥接按需求取「整回合按 step 合并的
 * 最终累计文本」，与 AssistantTextAccumulator 本体一致。
 */
export class TurnTextAccumulator {
  #steps = new Map();
  #legacyText = '';

  clear() {
    this.#steps.clear();
    this.#legacyText = '';
  }

  /** 追加一段流式文本增量（assistant/chunk 的 text-delta）。 */
  appendDelta(step, index, text) {
    if (typeof text !== 'string' || !text) return;
    const stepNumber = Number.isSafeInteger(step) ? step : 0;
    const partIndex = Number.isSafeInteger(index) ? index : 0;
    this.#legacyText = '';
    const parts = this.#steps.get(stepNumber) ?? new Map();
    parts.set(partIndex, (parts.get(partIndex) ?? '') + text);
    this.#steps.set(stepNumber, parts);
  }

  /** 用 canonical 定稿替换某个 step（assistant/message）。 */
  setCanonical(step, text) {
    if (typeof text !== 'string' || !text.trim()) return;
    if (!Number.isSafeInteger(step)) {
      this.#steps.clear();
      this.#legacyText = text.trim();
      return;
    }
    this.#legacyText = '';
    this.#steps.set(step, new Map([[0, text.trim()]]));
  }

  /**
   * 丢掉整个 step 已累计的文本。
   * 用于 `assistant/message` 带 `interrupted: true`：那一段是半截话，
   * 既不能进最终文本，也不该让它底下残留的流式增量冒充答案。
   */
  dropStep(step) {
    if (Number.isSafeInteger(step)) this.#steps.delete(step);
  }

  get text() {
    if (this.#steps.size === 0) return this.#legacyText;
    return [...this.#steps.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, parts]) => [...parts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, text]) => text)
        .join('\n')
        .trim())
      .filter(Boolean)
      .join('\n\n');
  }
}

/**
 * 把 turn/end 的 reason 归一成字符串标签：`'completed'` 和 `{ kind: 'completed' }`
 * 都要认。逐行照抄 deferred-delivery.mjs:6 `terminalOutcomeOf`。
 */
export function turnReasonKind(reason) {
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  return null;
}

/** 只有恰好 'completed' 才算成功。 */
export function isCompletedTurn(reason) {
  return turnReasonKind(reason) === 'completed';
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function freshTurnState(turn) {
  return { turn, text: new TurnTextAccumulator() };
}

/** SessionHeader 没有 title，活会话的标题只能从它自己的事件流里读（session-title-prefix.mjs:71）。 */
function titleFromSessionEvents(session) {
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session?.events;
  if (!Array.isArray(events)) return null;
  const latest = events.findLast((event) => event?.type === 'session/title');
  return typeof latest?.data?.title === 'string' ? latest.data.title : null;
}

function serviceFrom(context, name) {
  if (!context) return undefined;
  // Accessing an UNDECLARED service on a Cordis context THROWS
  // ("cannot get property \"X\" without inject") instead of yielding undefined.
  // That took this whole plugin down: the bridge is installed from the plugin's
  // apply(), and this read killed setup before the transport was ever started.
  // Readiness is tracked by ctx.inject elsewhere; here we only want "the value
  // if it is already there, otherwise undefined".
  let direct;
  try {
    direct = context[name];
  } catch {
    direct = undefined;
  }
  if (direct !== undefined) return direct;
  if (typeof context.get === 'function') {
    try {
      return context.get(name);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function resolvedClientTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.includes('/') ? zone : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 主体
 * ------------------------------------------------------------------ */

/**
 * 在给定 Cordis 上下文里装上桥接。
 *
 * @param {object} ctx 宿主 Cordis 上下文（必须有 `on`）。
 * @param {object} options
 * @param {(payload: { sessionId: string, text: string, turn: number|null }) => void} options.onTurnComplete
 *        回合**成功完成**（turn/end 的 reason 恰为 'completed'）时同步调用一次。
 *        `text` 可能是空串（例如整回合只有工具调用），消费方自行决定是否投递。
 * @param {object} [options.logger] 形如 console 的 logger，默认 console。
 * @returns {{
 *   listSessions: () => Promise<Array<{id: string, title: string|null, cwd: string|null, running: boolean}>>,
 *   submitUserText: (sessionId: string, text: string) => Promise<void>,
 *   isSessionRunning: (sessionId: string) => boolean,
 *   dispose: () => void
 * }}
 */
export function installHarnessBridge(ctx, options = {}) {
  if (typeof ctx?.on !== 'function') {
    throw new TypeError('installHarnessBridge requires a Cordis context with ctx.on');
  }
  const { onTurnComplete } = options;
  if (typeof onTurnComplete !== 'function') {
    throw new TypeError('installHarnessBridge requires options.onTurnComplete');
  }
  const log = options.logger ?? defaultLogger();

  let closed = false;

  /** 当前打开的回合：sessionId -> { turn, text, sawInterrupted } */
  const openTurns = new Map();
  /** 由事件流维护的 running 视图：sessionId -> boolean */
  const runningById = new Map();
  /** 每会话已消费的最大 seq，用来挡住重放/重复的事件（harness-client.mjs:663,695 同款）。 */
  const lastSeqBySession = new Map();

  /** 延迟就绪的服务：ctx.inject 回调到达前一律 undefined。 */
  const services = {
    sessionController: serviceFrom(ctx, 'sessionController'),
    typertGateway: serviceFrom(ctx, 'typertGateway'),
    sessions: serviceFrom(ctx, 'sessions'),
    agents: serviceFrom(ctx, 'agents'),
  };

  const disposers = [];
  // AbortControllers for prompts that are in flight, so dispose() can cancel them.
  const pendingAborts = new Set();

  /* ---------------- 事件监听 ---------------- */

  const emitTurnComplete = (payload) => {
    try {
      onTurnComplete(payload);
    } catch (error) {
      // 消费方抛错绝不能掀翻宿主的 emit 栈。
      log.error?.('onTurnComplete threw; the turn was still consumed:', error);
    }
  };

  const onSessionEvent = (session, event) => {
    if (closed) return;
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (!event || typeof event !== 'object') return;

    // 去重水位线：重放 / 重复投递的同一 seq 只处理一次。
    if (Number.isFinite(event.seq)) {
      const previous = lastSeqBySession.get(sessionId);
      if (previous !== undefined && event.seq <= previous) return;
      lastSeqBySession.set(sessionId, event.seq);
    }

    switch (event.type) {
      case 'turn/start': {
        const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : null;
        openTurns.set(sessionId, freshTurnState(turn));
        runningById.set(sessionId, true);
        return;
      }

      case 'user/message': {
        // 正常路径上 turn/start 已经开好回合；这里只兜「turn/start 丢了」。
        const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : null;
        const state = openTurns.get(sessionId);
        if (!state || (turn !== null && state.turn !== null && state.turn !== turn)) {
          openTurns.set(sessionId, freshTurnState(turn));
        }
        return;
      }

      case 'step/start':
      case 'step/end': {
        // 本桥接不按 step 单独出事件；累计器自己按 step 归并，这两帧无需处理。
        return;
      }

      case 'assistant/chunk': {
        const state = openTurns.get(sessionId);
        if (!state) return;
        const chunk = event.data?.chunk;
        if (chunk?.type !== 'text-delta') return;
        state.text.appendDelta(event.data?.step, chunk.index, chunk.text);
        return;
      }

      case 'assistant/message': {
        const state = openTurns.get(sessionId);
        if (!state) return;
        // 显式替换（消息被编辑 / 压缩重写，surfaceOp = {op:'replace',...}）：
        // 本桥接不做区间替换，直接跳过这帧，免得旧文本被重复计入。
        // 追加帧的 surfaceOp 是字符串 'append'（dsh-agent-loop 的 append 调用就是这么传的），
        // 老事件可能整个字段都没有 —— 两种情况都按追加处理。
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
        const data = event.data ?? {};
        const step = Number.isSafeInteger(data.step) ? data.step : null;
        if (data.interrupted === true) {
          // 半截话整段丢掉，不计入最终文本（deferred-delivery.mjs:59）。
          // 注意：这里**不**因此放弃整个回合 —— 只要 turn/end 的 reason 是
          // 'completed'，本回合仍然要回调，只是少了这一段。
          state.text.dropStep(step);
          return;
        }
        state.text.setCanonical(step, textFromContent(data.message?.content));
        return;
      }

      case 'turn/end': {
        const state = openTurns.get(sessionId);
        const rawTurn = event.data?.turn;
        const turn = Number.isSafeInteger(rawTurn) ? rawTurn : (state?.turn ?? null);
        const text = state ? state.text.text.trim() : '';
        // 先把状态收干净再回调：回调里再进事件也读不到脏状态。
        openTurns.delete(sessionId);
        runningById.set(sessionId, false);
        if (!isCompletedTurn(event.data?.reason)) return;
        emitTurnComplete({ sessionId, text, turn });
        return;
      }

      default:
        return;
    }
  };

  // { global: true } 是必须的：没有它，插件 fiber 只看得到自己作用域内的事件，
  // 永远收不到宿主全局的 session 流（session-title-prefix.mjs:99-104）。
  disposers.push(ctx.on('session/event', onSessionEvent, { global: true }));

  /* ---------------- 服务就绪（优雅降级） ---------------- */

  const adopt = (context, ...names) => {
    for (const name of names) {
      const service = serviceFrom(context, name);
      if (service !== undefined) services[name] = service;
    }
  };

  if (typeof ctx.inject === 'function') {
    const register = (dependencies, names) => {
      try {
        const disposer = ctx.inject(dependencies, (readyCtx) => {
          if (closed) return;
          adopt(readyCtx, ...names);
        });
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        log.warn?.(
          `unable to await ${dependencies.join(', ')}; the bridge degrades gracefully:`,
          error?.message ?? error,
        );
      }
    };
    register(['sessionController'], ['sessionController']);
    register(['typertGateway'], ['typertGateway']);
    register(['sessions'], ['sessions']);
    register(['agents'], ['agents']);
  }

  /* ---------------- 对外接口 ---------------- */

  const bridgeUnavailable = (what) => {
    const error = new Error(
      `${what}: 宿主没有可用的 sessionController / typertGateway（服务未就绪或未挂载）`,
    );
    error.code = 'harness-bridge-unavailable';
    return error;
  };

  const listSessions = async () => {
    if (closed) return [];

    // 正路：宿主会话列表服务。一次拿到 id / 标题 / 工作区 / 是否在跑。
    const controller = services.sessionController;
    if (controller && typeof controller.list === 'function') {
      try {
        const value = await controller.list({});
        const items = Array.isArray(value?.items) ? value.items : [];
        return items
          .filter((item) => typeof item?.sessionId === 'string' && item.sessionId)
          .map((item) => {
            const title = item.projections?.values?.title;
            const running = item.running === true;
            runningById.set(item.sessionId, running);
            return {
              id: item.sessionId,
              title: typeof title === 'string' ? title : null,
              cwd: typeof item.cwd === 'string' ? item.cwd : null,
              running,
            };
          });
      } catch (error) {
        log.warn?.('sessionController.list failed; falling back to ctx.sessions:', error?.message ?? error);
      }
    }

    // 退路：进程内会话表。标题要用 session/title 事件补，running 靠事件视图 + agents。
    const sessions = services.sessions;
    if (sessions && typeof sessions.list === 'function') {
      try {
        const agents = services.agents;
        return sessions.list()
          .map((session) => {
            const id = typeof session?.id === 'string' ? session.id : null;
            let running = runningById.get(id) === true;
            if (!running && agents && typeof agents.get === 'function') {
              running = agents.get(id)?.status === 'running';
            }
            return {
              id,
              title: titleFromSessionEvents(session),
              cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : null,
              running,
            };
          })
          .filter((row) => typeof row.id === 'string' && row.id);
      } catch (error) {
        log.warn?.('ctx.sessions.list failed:', error?.message ?? error);
      }
    }

    return [];
  };

  const submitUserText = async (sessionId, text) => {
    if (closed) throw bridgeUnavailable('submitUserText（桥接已 dispose）');
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('submitUserText requires a non-empty sessionId');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new TypeError('submitUserText requires non-empty text');
    }
    const zone = resolvedClientTimeZone();
    const request = {
      requestId: randomUUID(),
      sessionId,
      // 'queue'：把这段文字排进该会话的回合队列（忙则排队，闲则立刻起一回合）。
      // 'steer' 是「打断当前回合、插一句话」，不是「投喂一条用户输入」的语义。
      mode: 'queue',
      content: [{ type: 'text', text }],
      ...(zone === undefined ? {} : { clientTimeZone: zone }),
    };

    // 选路 1（推荐）：直接调宿主服务对象。
    // 理由见文件头 —— 它是 `session/prompt` 这条线最终的落点，少了「线参数名 +
    // 描述符校验」这一层，冷会话唤醒 / 归档闸门 / requestId 幂等 / 附件准入全都自带。
    const controller = services.sessionController;
    if (controller && typeof controller.prompt === 'function') {
      // The host method signature is (request, signal) -- see the sessionController.list
      // note in this file's header. Calling it with the request alone makes the host
      // do `signal.throwIfAborted()` on undefined and the whole submit dies with
      //   Cannot read properties of undefined (reading 'throwIfAborted')
      // which is exactly the failure that made every forwarded WeChat message vanish
      // with no trace on either side. `list` tolerates a missing signal; `prompt` does not.
      const abort = new AbortController();
      pendingAborts.add(abort);
      try {
        await controller.prompt(request, abort.signal);
      } finally {
        pendingAborts.delete(abort);
      }
      return;
    }

    // 选路 2：经 typert 网关，与 dsh-im 的 modern-harness-api.mjs:230-235 完全同形
    // （args 的键名 `request` 来自宿主方法的形参名，见 typert 描述符）。
    const gateway = services.typertGateway;
    if (gateway && typeof gateway.invoke === 'function') {
      await gateway.invoke({
        namespace: 'session',
        method: 'prompt',
        args: { request },
      });
      return;
    }

    throw bridgeUnavailable('submitUserText');
  };

  const isSessionRunning = (sessionId) => {
    if (closed || typeof sessionId !== 'string' || !sessionId) return false;
    const agents = services.agents;
    if (agents && typeof agents.get === 'function') {
      try {
        // harness-session-coordinator.mjs:24 就是这个判据：agent?.status !== 'running'。
        const agent = agents.get(sessionId);
        if (agent) return agent.status === 'running';
      } catch {
        /* 服务在但不认这个 id：退回事件视图 */
      }
    }
    if (openTurns.has(sessionId)) return true;
    return runningById.get(sessionId) === true;
  };

  const dispose = () => {
    if (closed) return;
    closed = true;
    // Cancel any in-flight prompt: the host's prompt takes an AbortSignal, and
    // aborting it on unload is what the signal is for.
    for (const abort of pendingAborts) {
      try { abort.abort(); } catch { /* ignore */ }
    }
    pendingAborts.clear();
    openTurns.clear();
    runningById.clear();
    lastSeqBySession.clear();
    for (const disposeOne of disposers.splice(0).reverse()) {
      try {
        disposeOne?.();
      } catch (error) {
        log.warn?.('a bridge disposer threw:', error?.message ?? error);
      }
    }
  };

  if (typeof ctx.effect === 'function') {
    try {
      // 与 session-title-prefix.mjs:112-114 同款：effect 返回 dispose 本身作为清理函数。
      ctx.effect(() => dispose, BRIDGE_LABEL);
    } catch (error) {
      log.warn?.('ctx.effect registration failed; call dispose() yourself:', error?.message ?? error);
    }
  }

  /**
   * What the bridge actually managed to acquire.
   *
   * The failure this exists for: `submitUserText` needs `sessionController.prompt`
   * or `typertGateway.invoke`, and when neither is present it throws -- but
   * listing sessions still works (it has a fallback), so the bridge LOOKS healthy
   * while every forwarded message is silently dropped. Reporting the acquired
   * services makes "the message never became a turn" diagnosable instead of
   * guesswork. Exposed through the host's state route.
   */
  const diagnose = () => ({
    sessionController: services.sessionController
      ? (typeof services.sessionController.prompt === 'function' ? 'prompt' : 'no-prompt')
      : 'absent',
    typertGateway: services.typertGateway
      ? (typeof services.typertGateway.invoke === 'function' ? 'invoke' : 'no-invoke')
      : 'absent',
    sessions: services.sessions ? 'present' : 'absent',
    agents: services.agents ? 'present' : 'absent',
    canSubmit: Boolean(
      (services.sessionController && typeof services.sessionController.prompt === 'function')
      || (services.typertGateway && typeof services.typertGateway.invoke === 'function'),
    ),
  });

  return Object.freeze({
    listSessions,
    submitUserText,
    isSessionRunning,
    diagnose,
    dispose,
  });
}

export default installHarnessBridge;
