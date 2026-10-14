# dsh-wechat-box —— 设计文档

> 状态：**阶段 2 已上线（2026-10-14 12:59 重启后运行中；A1–A11 真机验证待逐项走）**
> 决策日期：2026-10-14
> 目标：自建微信插件，替换 `@xmanrui/dsh-im`

---

## 0. 当前状态（2026-10-14 12:4x，每轮更新）

| 项 | 状态 |
|---|---|
| 代码 | ✅ 5 个模块全写完（transport / harness / router / lib 宿主 / lib 客户端） |
| 测试 | ✅ **125 项全绿 / 10 套件**（manifest 6 · router 11 · transport 17 · harness 13 · questions 15 · approvals 12 · host 22 · client 8 · integration 13 · e2e 8） |
| R7 提问 + 审批往返 | ✅ **均已实现 + 测试**（A10 / A11） |
| 真网验证（发送路径） | ✅ **已实测通过** —— `transport/live-probe.mjs --send` 返回 `{ok:true, contextTokenUsed:true}`；token 的 sha256 与 dsh-im 记录的 `credentialHash` 一致 |
| 真网验证（长轮询） | ❌ 未验证 —— 不能抢 dsh-im 的游标，只能等阶段 2 |
| 传输层状态文件 | ✅ 已用 dsh-im 的 `context_token`（seq=30）**播种**，阶段 2 起即可主动发送 |
| 安装 | ✅ 阶段 1 已装（junction + bundles）；客户端 bundle **已确认在宿主图里**（`/plugins` 探针 200） |
| 安全阀 | 🔒 `weixinEnabled: false` —— 新插件不接微信，微信仍由 dsh-im 服务 |
| 迁移工具 | ✅ `migrate.ps1 -Check / -Phase1 / -Phase2 / -Rollback` |

**本轮修掉的两个真 bug**（都是靠测试/侦察发现的，不是猜的）：

1. **路由注册顺序**：`apply` 原本把 HTTP 路由注册排在加载 transport/bridge 之后。
   一旦那步抛错，`apply` 中止 → 路由永不出现（所有请求 401），**而宿主仍公告客户端半边**，
   于是失败从外面完全看不见。现在路由**最先**注册，并且把 setup 失败收进 `applyError`
   由状态路由报出来。回归测试已固化。
2. **`transportReady` 撒谎**：`start()` 抛错时 `transport` 对象仍存在，
   旧的判定 `transport !== null && transportError === null` 会报「就绪」——
   一个死掉的桥看起来是健康的。现在用独立的 `transportStarted` 判定。

**阻塞点**：插件要真正加载必须**重启 DSH**。侦察曾观察到一次热重载（12:08，包名集合变化），
但我随后用「调序 / 先删后加」两种方式都**无法复现**，所以不依赖它。
重启后按 §8.5 的判读流程走（**401 ≠ 页面问题**，是宿主没注册路由）。

**修正（2026-10-14 12:2x）**：先前根据 README 判断「宿主启动时快照 `client.js`，改动只能靠 HMR 钩子」
**是错的**。实测：`/plugins` 探针按**当前文件**的 mtime/ctime/size 现算 rev 并请求，
宿主返回 **200**（rev 随文件改动而变）。
→ **客户端改动不需要重启宿主，刷新页面即可**；只有宿主半边（ESM 已被 import）需要重启。
→ 因此「按钮是否渲染」可以**零成本**验证：按 F5，看会话标题右侧有没有「微信」胶囊。

**迁移脚本已干跑验证**：`test-migrate.ps1` 在临时副本上跑 `-Phase2` → `-Rollback`，
15 项断言全过，并断言**真实 profile 全程未被触碰**。
（干跑时抓到 `migrate.ps1` 一个真 bug：`$PluginDir` 参数与计算出的 `$pluginDir`
在 PowerShell 里是**同一个变量**（变量名大小写不敏感），junction 路径会静默覆盖包位置；
已把参数改名为 `$PluginRoot`。）

**阶段 2 的硬约束**：`weixinEnabled: true` 与「从 bundles 移除 `@xmanrui/dsh-im`」
**必须在同一次重启生效** —— 两个长轮询消费者会互相抢消息、共享同一游标。
`migrate.ps1 -Phase2` 把这两步绑在一起，并自动备份。

