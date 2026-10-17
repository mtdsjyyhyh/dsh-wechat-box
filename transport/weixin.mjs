/**
 * weixin.mjs — 微信 / 企业微信 iLink 机器人传输层（独立实现，零第三方依赖）
 *
 * ---------------------------------------------------------------------------
 * 出处声明 / PROVENANCE
 * ---------------------------------------------------------------------------
 * 本文件是从第三方插件 `@xmanrui/dsh-im`（MIT License）的微信渠道实现**移植**而来：
 *   - src/channels/weixin/weixin-api.mjs        （协议核心：端点、鉴权头、请求/响应形状）
 *   - src/channels/weixin/weixin-runtime.mjs    （长轮询循环、退避、错误分类）
 *   - src/channels/weixin/state-store.mjs       （状态持久化、context_token、去重环）
 *   - src/channels/weixin/weixin-bridge.mjs     （仅按符号查阅：入站消息解析、context_token 捕获点）
 *   - src/channels/weixin/connection-error.mjs  （错误码语义）
 * 上游版权归 @xmanrui/dsh-im 作者所有，MIT 许可。本文件为自包含重写：
 * 不 import 原包，不依赖任何第三方 npm 包，只用 Node 内置模块。
 *
 * 与参考实现的有意偏离（都已在对应位置写明理由）：
 *   1. 只保留「已绑定机器人 token」之后的运行期链路（长轮询 + 发文本）。
 *      扫码绑定 / 二维码登录 / getconfig / sendtyping / 图片 / 文件 / CDN 上传**不在范围内**。
 *   2. 长轮询连续失败**不**在 3 次后放弃（参考实现会），改为封顶指数退避无限重试，
 *      只有平台明确判死（ret/errcode = -14，token 失效）才终止循环。
 *   3. 入站非文本消息**默认转发**为 { kind: 'unsupported' }，而不是静默丢弃。
 *   4. 状态写盘失败不致命（只 warn），参考实现会抛错。
 *   5. 默认 logger 为静默 no-op（库不该往宿主 stdout 里写字），需要诊断请显式传 console。
 *
 * ---------------------------------------------------------------------------
 * 平台怪癖（踩过的坑，改代码前先读）
 * ---------------------------------------------------------------------------
 *   Q1. **长轮询超时是正常现象，不是错误。** 服务端会把 getupdates 请求 hold 住直到
 *       客户端超时窗口结束，然后什么都不返回。参考实现把「超时」直接合成为一条空响应
 *       （weixin-api.mjs:684-689）。照做：超时 → 空批次 + 游标保持不变，连接状态仍算
 *       健康。若把超时当网络故障处理，会得到一条永远在"重连"的假象。
 *   Q2. **游标字段叫 `get_updates_buf`**（请求、响应同名）。必须**先处理完本批 msgs 再
 *       落盘新游标**，否则处理途中崩溃会把整批消息永久跳过。
 *   Q3. **平台会把我方发出的消息回灌进同一路 getupdates 流**，用 `message_type === 2`
 *       标记出站。参考实现整条跳过（weixin-bridge.mjs:385）。默认照做；万一以后发现
 *       入站也带 2，用 `treatMessageType2AsInbound: true` 关掉该过滤。
 *   Q4. **消息 id 是 64 位整数**，会超出 JS 安全整数范围（实测形如 7514359851928797000）。
 *       必须用 String() 处理，绝不要 Number() 后当数字比较；高位还编码了毫秒时间戳
 *       （见 weixinMessageTimestampMs）。
 *   Q5. **context_token 只从入站消息里拿得到**，出站时回填（见下方生命周期注释）。
 *   Q6. 语音消息若已被微信转成文字，会出现在 `voice_item.text`（item.type === 3），
 *       参考实现把它和文本一样处理；本模块同样把它当文本回调，`kind: 'text'`。
 *   Q7. **不要把 token 写进日志 / 状态文件 / 错误消息。** 状态文件里只存 token 的
 *       sha256 前缀用途的 credentialHash（换 token 即作废 context_token 缓存）。
 *
 * ---------------------------------------------------------------------------
 * 接口契约
 * ---------------------------------------------------------------------------
 *   createWeixinTransport(options) -> transport
 *     options: {
 *       botId, accountId, baseUrl, tokenRef,   // 来自 config.json
 *       credentialsPath?,                      // 默认 ~/.dsh/.credentials.yaml
 *       statePath,                             // 【必填】本传输层自己的状态文件（tmp+rename 原子写）
 *       logger?,                               // { info, warn, error }，可选，默认静默
 *       fetchImpl?,                            // 测试注入，默认 globalThis.fetch
 *       // 可选调参（默认值见 DEFAULTS）
 *       longPollTimeoutMs, requestTimeoutMs, backoffBaseMs, backoffMaxMs,
 *       seenLimit, forwardUnsupported, botAgent, notifyOnStart, notifyOnStop,
 *       treatMessageType2AsInbound, allowUntrustedBaseUrl,
 *       maxConsecutiveFailures, startRetryDelaysMs, contextTokenLimit, env,
 *     }
 *
 *   transport.start(onMessage) -> Promise<status>   // 开始长轮询；幂等（已在跑则直接返回 status）
 *   transport.sendText(userId, text) -> Promise<{ok:true,...}|{ok:false,code,message}>  // 不抛异常
 *   transport.stop() -> Promise<void>               // 中断在途请求、清定时器、停轮询
 *   transport.status() -> { connected, lastInboundAt, lastOutboundAt, lastError, pollCount, ... }
 *
 *   onMessage(msg) 收到的消息形状：
 *     {
 *       kind: 'text' | 'unsupported',   // 语音转文字算 'text'
 *       userId,        // 形如 "<openid>@im.wechat"
 *       messageId,     // 平台消息 id（字符串！用于去重）
 *       text,          // kind==='text' 时为正文；kind==='unsupported' 时为 ''（不是 null，
 *                      // 这样调用方 .length / if(msg.text) 都不会炸）
 *       at,            // 毫秒时间戳（create_time_ms → 消息 id 内嵌时间 → Date.now()）
 *       raw,           // 原始载荷，便于排查
 *       // 附加：非文本消息才有 itemTypes
 *     }
 *   onMessage 允许同步或返回 Promise；它抛错/拒绝**不会**打断轮询循环（只记录日志）。
 *   同一批内按 seq（退化到 create_time_ms）升序派发；不等待 onMessage 返回即派发下一条，
 *   因此慢消费者可能看到重叠调用 —— 派发顺序有保证，"处理完成顺序"没有。
 *
 * ---------------------------------------------------------------------------
 * context_token 完整生命周期
 * ---------------------------------------------------------------------------
 *   来源  ：只出现在**入站**消息上（weixin-bridge.mjs:425 `message?.context_token`）。
 *           它是平台发给这个「机器人登录 + 该用户会话」的对话能力凭证。
 *   更新  ：每收到一条该用户的消息就刷新；写入 `state.contextTokens[userId]`。
 *           带单调性护栏（state-store.mjs:157-161）：新条目的 seq / messageTimeMs
 *           若比已存的小，则**拒绝覆盖** —— 乱序或重复投递的旧批次不能把新凭证顶掉。
 *   失效  ：contextTokens 整体绑定在 bot 凭据上（credentialHash = sha256(token)）。
 *           检测到 token 变了 → 清空整张表（旧凭证对新登录无意义）。
 *   使用  ：sendText 时若表里有该用户的 token 就放进 `msg.context_token`
 *           （weixin-api.mjs:758）；没有就省略该字段。**主动/延迟发送**必须有它 ——
 *           那类发送没有入站消息可"接话"，平台拿不到对话上下文。
 *   容量  ：默认最多 1000 个用户，超出按插入顺序淘汰最旧的（state-store.mjs:164-165）。
 *
 * 最小 state schema（statePath 指向的 JSON，version 1）：
 *   {
 *     "version": 1,
 *     "credentialHash": "<sha256(token) hex>|null",  // token 变更检测，换 token 即清空 contextTokens
 *     "getUpdatesBuf": "<服务端游标>",                // 长轮询游标，原样回传
 *     "seenMessageIds": ["<messageId>", ...],        // 去重环，新的在后，最多 seenLimit 条
 *     "contextTokens": {                             // 每用户对话能力凭证
 *       "<userId>": { "token": "...", "seq": "123"|null,
 *                     "messageTimeMs": 123|null, "receivedAt": 123 }
 *     },
 *     "updatedAt": 1234567890
 *   }
 */

