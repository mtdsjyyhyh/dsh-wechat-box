/**
 * login.mjs — 微信 iLink 扫码登录（拉二维码 + 轮询扫码状态），零第三方依赖
 *
 * ---------------------------------------------------------------------------
 * 出处声明 / PROVENANCE
 * ---------------------------------------------------------------------------
 * 本文件是对第三方插件 `@xmanrui/dsh-im`（MIT License）微信渠道扫码登录实现的
 * **逐行对照移植**（行号可对照）：
 *   - src/channels/weixin/weixin-api.mjs
 *       beginLogin            L637-655
 *       pollLogin             L657-671
 *       validateLoginResponse L500-505
 *       LOGIN_STATUSES        L29-38
 *       requestJson           L436-498      （超时 / 错误归一化 / abort 语义）
 *       commonHeaders         L289-294
 *       authenticatedHeaders  L296-305      （鉴权头构造）
 *       normalizeWeixinApiBaseUrl L255-272
 *       normalizeWeixinQrUrl  L274-287
 *       rejectedProviderResponse  L101-109
 *       abortError            L431-434
 *   - src/channels/weixin/weixin-controller.mjs
 *       #runProvisioning 状态处理 L441-506
 *       apiBaseFromServer     L34-38
 *       QR_TTL_MS             L25     （5 分钟）
 *       pollIntervalMs        L47     （1000ms）
 * 上游版权归 @xmanrui/dsh-im 作者所有，MIT 许可。本文件为自包含重写：不 import 原包、
 * 不依赖任何第三方 npm 包，只用 Node 内置模块；仅从同目录的 `./weixin.mjs` 复用错误类型
 * `WeixinTransportError`，好让 `.code` 语义、`instanceof` 判定与既有传输层完全一致。
 *
 * ---------------------------------------------------------------------------
 * 协议细节（全部照抄参考实现；这里是唯一的「事实表」，改代码前先读）
 * ---------------------------------------------------------------------------
 *   B1. 拉二维码
 *       POST {base}ilink/bot/get_bot_qrcode?bot_type=<botType>        (weixin-api.mjs:639-642)
 *         请求头：iLink-App-Id: bot
 *                 iLink-App-ClientVersion: 132102
 *                 content-type: application/json
 *                 AuthorizationType: ilink_bot_token      ← 注意不是 Authorization-Type
 *                 X-WECHAT-UIN: base64(随机 uint32 的十进制字符串)
 *                 **没有** Authorization 头（此时还没有凭据；reference 走 authenticated
 *                 分支但 token 为空，见 weixin-api.mjs:466 + L303）
 *         请求体：{ local_token_list: [<本机已有的 token>...] }
 *                 —— 去重、trim、最多保留最后 10 个（weixin-api.mjs:638），
 *                    平台用它判断这个微信号是不是已经在本机登录过；
 *                    不传/传空就是空数组，行为等价于「全新登录」。
 *         超时  ：10s（weixin-api.mjs:644）
 *         响应  ：{ qrcode, qrcode_img_content, ... }
 *                 qrcode             = 轮询令牌（非空字符串，否则 invalid-qr）
 *                 qrcode_img_content = 二维码地址，必须 https + *.weixin.qq.com / *.wechat.com
 *                                      （normalizeWeixinQrUrl，L274-287）
 *                 errcode/ret ≠ 0    = 平台拒绝（qr-request-rejected + providerCode，L648）
 *   B2. 轮询扫码状态
 *       GET {base}ilink/bot/get_qrcode_status?qrcode=<token>[&verify_code=<code>]
 *                                                                 (weixin-api.mjs:657-671)
 *         请求头：**只有** iLink-App-Id + iLink-App-ClientVersion
 *                 （authenticated:false → commonHeaders，L289-294：没有 content-type、
 *                  没有 AuthorizationType、没有 X-WECHAT-UIN、没有 Authorization。
 *                  这是参考实现的**故意**选择，别"顺手补齐"成鉴权头。）
 *         超时  ：35s（L22 的 DEFAULT_LONG_POLL_TIMEOUT_MS，L666）—— 服务端会把请求 hold 住，
 *                 超时是正常窗口，不是故障；但本模块仍按错误上抛，由调用方决定是否重试。
 *         响应  ：{ status, ... }；status 必须命中 B3 的 8 个值之一，
 *                 否则 invalid-login-status（L500-505）
 *   B3. 状态语义（weixin-controller.mjs:448-499）
 *       wait                 尚未扫码 → 继续轮询
 *       scaned               已扫码、等用户在手机上点确认 → 继续轮询
 *       confirmed            授权成功 → 响应带凭据：
 *                              bot_token      → credentials.token
 *                              ilink_bot_id   → credentials.accountId
 *                              ilink_user_id  → credentials.ownerUserId
 *                              baseurl        → credentials.baseUrl（后续长轮询/发消息用）
 *                            **任一为空 → incomplete-login**（L481-486）
 *       expired              二维码过期 → 必须重新 beginLogin（L460-463）
 *       scaned_but_redirect  已扫，但要在另一个接入点完成 → 响应带 redirect_host，
 *                            换 baseUrl 后继续轮询（L464-466，apiBaseFromServer L34-38：
 *                            可以不带 scheme，会自动补 https://）
 *       need_verifycode      要手机上显示的 4~8 位配对码 → 带 verifyCode 重新轮询（L453-455）
 *       verify_code_blocked  配对码多次错误 → 终止，重新生成二维码（L456-459）
 *       binded_redirect      该微信号已绑定过 → 终止；本机有可用凭据就直接复用，
 *                            没有就报「已绑定但无凭据」（L467-479）
 *   B4. 轮询节奏：控制器每 1s 轮一次（pollIntervalMs，L47），二维码 5 分钟作废（QR_TTL_MS，L25）。
 *       本模块**不实现循环**（导出契约只要求 beginLogin/pollLogin 两个原语），
 *       节奏常量 POLL_INTERVAL_MS / QR_TTL_MS 已导出，由调用方自己写循环。
 *
 * ---------------------------------------------------------------------------
 * 与参考实现的有意偏离（都写明了理由）
 * ---------------------------------------------------------------------------
 *   D1. beginLogin 用 **POST + body**（照抄 weixin-api.mjs:639-645）。任务书里把这一步写成
 *       GET，与参考实现代码不一致 —— 以参考实现为准。若平台只认 GET，改两处即可：
 *       常量 QRCODE_REQUEST_METHOD 改成 'GET'，并删掉 beginLogin 里的 body 字段
 *       （GET 不该带请求体；local_token_list 是 POST body 里的字段，见 weixin-api.mjs:643）。
 *   D2. 请求超时可由 createWeixinLogin(options) 调整，并**硬性封顶** MAX_TIMEOUT_MS；
 *       参考实现把 10s / 35s 写死。封顶是为了满足「超时要有上限」。
 *   D3. pollLogin 缺 qrcode 参数时抛 invalid-qr（参考实现抛裸 TypeError('qrcode is required')），
 *       以满足「错误一律是带 code 的 Error」。
 *   D4. 返回值 = 参考实现的原始响应 + 两个派生字段：
 *         confirmed            → credentials { token, accountId, ownerUserId, baseUrl }
 *         scaned_but_redirect  → baseUrl（归一化后的接入点，直接喂给下一次 pollLogin）
 *       （参考实现把这两个字段的换算放在 controller 里，本模块把它前移到协议层。）
 *   D5. 0 / 负数 / NaN / Infinity 的超时参数一律回落默认值（参考实现内部用 `timeoutMs > 0`
 *       判断，0 表示"不超时"。这里**不允许**把超时关掉：要提前结束请用 signal。）
 *
 * ---------------------------------------------------------------------------
 * 接口契约
 * ---------------------------------------------------------------------------
 *   createWeixinLogin({ fetchImpl = fetch, beginTimeoutMs?, pollTimeoutMs? }) -> login
 *     login.beginLogin({ baseUrl?, botType?, localTokens?, signal? })
 *       -> { qrcode, qrcodeUrl, baseUrl }
 *     login.pollLogin({ qrcode, baseUrl?, verifyCode?, signal? })
 *       -> { ...原始响应, status, credentials?, baseUrl? }        // 见 D4
 *     login.LOGIN_STATUSES        // Set，8 个状态
 *     login.DEFAULT_QR_BASE_URL   // 'https://ilinkai.weixin.qq.com/'
 *
 *   错误：一律是 WeixinTransportError（来自 ./weixin.mjs），带 `.code`：
 *     invalid-qr | invalid-login-status | incomplete-login | http-error | timeout
 *     | qr-request-rejected（B1 的平台拒绝，额外带 providerCode）
 *     | untrusted-qr | invalid-base-url | untrusted-base-url | untrusted-endpoint
 *     | invalid-response | network-error
 *   被 signal 取消时抛 AbortError（name === 'AbortError'），**不是** timeout。
 *   注意两者的形状差别（实测 Node 24）：取消是 DOMException，只有**数字**遗留码
 *   `code: 20`（ABORT_ERR）；业务错误才有字符串 `.code`。所以判错请先看
 *   `error.name === 'AbortError'` 或 `typeof error.code === 'string'`。
 *
 * ---------------------------------------------------------------------------
 * 安全红线
 * ---------------------------------------------------------------------------
 *   S1. **任何路径都不会把 token / bot_token 写进错误消息、日志或 stdout/stderr。**
 *       本模块没有 logger 参数，运行期不打印任何东西；错误消息里只出现**字段名**，
 *       不出现字段值（唯一例外是扫码地址的主机名，用于定位不受信任的接入点）。
 *   S2. 扫码地址与接入点地址都做 https + 微信域名的白名单校验（B1/B2/B3），
 *       服务端返回的任意 URL 不会被直接拿去请求。
 *   S3. 错误消息里的服务端字符串（status、hostname）会被截断 + 去掉控制字符，
 *       避免脏响应往日志里注入换行/终端转义。
 */