**2026-10-14 12:59 更新：阶段 2 已上线，并抓到+修掉第三个真 bug（BOM 启动崩溃）**。
`-Phase2` 在 12:51 运行后，DSH 连续 5 次启动崩溃
（`crash-2026-10-14T04-52~04-56*host.log`：`Unexpected token '\uFEFF'` @ `readProfileManifest`）：
PS 5.1 的 `Set-Content -Encoding UTF8` **会写 BOM**，而宿主对 `package.json` 做的是
逐字节 `JSON.parse`，BOM 即语法错误 → 宿主启动即死（阶段 1 没踩到，是因为当时
`dsh-wechat-box` 已在 bundles 里、`Set-Bundles` 被跳过；`-Phase2` 第一次真正重写该文件）。
修复三件事：
1. `profiles/desktop/package.json` 与插件 `cordis.patch.yml` 已重写为**无 BOM**（内容不变，阶段 2 配置保留）；
2. `migrate.ps1` 的 `Set-Bundles`/`Set-Valve` 一律改走 `Write-Utf8NoBom`（禁止 `Set-Content` 写这两个文件）；
3. `test-migrate.ps1` 增加 **BOM 字节级断言**（修复前 2 项红 → 修复后 18/18 绿），
   并把「live 未被触碰」断言改为**前后字节快照对比**，不再硬编码阶段（此前硬编码阶段 1，阶段 2 落地即过期）。

12:59 重启验证：无新 crash；`/api/dsh-wechat-box/state` → 200，
`weixinEnabled: true`（bundle-config）、transport `connected`（pollCount 增长）、
`questionsRegistered`/`approvalsRegistered` 均 true、无 `applyError`。
**副作用提醒**：dsh-im 已停用 → `dsh-wechat-push.ps1` 的 dsh-im 直连推送不再可用，
推送改走新插件的「选中会话」模型（微信发消息→回数字选中）。

---

## 1. 已确认的需求（用户原话 → 精确语义）

> 「一个开关，开关打开就启用微信 box，当前对话就跟微信 BOX 连通，可以互发消息，
> 开关关闭则只能微信选定对话发送消息，选定对话后对应对话的开关自动打开，
> 然后现在的微信插件就不要了」

翻译成可实现的规则：

| # | 规则 | 精确语义 |
|---|---|---|
| R1 | 每个对话一个开关 | 开关状态按 **sessionId** 持久化，默认**关** |
| R2 | 开关开 = 双向连通 | 该对话的助手输出 → 微信；微信来的消息 → **投喂进该对话** |
| R3 | 开关关 = 只能微信侧单向发 | 微信仍可**选中**该对话并单向下发一条消息；但该对话的输出**不**回微信 |
| R4 | 选中即开启 | 微信侧选中编号 N 后，第 N 个对话的开关**自动置为开**（此后按 R2 双向） |
| R5 | 微信侧选对话 | 向机器人发**任意消息** → 回**编号对话列表** → 回复**数字**选中 |
| R6 | 替换 dsh-im | 新插件验证通过后停用 `@xmanrui/dsh-im` |
| R7 | 提问也要能远程答 | 宿主发起的 `ask_user_question`（交互式提问）必须推到微信，且**在微信回数字/文字就能作答**；审批同理。这是用户明确抱怨过的痛点。 |

**同一时刻只有一个对话处于"选中"态**（R5 的语义），但 R1 说每个对话各有一个开关——
因此：**"选中"= 把开关切到该对话并关掉其它对话**（单选模型）。这是对 R1+R4 的自然统一。

---

## 2. 为什么必须自建传输层（调研结论，含证据）

原本想「保留 dsh-im 的连接，只换交互层」，**不可行**：

1. `ctx.dshIm` 是 `Object.freeze()` 过的门面，**没有**任何 session 绑定 API
   （`plugin-src/host/index.mjs:93-107`：只暴露 consumeInbound / replyChecked /
   describeBot / sendChecked / send / listTargets / listBots）。
2. 绑定状态确实存在普通 JSON 里
   （`integrations/dsh-weixin/accounts/<botId>/state.json` → `sessions["p2p:<uid>@im.wechat"]`），
   但 `src/channels/weixin/state-store.mjs` 把它**整体读进内存 `#state`**（`load()` L123-125），
   每次改动 `#persist()` **全量覆写**（L283-289）。
   → 外部改文件会被覆盖，且不重启不生效。**无法用开关驱动绑定。**