import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// 协议常量（全部来自 weixin-api.mjs，行号见注释）
// ---------------------------------------------------------------------------

/** iLink 生产环境基址（weixin-api.mjs:11）。 */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com/';
/** 协议版本，放进每个请求的 base_info.channel_version（weixin-api.mjs:12）。 */
export const WEIXIN_PROTOCOL_VERSION = '2.4.6';
/** iLink-App-Id，固定 'bot'（weixin-api.mjs:19）。 */
const ILINK_APP_ID = 'bot';
/** iLink-App-ClientVersion = (2<<16)|(4<<8)|6 = 132102（weixin-api.mjs:20）。 */
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
/**
 * base_info.bot_agent。**故意沿用参考实现实测可用的取值**：这是纯元数据字段，
 * 但平台是否按它做灰度/限流未知，换名字的收益为零、风险非零。要改成自己的标识请传
 * options.botAgent，或设成 null 让整个 bot_agent 字段消失。
 */
const DEFAULT_BOT_AGENT = 'DeepSeekHarness/1.1.0';

/** 普通请求超时（weixin-api.mjs:21）。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** 长轮询超时（weixin-api.mjs:22）——服务端 hold 窗口，超时= 空批次，见 Q1。 */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

const DEFAULTS = Object.freeze({
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  longPollTimeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  seenLimit: 1_000,
  contextTokenLimit: 1_000,
  forwardUnsupported: true,
  notifyOnStart: true,
  notifyOnStop: true,
  treatMessageType2AsInbound: false,
  allowUntrustedBaseUrl: false,
});

/** 去重环 / context_token 表的硬上限兜底（防止配置文件给出荒谬值）。 */
const HARD_LIMITS = Object.freeze({ seenLimit: 20_000, contextTokenLimit: 5_000 });

const MESSAGE_ID_TIMESTAMP_SHIFT = 22n;
const MESSAGE_ID_MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const MESSAGE_ID_MAX_FUTURE_MS = 24 * 60 * 60 * 1_000;

/** 平台判死的 provider code：-14 = 登录凭据失效（weixin-runtime.mjs:266）。 */
const FATAL_PROVIDER_CODES = new Set(['-14']);

/**
 * 微信媒体 CDN 基址（官方 openclaw-weixin src/cdn/cdn-url.ts 的 cdnBaseUrl）。
 * 只有服务端没给 upload_full_url 时才用它自己拼 /upload?…。
 */
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * getuploadurl 的 media_type。与 item_list 的 type 是**两套编号**，不要混用：
 * 上传槽位 1=图片 2=视频 3=文件 4=语音；消息 item 2=图片 3=语音 4=文件 5=视频。
 */
const UPLOAD_MEDIA_TYPE_FILE = 3;

/**
 * 单文件上限。整个文件要读进内存再加密上传，所以必须有上限；
 * 这里取 30MB——足够发论文/表格/图片，又不至于让一次误发把宿主内存吃光。
 */
const MAX_FILE_BYTES = 30 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 传输层错误。code 取值与参考实现保持一致，便于对照上游日志：
 *   network-error | timeout | http-error | invalid-response |
 *   untrusted-base-url | invalid-base-url | untrusted-endpoint |
 *   updates-rejected | stale-token | send-rejected | token-missing
 */
export class WeixinTransportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WeixinTransportError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 非空字符串或 null（参考实现到处在用同一个约定）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** provider code 只允许短的安全字符集，避免把服务端返回的任意文本灌进日志/状态。 */
function safeProviderCode(value) {
  const code = value === undefined || value === null ? null : String(value).trim();
  return code && /^-?[A-Za-z0-9_.:-]{1,160}$/.test(code) ? code : undefined;
}

function toFiniteNumber(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

/** 非负整数时间戳或 null。 */
function toTimestamp(value) {
  const number = toFiniteNumber(value);
  return number !== null && number >= 0 ? Math.trunc(number) : null;
}

/** 64 位整数字符串化（Q4：绝不能用 Number）。 */
function toStringId(value) {
  if (value === undefined || value === null) return null;
  return nonEmptyString(String(value));
}

/**
 * seq 只接受纯十进制整数字符串（weixin-runtime.mjs:88-98 的 `sequence()`）。
 * 为什么单独把关：seq 会参与 BigInt() 比较，任何 `12a` / `1e3` / 带空格的输入都会
 * 让 BigInt 抛 SyntaxError —— 那是在消息处理路径上，一条脏消息就能打死整个循环。
 */
function sequenceOf(value) {
  const text = typeof value === 'string' ? value.trim()
    : Number.isSafeInteger(value) ? String(value) : '';
  return /^\d+$/.test(text) ? text : null;
}

function isWeixinHost(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/\.$/, '');
  return normalized === 'weixin.qq.com' || normalized.endsWith('.weixin.qq.com')
    || normalized === 'wechat.com' || normalized.endsWith('.wechat.com');
}