import { randomBytes } from 'node:crypto';

import { WeixinTransportError } from './weixin.mjs';

// ---------------------------------------------------------------------------
// 协议常量（全部来自参考实现，行号见注释）
// ---------------------------------------------------------------------------

/** iLink 扫码登录基址（weixin-api.mjs:11 的 WEIXIN_QR_BASE_URL）。 */
export const DEFAULT_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';

/** 默认 bot_type（weixin-api.mjs:13 DEFAULT_BOT_TYPE）。 */
export const DEFAULT_BOT_TYPE = '3';

/** iLink-App-Id，固定 'bot'（weixin-api.mjs:19）。 */
const ILINK_APP_ID = 'bot';

/** iLink-App-ClientVersion = (2<<16)|(4<<8)|6 = 132102（weixin-api.mjs:20）。 */
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;

/** 拉二维码超时（weixin-api.mjs:21 + L644 显式传 10s）。 */
const DEFAULT_BEGIN_TIMEOUT_MS = 10_000;

/** 轮询状态超时（weixin-api.mjs:22 DEFAULT_LONG_POLL_TIMEOUT_MS）。 */
const DEFAULT_POLL_TIMEOUT_MS = 35_000;

/**
 * 超时硬上限（偏离 D2）。参考实现写死 10s/35s；这里允许调参但封顶 2 分钟，
 * 免得调用方传个 1e12 把「超时」变成事实上的永不超时。
 */