3. `consumeInbound`（独占收消息）**只支持飞书/Lark**
   （`PROACTIVE_DELIVERY.md:360`），微信实现此契约前一律返回 `capability-unavailable`。
   → 无法"只借传输、自己路由"。

**结论**：要拥有路由，就必须拥有传输。微信传输层规模：
`weixin-api 34KB + weixin-bridge 57KB + weixin-controller 27KB + weixin-runtime 15KB +
state-store 10KB + config-store 7KB + connection-error 26KB ≈ 178 KB / 10 模块`。
（MIT 许可，可移植。）

---

## 3. 架构

```
┌─────────────────────── DSH Host 进程 ───────────────────────┐
│                                                              │
│  dsh-wechat-box（新插件，本仓库）                             │
│   ├─ transport/   微信 iLink 长轮询 + 发消息 + 登录态         │
│   ├─ router/      开关状态 + 会话投喂 + 回合回传              │
│   ├─ picker/      编号列表 / 数字选中 / 选中即开启            │
│   └─ http/        给浏览器半用的同源路由（开关读写）          │
│                                                              │
│  @xmanrui/dsh-im  ← 验证通过后从 profile bundles 移除         │
└──────────────────────────────────────────────────────────────┘
              ▲                                    ▲
              │ 长轮询                              │ 同源 fetch
              ▼                                    │
   https://ilinkai.weixin.qq.com/           DSH Web 客户端
        （微信机器人）                        （会话标题右侧开关）
```

### 3.1 状态模型

`<DSH_HOME>/storages/wechat-box.json`：

```jsonc
{
  "version": 1,
  "selectedSessionId": "<session-id>",    // R5 的"当前选中"，单选
  "sessions": {
    "<session-id>": { "enabled": true, "title": "<会话标题>", "updatedAt": 0 }
  },
  "weixin": {                              // 传输层自己的状态
    "cursor": "…",                         // 长轮询游标
    "contextTokens": { "<userId>@im.wechat": { "token": "…", "seq": "…" } }
  }
}
```

> 与 dsh-im 的 `state.json` 分开存，互不干扰；迁移时不需要搬数据。

### 3.2 微信侧交互（R5）

| 用户动作 | 机器人回应 |
|---|---|
| 发任意非数字文本（无选中态） | 编号列表：`1. <会话标题>（<工作区>）…` + 「回复数字选择」 |
| 回复数字 `N` | 选中第 N 个会话 → **该会话开关自动置开**（其余置关）→ 回「已切到 N. <标题>，现在可以对话了」 |
| 数字越界 / 无会话 | 回错误 + 重发列表 |
| `/list`（可选别名） | 强制重发列表 |
| `/off`（可选别名） | 关闭当前选中会话的开关，停止回传 |

### 3.3 DSH 侧开关（R1/R2）

- 位置：会话标题右侧（插槽 `conversation.session.header.actions`）
- 后端：同源 HTTP 路由（`GET /api/dsh-wechat-box/state`、`POST /api/dsh-wechat-box/toggle`）
- 开 → 该会话成为选中项并启用双向；关 → 停用
- **必须带自诊断信标**（见 §5）

---

## 4. 迁移与回滚（R6）

**绝不先拆后建。** 顺序：

1. 新插件并行开发，**不动** dsh-im。
2. `@xmanrui/dsh-im` 的微信通道先停用（从 profile bundles 移除 / 或断开该机器人账号），
   让长轮询只有一个消费者（两个消费者会互相抢消息）。
3. 验证 R1–R5 全部通过后再正式移除依赖。
4. 任意一步出问题 → 用还原点回滚。