/** 校验并规范化 baseUrl，顺手丢掉 userinfo/query/hash（weixin-api.mjs:255-272）。 */
function normalizeBaseUrl(value, { allowUntrusted = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinTransportError('invalid-base-url', `微信服务基址无效：${String(value)}`);
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
    throw new WeixinTransportError('untrusted-base-url', `微信服务基址必须是 https:443：${url.origin}`);
  }
  if (!allowUntrusted && !isWeixinHost(url.hostname)) {
    throw new WeixinTransportError('untrusted-base-url', `拒绝访问不受信任的基址主机：${url.hostname}`);
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

/**
 * 请求头（weixin-api.mjs:289-305）。
 * 注意 `AuthorizationType` 不是标准头，**不要**"顺手改成 Authorization-Type"。
 * X-WECHAT-UIN 是每请求随机的设备指纹：把一个随机 uint32 的十进制字符串做 base64。
 */
function buildHeaders({ token, json = true } = {}) {
  const headers = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  };
  if (json) headers['content-type'] = 'application/json';
  const bearer = nonEmptyString(token);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

function baseInfo(botAgent) {
  return {
    channel_version: WEIXIN_PROTOCOL_VERSION,
    ...(botAgent ? { bot_agent: botAgent } : {}),
  };
}

/**
 * AES-128-ECB + PKCS#7，iLink 的 CDN 上传就认这一种。
 *
 * ECB 在现代密码学里是反面教材（相同明文块出相同密文块），但这里没有选择：
 * 平台按 ECB 解密，换成 GCM/CBC 会直接解不开。密钥每次上传现生成、只作用于
 * 一个文件，所以它的弱点不会跨消息累积。
 */
function encryptEcb(plain, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
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

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

// ---------------------------------------------------------------------------
// 凭据读取：env 优先，其次极简 YAML 按行解析
// ---------------------------------------------------------------------------

/**
 * 从 YAML 文本里取出某个 key 的标量值。
 *
 * 这是**故意的极简实现**：不引入 yaml 依赖，也不做完整 YAML 语义。它依赖真实凭据文件的
 * 形状（本机实测：`records:`/`refs:` 之下两空格缩进的 `KEY: value`，值可能是裸串或引号包裹）：
 *
 *   refs:
 *     DSH_WEIXIN_BOT_TOKEN_xxxx: <value>
 *
 * 规则：
 *   - 跳过注释行与空行；key 出现在任意缩进层级都接受（key 名在本文件里是唯一的）。
 *   - 前缀匹配按「行首到冒号」精确比对，所以 `FOO` 不会匹配到 `FOO_BAR`。
 *   - `KEY:`（值为空 = 后面是嵌套块）不算命中，继续往下找。
 *   - 值若被单/双引号包裹则去引号并反转义；裸值只在 ` #`（空格+井号）处截断注释
 *     —— 这样 token 里合法的 `#` 不会被误吃。
 *   - 支持 YAML 的 `KEY: "quoted"` 与 `"KEY": value` 两种写法。
 */
export function extractYamlScalar(text, key) {
  if (typeof text !== 'string' || !nonEmptyString(key)) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = `(?:"${escaped}"|'${escaped}'|${escaped})`;
  const linePattern = new RegExp(`^\\s*${quoted}\\s*:\\s*(.*)$`);
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = linePattern.exec(line);
    if (!match) continue;
    const raw = match[1].trim();
    if (!raw) continue; // 形如 `records:` 的嵌套块头，不是标量
    return unquoteYamlScalar(raw);
  }
  return null;
}

function unquoteYamlScalar(raw) {
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (raw.length >= 2 && first === last && (first === '"' || first === "'")) {
    const inner = raw.slice(1, -1);
    if (first === "'") return inner.replace(/''/g, "'");
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  const commentAt = raw.search(/\s#/);
  return commentAt >= 0 ? raw.slice(0, commentAt).trim() : raw;
}

/** 默认凭据文件位置：~/.dsh/.credentials.yaml。 */
export function defaultCredentialsPath() {
  return join(homedir(), '.dsh', '.credentials.yaml');
}

/**
 * 解析 token：先查 process.env[tokenRef]，再读凭据 YAML。
 * 返回值里带 source 仅用于日志（绝不打印 token 本身）。
 */
async function resolveToken({ tokenRef, credentialsPath, env }) {
  const ref = nonEmptyString(tokenRef);
  if (!ref) return null;
  const fromEnv = env?.[ref];
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return { token: fromEnv.trim(), source: 'env' };
  }
  let text;
  try {
    text = await readFile(credentialsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new WeixinTransportError('credential-read-failed', `无法读取凭据文件：${credentialsPath}`, { cause: error });
  }
  const value = extractYamlScalar(text, ref);
  return nonEmptyString(value) ? { token: value.trim(), source: 'credentials-file' } : null;
}

/** 只用 token 的 sha256 做「换了凭据」判定，不入库明文。 */
function credentialHashOf(token) {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// 入站消息解析
// ---------------------------------------------------------------------------

/**
 * 平台消息 id：优先 message_id，退化到 client_id（weixin-api.mjs:930-935）。
 * 结果**一定是字符串**（Q4）。
 */
export function weixinMessageId(message) {
  const direct = toStringId(message?.message_id);
  if (direct) return direct;
  return toStringId(message?.client_id);
}

/**
 * 从 64 位消息 id 高位解出毫秒时间戳（weixin-api.mjs:916-928）。
 * 用途：create_time_ms 缺失时的兜底时间。
 */
export function weixinMessageTimestampMs(messageId, { now = Date.now() } = {}) {
  const value = messageId === undefined || messageId === null ? '' : String(messageId).trim();
  if (!/^\d{16,20}$/u.test(value)) return null;
  try {
    const timestampMs = Number(BigInt(value) >> MESSAGE_ID_TIMESTAMP_SHIFT);
    if (!Number.isSafeInteger(timestampMs)
      || timestampMs < MESSAGE_ID_MIN_TIMESTAMP_MS
      || timestampMs > now + MESSAGE_ID_MAX_FUTURE_MS) return null;
    return timestampMs;
  } catch {
    return null;
  }
}

/**
 * 提取文本（weixin-api.mjs:839-851）：
 *   item.type === 1 → text_item.text   普通文本
 *   item.type === 3 → voice_item.text  语音已被微信转写成的文字（Q6）
 * 返回第一个非空的 trim 后的结果。
 */
export function extractWeixinText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim();
      if (text) return text;
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim();
      if (text) return text;
    }
  }
  return null;
}

/** 非文本消息的 item 类型清单，放进 { kind:'unsupported' } 便于调用方分类。 */
function itemTypesOf(message) {
  const types = [];
  for (const item of message?.item_list ?? []) {
    const type = toFiniteNumber(item?.type);
    if (type !== null && !types.includes(type)) types.push(type);
  }
  return types;
}

/**
 * 按 seq（退化 create_time_ms）升序排序（weixin-runtime.mjs:83-98）。
 * 只有当**所有**消息都带同一个可用字段时才排序，避免半数字段把顺序搅乱。
 */
export function orderWeixinMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return Array.isArray(messages) ? messages : [];
  const orderField = ['seq', 'create_time_ms'].find((field) => messages.every((message) => (
    toFiniteNumber(message?.[field]) !== null
  )));
  if (!orderField) return messages;
  return messages
    .map((message, index) => ({ message, index, order: Number(message[orderField]) }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ message }) => message);
}

// ---------------------------------------------------------------------------
// 状态文件（原子写）
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    version: 1,
    credentialHash: null,
    getUpdatesBuf: '',
    seenMessageIds: [],
    contextTokens: {},
    updatedAt: 0,
  };
}

/** 反序列化 + 逐字段校验；任何坏字段都退化，绝不让坏状态文件把服务起不来。 */
function normalizeState(value, { seenLimit, contextTokenLimit }) {
  const state = emptyState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  state.credentialHash = typeof value.credentialHash === 'string' && /^[a-f0-9]{64}$/.test(value.credentialHash)
    ? value.credentialHash : null;
  state.getUpdatesBuf = typeof value.getUpdatesBuf === 'string' ? value.getUpdatesBuf : '';
  if (Array.isArray(value.seenMessageIds)) {
    state.seenMessageIds = value.seenMessageIds
      .filter((id) => typeof id === 'string' && id)
      .slice(-seenLimit);
  }
  if (value.contextTokens && typeof value.contextTokens === 'object' && !Array.isArray(value.contextTokens)) {
    const entries = Object.entries(value.contextTokens).slice(-contextTokenLimit);
    for (const [userId, entry] of entries) {
      const token = nonEmptyString(entry?.token);
      if (!nonEmptyString(userId) || !token) continue;
      state.contextTokens[userId] = {
        token,
        seq: entry?.seq === undefined || entry?.seq === null ? null : toStringId(entry.seq),
        messageTimeMs: toTimestamp(entry?.messageTimeMs),
        receivedAt: toTimestamp(entry?.receivedAt),
      };
    }
  }
  state.updatedAt = toTimestamp(value.updatedAt) ?? 0;
  return state;
}

/**
 * 状态容器：内存为真、磁盘为副本。
 * 写盘串行化 + 同 tick 合并（一批消息只触发一次写），失败只 warn 不影响轮询。
 */
class StateFile {
  #path;
  #seenLimit;
  #contextTokenLimit;
  #logger;
  #state = emptyState();
  #loaded = false;
  #loading = null;
  #writeQueue = Promise.resolve();
  #scheduled = null;
  #seenSet = new Set();

  constructor({ path, seenLimit, contextTokenLimit, logger }) {
    this.#path = path;
    this.#seenLimit = seenLimit;
    this.#contextTokenLimit = contextTokenLimit;
    this.#logger = logger;
  }