export const MAX_TIMEOUT_MS = 120_000;

/** 超时下限：只要 > 0 就至少 1ms（否则 setTimeout 语义会变成"立刻触发"）。 */
const MIN_TIMEOUT_MS = 1;

/** 二维码有效期 5 分钟（weixin-controller.mjs:25 QR_TTL_MS）——调用方写循环时用。 */
export const QR_TTL_MS = 5 * 60_000;

/** 建议轮询间隔 1s（weixin-controller.mjs:47 publicAttempt.pollIntervalMs）。 */
export const POLL_INTERVAL_MS = 1_000;

/**
 * 平台定义的扫码状态全集（weixin-api.mjs:29-38）。
 * 注意：Set 冻不住（Object.freeze 不影响 .add），别改这个对象。
 */
export const LOGIN_STATUSES = new Set([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'scaned_but_redirect',
  'need_verifycode',
  'verify_code_blocked',
  'binded_redirect',
]);

/**
 * 偏离 D1 的落点：拉二维码的 HTTP method。
 * 参考实现是 POST + `{ local_token_list }`（weixin-api.mjs:639-645）；任务书描述为 GET。
 * 只认 GET 的话：这里改成 'GET'，并删掉 beginLogin 里那一行 body（GET 不带请求体）。
 */
const QRCODE_REQUEST_METHOD = 'POST';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 非空字符串或 null（参考实现到处在用同一个约定）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** provider code 只允许短的安全字符集（weixin-api.mjs:54-57）。 */
function safeProviderCode(value) {
  const code = value === undefined || value === null ? null : String(value).trim();
  return code && /^-?[A-Za-z0-9_.:-]{1,160}$/.test(code) ? code : undefined;
}