**还原点**（已于 2026-10-14 12:00 建立）：
`<repo>\_baseline\dsh-weixin-<YYYYMMDD-HHMMSS>\`
含 `integrations-dsh-weixin/`（含账号 state.json）、`integrations-dsh-im/`、
`profile-package.json`、`profile-cordis.patch.yml`。
凭据在 `~/.dsh/.credentials.yaml` → `DSH_WEIXIN_BOT_TOKEN_<BOT-ID>`（未动）。

**基线已确认可用**：2026-10-14 12:00 主动投递实测 `{"sent":true}`。

---

## 5. 已知未解问题（侦察中）

| # | 问题 | 负责 |
|---|---|---|
| Q1 | 微信 iLink 协议：端点 / 鉴权 / 长轮询循环 / 消息结构 / `context_token` 生命周期 / 错误码 | 侦察 A |
| Q2 | 宿主 API：如何向**指定 sessionId** 投喂用户消息；如何枚举会话；如何区分消息来源 | 侦察 B |
| Q3 | 静态 bundle 的客户端半边为何没加载；`__ModuleLoader__` 与 slot 注册的确切契约 | 侦察 C |

**Q3 附带症状**：已装的 `dsh-wechat-notify` 宿主半边工作正常
（`GET /api/dsh-wechat-notify/state` → `{"ok":true,…}`），但会话标题右侧的按钮没渲染。
新插件必须**先解决这个**，否则开关无处可放。

---

## 6. 验收标准

- [ ] A1 微信发任意消息 → 收到编号列表，内容与 DSH 里真实会话一致
- [ ] A2 回数字 N → 该对话开关自动开、其余自动关，且微信收到确认
- [ ] A3 开关开的对话：DSH 里跑一个任务 → 回合结束微信收到最终回答
- [ ] A4 开关开的对话：微信发消息 → 进入该对话并被处理，回答回到微信
- [ ] A5 开关关的对话：任务结束**不**推微信；但微信选中后单向下发一条仍能进入该对话
- [ ] A6 DSH 网页上开关可见、可点、状态与微信侧一致（刷新后仍正确）
- [ ] A7 DSH 重启后：登录态恢复、开关状态保留、不需要重新扫码/绑定
- [ ] A8 停用 dsh-im 后 A1–A7 全部仍然通过
- [ ] A9 回滚演练：用还原点能恢复原状
- [ ] A10 **提问往返**：宿主发起 `ask_user_question` → 微信收到问题与选项 → 在微信回「1」→ 该问题被作答，宿主继续跑（R7）
- [ ] A11 审批往返：沙箱提权等审批 → 微信收到 → 回「批准」生效

---

## 8. DSH 客户端插件的硬约束（已查证，2026-10-14）

来自 `@deepseek-ai/dsh-client-modules`（`cordis.patch.yml` L205-215 与 README.zh.md）：

1. 浏览器插件清单（`window.__DSH_BOOT__`）由宿主**扫描已启用的 Loader 条目**的 `dsh.client` 声明组合而成；
   我插件的宿主半边能工作，证明条目已挂载，声明也已通过校验。
2. **宿主在发布前会「快照」每个 `client.js` 入口**，且「bundle 内容变更**只能**通过
   `rebuilt()`（HMR 钩子）进入图」。
   → **改客户端代码后必须重启 DSH 才生效**；仅有 `pnpm run dev:web` 在跑时才有 HMR。
   → 因此：**客户端改动要攒批，一次重启验完所有改动**。
3. bundle 通过 requirejs 风格的 combo 路由提供：
   `/plugins/??<pkg>/client.js&rev=<rev>`（绝对形式）或文档相对形式 `plugins/??…&rev=…`。
   逐插件 revision 由入口的 `mtimeMs/ctimeMs/size` 派生。
   → 探活时**不要**去请求 `/plugins/<pkg>/client.js`（我试过，对 dsh-im 也 404）。
4. `dsh.client` 声明经 `parseDshClient` 校验：`platform`（必填字符串）、
   `inject`（字符串数组）、`external`（字符串数组）、`immediately`（布尔）。
   四项之外的多余字段不会被校验，但也不生效。
5. **自诊断信标是必须的**：由于每次验证都要重启，客户端半边必须在
   `lib/client.js` 求值的第一时间、以及注册成功/失败三处，向宿主已有路由回报状态
   （用哨兵 sessionId 走 `POST /api/dsh-wechat-box/toggle`），这样一次重启就能定位：
   是 bundle 没加载、注册被拒、还是组件渲染成 null。

---

## 7. 工程约束（本机）

- shell 是 **Windows PowerShell 5.1**；带中文的 `.ps1` 必须 UTF-8 **with BOM**
- **PATH 是坏的** → 一律绝对路径（node 在
  `<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）