  get path() { return this.#path; }
  get buf() { return this.#state.getUpdatesBuf; }

  async load() {
    if (this.#loaded) return this;
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      try {
        const text = await readFile(this.#path, 'utf8');
        this.#state = normalizeState(JSON.parse(text), {
          seenLimit: this.#seenLimit,
          contextTokenLimit: this.#contextTokenLimit,
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // 坏状态文件不该阻止服务启动：退化为空状态，让平台把游标重新给一遍。
          this.#logger.warn?.(`[weixin] 状态文件读取失败，按空状态启动：${this.#path}`, error?.message ?? error);
        }
        this.#state = emptyState();
      }
      this.#seenSet = new Set(this.#state.seenMessageIds);
      this.#loaded = true;
      this.#loading = null;
      return this;
    })();
    return this.#loading;
  }

  hasSeen(messageId) { return this.#seenSet.has(messageId); }

  markSeen(messageId) {
    if (this.#seenSet.has(messageId)) return false;
    this.#seenSet.add(messageId);
    const ids = this.#state.seenMessageIds;
    ids.push(messageId);
    // 环形裁剪：超限时丢最旧的。Set 与数组同步裁剪，否则两者会漂移。
    while (ids.length > this.#seenLimit) {
      const dropped = ids.shift();
      if (dropped !== undefined) this.#seenSet.delete(dropped);
    }
    this.#schedulePersist();
    return true;
  }

  setBuf(value) {
    if (typeof value !== 'string' || !value || value === this.#state.getUpdatesBuf) return false;
    this.#state.getUpdatesBuf = value;
    this.#schedulePersist();
    return true;
  }

  /**
   * 记录/刷新某用户的 context_token。
   * 单调性护栏（state-store.mjs:157-161）：seq 或 messageTimeMs 变小 → 拒绝覆盖。
   * 理由：乱序批次、重复投递、平台重放都会带来"更旧"的 token，覆盖会让后续主动
   * 发送用一个已过期的对话能力，表现为"发出去了但对方收不到/平台报错"。
   */
  rememberContextToken({ userId, token, seq, messageTimeMs }) {
    const user = nonEmptyString(userId);
    const contextToken = nonEmptyString(token);
    if (!user || !contextToken) return false;
    const next = {
      token: contextToken,
      seq: sequenceOf(seq),
      messageTimeMs: toTimestamp(messageTimeMs),
      receivedAt: Date.now(),
    };
    const previous = this.#state.contextTokens[user];
    if (previous) {
      if (previous.seq !== null && next.seq !== null && BigInt(next.seq) <= BigInt(previous.seq)) {
        // seq 没前进：只刷新 receivedAt，不换 token。
        if (previous.token !== next.token) return false;
      } else if (previous.messageTimeMs !== null && next.messageTimeMs !== null
        && next.messageTimeMs < previous.messageTimeMs) {
        return false;
      }
    }
    // 重新插入到末尾 = LRU 意义上的"最近使用"。
    delete this.#state.contextTokens[user];
    this.#state.contextTokens[user] = next;
    const keys = Object.keys(this.#state.contextTokens);
    if (keys.length > this.#contextTokenLimit) {
      for (const key of keys.slice(0, keys.length - this.#contextTokenLimit)) {
        delete this.#state.contextTokens[key];
      }
    }
    this.#schedulePersist();
    return true;
  }

  contextTokenFor(userId) {
    const user = nonEmptyString(userId);
    return user ? this.#state.contextTokens[user]?.token ?? null : null;
  }

  contextTokenCount() { return Object.keys(this.#state.contextTokens).length; }

  /**
   * 绑定 bot 凭据。token 变了就清空 contextTokens —— 旧凭证属于旧登录，
   * 拿去发消息只会得到平台拒绝。
   */
  bindCredential(token) {
    const hash = credentialHashOf(token);
    if (this.#state.credentialHash === hash) return false;
    this.#state.credentialHash = hash;
    const had = Object.keys(this.#state.contextTokens).length;
    this.#state.contextTokens = {};
    if (had) this.#logger.info?.(`[weixin] bot 凭据已变更，已清空 ${had} 条 context_token`);
    this.#schedulePersist();
    return true;
  }

  /** 同 tick 内多次变更加载只写一次盘；写盘本身串行。 */
  #schedulePersist() {
    if (this.#scheduled) return this.#scheduled;
    this.#scheduled = (async () => {
      await Promise.resolve();
      this.#scheduled = null;
      await this.#persist();
    })();
    return this.#scheduled;
  }

  /** 等所有待写 / 在写的快照落盘。stop() 调它保证游标不丢。 */
  async flush() {
    for (let guard = 0; guard < 200; guard += 1) {
      if (this.#scheduled) {
        await this.#scheduled.catch(() => undefined);
        continue;
      }
      if (this.#inFlight === 0) return;
      await this.#writeQueue.catch(() => undefined);
    }
  }

  #inFlight = 0;

  /** tmp + rename 原子写：读者永远看到完整 JSON，不会读到半个文件。 */
  async #persist() {
    this.#state.updatedAt = Date.now();
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    this.#inFlight += 1;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    try {
      await operation;
    } catch (error) {
      // 状态写不进去不该让机器人下线：内存里仍然是对的，重启后最坏重放一批消息（有去重环兜底）。
      this.#logger.warn?.(`[weixin] 状态写入失败：${this.#path}`, error?.message ?? error);
    } finally {
      this.#inFlight -= 1;
    }
  }

  snapshot() {
    return {
      version: this.#state.version,
      credentialHash: this.#state.credentialHash,
      getUpdatesBuf: this.#state.getUpdatesBuf,
      seenMessageIds: [...this.#state.seenMessageIds],
      contextTokens: Object.fromEntries(
        Object.entries(this.#state.contextTokens).map(([key, value]) => [key, { ...value }]),
      ),
      updatedAt: this.#state.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

/**
 * 打一个 JSON 请求。
 * - 独立 AbortController 做超时，并与外部 signal 合并：stop() 能瞬断在途长轮询。
 * - `timedOut` 标记让我们能区分「超时」与「被 stop() 取消」——两者的语义完全不同。
 */
async function requestJson(fetchImpl, {
  method,
  baseUrl,
  endpoint,
  body,
  token,
  timeoutMs,
  signal,
  allowUntrustedBaseUrl,
  authenticated = true,
}) {
  const trustedBase = normalizeBaseUrl(baseUrl, { allowUntrusted: allowUntrustedBaseUrl });
  const url = new URL(endpoint, trustedBase);
  if (!allowUntrustedBaseUrl && !isWeixinHost(url.hostname)) {
    throw new WeixinTransportError('untrusted-endpoint', `拒绝访问不受信任的端点：${url.origin}`);
  }
  if (signal?.aborted) throw abortError(signal);

  const timeoutController = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs) : null;
  // Node 20.3+ 的 AbortSignal.any：任一路 abort 都会让请求中断。
  const combined = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetchImpl(url, {
      method,
      headers: buildHeaders({ token, json: true }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
      redirect: 'error',
    });
    if (!response?.ok) {
      throw new WeixinTransportError('http-error', `微信服务请求失败（HTTP ${response?.status ?? '?'}）`, {
        status: response?.status,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeixinTransportError('invalid-response', '微信服务返回了无法解析的 JSON。', { cause: error });
    }
  } catch (error) {
    // 外部取消优先：stop() 期间的任何异常都还原成 AbortError，由循环静默退出。
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

/**
 * 错误分类：决定「退避重试」还是「判死」。
 * 参考实现把可重试定义为 network-error / timeout / HTTP 408|425|429|5xx
 * （weixin-runtime.mjs:42-47），这里沿用；额外把平台 code -14 单独标成致命。
 */
export function classifyError(error) {
  const code = error?.code;
  const status = Number(error?.status);
  if (code === 'stale-token' || FATAL_PROVIDER_CODES.has(String(error?.providerCode))) {
    return { kind: 'auth', retryable: false, fatal: true };
  }
  if (code === 'timeout') return { kind: 'timeout', retryable: true, fatal: false };
  if (code === 'network-error') return { kind: 'offline', retryable: true, fatal: false };
  if (code === 'http-error') {
    if (status === 401 || status === 403) {
      // 参考实现的明确立场（connection-error.mjs:126）：HTTP 401/403 不足以断定
      // 登录凭据失效（可能是代理/WAF），因此**不**判死，只持续重试并上报。
      return { kind: 'http-auth', retryable: true, fatal: false };
    }
    if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) {
      return { kind: 'http-transient', retryable: true, fatal: false };
    }
    return { kind: 'http-client', retryable: false, fatal: false };
  }
  if (code === 'updates-rejected' || code === 'send-rejected') {
    return { kind: 'protocol', retryable: false, fatal: false };
  }
  return { kind: 'unknown', retryable: false, fatal: false };
}

function backoffDelay(attempt, baseMs, maxMs) {
  const exponential = baseMs * (2 ** Math.max(0, attempt - 1));
  return Math.min(exponential, maxMs);
}

/** 可被 signal 立即打断的 sleep（stop() 不能等退避跑完）。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

/**
 * 创建一个微信 iLink 传输层实例。
 * 不做任何 I/O；start() 才连网。
 */
export function createWeixinTransport(options = {}) {
  const {
    botId = null,
    accountId = null,
    baseUrl = DEFAULT_BASE_URL,
    tokenRef = null,
    // A token handed over directly, e.g. one just produced by the QR login flow.
    // resolveToken() only understands a *reference* (env var / credentials file),
    // and a freshly bound account has neither -- it has not been written to the
    // shared credentials store yet. Checked before tokenRef.
    token: tokenOption = null,
    credentialsPath = defaultCredentialsPath(),
    statePath,
    logger = null,
    fetchImpl = globalThis.fetch,
    env = process.env,
  } = options;

  if (!nonEmptyString(statePath)) {
    throw new TypeError('createWeixinTransport: statePath 必填（状态文件绝对路径）');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createWeixinTransport: fetchImpl 必须是函数（Node 24 默认用 globalThis.fetch）');
  }

  const settings = {
    requestTimeoutMs: positiveOr(options.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    longPollTimeoutMs: positiveOr(options.longPollTimeoutMs, DEFAULTS.longPollTimeoutMs),
    backoffBaseMs: positiveOr(options.backoffBaseMs, DEFAULTS.backoffBaseMs),
    backoffMaxMs: positiveOr(options.backoffMaxMs, DEFAULTS.backoffMaxMs),
    seenLimit: clampLimit(options.seenLimit, DEFAULTS.seenLimit, HARD_LIMITS.seenLimit),
    contextTokenLimit: clampLimit(options.contextTokenLimit, DEFAULTS.contextTokenLimit, HARD_LIMITS.contextTokenLimit),
    forwardUnsupported: options.forwardUnsupported ?? DEFAULTS.forwardUnsupported,
    notifyOnStart: options.notifyOnStart ?? DEFAULTS.notifyOnStart,
    notifyOnStop: options.notifyOnStop ?? DEFAULTS.notifyOnStop,
    treatMessageType2AsInbound: options.treatMessageType2AsInbound ?? DEFAULTS.treatMessageType2AsInbound,
    allowUntrustedBaseUrl: options.allowUntrustedBaseUrl ?? DEFAULTS.allowUntrustedBaseUrl,
    botAgent: options.botAgent === undefined ? DEFAULT_BOT_AGENT : options.botAgent,
    // 连续失败上限：默认无限（见文件头偏离说明 2）；设成有限值即恢复"尝试 N 次后放弃"。
    maxConsecutiveFailures: positiveOr(options.maxConsecutiveFailures, Number.POSITIVE_INFINITY),
    // notifystart 的重试节奏（参考实现 weixin-runtime.mjs:16 的 DEFAULT_START_RETRY_DELAYS_MS）。
    startRetryDelaysMs: Array.isArray(options.startRetryDelaysMs)
      ? options.startRetryDelaysMs.filter((ms) => Number.isFinite(ms) && ms >= 0)
      : [250, 1_000, 3_000],
  };

  const log = {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : () => {},
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : () => {},
  };

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, { allowUntrusted: settings.allowUntrustedBaseUrl });
  const state = new StateFile({
    path: statePath,
    seenLimit: settings.seenLimit,
    contextTokenLimit: settings.contextTokenLimit,
    logger: log,
  });

  /** 运行期状态。status() 返回它的浅拷贝。 */
  const runtime = {
    running: false,
    connected: false,
    startedAt: null,
    lastPollAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastError: null,
    lastErrorInfo: null,
    pollCount: 0,
    consecutiveFailures: 0,
    fatal: false,
  };

  let controller = null;
  let loopPromise = null;
  let onMessageHandler = null;
  let cachedToken = null;   // { token, source }
  let tokenChecked = false;

  /** 惰性解析 token 并缓存；只有 tokenRef 消失才会重新读盘。 */
  async function token() {
    if (tokenChecked && cachedToken) return cachedToken;
    tokenChecked = true;
    cachedToken = nonEmptyString(tokenOption)
      ? { token: tokenOption.trim(), source: 'direct' }
      : await resolveToken({ tokenRef, credentialsPath, env });
    return cachedToken;
  }

  function requireToken() {
    if (!cachedToken) {
      throw new WeixinTransportError(
        'token-missing',
        `未找到微信机器人凭据（tokenRef=${tokenRef ?? '<未配置>'}，来源：环境变量或 ${credentialsPath}）。`,
      );
    }
    return cachedToken.token;
  }

  function recordError(error, phase) {
    const classification = classifyError(error);
    runtime.lastError = error?.message ?? String(error);
    runtime.lastErrorInfo = {
      code: error?.code ?? 'unknown',
      phase,
      kind: classification.kind,
      retryable: classification.retryable,
      fatal: classification.fatal,
      status: error?.status ?? null,
      providerCode: error?.providerCode ?? null,
      at: Date.now(),
    };
    return classification;
  }

  // --- 端点封装 -----------------------------------------------------------

  /**
   * 长轮询：POST ilink/bot/getupdates（weixin-api.mjs:673-690）。
   * 超时被合成为空批次（Q1）—— 这是本传输层最重要的一个"看起来像 bug 的正常行为"。
   */
  async function getUpdates(signal) {
    try {
      return await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl: normalizedBaseUrl,
        endpoint: 'ilink/bot/getupdates',
        body: { get_updates_buf: state.buf, base_info: baseInfo(settings.botAgent) },
        token: requireToken(),
        timeoutMs: settings.longPollTimeoutMs,
        signal,
        allowUntrustedBaseUrl: settings.allowUntrustedBaseUrl,
      });
    } catch (error) {
      if (error instanceof WeixinTransportError && error.code === 'timeout' && !signal?.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: state.buf };
      }
      throw error;
    }
  }

  async function notifyStart(signal) {
    return await requestJson(fetchImpl, {
      method: 'POST',
      baseUrl: normalizedBaseUrl,
      endpoint: 'ilink/bot/msg/notifystart',
      body: { base_info: baseInfo(settings.botAgent) },
      token: requireToken(),
      timeoutMs: settings.requestTimeoutMs,
      signal,
      allowUntrustedBaseUrl: settings.allowUntrustedBaseUrl,
    });
  }

  async function notifyStop(signal) {
    return await requestJson(fetchImpl, {
      method: 'POST',
      baseUrl: normalizedBaseUrl,
      endpoint: 'ilink/bot/msg/notifystop',
      body: { base_info: baseInfo(settings.botAgent) },
      token: requireToken(),
      timeoutMs: settings.requestTimeoutMs,
      signal,
      allowUntrustedBaseUrl: settings.allowUntrustedBaseUrl,
    });
  }

  // --- 入站处理 -----------------------------------------------------------

  /**
   * 处理一条平台消息。**同步**完成去重记账与派发；写盘在后台串行进行。
   * 顺序很重要：先记账再回调 —— 回调里抛错/进程崩溃都不该导致同一条消息二次投递。
   */
  function handleInbound(raw) {
    // Q3：平台把出站消息回灌进同一路流，用 message_type === 2 标记。
    if (raw?.message_type === 2 && !settings.treatMessageType2AsInbound) return;

    const messageId = weixinMessageId(raw);
    const userId = nonEmptyString(raw?.from_user_id);
    if (!messageId || !userId) return;
    if (state.hasSeen(messageId)) return;
    state.markSeen(messageId);

    // context_token 的捕获**先于**文本过滤：图片/文件消息同样携带可用的对话能力，
    // 丢掉它们会让随后针对该用户的主动发送失去 context_token。
    state.rememberContextToken({
      userId,
      token: raw?.context_token,
      seq: raw?.seq,
      messageTimeMs: raw?.create_time_ms ?? weixinMessageTimestampMs(messageId),
    });

    const text = extractWeixinText(raw);
    const at = toTimestamp(raw?.create_time_ms)
      ?? weixinMessageTimestampMs(messageId)
      ?? Date.now();

    const message = text
      ? { kind: 'text', userId, messageId, text, at, raw }
      : {
          kind: 'unsupported',
          userId,
          messageId,
          text: '',            // 空串而不是 null：调用方 .length / 真值判断都不会炸
          at,
          raw,
          itemTypes: itemTypesOf(raw),
        };

    if (message.kind === 'unsupported' && !settings.forwardUnsupported) return;

    // lastInboundAt 记的是"我们何时收到"（墙钟），与消息自带的 at 区分开：
    // 平台重放旧消息时 at 会很旧，用它判断连接健康度会误判。
    runtime.lastInboundAt = Date.now();
    // 回调异步化但**不 await**：一条慢消息不该阻塞整批派发（与参考实现的
    // `void this.#bridge.accept(message)` 一致）。错误必须就地吞掉，否则会变成
    // unhandledRejection 把宿主进程带走。
    try {
      const result = onMessageHandler(message);
      if (result && typeof result.then === 'function') {
        result.catch((error) => log.error?.('[weixin] onMessage 处理失败：', error));
      }
    } catch (error) {
      log.error?.('[weixin] onMessage 抛出异常：', error);
    }
  }

  // --- 轮询循环 -----------------------------------------------------------

  async function pollLoop(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      let response = null;
      let failure = null;
      try {
        response = await getUpdates(signal);
      } catch (error) {
        failure = error;
      }
      if (signal.aborted) break;
      runtime.pollCount += 1;
      runtime.lastPollAt = Date.now();

      if (failure) {
        const classification = recordError(failure, 'poll');
        runtime.connected = false;
        attempt += 1;
        runtime.consecutiveFailures = attempt;
        log.warn?.(`[weixin] 长轮询失败（第 ${attempt} 次，${classification.kind}）：${runtime.lastError}`);
        if (classification.fatal) {
          runtime.fatal = true;
          log.error?.('[weixin] 平台判定登录凭据失效（ret=-14），停止轮询。请重新绑定机器人。');
          break;
        }
        if (attempt >= settings.maxConsecutiveFailures) {
          log.error?.(`[weixin] 连续失败 ${attempt} 次，放弃轮询。`);
          break;
        }
        try {
          // 不可重试但仍非致命（例如 4xx 客户端错误 / 协议拒绝）：继续跑，但直接退避到上限，
          // 避免把服务端打爆；这类错误通常是配置问题，用户需要从 status() 里看到。
          const wait = classification.retryable
            ? backoffDelay(attempt, settings.backoffBaseMs, settings.backoffMaxMs)
            : settings.backoffMaxMs;
          if (!classification.retryable) {
            log.error?.(`[weixin] 不可重试错误（${runtime.lastErrorInfo.code}），转入 ${wait}ms 慢速重试。`);
          }
          await delay(wait, signal);
        } catch {
          break; // stop() 打断退避
        }
        continue;
      }

      // 平台级拒绝：HTTP 200 但 body 里 ret/errcode 非 0（weixin-runtime.mjs:263-270）。
      const providerCode = rejectedProviderCode(response);
      if (providerCode) {
        const fatal = FATAL_PROVIDER_CODES.has(providerCode);
        const error = new WeixinTransportError(
          fatal ? 'stale-token' : 'updates-rejected',
          fatal ? '微信登录凭据已失效，请重新绑定机器人。' : '微信消息同步请求被拒绝。',
          { providerCode },
        );
        const classification = recordError(error, 'poll');
        runtime.connected = false;
        attempt += 1;
        runtime.consecutiveFailures = attempt;
        if (classification.fatal) {
          runtime.fatal = true;
          log.error?.(`[weixin] ${error.message}（providerCode=${providerCode}）`);
          break;
        }
        log.warn?.(`[weixin] getupdates 被拒绝（providerCode=${providerCode}），退避重试。`);
        try {
          await delay(backoffDelay(attempt, settings.backoffBaseMs, settings.backoffMaxMs), signal);
        } catch {
          break;
        }
        continue;
      }

      attempt = 0;
      runtime.consecutiveFailures = 0;
      runtime.connected = true;
      runtime.lastError = null;
      runtime.lastErrorInfo = null;

      for (const message of orderWeixinMessages(response?.msgs)) {
        if (signal.aborted) break;
        // 单条脏消息绝不能打死整个传输层：平台字段是外部输入，解析失败只丢这一条。
        try {
          handleInbound(message);
        } catch (error) {
          log.error?.('[weixin] 入站消息解析失败，已丢弃该条：', error);
        }
      }

      // Q2：**处理完本批再前移游标**。反过来做的话，处理到一半崩掉会永久跳过消息。
      const nextBuf = response?.get_updates_buf;
      if (typeof nextBuf === 'string' && nextBuf) state.setBuf(nextBuf);
    }
  }

  // --- 对外接口 -----------------------------------------------------------

  return Object.freeze({
    /** 让 start() 之前也能安全读状态文件（例如只调 sendText 的场景）。 */
    async ready() {
      await state.load();
      await token();
      if (cachedToken) state.bindCredential(cachedToken.token);
      return true;
    },

    /**
     * 开始长轮询。
     * - onMessage: (msg) => void | Promise<void>，见文件头契约。
     * - 已在运行：直接返回当前 status（不重复起循环、不更换 handler）。
     * - 返回时**已**完成 notifyStart，循环在后台跑（start 不 await 首次轮询）。
     */
    async start(onMessage) {
      if (typeof onMessage !== 'function') throw new TypeError('start(onMessage): onMessage 必须是函数');
      if (runtime.running) {
        log.warn?.('[weixin] start() 被重复调用，忽略新的 onMessage，返回当前状态。');
        return this.status();
      }
      await state.load();
      const resolved = await token();
      if (!resolved) {
        throw new WeixinTransportError(
          'token-missing',
          `未找到微信机器人凭据（tokenRef=${tokenRef ?? '<未配置>'}）：请检查环境变量或凭据文件 ${credentialsPath}。`,
        );
      }
      state.bindCredential(resolved.token);

      controller = new AbortController();
      const signal = controller.signal;
      onMessageHandler = onMessage;
      runtime.running = true;
      runtime.connected = false;
      runtime.fatal = false;
      runtime.consecutiveFailures = 0;
      runtime.startedAt = Date.now();
      runtime.lastError = null;
      runtime.lastErrorInfo = null;
      log.info?.(`[weixin] 启动长轮询 bot=${botId ?? '?'} base=${normalizedBaseUrl} token来源=${resolved.source}`);

      if (settings.notifyOnStart) {
        // notifystart 失败不影响轮询本身；参考实现会对可重试错误做 250/1000/3000ms 重试
        // （weixin-runtime.mjs:16,234-250），这里保留同样的节奏（可用 startRetryDelaysMs 覆盖）。
        const startRetryDelays = settings.startRetryDelaysMs;
        for (let attempt = 0; ; attempt += 1) {
          try {
            const response = await notifyStart(signal);
            const providerCode = rejectedProviderCode(response, ['errcode', 'ret']);
            if (providerCode) {
              // 与参考实现一致（weixin-api.mjs:817）：只有 -14 说明凭据失效，其余都只是"启动没成功"。
              throw new WeixinTransportError(
                providerCode === '-14' ? 'stale-token' : 'start-rejected',
                '微信账号连接启动失败。',
                { providerCode },
              );
            }
            break;
          } catch (error) {
            if (signal.aborted) throw abortError(signal);
            const classification = classifyError(error);
            if (classification.fatal) {
              controller?.abort();
              controller = null;
              runtime.running = false;
              throw error;
            }
            const wait = startRetryDelays[attempt];
            if (wait === undefined) {
              // 重试用尽：仍然开始轮询（长轮询本身就能发现 token 失效），只记录警告。
              log.warn?.(`[weixin] notifystart 未成功（${error?.code ?? error}），继续轮询。`);
              break;
            }
            log.warn?.(`[weixin] notifystart 重试（${wait}ms）：${error?.message ?? error}`);
            await delay(wait, signal);
          }
        }
      }

      const thisLoop = pollLoop(signal)
        .catch((error) => {
          if (!signal.aborted) log.error?.('[weixin] 轮询循环异常退出：', error);
        })
        .finally(() => {
          runtime.running = false;
          runtime.connected = false;
          // 只有仍是"当前这次循环"时才清空句柄，避免 stop()→start() 交错时误清新循环。
          if (loopPromise === thisLoop) loopPromise = null;
        });
      loopPromise = thisLoop;

      return this.status();
    },

    /**
     * 发送文本。**永不抛异常**，一律返回结果对象：
     *   成功 → { ok:true, messageId, contextTokenUsed }
     *   失败 → { ok:false, code, message, providerCode?, status? }
     * 不要求 start() 已调用（主动投递场景只需 token + context_token）。
     */
    async sendText(userId, text) {
      const recipient = nonEmptyString(userId);
      const content = nonEmptyString(text);
      if (!recipient || !content) {
        return { ok: false, code: 'invalid-argument', message: 'sendText(userId, text)：两者都必须是非空字符串。' };
      }
      await state.load();
      let tokenValue;
      try {
        const resolved = await token();
        if (!resolved) throw new WeixinTransportError('token-missing', '未找到微信机器人凭据。');
        tokenValue = resolved.token;
        state.bindCredential(tokenValue); // 凭据变了会在内存里作废所有 context_token
      } catch (error) {
        return { ok: false, code: error?.code ?? 'token-missing', message: error?.message ?? String(error) };
      }

      const contextToken = state.contextTokenFor(recipient);
      // client_id 既是幂等键也是回执 id（weixin-api.mjs:743）。
      const clientId = `dsh-weixin-${randomUUID()}`;
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: recipient,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: content } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: baseInfo(settings.botAgent),
      };

      let response;
      try {
        response = await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl: normalizedBaseUrl,
          endpoint: 'ilink/bot/sendmessage',
          body,
          token: tokenValue,
          timeoutMs: settings.requestTimeoutMs,
          // 用运行中的 signal 让 stop() 也能中断发送；没在跑就用独立超时。
          signal: controller?.signal,
          allowUntrustedBaseUrl: settings.allowUntrustedBaseUrl,
        });
      } catch (error) {
        const code = error?.name === 'AbortError' ? 'aborted' : (error?.code ?? 'unknown');
        recordError(error, 'send');
        return {
          ok: false,
          code,
          message: error?.message ?? String(error),
          ...(error?.status !== undefined ? { status: error.status } : {}),
        };
      }

      const providerCode = rejectedProviderCode(response);
      if (providerCode) {
        const error = new WeixinTransportError('send-rejected', '微信服务拒绝了回复消息。', { providerCode });
        recordError(error, 'send');
        return { ok: false, code: 'send-rejected', message: error.message, providerCode };
      }

      runtime.lastOutboundAt = Date.now();
      if (runtime.lastErrorInfo?.phase === 'send') {
        runtime.lastError = null;
        runtime.lastErrorInfo = null;
      }
      return { ok: true, messageId: clientId, contextTokenUsed: Boolean(contextToken), response };
    },

    /**
     * 发送一个文件。**永不抛异常**，返回形状与 sendText 一致。
     *
     * 协议以官方 openclaw-weixin v2.4.6 源码为准
     * （src/cdn/upload.ts、src/cdn/cdn-upload.ts、src/messaging/send.ts）。
     * 三步，不是一条消息：
     *   1. POST ilink/bot/getuploadurl —— 拿上传地址。请求同时带**明文**
     *      rawsize/rawfilemd5 与**密文** filesize，`aeskey` 是密钥的 **hex** 串，
     *      文件无缩略图要显式 `no_need_thumb: true`，`filekey` 是客户端现生成的
     *      随机 16 字节 hex（不是文件名）。
     *   2. POST 密文到 CDN（AES-128-ECB + PKCS#7）。注意是 **POST 不是 PUT**；
     *      真正的下载参数在响应头 `x-encrypted-param`，**不在 body**。
     *   3. POST ilink/bot/sendmessage —— `type: 4` + `file_item`
     *      `{ media: {encrypt_query_param, aes_key, encrypt_type:1}, file_name, len }`。
     *      这里 `media.aes_key` 是 **base64(hex 字符串)**（与第 1 步的纯 hex 不同），
     *      `len` 是**明文字节数的字符串**。
     */
    async sendFile(userId, filePath) {
      const recipient = nonEmptyString(userId);
      if (!recipient) {
        return { ok: false, code: 'invalid-argument', message: 'sendFile(userId, filePath)：userId 必须是非空字符串。' };
      }
      const target = nonEmptyString(filePath);
      if (!target) {
        return { ok: false, code: 'invalid-argument', message: 'sendFile(userId, filePath)：filePath 必须是非空字符串。' };
      }

      let plain;
      let fileStat;
      try {
        fileStat = await stat(target);
        if (!fileStat.isFile()) {
          return { ok: false, code: 'not-a-file', message: `不是一个文件：${target}` };
        }
        // 上限来自协议侧而不是我们的偏好：整段文件要读进内存再加密上传，
        // 无上限会让一次误发大文件把宿主内存吃光。
        if (fileStat.size > MAX_FILE_BYTES) {
          return {
            ok: false,
            code: 'file-too-large',
            message: `文件 ${fileStat.size} 字节，超过上限 ${MAX_FILE_BYTES} 字节（${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB）。`,
          };
        }
        if (fileStat.size === 0) {
          return { ok: false, code: 'empty-file', message: `文件是空的：${target}` };
        }
        plain = await readFile(target);
      } catch (error) {
        return { ok: false, code: error?.code ?? 'read-failed', message: `读取文件失败：${error?.message ?? error}` };
      }

      await state.load();
      let tokenValue;
      try {
        const resolved = await token();
        if (!resolved) throw new WeixinTransportError('token-missing', '未找到微信机器人凭据。');
        tokenValue = resolved.token;
        state.bindCredential(tokenValue);
      } catch (error) {
        return { ok: false, code: error?.code ?? 'token-missing', message: error?.message ?? String(error) };
      }

      const fileName = basename(target);
      const plainMD5 = createHash('md5').update(plain).digest('hex');
      // filekey 由客户端现生成（16 字节 hex），**不是**文件名：它在上传 URL 里当
      // 参数用，文件名走 file_item.file_name。用文件名会撞上 URL 编码和重名。
      const filekey = randomBytes(16).toString('hex');
      const aesKey = randomBytes(16);
      let cipher;
      try {
        cipher = encryptEcb(plain, aesKey);
      } catch (error) {
        return { ok: false, code: 'encrypt-failed', message: `加密文件失败：${error?.message ?? error}` };
      }

      // --- 1. 预签名上传地址 ---------------------------------------------
      // getuploadurl 的 aeskey 是**16 字节密钥的 hex 字符串**（官方 upload.ts:
      // `aeskey.toString("hex")`）。传 base64 会被平台判为非法参数（ret=-1）。
      // 文件没有缩略图，`no_need_thumb: true` 必须显式给出。
      let uploadParam = null;
      let uploadFullUrl = null;
      const uploadRequestBody = {
        filekey,
        media_type: UPLOAD_MEDIA_TYPE_FILE,
        to_user_id: recipient,
        rawsize: fileStat.size,
        rawfilemd5: plainMD5,
        filesize: cipher.length,
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
        base_info: baseInfo(settings.botAgent),
      };
      try {
        const response = await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl: normalizedBaseUrl,
          endpoint: 'ilink/bot/getuploadurl',
          body: uploadRequestBody,
          token: tokenValue,
          timeoutMs: settings.requestTimeoutMs,
          signal: controller?.signal,
          allowUntrustedBaseUrl: settings.allowUntrustedBaseUrl,
        });
        const providerCode = rejectedProviderCode(response);
        if (providerCode) {
          // 平台只说 ret，不说为什么。把 errmsg 带出来——排查 getuploadurl
          // 参数错误时，这是唯一能区分「字段名不对」和「值不合法」的线索。
          const providerMessage = nonEmptyString(response?.errmsg) ?? null;
          recordError(new WeixinTransportError('upload-rejected', '微信服务拒绝了上传请求。', { providerCode }), 'send');
          return {
            ok: false,
            code: 'upload-rejected',
            message: providerMessage
              ? `微信服务拒绝了上传请求：${providerMessage}`
              : '微信服务拒绝了上传请求（平台未给出 errmsg）。',
            providerCode,
            providerMessage,
            // 请求体里没有任何密钥（aeskey 是本次现生成、只对这一个文件有效），
            // 回显它能让调用方直接看出是哪个字段被拒。
            sentFields: Object.keys(requestBody),
          };
        }
        uploadFullUrl = nonEmptyString(response?.upload_full_url);
        uploadParam = nonEmptyString(response?.upload_param);
      } catch (error) {
        const code = error?.name === 'AbortError' ? 'aborted' : (error?.code ?? 'unknown');
        recordError(error, 'send');
        return { ok: false, code, message: error?.message ?? String(error) };
      }
      // --- 2. POST 密文到 CDN --------------------------------------------
      // 官方 cdn-upload.ts：**POST**（不是 PUT），且只带 Content-Type。
      // 服务端优先给 upload_full_url；没有才自己拼 /c2c/upload?encrypted_query_param=&filekey=。
      // 关键：真正的**下载**参数在响应头 `x-encrypted-param` 里，不在 body。
      // 拿 body 里的 upload_param 当下载参数发出去，微信那头就打不开文件。
      const uploadUrl = uploadFullUrl
        ?? (uploadParam
          ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
          : null);
      if (!uploadUrl) {
        recordError(new WeixinTransportError('upload-no-url', 'getuploadurl 没有返回上传地址。'), 'send');
        return { ok: false, code: 'upload-no-url', message: 'getuploadurl 没有返回上传地址。' };
      }

      let downloadParam;
      try {
        const uploadResponse = await fetchImpl(uploadUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: cipher,
          signal: controller?.signal,
        });
        if (!uploadResponse?.ok) {
          const detail = uploadResponse?.headers?.get?.('x-error-message') ?? '';
          const error = new WeixinTransportError(
            'upload-http-error',
            `上传文件失败（HTTP ${uploadResponse?.status ?? '?'}${detail ? `：${detail}` : ''}）`,
            { status: uploadResponse?.status },
          );
          recordError(error, 'send');
          return { ok: false, code: 'upload-http-error', message: error.message, status: uploadResponse?.status };
        }
        downloadParam = nonEmptyString(uploadResponse?.headers?.get?.('x-encrypted-param'));
        if (!downloadParam) {
          const error = new WeixinTransportError(
            'upload-no-param',
            'CDN 上传成功但响应头缺少 x-encrypted-param，无法构造文件引用。',
          );
          recordError(error, 'send');
          return { ok: false, code: 'upload-no-param', message: error.message };
        }
      } catch (error) {
        const code = error?.name === 'AbortError' ? 'aborted' : (error?.code ?? 'unknown');
        recordError(error, 'send');
        return { ok: false, code, message: error?.message ?? String(error) };
      }

      // --- 3. 发消息 ------------------------------------------------------
      const contextToken = state.contextTokenFor(recipient);
      // 没有 context_token 的一条会被平台接受再静默丢弃（与 sendText 同一个坑）。
      if (!contextToken) {
        return {
          ok: false,
          code: 'no-context-token',
          message: '微信会话尚未建立：需要对方先在微信里发一条消息（机器人无法主动发起会话）。',
        };
      }
      const clientId = `dsh-weixin-${randomUUID()}`;
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: recipient,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          // 官方 FileItem：{ media: CDNMedia, file_name, len }。
          // `media.aes_key` 是 **base64(hex 字符串)**（官方 send.ts:
          // `Buffer.from(uploaded.aeskey).toString("base64")`，而 aeskey 本身是 hex）——
          // 与 getuploadurl 里的纯 hex 不同，别照抄。
          // `len` 是**明文字节数的字符串**，不是数字字段 file_size。
          item_list: [{
            type: 4,
            file_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64'),
                encrypt_type: 1,
              },
              file_name: fileName,
              len: String(fileStat.size),
            },
          }],
          context_token: contextToken,
        },
        base_info: baseInfo(settings.botAgent),
      };

      let response;
      try {
        response = await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl: normalizedBaseUrl,
          endpoint: 'ilink/bot/sendmessage',
          body,
          token: tokenValue,
          timeoutMs: settings.requestTimeoutMs,
          signal: controller?.signal,
          allowUntrustedBaseUrl: settings.allowUntrustedBaseUrl,
        });
      } catch (error) {
        const code = error?.name === 'AbortError' ? 'aborted' : (error?.code ?? 'unknown');
        recordError(error, 'send');
        return { ok: false, code, message: error?.message ?? String(error) };
      }