/** 首个非零的 ret/errcode 即为拒绝码（weixin-api.mjs:101-109）。 */
function rejectedProviderCode(value, fields = ['ret', 'errcode']) {
  if (!value || typeof value !== 'object') return null;
  for (const field of fields) {
    if (value[field] !== undefined && value[field] !== 0 && value[field] !== '0') {
      return safeProviderCode(value[field]) ?? 'rejected';
    }
  }
  return null;
}

/** 服务端字符串进日志前先截断 + 去控制字符（安全红线 S3）。 */
function safeEcho(value, maxLength = 40) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, maxLength);
}

function isWeixinHost(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/\.$/, '');
  return normalized === 'weixin.qq.com' || normalized.endsWith('.weixin.qq.com')
    || normalized === 'wechat.com' || normalized.endsWith('.wechat.com');
}

/** 校验并规范化 baseUrl，顺手丢掉 userinfo/query/hash（weixin-api.mjs:255-272）。 */
function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinTransportError('invalid-base-url', '微信服务基址无效。');
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
    throw new WeixinTransportError('untrusted-base-url', `微信服务基址必须是 https:443（实际 ${url.protocol}//${url.host}）。`);
  }
  if (!isWeixinHost(url.hostname)) {
    throw new WeixinTransportError('untrusted-base-url', `拒绝访问不受信任的基址主机：${safeEcho(url.hostname, 80)}`);
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

/** 扫码地址归一化（weixin-api.mjs:274-287）。 */
function normalizeQrUrl(value) {
  const text = nonEmptyString(value);
  if (!text) {
    throw new WeixinTransportError('invalid-qr', '微信服务没有返回扫码地址（qrcode_img_content）。');
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WeixinTransportError('invalid-qr', '微信服务返回了无效的扫码地址（qrcode_img_content）。');
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new WeixinTransportError('untrusted-qr', `微信服务返回了不受信任的扫码地址（host=${safeEcho(url.hostname, 80)}）。`);
  }
  return url.toString();
}

/** 服务端给的接入点：可以是裸域名，自动补 https://（weixin-controller.mjs:34-38）。 */
function apiBaseFromServer(value, fallback) {
  const raw = nonEmptyString(value);
  if (!raw) return normalizeBaseUrl(fallback);
  return normalizeBaseUrl(raw.includes('://') ? raw : `https://${raw}`);
}

/**
 * 请求头（weixin-api.mjs:289-305）。
 * `authenticated: false` 时**只有**两个 iLink 头（commonHeaders，L289-294），
 * 这是 get_qrcode_status 的正确形状；`true` 时是 authenticatedHeaders 的形状，
 * 但没有 token 就不带 Authorization（登录链路本来就还没有凭据）。
 */
function buildHeaders({ authenticated = true } = {}) {
  const headers = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
  };
  if (!authenticated) return headers;
  headers['content-type'] = 'application/json';
  headers.AuthorizationType = 'ilink_bot_token';
  // 每请求随机的设备指纹：随机 uint32 的十进制字符串做 base64（weixin-api.mjs:301）。
  headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
  return headers;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * 超时归一化（偏离 D2/D5）：非有限、≤ 0 一律回落 fallback；否则截断并夹在
 * [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS] 之内。导出是为了让调用方能自测封顶行为。
 */
export function resolveTimeoutMs(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(number), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** bot_type 归一化：缺省/空串 → DEFAULT_BOT_TYPE（weixin-api.mjs:13,637）。 */
function botTypeValue(value) {
  if (value === undefined || value === null) return DEFAULT_BOT_TYPE;
  return String(value).trim() || DEFAULT_BOT_TYPE;
}

/** 本机已有 token 列表：去重 + trim + 最多保留最后 10 个（weixin-api.mjs:638）。 */
function localTokenList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(nonEmptyString).filter(Boolean))].slice(-10);
}