- 宿主插件改动**必须重启 DSH** 才生效；重启会中断当前会话（会话记录持久化，可恢复）
- 开发用 junction：`profiles/desktop/node_modules/<pkg>` → `<workspace-root>\<pkg>`，改完即改源码
  - ⚠️ 侦察提醒：junction 没有对应的 `dependencies` manifest 条目时，
    **下一次任何 pnpm / 插件市场操作可能把它当垃圾清理掉**。真出现就重跑 `migrate.ps1 -Phase1`。

---

## 8.5 重启后的判读流程（阶段 1 验收）

| 现象 | 含义 | 下一步 |
|---|---|---|
| `GET /api/dsh-wechat-box/state` → **401** | **宿主半边没注册路由**（不是页面问题！） | 查 `apply` 是否抛错 / bundle 是否被 `skippedBundles` 丢掉 |
| 200 且 `applyError` 非空 | 插件自己说出了失败原因 | 照 `applyError` 修 |
| `beacon` 有 `eval` + `registered` | 开关已注册，页面上应能看见 | 看按钮是否在会话标题右侧 |
| `beacon` 只有 `error` | 槽位注册被拒，`error` 是原因 | 照 error 修 |
| `beacon` **空** | 页面里客户端半边没跑起来 | 看「设置 → 插件 → 插件列表」的「当前页面的同步失败」 |
| `transportError` = `disabled by config` | 安全阀生效，微信未受影响 | 符合阶段 1 预期 |

`/plugins/??dsh-wechat-box/client.js&rev=<rev>`（无鉴权）返回 200 = 宿主确实公告了这个 bundle。
探针脚本：`<workspace-root>\_recon\probe2.mjs`。

---

## 9. R7 实现方案（下一片：微信里答提问 / 审批）

**钩子已确证**（`dsh-im/plugin-src/host/modern-harness-api.mjs:277-286`）：

```js
ctx.on('approval/request',       (request, next) => this.#requestApproval(request, next),
       { global: true, prepend: true });
ctx.on('user-questions/request', (request, next) => this.#requestQuestion(request, next),
       { global: true, prepend: true });
```

两个都是 **waterfall** 事件（收 `next`）：不调 `next()` 即由自己作答；调 `next()` 交给下一个处理者。
dsh-im 用 `prepend: true` 抢到链首。

**⚠️ 冲突风险**：阶段 1 期间 dsh-im 仍在链上且抢先。若我也抢先注册，两方会争同一个请求。
**因此本片必须用 `weixinEnabled` 同一把锁门控**：安全阀关着就**绝不注册**这两个处理器。
（做不到「和平共处」，只能二选一 —— 这也符合阶段 2 的整体切换。）

**实现前需要读清的**：
1. `#requestQuestion(request, next)` / `#requestApproval(request, next)` 的 `request` 形状与
   **作答返回值**（approval 的帧形状见 `modern-harness-api.mjs:633-646`；question 的在 `#questionFrame`）。
2. 微信侧「回复序号 → 对应 pending 问题」的映射（需要 pending 表 + 超时）。
3. 取消路径：宿主取消提问时必须把微信侧的等待一并收掉，否则用户回的数字会**错配到下一个问题**。
4. 验收：§6 的 **A10 / A11**（提问往返、审批往返）。

**验收状态**：A1–A4 有测试覆盖（router + host + integration + e2e）；
A5–A9 待阶段 2 真机验证；**A10（提问往返）已实现**，A11（审批往返）未实现。

### 9.1 提问（A10）—— 已实现

- `harness/questions.mjs`：纯函数（`validHarnessQuestion` / `questionText` / `questionsText` /
  `answerForQuestion` / `isListRequest`）+ `createQuestionBridge`（pending 表 + waterfall 处理器）。
  渲染与文字→答案的解析**移植自** `dsh-im/src/channels/shared/harness-question.mjs`（MIT），
  去掉了 i18n 间接层。
- 答案形状确证：`{ answers: [{ id, selected: [label], custom? }] }`
  —— **`selected` 存的是选项 label，不是序号**（`text-harness-bridge.mjs:1415`）。
- 与宿主的**竞速**语义：同时挂载 `next()`（Web/CLI 自己的作答面）与微信作答，**先到者胜**；
  输了就丢掉自己的 pending，避免用户稍后回的数字去回答一个模型已经翻篇的问题。
- 优先级：**待答问题优先于编号选择器**——你回的那句话首先是答案，不是新指令。
- 同一时刻只允许一个提问在飞；第二个提问**直接交还宿主**（`next()`），
  因为一个聊天里交错两套问题必然错配。