      const providerCode = rejectedProviderCode(response);
      if (providerCode) {
        const error = new WeixinTransportError('send-rejected', '微信服务拒绝了这条文件消息。', { providerCode });
        recordError(error, 'send');
        return { ok: false, code: 'send-rejected', message: error.message, providerCode };
      }

      runtime.lastOutboundAt = Date.now();
      if (runtime.lastErrorInfo?.phase === 'send') {
        runtime.lastError = null;
        runtime.lastErrorInfo = null;
      }
      return {
        ok: true,
        messageId: clientId,
        contextTokenUsed: true,
        fileName,
        fileSize: fileStat.size,
        response,
      };
    },

    /**
     * 停止：abort 在途请求 → 等循环退出 → 冲刷状态写盘 → 通知平台。
     * 幂等；未启动时调用也安全。
     */
    async stop() {
      const wasRunning = runtime.running || Boolean(controller);
      const currentController = controller;
      const currentLoop = loopPromise;
      controller = null;
      loopPromise = null;
      currentController?.abort();
      if (currentLoop) await currentLoop.catch(() => undefined);
      await state.flush();
      runtime.running = false;
      runtime.connected = false;
      if (wasRunning && settings.notifyOnStop && cachedToken) {
        try {
          // 10s 独立超时：此时控制器已经 abort，不能复用旧 signal。
          await notifyStop(AbortSignal.timeout(10_000));
        } catch (error) {
          // 平台没确认停止不算错误（weixin-runtime.mjs:317-328 同样只收进 warnings）。
          log.warn?.(`[weixin] notifystop 未成功：${error?.message ?? error}`);
        }
      }
      return undefined;
    },

    /** 只读状态快照。契约字段：connected / lastInboundAt / lastOutboundAt / lastError / pollCount。 */
    status() {
      return {
        connected: runtime.connected,
        lastInboundAt: runtime.lastInboundAt,
        lastOutboundAt: runtime.lastOutboundAt,
        lastError: runtime.lastError,
        pollCount: runtime.pollCount,
        // --- 扩展字段（便于排障，不参与契约） ---
        running: runtime.running,
        fatal: runtime.fatal,
        startedAt: runtime.startedAt,
        lastPollAt: runtime.lastPollAt,
        consecutiveFailures: runtime.consecutiveFailures,
        lastErrorInfo: runtime.lastErrorInfo ? { ...runtime.lastErrorInfo } : null,
        botId,
        accountId,
        statePath,
        contextTokenCount: state.contextTokenCount(),
      };
    },

    /** 状态快照（不含 token 明文，可安全落日志）。 */
    stateSnapshot() {
      return state.snapshot();
    },
  });
}

function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampLimit(value, fallback, hardMax) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), hardMax);
}