// ---------------------------------------------------------------------------
// HTTP 层（weixin-api.mjs:436-498 的同构重写）
// ---------------------------------------------------------------------------

/**
 * 打一个 JSON 请求。
 * - 独立 AbortController 做超时，并与外部 signal 合并（AbortSignal.any）。
 * - `timedOut` 标记用于区分「超时」与「被 signal 取消」——两者语义完全不同。
 * - 归一化：http-error / invalid-response / timeout / network-error，全部带 .code。
 */
async function requestJson(fetchImpl, {
  method,
  baseUrl,
  endpoint,
  body,
  timeoutMs,
  signal,
  authenticated = true,
}) {
  const trustedBase = normalizeBaseUrl(baseUrl);
  const url = new URL(endpoint, trustedBase);
  if (!isWeixinHost(url.hostname)) {
    throw new WeixinTransportError('untrusted-endpoint', `拒绝访问不受信任的端点：${safeEcho(url.hostname, 80)}`);
  }
  if (signal?.aborted) throw abortError(signal);

  const timeoutController = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs) : null;
  const combined = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetchImpl(url, {
      method,
      headers: buildHeaders({ authenticated }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
      redirect: 'error',
    });
    if (!response?.ok) {
      throw new WeixinTransportError('http-error', `微信服务请求失败（HTTP ${response?.status ?? '?'}）。`, {
        status: response?.status,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeixinTransportError('invalid-response', '微信服务返回了无法解析的 JSON。', { cause: error });
    }
  } catch (error) {
    // 外部取消优先：signal 期间的任何异常都还原成 AbortError，交给调用方静默退出。
    if (signal?.aborted) throw abortError(signal);
    if (error instanceof WeixinTransportError) {
      error.durationMs = Date.now() - startedAt;
      throw error;
    }
    const failure = timedOut
      ? new WeixinTransportError('timeout', `微信服务请求超时（${timeoutMs}ms）。`, { cause: error })
      : new WeixinTransportError('network-error', '暂时无法访问微信服务。', { cause: error });
    failure.durationMs = Date.now() - startedAt;
    failure.timeoutMs = timeoutMs;
    throw failure;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 响应校验
// ---------------------------------------------------------------------------

/** status 必须是 8 个已知值之一（weixin-api.mjs:500-505）。 */
function validateLoginStatus(response) {
  const status = response && typeof response === 'object' ? response.status : undefined;
  if (typeof status !== 'string' || !LOGIN_STATUSES.has(status)) {
    const seen = typeof status === 'string'
      ? `「${safeEcho(status)}」`
      : `（${status === undefined ? 'undefined' : status === null ? 'null' : typeof status}）`;
    throw new WeixinTransportError('invalid-login-status', `微信服务返回了无法识别的扫码状态${seen}。`);
  }
  return status;
}

/**
 * confirmed 的凭据（weixin-controller.mjs:481-489）。
 * 只报**缺了哪些字段名**，绝不把 token 值写进错误消息（安全红线 S1）。
 */
function loginCredentials(response, currentBaseUrl) {
  const token = nonEmptyString(response?.bot_token);
  const accountId = nonEmptyString(response?.ilink_bot_id);
  const ownerUserId = nonEmptyString(response?.ilink_user_id);
  if (!token || !accountId || !ownerUserId) {
    const missing = [
      ['bot_token', token],
      ['ilink_bot_id', accountId],
      ['ilink_user_id', ownerUserId],
    ].filter(([, value]) => !value).map(([field]) => field).join(', ');
    throw new WeixinTransportError(
      'incomplete-login',
      `微信授权成功（confirmed），但返回的账号凭据不完整（缺少 ${missing}）。`,
    );
  }
  return {
    token,
    accountId,
    ownerUserId,
    baseUrl: apiBaseFromServer(response?.baseurl, currentBaseUrl),
  };
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

/**
 * 创建一个扫码登录客户端。不做任何 I/O；beginLogin()/pollLogin() 才连网。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]      测试注入，默认 globalThis.fetch
 * @param {number} [options.beginTimeoutMs]       拉二维码超时，默认 10_000，封顶 MAX_TIMEOUT_MS
 * @param {number} [options.pollTimeoutMs]        轮询状态超时，默认 35_000，封顶 MAX_TIMEOUT_MS
 */
export function createWeixinLogin({ fetchImpl = fetch, beginTimeoutMs, pollTimeoutMs } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createWeixinLogin: fetchImpl 必须是函数（Node 24 默认用 globalThis.fetch）');
  }
  const timeouts = {
    begin: resolveTimeoutMs(beginTimeoutMs, DEFAULT_BEGIN_TIMEOUT_MS),
    poll: resolveTimeoutMs(pollTimeoutMs, DEFAULT_POLL_TIMEOUT_MS),
  };

  return Object.freeze({
    /**
     * 拉取扫码二维码（B1）。
     * @returns {Promise<{qrcode: string, qrcodeUrl: string, baseUrl: string}>}
     *   qrcode    轮询令牌，喂给 pollLogin
     *   qrcodeUrl 归一化后的二维码地址（手机扫它）
     *   baseUrl   归一化后的接入点，建议原样传给 pollLogin
     */
    async beginLogin({ baseUrl = DEFAULT_QR_BASE_URL, botType, localTokens, signal } = {}) {
      const trustedBase = normalizeBaseUrl(baseUrl);
      const response = await requestJson(fetchImpl, {
        method: QRCODE_REQUEST_METHOD,
        baseUrl: trustedBase,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botTypeValue(botType))}`,
        body: { local_token_list: localTokenList(localTokens) },
        timeoutMs: timeouts.begin,
        signal,
        authenticated: true,
      });
      // 平台级拒绝先判（weixin-api.mjs:648），再判令牌是否缺失（L650）。
      const providerCode = rejectedProviderCode(response, ['errcode', 'ret']);
      if (providerCode) {
        throw new WeixinTransportError('qr-request-rejected', '微信服务拒绝了二维码申请。', { providerCode });
      }
      const qrcode = nonEmptyString(response?.qrcode);
      if (!qrcode) {
        throw new WeixinTransportError('invalid-qr', '微信服务没有返回二维码令牌（qrcode）。');
      }
      return {
        qrcode,
        qrcodeUrl: normalizeQrUrl(response?.qrcode_img_content),
        baseUrl: trustedBase,
      };
    },

    /**
     * 轮询扫码状态（B2/B3）。
     * @returns {Promise<object>} 原始响应 + status（+ confirmed 的 credentials /
     *   scaned_but_redirect 的 baseUrl，见偏离 D4）
     */
    async pollLogin({ qrcode, baseUrl = DEFAULT_QR_BASE_URL, verifyCode, signal } = {}) {
      const qr = nonEmptyString(qrcode);
      if (!qr) {
        // 偏离 D3：参考实现抛裸 TypeError('qrcode is required')，这里给带 code 的错误。
        throw new WeixinTransportError('invalid-qr', 'pollLogin: qrcode 必填（用 beginLogin() 返回的 qrcode）。');
      }
      const trustedBase = normalizeBaseUrl(baseUrl);
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`;
      const code = nonEmptyString(verifyCode);
      if (code) endpoint += `&verify_code=${encodeURIComponent(code)}`;

      const response = await requestJson(fetchImpl, {
        method: 'GET',
        baseUrl: trustedBase,
        endpoint,
        timeoutMs: timeouts.poll,
        signal,
        // get_qrcode_status 是**未鉴权**端点：只有两个 iLink 头（weixin-api.mjs:668）。
        authenticated: false,
      });

      const status = validateLoginStatus(response);
      const result = { ...response, status };
      if (status === 'confirmed') {
        result.credentials = loginCredentials(response, trustedBase);
      } else if (status === 'scaned_but_redirect') {
        // 已扫，但要在另一个接入点完成：把归一化后的 baseUrl 交给调用方换线。
        result.baseUrl = apiBaseFromServer(response.redirect_host, trustedBase);
      }
      return result;
    },

    LOGIN_STATUSES,
    DEFAULT_QR_BASE_URL,
  });
}