- 异常路径：`/list` 重发问题、空白回复重新提问、`AbortSignal` 取消、
  超时（默认 10 分钟）都释放 pending。

### 9.2 审批（A11）—— 已实现

- `harness/approvals.mjs`：`parseApprovalReply` / `approvalText` / `createApprovalBridge`。
- 事件 `approval/request`，作答值 **`'allowed-once' | 'rejected'`**（`modern-harness-api.mjs:725`）。
- 回复映射：批准/同意/可以/好/是/yes/y/ok/1 → 允许；拒绝/不同意/不行/不要/否/no/n/2 → 拒绝。
- **看不懂就重新提问，绝不猜**——审批不是可以「聪明一下」的地方（测试固化）。
- 两个关键竞速细节：
  - 原生作答者返回 `'unavailable'`（网页端没人）**不算答案**，微信侧继续等着；
  - 原生作答者**抛错**同样不丢审批，微信侧继续等。
  这两条如果写错，审批会变成「静默失败」——界面没人、微信也收不到。
- 与提问共用门控与优先级：待答的提问/审批**优先于编号选择器**。

---

## 10. 扫码绑定新微信账号 —— 集成设计与已验地基

> 状态：**地基已全部验证，集成未开始**（2026-10-14 13:4x）

### 10.1 已验证的地基（不要重复调研）

| 地基 | 结论 | 证据 |
|---|---|---|
| 拉二维码 | **POST** `ilink/bot/get_bot_qrcode?bot_type=3`（不是 GET） | 真机实测拿到二维码 `<qrcode-token>…` |
| 轮询 | `GET ilink/bot/get_qrcode_status?qrcode=<token>[&verify_code=]` | `transport/login.mjs` |
| 8 状态 | `wait/scaned/confirmed/expired/scaned_but_redirect/need_verifycode/verify_code_blocked/binded_redirect` | 同上 |
| 凭据字段 | `confirmed` → `bot_token` / `ilink_bot_id` / `ilink_user_id` / `baseurl` | weixin-api.mjs:481-495 |
| **凭据写入** | `ctx.credentials.modifyRecord(key, fn)` —— 记录的**唯一**写路径 | `@deepseek-ai/dsh-credentials` 源码+README |
| 为什么不用引用 | 启动环境变量提供的密钥**无法覆盖**且本轮只读；新账号也没有引用 | README 明载 |
| 传输层收 token | 新增 `token:` 选项（`resolveToken` 只认引用，新账号两者都没有） | 实测 `Bearer DIRECT-TOKEN-42` |

### 10.2 集成四步

1. ✅ 读 `ctx.credentials` API
2. ✅ 传输层接受直接 token
3. ⬜ **宿主两条路由** `/api/dsh-wechat-box/login/begin`、`/login/poll` + 激活链路
4. ⬜ **设置页**：按钮 → 二维码 → 轮询 → 验证码输入 → 已绑定分支

### 10.3 激活链路（`confirmed` 之后，必须有回滚）

```
confirmed → ctx.credentials.modifyRecord('dsh-wechat-box/<botId>', …)
          → 写 storages/wechat-box-account.json（botId/accountId/ownerUserId/baseUrl）
          → 新建 transport({ token, botId, ... }) → start(onInbound)
          → 旧 transport.stop()
          → 任一步失败：回滚到旧账号 + 报错给设置页
```

### 10.4 两个必须处理的分支

- **`need_verifycode`** → 设置页出输入框，下次 poll 带 `verifyCode`（协议层不校验，controller 层校验 `/^\d{4,8}$/`）
- **`binded_redirect`** → 该微信号已绑定：**本地有凭据就直接激活**，没有则报 `already-bound` 失败（参考实现 controller L467-479）

### 10.5 已知偏离 / 待补

- `login.mjs` 里 `buildHeaders`/`normalizeBaseUrl` 是从 `weixin.mjs` **逐行照抄**的私有函数副本
  → **改 weixin.mjs 的请求头时必须同步改 login.mjs**
- 「传输层直接收 token」目前只有探针验证，**尚未写进常驻测试**
- `signal` 取消抛的是 DOMException：`name === 'AbortError'` 但 `.code` 是**数字 20**；判错不能只看 `.code`