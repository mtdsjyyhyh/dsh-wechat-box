/**
 * dsh-wechat-box -- host half.
 *
 * Wires three pieces into one Cordis plugin:
 *   transport/  WeChat iLink long-poll + sendText        (external module)
 *   router/     per-conversation switch + numbered picker (this package)
 *   harness/    drive DSH sessions, observe turn completion (external module)
 *
 * Design rules (see ../DESIGN.md):
 *   R1 switch per conversation, default OFF, persisted
 *   R2 ON  -> two-way bridge
 *   R3 OFF -> WeChat may still push one message into a picked conversation
 *   R4 picking on the WeChat side turns that conversation's switch ON
 *   R5 any free text from WeChat answers with a numbered list; a bare number picks
 *
 * ROBUSTNESS RULE, learned the hard way
 * -------------------------------------
 * The HTTP routes are registered BEFORE any await that can fail. A previous
 * version registered them after loading the transport and the bridge; when that
 * setup threw, `apply` aborted, the routes never appeared (every request 401),
 * and the client half was still announced by the host -- so the failure was
 * invisible from outside. Now the diagnostics channel exists first and reports
 * `applyError`, so a broken plugin can always explain itself.
 *
 * Deliberately NOT done here: approval forwarding and interactive-question
 * forwarding (DESIGN.md R7/A10-A11). Those need the harness interaction seam;
 * they are a separate slice.
 */
import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { randomUUID } from 'node:crypto';

import {
  createRouter,
  classifyInbound,
  formatSessionList,
  formatSelected,
  formatOutOfRange,
  splitForWeChat,
  // `/new` (create a conversation in a workspace) and `/session <id> open|close`.
  createPendingChoice,
  parseChoiceNumber,
  workspaceKey,
  formatWorkspaceList,
  formatWorkspaceOutOfRange,
  formatNewSession,
  formatSessionNotFound,
  formatSessionOpened,
  formatSessionClosed,
  NEW_CANCELLED_TEXT,
  MAX_WORKSPACE_CHOICES,
  NEW_CHOICE_TTL_MS,
} from '../router/router.mjs';
import { createQuestionBridge } from '../harness/questions.mjs';
import { createApprovalBridge } from '../harness/approvals.mjs';
import { appendFileSync } from 'node:fs';

export const name = 'dsh-wechat-box';

/**
 * Declared dependency -- and possibly the reason this plugin applies at all.
 *
 * The boot trace proved the host IMPORTED this module but never called `apply`.
 * The one structural difference from the previous plugin that did apply
 * (dsh-wechat-notify) is that this one declared no `inject` array. So the
 * dependency is declared explicitly, and it is one that genuinely exists: the
 * web server our diagnostic routes live on. dsh-im resolves `webServer`
 * dynamically and its routes work, so the service is globally available.
 */
export const inject = ['webServer'];

export const STATE_PATH = '/api/dsh-wechat-box/state';
export const TOGGLE_PATH = '/api/dsh-wechat-box/toggle';
export const BEACON_PATH = '/api/dsh-wechat-box/beacon';
export const ENABLED_PATH = '/api/dsh-wechat-box/enabled';
export const PUSH_PATH = '/api/dsh-wechat-box/push';
export const LOGIN_BEGIN_PATH = '/api/dsh-wechat-box/login/begin';export const LOGIN_POLL_PATH = '/api/dsh-wechat-box/login/poll';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BEACONS = 40;

/**
 * How long a QR token lives, and therefore how long we keep it in memory.
 *
 * The transport layer owns the authoritative constant (transport/login.mjs
 * QR_TTL_MS = 5min, copied from weixin-controller.mjs:25). It is restated here
 * rather than imported because a constant that governs a *route's* behaviour
 * should not be able to disappear behind a dynamic import that only exists in
 * production -- and because the value is part of the HTTP contract we hand the
 * settings page (`expiresAtMs`).
 */
const QR_TTL_MS = 5 * 60_000;

/**
 * Ceiling on how long the boot (and an activation) waits for the credentials
 * service.
 *
 * `ctx.inject(['credentials'], cb)` starts a fiber that resolves only once the
 * service exists; if the plugin is not composed in, the fiber never runs and a
 * bare await would hang the boot forever. A timeout turns that into the
 * documented degradation: the reason goes to the boot trace, and the caller
 * decides. Both callers now treat "no service" as a failure rather than a
 * warning, because the credential record is the token's only durable home (see
 * activateAccount and the boot path): with no record there is nothing to run on.
 */
const CREDENTIALS_TIMEOUT_MS = 3_000;

/** Bounded, throw-proof string for a diagnostic. Never carries a secret. */
function text(value, max = 200) {
  try {
    return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);
  } catch {
    return '<unprintable>';
  }
}

/**
 * Boot trace: a diagnostics channel that does NOT depend on the thing being
 * diagnosed.
 *
 * The HTTP routes are how this plugin reports its own state, but when the
 * plugin fails before registering them the routes are exactly what is missing,
 * so the failure is invisible: the host announces the client half (its entry
 * has a fiber) while every request 401s. That is where we ended up: a restart
 * changed nothing and no host log said why.
 *
 * So the plugin also appends a line to <DSH_HOME>/wechat-box-boot.log at each
 * lifecycle step. It is best-effort and never throws.
 */
function bootTrace(step, detail) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    let suffix = '';
    if (detail !== undefined) {
      // Computing the detail must not be able to throw: this is the line that
      // runs before anything else, and an exception here would look exactly
      // like "the plugin was never applied".
      try { suffix = ` :: ${String(detail).slice(0, 800)}`; } catch { suffix = ' :: <unprintable>'; }
    }
    appendFileSync(join(home, 'wechat-box-boot.log'), `${new Date().toISOString()} pid=${process.pid} ${step}${suffix}\n`, 'utf8');
  } catch { /* diagnostics must never break the plugin */ }
}

bootTrace('module-imported');

/** Short, throw-proof description of whatever an API handed back. */
function describeValue(value) {
  try {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type !== 'object' && type !== 'function') return `${type}:${String(value).slice(0, 40)}`;
    if (type === 'function') return 'function';
    const keys = Object.keys(value).slice(0, 8);
    let json = '';
    try { json = JSON.stringify(value).slice(0, 160); } catch { json = '<circular>'; }
    return `object{${keys.join(',')}} ${json}`;
  } catch {
    return '<undescribable>';
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function routerStatePath() {
  return join(dshHome(), 'storages', 'wechat-box.json');
}

/**
 * The account this plugin bound by scanning a QR code (DESIGN.md 10.3).
 *
 * Deliberately NOT dsh-im's `integrations/dsh-weixin/config.json`: that file
 * belongs to another plugin and is rewritten by it, so writing our login result
 * there would be both rude and racy. This one file is ours alone, and it carries
 * the IDENTITY of the bound account -- botId / accountId / ownerUserId / baseUrl
 * -- and nothing else. What makes "restart after binding" work without a second
 * scan is this file PLUS the credential record holding the token: the two are
 * written together by activateAccount() and must both be there on the next boot.
 */
function accountPath() {
  return join(dshHome(), 'storages', 'wechat-box-account.json');
}

/** Legacy location: the account @xmanrui/dsh-im bound, kept readable forever. */
function legacyAccountPath() {
  return join(dshHome(), 'integrations', 'dsh-weixin', 'config.json');
}

function transportStatePath() {
  return join(dshHome(), 'storages', 'wechat-box-transport.json');
}

/**
 * The runtime on/off switch the Settings page drives (DESIGN.md requirement 7).
 *
 * The bundle config (`cordis.patch.yml`) is a *default*: it is baked at install
 * time and cannot be changed without editing a file and restarting. A setting
 * the user flips must survive a restart, so the effective value is persisted
 * here and takes precedence. Absent file -> fall back to the bundle config.
 */
function settingsPath() {
  return join(dshHome(), 'storages', 'wechat-box.config.json');
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.weixinEnabled === 'boolean') {
      return { weixinEnabled: parsed.weixinEnabled, source: 'settings-file' };
    }
  } catch { /* missing or corrupt -> no override */ }
  return null;
}

async function writeSettings(patch) {
  let current = {};
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
  } catch { /* start fresh */ }
  const next = { version: 1, ...current, ...patch, updatedAt: Date.now() };
  await mkdir(dirname(settingsPath()), { recursive: true });
  const tmp = `${settingsPath()}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, settingsPath());
  return next;
}

/**
 * An account object is usable when it can both be displayed and connected.
 *
 * `tokenRef` is deliberately NOT a substitute for `accountId`: a transport built
 * from a tokenRef alone would resolve the reference to the OLD bot's secret and
 * then talk to the new bot's account -- a mix-up that has no error message of
 * its own, it just silently authenticates as the wrong thing.
 *
 * An account read from the account file has NO token at this point -- it is
 * filled in from the credential record during setup (see
 * tokenFromCredentialRecord in apply()) and the transport is only built once
 * that succeeded, so this test is asked about accounts that are ready to run.
 */
function isUsableAccount(value) {
  return Boolean(value
    && typeof value === 'object'
    && typeof value.accountId === 'string' && value.accountId
    && (typeof value.token === 'string' && value.token
      || typeof value.tokenRef === 'string' && value.tokenRef));
}

/**
 * Does this account carry a credential we can reach later?
 *
 * A token in hand always works. A tokenRef only works for the account that
 * reference belongs to (it is the key of an entry in the credentials document or
 * the environment), so it is only accepted for the legacy dsh-im account, where
 * the reference is known to resolve.
 */
function hasReachableCredential(account) {
  if (typeof account?.token === 'string' && account.token) return true;
  return account?.source === 'dsh-im-config' && typeof account.tokenRef === 'string' && Boolean(account.tokenRef);
}

/**
 * Read the bound WeChat account.
 *
 * The account file this plugin writes (`storages/wechat-box-account.json`) wins;
 * the dsh-im `config.json` is the backward-compatible fallback so an existing
 * installation keeps working (and its `tokenRef` keeps being honoured) until the
 * user scans a new code. Sources are tagged so callers can tell which one they
 * got -- the login flow must not treat a legacy reference as a fresh token.
 *
 * NOTE the `token` of the returned account: this function never fills it from
 * the account file. The token for an account this plugin bound by scanning comes
 * from the credential record (see tokenFromCredentialRecord inside apply()), and
 * a plaintext `token` left in the account file by an earlier version of this
 * plugin is ignored AND erased (stripLegacyToken).
 */
async function readAccount() {
  try {
    const raw = JSON.parse(await readFile(accountPath(), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.botId === 'string' && raw.botId) {
      const account = {
        botId: raw.botId,
        accountId: raw.accountId,
        ownerUserId: raw.ownerUserId,
        baseUrl: raw.baseUrl,
        // Never read from this file, whatever an older version wrote there.
        token: null,
        tokenRef: null,
        updatedAt: raw.updatedAt ?? null,
        source: 'account-file',
      };
      // Any `token` key at all is legacy: the field does not exist in the current
      // shape, so its presence means an old writer left a live secret on disk.
      if (Object.hasOwn(raw, 'token')) {
        // MIGRATE BEFORE STRIPPING. The record is the token's only home now, and
        // until this very release it was never actually written (the inject
        // callback's return value made Cordis throw "Invalid effect"), so the
        // record is empty while the file still holds the live token. Stripping
        // first would therefore refuse to start the transport on the next boot
        // and take WeChat down until a re-scan. Moving the value across first
        // reaches the same end state -- token only in the record, gone from the
        // file -- without an outage.
        if (typeof raw.token === 'string' && raw.token.trim()) {
          // Migration must never be able to break account loading. If the record
          // cannot be written, the strip below still happens and the plugin
          // reports a missing credential loudly rather than failing here.
          try {
            const migrated = await writeCredentialRecord(raw.botId, {
              kind: 'grant',
              payload: {
                token: raw.token,
                accountId: raw.accountId,
                ownerUserId: raw.ownerUserId,
                baseUrl: raw.baseUrl,
              },
            });
            bootTrace(
              migrated.ok ? 'legacy-token-migrated' : 'legacy-token-migrate-failed',
              `${accountPath()} :: ${migrated.ok ? 'moved into the credential record, then removed from the file' : migrated.reason}`,
            );
          } catch (error) {
            bootTrace('legacy-token-migrate-failed', `${accountPath()} :: ${text(error?.message ?? error)}`);
          }
        }
        account.legacyTokenStripped = await stripLegacyToken(raw);
      }
      return account;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A corrupt account file must be visible: silently falling back to the old
      // account is how "I scanned and it went back to the other bot" happens.
      bootTrace('account-file-unreadable', `${accountPath()} :: ${text(error?.message ?? error)}`);
    }
  }
  const raw = JSON.parse(await readFile(legacyAccountPath(), 'utf8'));
  const account = Array.isArray(raw?.accounts) ? raw.accounts[0] : null;
  if (!account || typeof account !== 'object') throw new Error('no WeChat account in config.json');
  return {
    botId: account.botId,
    accountId: account.accountId,
    tokenRef: account.tokenRef,
    token: null,
    baseUrl: account.baseUrl,
    ownerUserId: account.ownerUserId,
    updatedAt: null,
    source: 'dsh-im-config',
    // The legacy account's secret is resolved by the transport itself (from the
    // environment or the credentials YAML); it never passes through this plugin.
    credentialSource: 'reference',
  };
}

/**
 * Erase the plaintext `token` an earlier version of this plugin wrote into the
 * account file, and say so in the boot trace.
 *
 * Why erase rather than keep reading it: that field is exactly what this file
 * must not hold. Its only protection was `mode: 0600`, and on Windows -- the
 * platform this runs on -- chmod is a no-op, so the file is guarded by ordinary
 * ACLs alone. The credential record is the token's home now; the field is dead
 * weight carrying a live secret.
 *
 * Never throws: the account stays usable when the rewrite fails (its token was
 * never going to be read from here), so the failure is reported and the load
 * continues. Neither trace line carries the value.
 */
async function stripLegacyToken(raw) {
  try {
    await writeAccountFile(raw);
    bootTrace(
      'legacy-token-stripped',
      `${accountPath()} :: the plaintext token field was removed; the credential record is its only home`,
    );
    return true;
  } catch (error) {
    bootTrace('legacy-token-strip-failed', `${accountPath()} :: ${text(error?.message ?? error)}`);
    return false;
  }
}

/**
 * Write the bound account, atomically.
 *
 * Temp file + rename in the same directory: a half-written account file would
 * come back on the next boot as "no account at all", and the only way to fix it
 * would be another scan.
 *
 * This file is NOT a secret store, and the record below is a whitelist so it
 * cannot accidentally become one: the bot token lives in the credential record
 * (`ctx.credentials`), which is the only place in this plugin meant to hold it.
 * The `mode: 0600` is kept for the identifiers, but on Windows -- the platform
 * this runs on -- chmod is a no-op, so a token here would be protected by
 * nothing but ordinary ACLs. (DESIGN.md 10.3.)
 *
 * Temp files are named after the destination and swept at the next boot (see
 * sweepAccountTemps): a process that died mid-write leaves one behind, and
 * `readdir` + `unlink` is the only cleanup a crash-safe scheme can offer.
 */
const ACCOUNT_TMP_SUFFIX = '.tmp';

async function sweepAccountTemps() {
  const directory = dirname(accountPath());
  const prefix = `${accountPath().slice(directory.length + 1)}.`;
  try {
    for (const entry of await readdir(directory)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(ACCOUNT_TMP_SUFFIX)) continue;
      try { await unlink(join(directory, entry)); } catch { /* best effort */ }
    }
  } catch { /* the directory may not exist yet */ }
}

async function writeAccountFile(account) {
  const path = accountPath();
  await mkdir(dirname(path), { recursive: true });
  // Exactly these keys, never a token: this file is rewritten by the rollback
  // path as well, and both writers must produce the same token-free shape.
  const record = {
    version: 1,
    botId: account.botId ?? null,
    accountId: account.accountId ?? null,
    ownerUserId: account.ownerUserId ?? null,
    baseUrl: account.baseUrl ?? null,
    updatedAt: Date.now(),
  };
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  return record;
}

/**
 * Turn a raw platform id into a legal credentials-key segment.
 *
 * `<scope>/<id>` segments must match /^[a-z][a-z0-9-]*$/ (dsh-credentials
 * KEY_SEGMENT_PATTERN), and a real bot id (`wx_example_bot_id`) does
 * not: it contains underscores. So the id is slugged -- lowercased, illegal
 * characters folded to `-`, a leading letter forced -- which is deterministic
 * and reversible enough to find the record again, while the raw id stays in the
 * account file (which is the source of truth for connecting, not the record).
 */
function credentialSlug(rawId) {
  const slug = String(rawId ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return 'unknown';
  return /^[a-z]/.test(slug) ? slug : `a${slug}`;
}

/** The record key for one bot, in the plugin's own namespace. */
function credentialKeyFor(botId) {
  return `dsh-wechat-box/${credentialSlug(botId)}`;
}

// ------------------------------------------------------------------ http glue

/** Show enough of an identifier to recognise it, not enough to reuse it. */
function maskId(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return null;
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

/** The host part of a base URL, for display; never the path or query. */
function hostOf(value) {
  try {
    return new URL(String(value)).host;
  } catch {
    return null;
  }
}

let qrRenderer = null;

/**
 * Render a string as a QR code and return it as an inline SVG data URL.
 *
 * Why this exists: what the WeChat API returns as `qrcode_img_content` is NOT an
 * image. It is the content the QR encodes -- an `https://liteapp.weixin.qq.com/...`
 * landing page. The settings page originally handed that straight to an
 * `<img src>`, which can never render: fetching it returns `text/html`, so the
 * user just saw a broken image. The QR is therefore rendered where the `qrcode`
 * package is resolvable (the profile's node_modules, the same one dsh-im uses),
 * and the browser receives a data URL it can display with no extra dependency
 * and no markup injection.
 */
async function renderQrDataUrl(value) {
  if (!value) return null;
  try {
    if (!qrRenderer) {
      // Resolve `qrcode` from wherever it can be found. The profile's
      // node_modules is the normal home (dsh-im depends on it), but a different
      // install layout, a test run against a scratch DSH_HOME, or a future
      // profile rename would all miss that one path -- and a QR that silently
      // fails to render is exactly the bug this function exists to fix. So try
      // several anchors, then fall back to normal resolution.
      const { createRequire } = await import('node:module');
      const anchors = [
        join(dshHome(), 'profiles', process.env.DSH_PROFILE || 'desktop', 'package.json'),
        join(dshHome(), 'profiles', 'desktop', 'package.json'),
        join(process.cwd(), 'package.json'),
        import.meta.url,
      ];
      for (const anchor of anchors) {
        try {
          qrRenderer = createRequire(anchor)('qrcode');
          if (qrRenderer) break;
        } catch { /* try the next anchor */ }
      }
    }
    if (!qrRenderer) {
      const mod = await import('qrcode');
      qrRenderer = mod?.default ?? mod;
    }
    const svg = await qrRenderer.toString(String(value), {
      type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M',
    });
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  } catch (error) {
    // Best effort: the caller still returns the raw URL so the page can offer it
    // as a link instead of silently showing nothing.
    bootTrace('qr-render-failed', error?.message ?? error);
    return null;
  }
}

function json(response, status, value) {  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error('payload-too-large');
    chunks.push(buffer);
  }
  if (length === 0) return {};
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

// -------------------------------------------------------------------- plugin

export async function apply(ctx, config = {}) {
  // Nothing may be computed before this logs: the first statement of apply is
  // the only thing that runs if something later is fatal, and an exception in
  // an argument expression would look exactly like "the plugin never applied".
  bootTrace('apply-enter');
  try {
    await applyInner(ctx, config);
    bootTrace('apply-ok');
  } catch (error) {
    bootTrace('apply-threw', error?.stack ?? error?.message ?? error);
    throw error;
  }
  // MUST return undefined (or a function, or an iterable of disposers).
  //
  // Cordis treats a plugin's return value as an EFFECT RESULT (see Effect<T> and
  // Fiber._execute in cordis/src/fiber.ts). Its safeCollect accepts only a
  // function, null/undefined, a thenable, or an iterable; ANY other object makes
  // it `throw new TypeError('Invalid effect')`. That throw fails this fiber's
  // startup, which disposes every effect the fiber owns -- so the HTTP routes
  // registered moments earlier were torn down ~1ms after apply resolved, and
  // every request answered 401 while the plugin looked healthy from the inside.
  // Returning a debug object here cost five restarts to find.
  return undefined;
}

async function applyInner(ctx, config = {}) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
  const beacons = [];
  const router = createRouter({ statePath: routerStatePath() });
  // Test seam: `config.modules.transport` / `.bridge` replace the dynamic
  // imports, so the routing rules can be exercised without the real modules.
  // `.login` does the same for the QR-login primitive, which is what keeps the
  // binding tests off the network entirely.
  const loaders = config?.modules ?? {};
  const loginConfig = config?.login ?? {};
  // Tests need this short: the only way to observe "credentials never resolve"
  // is to wait it out.
  const credentialsTimeoutMs = Number.isFinite(loginConfig.credentialsTimeoutMs) && loginConfig.credentialsTimeoutMs > 0
    ? loginConfig.credentialsTimeoutMs
    : CREDENTIALS_TIMEOUT_MS;
  // Safety valve: while @xmanrui/dsh-im is mounted it long-polls the SAME bot.
  // Two consumers steal each other's messages, so the transport stays off until
  // the config says otherwise (see migrate.ps1 -Phase2). A persisted setting
  // (the Settings toggle) overrides this default; it is read inside the guarded
  // setup below so a settings file can never stop the routes from registering.
  let weixinEnabled = config?.weixinEnabled === true;
  let weixinEnabledSource = 'bundle-config';

  let transport = null;
  let bridge = null;
  let account = null;
  let lastUserId = null;
  let transportStarted = false;
  // Synchronous mirror of router.selectedId(), so reply() can prefix the fence
  // without awaiting. Kept in step at every place the selection changes.
  let currentSelection = null;
  let transportError = null;
  let bridgeError = null;
  let applyError = null;
  let questionsRegistered = false;
  let approvalsRegistered = false;
  let disposeQuestions = null;
  let disposeApprovals = null;
  // --- QR login (DESIGN.md 10) ----------------------------------------------
  // The QR token is the handle the platform gave us for ONE pending scan. It is
  // held here, in the host process, and never leaves except as the polling
  // parameter of our own follow-up request -- the browser gets `qrcodeUrl` (an
  // image address) and nothing else.
  let pendingQr = null;
  let loginPrimitive = undefined;      // lazily imported; `undefined` = not tried
  let lastLoginError = null;           // why login is unavailable, if it is
  let lastAccountError = null;         // why the account could not be put into service
                                       // (no credential record at boot, or a failed
                                       // activation) -- reported on the state route
  let activationError = null;          // last failed/rolled-back activation

  // --- `/new` and `/session <id> open|close` --------------------------------
  // The pending workspace choice is MEMORY ONLY and TTL-bounded. It is the one
  // piece of state whose whole job is to be short-lived: it exists between
  // "which workspace?" and the digit that answers it. Persisting it would mean a
  // restart could answer a question the user has long stopped looking at.
  //
  // `config.newChoice.ttlMs` is a test seam in the same spirit as
  // `config.modules`: the TTL is the only thing here that a fast test cannot
  // otherwise observe, and "the pending choice really does expire" is worth
  // asserting against real time rather than against a mock clock.
  const newChoiceTtlMs = Number.isFinite(config?.newChoice?.ttlMs) && config.newChoice.ttlMs > 0
    ? config.newChoice.ttlMs
    : undefined;
  // The entries behind the pending /new list, index-aligned with its options.
  // They travel beside the choice rather than inside it so the choice helper's
  // signature stays untouched; both are created together and cleared together.
  let pendingWorkspaceEntries = [];
  const newChoice = createPendingChoice(
    newChoiceTtlMs === undefined ? {} : { ttlMs: newChoiceTtlMs },
  );
  // Last failure from the create path, reported on the state route as well as in
  // WeChat: the one thing this plugin must never do again is fail silently.
  let createError = null;
  // Which sources the last workspace enumeration actually used, for the state
  // route. 'registry' = the host's workspace registry answered; 'sessions' =
  // fell back to the cwds of recent conversations; 'none' = nothing to offer.
  let workspaceSource = null;
  /**
   * Host services `/new` needs, filled by `ctx.inject` below.
   *
   * These are acquired SEPARATELY from `inject = ['webServer']` on purpose:
   * declaring them as required dependencies would stop the plugin applying at
   * all wherever they are absent, and the plugin's own diagnostic routes are
   * exactly what has to survive that.
   */
  const hostServices = { sessionController: undefined, workspaceRegistry: undefined };

  // R7: answer host questions over WeChat. Created unconditionally so its state
  // is inspectable, but its waterfall handler is only attached when the safety
  // valve is open -- dsh-im registers the SAME waterfall with `prepend: true`,
  // and two handlers on one request would fight over it.
  const questions = createQuestionBridge({
    send: (text) => reply(lastUserId, text),
    log: logger,
  });
  const approvals = createApprovalBridge({
    send: (text) => reply(lastUserId, text),
    log: logger,
  });

  // ---- activation machinery (DESIGN.md 10.3) -------------------------------
  // Everything here is deliberately *below* the hoisted `reply()` and above the
  // route table, so the login routes can call it while nothing has been set up
  // yet -- a request that arrives before setup finished gets an honest error
  // instead of a 401 or a hang.

  /**
   * Build a transport for one account.
   *
   * One construction site for both boot and activation, so a newly scanned
   * account and a boot-time account cannot drift apart. Note that a real
   * transport is built from `token` when we have one (a freshly scanned account
   * has no reference anywhere) and from `tokenRef` otherwise (the legacy dsh-im
   * account). Passing `token: undefined` is harmless: the transport checks for a
   * non-empty string and falls through to the reference.
   */
  async function buildTransport(forAccount) {
    if (typeof loaders.transport === 'function') {
      return await loaders.transport({
        account: forAccount,
        logger,
        statePath: transportStatePath(),
      });
    }
    const mod = await import('../transport/weixin.mjs');
    return mod.createWeixinTransport({
      botId: forAccount.botId,
      accountId: forAccount.accountId,
      baseUrl: forAccount.baseUrl,
      token: forAccount.token ?? undefined,
      tokenRef: forAccount.tokenRef ?? undefined,
      statePath: transportStatePath(),
      logger,
    });
  }

  /**
   * Stop a transport without ever throwing. Used on every path where a stop is
   * housekeeping rather than the operation the user asked for: a stop() that
   * throws must not be able to strand the plugin in a half-swapped state, and
   * the failure still goes to the boot trace (the "failures must be visible"
   * rule) rather than being dropped.
   */
  async function stopQuietly(target, label) {
    if (!target || typeof target.stop !== 'function') return;
    try {
      await target.stop();
    } catch (error) {
      bootTrace('transport-stop-failed', `${label} :: ${text(error?.message ?? error)}`);
      logger.warn?.(`[wechat-box] transport stop failed (${label}): ${error?.message ?? error}`);
    }
  }

  /**
   * The credential service, or null.
   *
   * `ctx.inject` starts a fiber whose callback only runs once the service is
   * registered, so the wait is bounded: if this plugin is composed without a
   * credentials provider the call would otherwise never settle, and the boot
   * would hang instead of reporting the documented degradation.
   *
   * Returns null (never throws) when credentials are out of reach -- the caller
   * records that in the boot trace and reports it.
   */
  let credentialsCache = null;
  async function credentialsService() {
    // Success is cached: both the boot path and every activation ask for this,
    // and each ask otherwise starts another injection fiber for a service that
    // cannot change identity mid-process. A failure is NOT cached -- the service
    // may still be composing.
    if (credentialsCache) return credentialsCache;
    if (typeof ctx?.inject !== 'function') return null;
    // The service is taken from a box filled by the injection callback -- NOT
    // from `ctx.inject`'s return value, which is not dependable: the Cordis
    // context proxies `inject` off its registry and the call came back undefined
    // in a real host context while the callback ran fine. The callback is the one
    // part of this API that behaved identically everywhere it was tested.
    const box = { service: undefined, ran: false };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), credentialsTimeoutMs);
    });
    try {
      const fiber = ctx.inject(['credentials'], (credentialCtx) => {
        box.ran = true;
        box.service = credentialCtx?.credentials;
        // MUST return undefined. `ctx.inject(deps, cb)` is literally
        // `ctx.plugin({ inject: deps, apply: cb })` (cordis Context.inject), so
        // this callback is a plugin BODY: its return value goes through the same
        // effect collection as apply()'s (Fiber._execute -> safeCollect), which
        // accepts only a function, null/undefined, a thenable or an iterable of
        // disposers. Returning the service object threw `TypeError: Invalid
        // effect` SYNCHRONOUSLY out of `ctx.inject` -- the catch below turned that
        // into "credentials unavailable" on EVERY call, so the grant was never
        // stored (`credentials-skipped :: … credentials service unavailable` in
        // wechat-box-boot.log) and the token only ever reached the account file.
        // Same trap as apply()'s return value, one level down.
        return undefined;
      });
      // Await the callback (directly or through the fiber) and the deadline
      // together; whichever comes first decides.
      const resolved = await Promise.race([Promise.resolve(fiber).then(() => box.service), timeout]);
      if (!resolved) {
        bootTrace(
          'credentials-unavailable',
          box.ran
            ? `the credentials context carried no service (got ${describeValue(box.service)})`
            : `the injection callback did not run within ${credentialsTimeoutMs}ms`,
        );
        return null;
      }
      if (typeof resolved.modifyRecord !== 'function') {
        // Key names, never describeValue: a credentials service may well hold the
        // records themselves as a property, and one of those records carries the
        // token this plugin is not allowed to print.
        bootTrace('credentials-unavailable', `service has no modifyRecord (type=${typeof resolved} keys=${Object.keys(resolved).join(',')})`);
        return null;
      }
      credentialsCache = resolved;
      return resolved;
    } catch (error) {
      bootTrace('credentials-unavailable', text(error?.stack ?? error?.message ?? error));
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ *
   * `/new`: workspaces + session creation
   * ------------------------------------------------------------------ */

  /**
   * Read one service off a Cordis context without throwing.
   *
   * Accessing an UNDECLARED service on a Cordis context THROWS
   * ("cannot get property \"X\" without inject") rather than yielding undefined,
   * which is the trap documented at the top of harness/bridge.mjs. The same care
   * applies here: this plugin has to be able to install itself and say what it is
   * missing, so a service that is not there is `undefined`, never an exception.
   */
  function serviceFrom(context, serviceName) {
    if (!context) return undefined;
    try {
      return context[serviceName];
    } catch {
      return undefined;
    }
  }

  /**
   * Ask the host for the two services `/new` is built on.
   *
   * `sessionController.create` is what actually creates a conversation (verified
   * against the host source: dsh-api-session-controller/lib/index.js:2971
   * `create(request) { return this.commands.create(request); }`, and the request
   * is `{ workspaceId? , cwd? , sessionId? , agentPreset? }` with `workspaceId`
   * XOR `cwd`). `workspaceRegistry.list()` is the workspace list itself
   * (dsh-workspace/lib/index.js:452, synchronous, registry order).
   *
   * Both are optional: without them `/new` reports why instead of pretending, and
   * `/session <id> open|close` keeps working because it needs neither.
   *
   * Called AFTER the routes are registered -- `ctx.inject` can throw
   * synchronously (see the credentials note below), and nothing may stand between
   * this plugin and its own diagnostics.
   */
  function acquireHostServices() {
    if (typeof ctx?.inject !== 'function') {
      bootTrace('host-services-unavailable', 'no ctx.inject');
      return;
    }
    for (const serviceName of ['sessionController', 'workspaceRegistry']) {
      try {
        const fiber = ctx.inject([serviceName], (readyCtx) => {
          const acquired = serviceFrom(readyCtx, serviceName);
          if (acquired !== undefined) {
            hostServices[serviceName] = acquired;
            bootTrace('host-service-acquired', serviceName);
          } else {
            bootTrace('host-service-empty', serviceName);
          }
          // MUST return undefined: this callback is a plugin BODY, and any other
          // return value is `TypeError: Invalid effect` (see credentialsService).
          return undefined;
        });
        // Not awaited: `/new` degrades with a readable message if the service is
        // still composing, and awaiting here would delay the rest of setup.
        if (fiber && typeof fiber.then === 'function') {
          fiber.then(
            () => undefined,
            (error) => bootTrace('host-service-fiber-rejected', `${serviceName} :: ${text(error?.message ?? error, 200)}`),
          );
        }
      } catch (error) {
        // Never fatal: the routes and the rest of the bridge do not depend on it.
        bootTrace('host-service-inject-failed', `${serviceName} :: ${text(error?.message ?? error, 200)}`);
      }
    }
  }

  /**
   * The registered workspaces' directories, in the host's own order.
   *
   * `null` means "the registry could not answer", which is different from "it
   * answered with nothing": the first falls back to session cwds, the second is
   * a real empty list. `workspaceRegistry.list()` throws when the registry's
   * durable state is not loaded yet, and a throw there must not take `/new` down.
   */
  /**
   * The registry entries, WITH their `workspaceId`.
   *
   * `create({ cwd })` and `create({ workspaceId })` are NOT equivalent even when
   * the directory is identical: the host only calls `workspace.attachSession()`
   * on the `workspaceId` path (see the `create` body in
   * dsh-api-session-controller). A session created by `cwd` alone has the right
   * directory but belongs to no workspace, so the GUI files it under
   * "未分组" -- reported from real use.
   */
  function registryWorkspaceEntries() {
    const registry = hostServices.workspaceRegistry;
    if (!registry || typeof registry.list !== 'function') return null;
    try {
      const rows = registry.list();
      if (!Array.isArray(rows)) return null;
      return rows
        .map((workspace) => {
          const path = typeof workspace?.path === 'string' && workspace.path ? workspace.path : null;
          if (!path) return null;
          const workspaceId = typeof workspace?.id === 'string' && workspace.id ? workspace.id : null;
          return { path, workspaceId };
        })
        .filter((entry) => entry !== null);
    } catch (error) {
      bootTrace('workspace-registry-list-failed', text(error?.message ?? error, 200));
      return null;
    }
  }

  function registryWorkspacePaths() {
    const entries = registryWorkspaceEntries();
    return entries === null ? null : entries.map((entry) => entry.path);
  }

  /**
   * The `/new` workspace list: registered workspaces first, then any other
   * directory a recent conversation lives in.
   *
   * Why both sources. The registry is the user's own curated list and its order
   * is the order they arranged, so it goes first and unchanged. The session cwds
   * are the answer to "where have I actually been working", and they catch the
   * case that matters most in practice: a directory that was opened without ever
   * being registered as a workspace. `sessionController.list()` already returns
   * newest-first (it sorts by `updatedAt`, host source line ~1904), so the tail
   * is naturally "most recently used first".
   *
   * De-duplication is by `workspaceKey` (case- and separator-insensitive), so the
   * same directory cannot appear twice under two spellings.
   */
  async function listWorkspaces({ sessions = null, limit = MAX_WORKSPACE_CHOICES } = {}) {
    try {
      const seen = new Set();
      const entries = [];
      const push = (path, workspaceId = null) => {
        if (typeof path !== 'string' || !path.trim()) return;
        const key = workspaceKey(path);
        if (!key || seen.has(key)) return;
        seen.add(key);
        entries.push({ path, workspaceId });
      };

      const registered = registryWorkspaceEntries();
      if (registered) for (const entry of registered) push(entry.path, entry.workspaceId);

      let rows = sessions;
      if (rows === null) {
        rows = typeof bridge?.listSessions === 'function'
          ? await bridge.listSessions().catch(() => [])
          : [];
      }
      // A cwd that came from a conversation is not a registered workspace, so it
      // has no id to attach to; those entries can only be created by `cwd`.
      for (const session of Array.isArray(rows) ? rows : []) push(session?.cwd);

      workspaceSource = registered !== null ? 'registry' : (entries.length > 0 ? 'sessions' : 'none');
      const sliced = entries.slice(0, limit);
      return {
        entries: sliced,
        paths: sliced.map((entry) => entry.path),
        source: workspaceSource,
        total: entries.length,
      };
    } catch (error) {
      // Enumeration must never be the thing that goes quiet: the caller answers
      // with "no workspaces" (which is true from where the user is standing) and
      // the reason lands on the state route.
      workspaceSource = 'none';
      bootTrace('workspace-enumeration-failed', text(error?.stack ?? error?.message ?? error, 400));
      logger.warn?.(`[wechat-box] workspace enumeration failed: ${error?.message ?? error}`);
      return { entries: [], paths: [], source: 'none', total: 0, error: text(error?.message ?? error, 200) };
    }
  }

  /**
   * Create one conversation in `cwd` through the host's own session command.
   *
   * The host is the only thing allowed to create a session: it resolves the
   * agent, applies the archived-session gate and the preset rules, and returns
   * the identity. Anything this plugin invented locally would be a session the
   * host does not know about -- which is to say, not a session.
   *
   * `create(request)` takes ONE argument. Unlike `prompt(request, signal)` it has
   * no signal parameter (host source line 2971), so nothing is passed for one.
   */
  async function createSessionInWorkspace(target) {
    const controller = hostServices.sessionController;
    if (!controller || typeof controller.create !== 'function') {
      const error = new Error('宿主没有提供 sessionController.create，无法新建会话');
      error.code = 'harness-create-unavailable';
      throw error;
    }
    // Prefer `workspaceId`: only that path makes the host attach the session to
    // its workspace, which is what puts it in the right group in the GUI.
    // `cwd` is the fallback for directories that were never registered.
    const workspaceId = typeof target?.workspaceId === 'string' && target.workspaceId ? target.workspaceId : null;
    const cwd = typeof target === 'string' ? target : target?.path;
    const created = await controller.create(workspaceId ? { workspaceId } : { cwd });
    const sessionId = typeof created?.sessionId === 'string' && created.sessionId ? created.sessionId : null;
    if (!sessionId) {
      const error = new Error('sessionController.create 没有返回 sessionId');
      error.code = 'harness-create-no-id';
      throw error;
    }
    return { sessionId, agentPreset: created?.agentPreset ?? null };
  }

  /**
   * The token inside a grant record, or null.
   *
   * The record shape is dsh-credentials' own (`{ kind: 'grant', payload }`) --
   * `{ kind: 'grant', payload: { token, accountId, ownerUserId } }` is what this
   * plugin writes in grantRecordFor().
   */
  function tokenInRecord(record) {
    const token = record?.payload?.token;
    return typeof token === 'string' && token ? token : null;
  }

  /**
   * A record's KEY NAMES, never its values.
   *
   * Used by the traces below: a credential record holds a live token in
   * `payload.token`, and "the token is never printed" is a red line for this
   * plugin (transport/login.mjs S1). Key names answer "is a record there, and is
   * it shaped the way we expect" without carrying anything reusable.
   */
  function recordShape(record) {
    // A record that is not the object we expect is described by its TYPE only: a
    // string record would otherwise be printed, and it might be the token.
    if (record === null) return 'null';
    if (typeof record !== 'object') return typeof record;
    const payload = record.payload;
    const payloadKeys = payload && typeof payload === 'object'
      ? Object.keys(payload).join(',')
      : (payload === null ? 'null' : typeof payload);
    return `record{${Object.keys(record).join(',')}} payload{${payloadKeys}}`;
  }

  /**
   * The token for an account this plugin bound itself, read from the credential
   * record -- its only durable home.
   *
   * Returns null AND reports when there is nothing to read: `lastAccountError` is
   * what the state route hands the settings page, and `credential-missing` is the
   * boot-trace line that survives the routes being broken. The alternative --
   * carrying on with `token: undefined` -- builds a transport that starts, fails
   * every request with `token-missing`, and reads like a network fault.
   */
  async function tokenFromCredentialRecord(forAccount) {
    const key = credentialKeyFor(forAccount?.botId);
    const record = await readCredentialRecord(forAccount?.botId);
    const token = tokenInRecord(record);
    if (!token) {
      lastAccountError = `凭据记录里没有 token（${key}）：token 只保存在凭据记录里，账号文件里没有。`
        + '请打开设置页重新扫码绑定；不会用空 token 去启动传输层。';
      bootTrace('credential-missing', `${key} :: ${recordShape(record)}`);
      return null;
    }
    bootTrace('credential-loaded', `${key} :: ${recordShape(record)} (value never printed)`);
    return token;
  }

  /** Read back the grant we stored for one bot, or null. Never logs the value. */
  async function readCredentialRecord(botId) {
    const service = await credentialsService();
    if (!service || typeof service.readRecord !== 'function') return null;
    try {
      const record = await service.readRecord(credentialKeyFor(botId));
      return record && typeof record === 'object' ? record : null;
    } catch (error) {
      bootTrace('credentials-read-failed', `${credentialKeyFor(botId)} :: ${text(error?.message ?? error)}`);
      return null;
    }
  }

  /**
   * Store the grant produced by a scan.
   *
   * `modifyRecord` is the ONLY write path (dsh-credentials README), and the
   * mutation sees the record as of the moment the write took exclusive hold --
   * which is what makes the rollback below a restore rather than a guess.
   *
   * Returns { ok, service, record } / { ok:false, reason }. Whether a failure is
   * fatal is the caller's call, not this one: activateAccount() treats it as fatal
   * (the record is the token's only durable home now), and this function just
   * reports what happened.
   */
  async function writeCredentialRecord(botId, record) {
    const service = await credentialsService();
    if (!service) return { ok: false, reason: 'credentials service unavailable' };
    try {
      const written = await service.modifyRecord(credentialKeyFor(botId), () => record);
      return { ok: true, service, record: written ?? record };
    } catch (error) {
      return { ok: false, reason: text(error?.message ?? error), service };
    }
  }

  /** Put a record back exactly as it was, or remove it if there was none. */
  async function restoreCredentialRecord(botId, before) {
    const service = await credentialsService();
    if (!service) return false;
    try {
      if (before && typeof before === 'object') await service.modifyRecord(credentialKeyFor(botId), () => before);
      else if (typeof service.deleteRecord === 'function') await service.deleteRecord(credentialKeyFor(botId));
      else return false;
      return true;
    } catch (error) {
      bootTrace('credentials-restore-failed', `${credentialKeyFor(botId)} :: ${text(error?.message ?? error)}`);
      return false;
    }
  }

  /** The grant record for one account: token + identifiers, nothing else. */
  function grantRecordFor(nextAccount) {
    const payload = {
      token: nextAccount.token,
      accountId: nextAccount.accountId,
      ownerUserId: nextAccount.ownerUserId,
    };
    // `baseUrl` is optional in the payload only because assertJsonValue rejects
    // undefined; an absent key is the same statement as a null one here.
    if (typeof nextAccount.baseUrl === 'string' && nextAccount.baseUrl) payload.baseUrl = nextAccount.baseUrl;
    return { kind: 'grant', payload };
  }

  /**
   * The account a confirmed poll describes. Returns null when the platform's
   * reply is not usable, with the reason in `lastLoginError`.
   */
  function accountFromCredentials(credentials) {
    const accountId = credentials?.accountId;
    const ownerUserId = credentials?.ownerUserId;
    const token = credentials?.token;
    const baseUrl = credentials?.baseUrl ?? pendingQr?.baseUrl ?? null;
    if (!token || !accountId || !ownerUserId || !baseUrl) {
      lastLoginError = 'confirmed without a usable credential set'
        + ` (token=${Boolean(token)}, accountId=${Boolean(accountId)},`
        + ` ownerUserId=${Boolean(ownerUserId)}, baseUrl=${Boolean(baseUrl)})`;
      bootTrace('login-incomplete', lastLoginError);
      return null;
    }
    // The bot id the platform reports (`ilink_bot_id`) is what every other part
    // of this plugin keys the account by, so a scan binds under that id and the
    // same id comes back on the next boot.
    return {
      botId: accountId,
      accountId,
      ownerUserId,
      baseUrl,
      token,
      tokenRef: null,
      source: 'qr-login',
    };
  }

  /**
   * Swap the running account, with a rollback (DESIGN.md 10.3).
   *
   * Order is the design's: credentials record -> account file -> transport swap.
   * Every step that has already landed is undone if a later one fails, and the
   * old account + old transport are put back, so a failure can never leave a
   * half-activated bridge (the failure mode that would be worst here: the
   * settings page says "bound", the host talks to the old bot, and nothing
   * anywhere says so).
   *
   * `options.skipCredentialsWrite` is the `binded_redirect` path: the record is
   * already ours, so only the account file and the transport need to move. "Already
   * ours" is checked, not assumed: the write is skipped only when the record really
   * does hold a token for this bot. (It cannot always: `binded_redirect` also fires
   * for the legacy dsh-im account, whose secret is a reference this process never
   * sees -- there is nothing to store there, and inventing an empty grant would be
   * worse than storing nothing.)
   */
  async function activateAccount(nextAccount, { skipCredentialsWrite = false } = {}) {
    if (!nextAccount?.accountId || !isUsableAccount(nextAccount)) {
      activationError = 'refusing to activate an account without an id and a credential';
      bootTrace('activate-rejected', activationError);
      return { ok: false, code: 'invalid-account', error: activationError };
    }
    // Re-binding the account that is already running is a no-op, not a restart:
    // a restart would drop the long-poll cursor for no reason. This is also the
    // `binded_redirect` + "already running" success path.
    if (account && transport && transportStarted && account.accountId === nextAccount.accountId) {
      bootTrace('activate-noop', `account ${maskId(nextAccount.accountId)} already running`);
      return { ok: true, restarted: false, account };
    }

    const previous = account;
    const previousTransport = transport;
    const previousStarted = transportStarted;
    // Read unconditionally: it is the rollback target, and it is also what makes
    // the skip above a fact rather than a promise.
    const previousRecord = await readCredentialRecord(nextAccount.botId);
    const tokenInHand = typeof nextAccount.token === 'string' && nextAccount.token ? nextAccount.token : null;
    const writeGrant = Boolean(tokenInHand) && !(skipCredentialsWrite && tokenInRecord(previousRecord));

    let nextTransport = null;
    let startedNew = false;
    let wroteAccount = false;
    // Distinct from `writeGrant`: "we tried" is not "it landed". The rollback only
    // undoes a record that was actually written (a failed write has nothing to
    // restore, and the service may be unreachable precisely then).
    let wroteRecord = false;

    try {
      // 1. credentials: the ONLY durable home for the token.
      //
      // A failed write used to be a warning, back when the account file carried a
      // copy of the token and the binding survived a restart anyway. It does not
      // any more, so a binding whose token never reached the record would work
      // until the next restart and then be gone -- with the failure visible only
      // as "no credential record" on a boot hours later. It is therefore fatal
      // here, and the rollback below puts the previous account back.
      if (writeGrant) {
        const written = await writeCredentialRecord(nextAccount.botId, grantRecordFor(nextAccount));
        if (!written.ok) {
          bootTrace('credentials-write-failed', `${credentialKeyFor(nextAccount.botId)} :: ${written.reason}`);
          throw new Error(
            `凭据记录写入失败（${written.reason}）：token 只保存在凭据记录里，`
            + '记录没写成，这次绑定就无法在重启后存活，因此不做半途激活。',
          );
        }
        bootTrace('credentials-written', credentialKeyFor(nextAccount.botId));
        wroteRecord = true;
        nextAccount.credentialSource = 'credential-record';
      } else if (skipCredentialsWrite) {
        bootTrace('credentials-reused', credentialKeyFor(nextAccount.botId));
        nextAccount.credentialSource = nextAccount.credentialSource ?? 'credential-record';
      } else {
        // The legacy dsh-im account: a reference, not a secret. Nothing to store.
        bootTrace('credentials-not-applicable', `${credentialKeyFor(nextAccount.botId)} :: the account carries a reference, not a token`);
      }

      // 2. the account file: what makes the binding survive a restart.
      await writeAccountFile(nextAccount);
      wroteAccount = true;

      // 3. the transport swap.
      nextTransport = await buildTransport(nextAccount);
      await nextTransport.start(onInbound);
      startedNew = true;

      // 4. retire the old one only after the new one is genuinely up.
      if (previousTransport && previousTransport !== nextTransport) {
        await stopQuietly(previousTransport, 'retiring the previous account');
      }

      transport = nextTransport;
      transportStarted = true;
      account = nextAccount;
      lastUserId = nextAccount.ownerUserId ?? null;
      transportError = null;
      activationError = null;
      bootTrace('activated', `account=${maskId(nextAccount.accountId)} restarted=${Boolean(previous)}`);
      return { ok: true, restarted: Boolean(previous), account: nextAccount };
    } catch (error) {
      const reason = text(error?.message ?? error, 400);
      lastAccountError = reason;
      const undone = [];
      const failed = [];

      // Undo in reverse order. Each undo is attempted even if an earlier one
      // failed: a partial rollback still beats none, and the report says which
      // half landed.
      if (startedNew || nextTransport) {
        await stopQuietly(nextTransport, 'rollback');
        undone.push('new-transport-stopped');
      }
      if (wroteAccount && previous) {
        try {
          await writeAccountFile(previous);
          undone.push('account-file-restored');
        } catch (undoError) {
          failed.push(`account-file: ${text(undoError?.message ?? undoError)}`);
        }
      } else if (wroteAccount) {
        undone.push('account-file-kept (there was no previous account to restore)');
      }
      // Only restore what actually landed: a write that never happened has nothing
      // to undo, and a skipped write must not delete a record that was already
      // ours (that record is the running account's token).
      if (wroteRecord) {
        if (await restoreCredentialRecord(nextAccount.botId, previousRecord)) {
          undone.push('credentials-record-restored');
        } else {
          failed.push('credentials-record: restore not possible');
        }
      }
      // Put the previous bridge back. If it cannot come back the state route and
      // the settings page say so -- a silent dead bridge is the one outcome this
      // whole block exists to prevent.
      if (previous) {
        try {
          const restored = previousTransport ?? await buildTransport(previous);
          if (previousStarted) await restored.start(onInbound);
          transport = restored;
          transportStarted = previousStarted;
          transportError = previousStarted ? null : 'transport disabled by config (weixinEnabled=false)';
          account = previous;
          lastUserId = previous.ownerUserId ?? null;
          undone.push('previous-transport-restored');
        } catch (restoreError) {
          transport = null;
          transportStarted = false;
          transportError = `rollback failed: ${text(restoreError?.message ?? restoreError)}`;
          failed.push(`previous-transport: ${transportError}`);
        }
      } else {
        transport = null;
        transportStarted = false;
        failed.push('previous-transport: there was none');
      }

      activationError = `activation failed: ${reason}`
        + ` [undone: ${undone.join(', ') || 'nothing'}]`
        + (failed.length ? ` [not undone: ${failed.join('; ')}]` : '');
      bootTrace('activate-failed', activationError);
      logger.warn?.(`[wechat-box] ${activationError}`);
      return {
        ok: false,
        code: error?.code ?? 'activation-failed',
        error: reason,
        rolledBack: failed.length === 0,
        undone,
        notUndone: failed,
      };
    }
  }

  // ---- helpers (hoisted, so the routes below may reference them) -----------

  async function reply(userId, text, { withSession = true, bindTo = null } = {}) {
    if (!text) return { ok: false, code: 'empty' };
    if (!transport) return { ok: false, code: 'no-transport' };
    // Every outbound message carries the bound conversation as a fenced,
    // copyable `/session <id>` block. Copy it in WeChat, paste it back, and the
    // chat rebinds to that conversation -- which is why the id has to be on the
    // message the user is looking at, not buried somewhere else.
    // Outbound binds the channel: whichever conversation just sent something to
    // WeChat is the one the next WeChat message goes to. Without this the user
    // had to re-select after every push, which defeats the point of a push.
    // Only rebind to a conversation the user has ALREADY switched on.
    // router.select() is not merely "point here": it flips that conversation's
    // switch ON and every other one OFF. Auto-binding a switched-off
    // conversation would therefore silently enable it -- the same surprise as
    // forwarding into a closed conversation, which is exactly the bug reported
    // from real use. A push may move the pointer; it may not open a switch.
    if (bindTo && bindTo !== currentSelection && await router.isEnabled(bindTo)) {
      try {
        const sessions = typeof bridge?.listSessions === 'function'
          ? await bridge.listSessions().catch(() => [])
          : [];
        const title = sessions.find((s) => s.id === bindTo)?.title;
        await router.select(bindTo, title);
        currentSelection = bindTo;
      } catch (error) {
        logger.warn?.(`[wechat-box] rebind to ${bindTo} failed: ${error?.message ?? error}`);
      }
    }
    const header = withSession && currentSelection
      ? `\`\`\`\n/session ${currentSelection}\n\`\`\`\n`
      : '';
    // The platform rejects a single message over 1800 chars, and a mirrored
    // assistant answer often is. Send the chunks in order and stop at the first
    // failure so a partial reply is reported as failed, not silently truncated.
    const chunks = splitForWeChat(`${header}${text}`);
    if (chunks.length === 0) return { ok: false, code: 'empty' };
    let last = null;
    for (const chunk of chunks) {
      try {
        last = await transport.sendText(userId ?? lastUserId, chunk);
      } catch (error) {
        logger.warn?.(`[wechat-box] send threw: ${error?.message ?? error}`);
        return { ok: false, code: 'threw' };
      }
      if (!last?.ok) {
        logger.warn?.(`[wechat-box] send failed: ${last?.code ?? 'unknown'}`);
        return last;
      }
    }
    return last;
  }

  /**
   * Send a value the user may need to COPY, in the form the client can copy.
   *
   * Verified against the real client: WeChat renders a triple-backtick fence as
   * a block that carries its own copy affordance. The transport still carries
   * plain text (`item_list` has only text/image/file types) -- but what the user
   * SEES is copyable, which is the actual requirement. So copyable values go out
   * fenced, on their own line, with the hint as a separate message so the block
   * stays clean.
   */
  async function replyCopyable(userId, hint, value) {
    if (hint) await reply(userId, hint);
    // No /session header on the value itself: the block must hold exactly the
    // value, so one copy gets it clean without stripping a prefix first.
    if (value) await reply(userId, `\`\`\`\n${String(value)}\n\`\`\``, { withSession: false });
  }

  /** R2: mirror a finished turn back to WeChat, but only for an ON conversation. */
  async function onTurnComplete(event) {
    try {
      const sessionId = event?.sessionId;
      const text = event?.text;
      if (!sessionId || !text) return;
      if (!(await router.isEnabled(sessionId))) return;
      // bindTo: the answer just went out for this conversation, so WeChat replies
      // must land back in it.
      await reply(lastUserId, text, { bindTo: sessionId });
    } catch (error) {
      logger.warn?.(`[wechat-box] turn mirror failed: ${error?.message ?? error}`);
    }
  }

  /**
   * `/session <id> open|close` -- set one conversation's switch explicitly.
   *
   * `open` is the bare `/session <id>` semantics (switch ON + move the pointer)
   * with the direction written out; `close` is its inverse. Neither invents a new
   * authorization rule: `open` turns the switch ON because the user asked for
   * exactly that, and `close` turns it OFF, which is the only thing that stops a
   * conversation's output from being mirrored.
   *
   * An id the host does not know is reported, never guessed at.
   */
  async function applySessionDirection(userId, open, sessionId, sessions) {
    const wanted = sessions.find((session) => session.id === sessionId);
    if (!wanted) {
      await reply(userId, formatSessionNotFound(sessionId), { withSession: false });
      return;
    }
    try {
      if (open) {
        await router.select(wanted.id, wanted.title);
        currentSelection = wanted.id;
        await reply(userId, formatSessionOpened(wanted));
        return;
      }
      await router.setEnabled(wanted.id, false);
      // `setEnabled(id, false)` clears `selectedId` when the pointer was on this
      // conversation; re-read it instead of assuming, so the mirror `reply()`
      // uses cannot drift from the persisted truth.
      currentSelection = await router.selectedId();
      await reply(userId, formatSessionClosed(wanted), { withSession: false });
    } catch (error) {
      logger.warn?.(`[wechat-box] ${open ? 'open' : 'close'} ${sessionId} failed: ${inspect(error)}`);
      await reply(userId, `${open ? '打开' : '关闭'}会话 ${sessionId} 失败：${error?.message ?? error}`, { withSession: false });
    }
  }

  /**
   * `/new` step 2: create the conversation, then select it.
   *
   * "Select it" is the whole point -- a conversation created and left unselected
   * would receive nothing, so the user would have answered a question and got
   * back a session that does not talk to them. `router.select` is the same call
   * the numbered picker makes: switch ON, pointer here.
   *
   * Every failure answers in WeChat AND lands in `createError` on the state
   * route. A silent create failure is the exact class of bug this plugin has
   * already been through once.
   */
  async function resolveNewChoice(userId, index) {
    // Peek first, and re-list on a miss from the SNAPSHOT the pending choice
    // holds -- not from a fresh enumeration. A retry addresses the stored
    // options, so re-sending anything else would put numbers on screen that do
    // not mean what they say.
    const open = newChoice.peek();
    if (open === null) {
      await reply(userId, NEW_CANCELLED_TEXT, { withSession: false });
      return;
    }
    const resolved = newChoice.resolve(index);
    if (!resolved.ok) {
      if (resolved.code === 'out-of-range') {
        // The slot stays open so the digit can simply be retyped within the TTL.
        await reply(userId, formatWorkspaceOutOfRange(index, open.options), { withSession: false });
        return;
      }
      await reply(userId, NEW_CANCELLED_TEXT, { withSession: false });
      return;
    }

    // Prefer the entry recorded with the list: it carries the workspaceId, and
    // only `create({ workspaceId })` makes the host attach the session to its
    // workspace. Using the bare path produced a session filed under 未分组.
    const entry = pendingWorkspaceEntries[index - 1]
      ?? { path: resolved.value, workspaceId: null };
    const cwd = entry.path;
    let created;
    try {
      created = await createSessionInWorkspace(entry);
      createError = null;
      bootTrace('session-created', `cwd=${cwd} id=${created.sessionId}`);
    } catch (error) {
      createError = `${error?.code ?? 'create-failed'}: ${error?.message ?? error}`;
      bootTrace('session-create-failed', createError);
      logger.warn?.(`[wechat-box] create in ${cwd} failed: ${inspect(error)}`);
      await reply(
        userId,
        `在 ${cwd} 新建对话失败：${error?.message ?? error}\n（这条会记录在 state 路由的 newSession.lastError 里）`,
        { withSession: false },
      );
      return;
    }

    // The host returns only an id; a brand-new conversation usually has no title
    // yet, so the lookup is best-effort and the wording says so rather than
    // printing an empty field.
    let title = null;
    try {
      const sessions = typeof bridge?.listSessions === 'function'
        ? await bridge.listSessions().catch(() => [])
        : [];
      title = sessions.find((session) => session.id === created.sessionId)?.title ?? null;
    } catch (error) {
      logger.warn?.(`[wechat-box] title lookup for ${created.sessionId} failed: ${error?.message ?? error}`);
    }

    try {
      await router.select(created.sessionId, title);
      currentSelection = created.sessionId;
    } catch (error) {
      // The conversation EXISTS at this point -- saying so matters, otherwise the
      // user would create a second one chasing a session that is already there.
      createError = `select-failed: ${error?.message ?? error}`;
      bootTrace('session-select-failed', createError);
      logger.warn?.(`[wechat-box] select ${created.sessionId} failed: ${inspect(error)}`);
      await reply(
        userId,
        `会话 ${created.sessionId} 已创建，但没能切过去/打开开关：${error?.message ?? error}\n`
        + `发 /session ${created.sessionId} open 重试。`,
        { withSession: false },
      );
      return;
    }

    await reply(userId, formatNewSession({ sessionId: created.sessionId, cwd, title }));
  }

  /** R3/R4/R5: the whole WeChat-side protocol. */
  async function onInbound(message) {
    try {
      const userId = message?.userId ?? account?.ownerUserId ?? null;
      const text = message?.text ?? '';
      if (userId) lastUserId = userId;
      // Non-text traffic carries a usable context_token but nothing to route.
      if (message?.kind === 'unsupported') return;

      // An open host question or approval owns the next message: the user's
      // reply is the ANSWER, not a new instruction. This must come before the
      // picker. Questions are checked first because an approval prompt can
      // outlive a question only if something went badly wrong.
      if (questions.hasPending()) {
        if (await questions.handleReply(text)) return;
      }
      if (approvals.hasPending()) {
        if (await approvals.handleReply(text)) return;
      }

      // A pending `/new` workspace choice owns the next BARE NUMBER.
      //
      // This has to be settled before `classifyInbound` is consulted at all:
      // otherwise the digit answering "which workspace?" would be read by the
      // conversation picker as "select the Nth existing conversation" -- a real
      // selection with a real side effect, and exactly the bug the ordering here
      // exists to prevent. Anything that is not a number cancels the pending
      // choice (and says so), then falls through to normal handling, so a command
      // sent by mistake still does what it says.
      if (newChoice.peek() !== null) {
        const choice = parseChoiceNumber(text);
        if (choice !== null) {
          await resolveNewChoice(userId, choice);
          return;
        }
        if (classifyInbound(text, 0).kind === 'new') {
          // `/new` again: re-issue the list against the CURRENT workspaces and
          // restart the window, rather than cancel-and-reissue (which would answer
          // a repeat with two messages). If there is nothing left to offer, the
          // choice is closed instead of leaving numbers pointing at stale rows.
          const { paths, entries } = await listWorkspaces();
          if (paths.length === 0) {
            newChoice.cancel();
            await reply(userId, formatWorkspaceList([]), { withSession: false });
            return;
          }
          newChoice.open(paths);
          pendingWorkspaceEntries = entries;
          await reply(userId, formatWorkspaceList(paths), { withSession: false });
          return;
        }
        newChoice.cancel();
        await reply(userId, NEW_CANCELLED_TEXT, { withSession: false });
      }

      const sessions = typeof bridge?.listSessions === 'function'
        ? await bridge.listSessions().catch(() => [])
        : [];
      const decision = classifyInbound(text, sessions.length);
      const snapshot = await router.snapshot();

      if (decision.kind === 'new') {
        // Step 1: offer the workspaces. No pending choice is opened for an empty
        // list -- there would be nothing a number could address.
        const { paths, entries } = await listWorkspaces({ sessions });
        if (paths.length === 0) {
          await reply(userId, formatWorkspaceList([]), { withSession: false });
          return;
        }
        newChoice.open(paths);
        pendingWorkspaceEntries = entries;
        await reply(userId, formatWorkspaceList(paths), { withSession: false });
        return;
      }
      if (decision.kind === 'session-open' || decision.kind === 'session-close') {
        await applySessionDirection(userId, decision.kind === 'session-open', decision.sessionId, sessions);
        return;
      }
      if (decision.kind === 'bind') {
        // The user copied `/session <id>` out of a message and pasted it back.
        const wanted = sessions.find((session) => session.id === decision.sessionId);
        if (!wanted) {
          await reply(userId, formatSessionNotFound(decision.sessionId), { withSession: false });
          return;
        }
        await router.select(wanted.id, wanted.title);
        currentSelection = wanted.id;
        await reply(userId, formatSelected(wanted, sessions.indexOf(wanted) + 1));
        return;
      }
      if (decision.kind === 'list') {
        await reply(userId, formatSessionList(sessions, snapshot));
        return;
      }
      if (decision.kind === 'off') {
        await router.clearSelection();
        currentSelection = null;
        await reply(userId, '已断开。这个对话的回答不再发到微信；发任意消息可以重新选。');
        return;
      }
      if (decision.kind === 'select') {
        const picked = sessions[decision.index - 1];
        if (!picked) {
          await reply(userId, formatOutOfRange(decision.index, sessions.length));
          return;
        }
        await router.select(picked.id, picked.title);
        currentSelection = picked.id;
        await reply(userId, formatSelected(picked, decision.index));
        // The id is the thing a user is most likely to need verbatim elsewhere,
        // so it goes out alone (see replyCopyable).
        await replyCopyable(userId, '会话 ID（长按下面那条即可整条复制）：', picked.id);
        return;
      }

      // Free text: forwarded only into a conversation whose switch is ON.
      //
      // "Selected" and "switched on" are two different things, and this used to
      // check only the first. Turning the switch off in the web UI left the
      // channel still pointing at that conversation, so WeChat messages kept
      // being forwarded into a conversation the user had explicitly closed. The
      // switch is the contract: OFF means nothing is forwarded, full stop.
      const selected = await router.selectedId();
      const forwarding = selected ? await router.isEnabled(selected) : false;
      if (!forwarding) {
        await reply(userId, selected
          ? '这个对话的微信开关是关着的，消息没有转发过去。\n发 /list 重新选一个，或发 /off 断开。'
          : formatSessionList(sessions, snapshot));
        return;
      }
      if (typeof bridge?.submitUserText !== 'function') {
        await reply(userId, `会话桥接未就绪（${bridgeError ?? 'unknown'}），暂时无法转发。`);
        return;
      }
      // A failure here used to be logged and nothing else: the message reached
      // the transport, never became a turn, and the user stared at a silent
      // WeChat window with no way to tell what broke. Always answer.
      try {
        await bridge.submitUserText(selected, text);
      } catch (error) {
        bridgeError = `submit failed: ${error?.message ?? error}`;
        logger.warn?.(`[wechat-box] submit failed: ${inspect(error)}`);
        await reply(
          userId,
          `消息没能送进会话：${error?.message ?? error}\n（这条会记录在 state 路由的 bridgeError 里）`,
        );
      }
    } catch (error) {
      logger.warn?.(`[wechat-box] inbound handling failed: ${inspect(error)}`);
    }
  }

  // ---- runtime switch (objective item 7) -----------------------------------

  /**
   * Attach the two R7 waterfalls. Only legal while the transport is ours:
   * dsh-im answers the same waterfalls with `prepend: true`, and two answerers
   * would both push the same request to WeChat.
   */
  function enableInteractions() {
    if (questionsRegistered || approvalsRegistered) return true;
    if (typeof ctx?.on !== 'function' || !transportStarted) return false;
    disposeQuestions = ctx.on(
      'user-questions/request',
      (request, next) => questions.handle(request, next),
      { global: true, prepend: true },
    );
    disposeApprovals = ctx.on(
      'approval/request',
      (request, next) => approvals.handle(request, next),
      { global: true, prepend: true },
    );
    questionsRegistered = true;
    approvalsRegistered = true;
    bootTrace('interactions-enabled');
    return true;
  }

  function disableInteractions() {
    try { disposeQuestions?.(); } catch { /* ignore */ }
    try { disposeApprovals?.(); } catch { /* ignore */ }
    disposeQuestions = null;
    disposeApprovals = null;
    questionsRegistered = false;
    approvalsRegistered = false;
    // Anyone mid-answer must be released, or their next message would be read
    // as an answer to a question nobody is listening for any more.
    try { questions.dismissAll('the WeChat bridge was switched off'); } catch { /* ignore */ }
    try { approvals.dismissAll('the WeChat bridge was switched off'); } catch { /* ignore */ }
    // A pending `/new` choice is a question nobody can answer any more once the
    // transport is down; dropping it stops a later restart from inheriting it.
    try { newChoice.cancel(); } catch { /* ignore */ }
    bootTrace('interactions-disabled');
  }

  /** Flip the switch at runtime and persist the choice so it survives a restart. */
  async function setWeixinEnabled(enabled, { persist = true } = {}) {
    const next = enabled === true;
    if (persist) {
      await writeSettings({ weixinEnabled: next });
      weixinEnabledSource = 'settings-file';
    }
    weixinEnabled = next;
    if (next) {
      if (transport && !transportStarted) {
        await transport.start(onInbound);
        transportStarted = true;
        transportError = null;
      }
      enableInteractions();
    } else {
      disableInteractions();
      if (transport && transportStarted) {
        try { await transport.stop(); } catch (error) {
          logger.warn?.(`[wechat-box] transport.stop failed: ${error?.message ?? error}`);
        }
        transportStarted = false;
      }
      transportError = 'transport disabled by config (weixinEnabled=false)';
    }
    bootTrace('switch-flipped', `weixinEnabled=${weixinEnabled} transportStarted=${transportStarted}`);
    return weixinEnabled;
  }

  // ---- HTTP routes FIRST: the plugin must always be able to explain itself --

  const stateRoute = async (request, response) => {
    if (request.method !== 'GET') { json(response, 405, { ok: false, error: 'method-not-allowed' }); return; }
    try {
      const snapshot = await router.snapshot();
      let sessions = [];
      if (typeof bridge?.listSessions === 'function') {
        sessions = await bridge.listSessions().catch(() => []);
      }
      // Enumerated for the diagnostic below. Reuses the session rows the route
      // already fetched instead of asking the host twice.
      let workspacePaths = [];
      try {
        const enumerated = await listWorkspaces({ sessions });
        workspacePaths = enumerated.paths;
      } catch (error) {
        bootTrace('workspace-enumeration-failed', text(error?.message ?? error, 200));
      }
      json(response, 200, {
        ok: true,
        selectedId: snapshot.selectedId,
        sessions: snapshot.sessions,
        available: sessions.map((s) => ({ id: s.id, title: s.title })),
        weixinEnabled,
        weixinEnabledSource,
        transportReady: transport !== null && transportStarted,
        transportError,
        bridgeError,
        applyError,
        hasTransport: transport !== null,
        hasBridge: bridge !== null,
        // Requirement: make "the WeChat message never became a turn" diagnosable.
        bridgeServices: typeof bridge?.diagnose === 'function' ? bridge.diagnose() : null,
        questionsRegistered,
        approvalsRegistered,
        questionPending: questions.hasPending(),
        approvalPending: approvals.hasPending(),
        // `/new`: whether the host can actually create a conversation, which
        // workspaces it would offer, and why the last attempt failed. This is the
        // route that answers "can this plugin create a session" without reading
        // any source: `canCreate` is computed from the live service object.
        newSession: {
          canCreate: typeof hostServices.sessionController?.create === 'function',
          sessionController: hostServices.sessionController
            ? (typeof hostServices.sessionController.create === 'function' ? 'create' : 'no-create')
            : 'absent',
          workspaceRegistry: hostServices.workspaceRegistry ? 'present' : 'absent',
          workspaceSource,
          workspaceCount: workspacePaths.length,
          // Paths are directories, not secrets: showing them is the only way to
          // tell "the registry answered" from "we guessed from session cwds".
          workspaces: workspacePaths,
          maxChoices: MAX_WORKSPACE_CHOICES,
          ttlMs: NEW_CHOICE_TTL_MS,
          pending: newChoice.peek() !== null,
          lastError: createError,
        },
        // Requirement 6: what the Settings page shows about the bound account.
        // Values are masked -- this route is unauthenticated on localhost, and a
        // full bot id + owner id is enough to impersonate the conversation.
        account: account ? {
          botId: maskId(account.botId),
          accountId: maskId(account.accountId),
          ownerUserId: maskId(account.ownerUserId),
          baseUrlHost: hostOf(account.baseUrl),
          tokenRef: account.tokenRef,
          // Which file the account came from, and whether the credential is a
          // token in hand or a reference. The settings page shows this: "bound
          // by scan" and "inherited from dsh-im" are different states with
          // different failure modes, and the user cannot tell them apart
          // otherwise. Never the token itself.
          source: account.source ?? null,
          credentialKind: account.token ? 'token' : (account.tokenRef ? 'reference' : 'none'),
          // Where the live credential came from: the credential record read at
          // boot, or the scan still in memory. Never the token itself.
          credentialSource: account.credentialSource ?? null,
        } : null,
        // Login-flow observability: whether a scan is pending, when it dies, and
        // the last reason any part of the flow refused to proceed. A QR flow
        // that fails silently is indistinguishable from one nobody started.
        login: {
          available: typeof loginPrimitive?.beginLogin === 'function',
          pending: pendingQr !== null,
          expiresAtMs: pendingQr?.expiresAtMs ?? null,
          error: lastLoginError,
          accountError: lastAccountError,
          activationError,
        },
        transport: typeof transport?.status === 'function' ? transport.status() : null,
      });
    } catch (error) {
      json(response, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  const toggleRoute = async (request, response) => {
    if (request.method !== 'POST') { json(response, 405, { ok: false, error: 'method-not-allowed' }); return; }
    try {
      const body = await readJson(request);
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) { json(response, 400, { ok: false, error: 'sessionId is required' }); return; }
      const enabled = body?.enabled === true;
      const snapshot = await router.setEnabled(sessionId, enabled, body?.title);
      json(response, 200, { ok: true, sessionId, enabled, selectedId: snapshot.selectedId, sessions: snapshot.sessions });
    } catch (error) {
      json(response, 400, { ok: false, error: String(error?.message ?? error) });
    }
  };

  const beaconRoute = async (request, response) => {
    try {
      if (request.method === 'POST') {
        const body = await readJson(request);
        beacons.push({
          at: Date.now(),
          stage: String(body?.stage ?? 'unknown').slice(0, 40),
          detail: body?.detail == null ? null : String(body.detail).slice(0, 300),
        });
        if (beacons.length > MAX_BEACONS) beacons.splice(0, beacons.length - MAX_BEACONS);
        json(response, 200, { ok: true, count: beacons.length });
        return;
      }
      // GET: what the browser half reported, newest first. One page refresh is
      // enough to tell "bundle never loaded" from "registration rejected".
      json(response, 200, { ok: true, count: beacons.length, beacons: [...beacons].reverse() });
    } catch (error) {
      json(response, 400, { ok: false, error: String(error?.message ?? error) });
    }
  };

  /**
   * Send a one-off WeChat message through THIS plugin's transport.
   *
   * Needed because the previous push path (`@xmanrui/dsh-im`'s delivery route)
   * died with dsh-im. Routing it through the host matters: a standalone script
   * would be a SECOND consumer of the same bot -- it would long-poll, steal
   * updates and overwrite the shared cursor. That mistake was made once during
   * this migration; this route makes it unnecessary.
   */
  const pushRoute = async (request, response) => {
    if (request.method !== 'POST') { json(response, 405, { ok: false, error: 'method-not-allowed' }); return; }
    try {
      const body = await readJson(request);
      const text = typeof body?.text === 'string' ? body.text : '';
      if (!text.trim()) { json(response, 400, { ok: false, error: 'text is required' }); return; }
      const userId = (typeof body?.userId === 'string' && body.userId)
        || lastUserId
        || account?.ownerUserId
        || null;
      if (!userId) { json(response, 409, { ok: false, error: 'no-target-yet' }); return; }
      if (!transportStarted) { json(response, 409, { ok: false, error: 'transport-not-running' }); return; }
      // An explicit push may name the conversation it is about, so the reply
      // lands there instead of wherever the channel happened to point.
      const bindTo = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null;
      const result = await reply(userId, text, { bindTo });
      json(response, result?.ok === true ? 200 : 502, { ok: result?.ok === true, result, userId });
    } catch (error) {
      json(response, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  const enabledRoute = async (request, response) => {
    if (request.method !== 'POST') { json(response, 405, { ok: false, error: 'method-not-allowed' }); return; }
    try {
      const body = await readJson(request);
      if (typeof body?.enabled !== 'boolean') {
        json(response, 400, { ok: false, error: 'enabled must be a boolean' });
        return;
      }
      const effective = await setWeixinEnabled(body.enabled);
      json(response, 200, {
        ok: true,
        weixinEnabled: effective,
        weixinEnabledSource,
        transportReady: transport !== null && transportStarted,
        transportError,
        questionsRegistered,
        approvalsRegistered,
      });
    } catch (error) {
      json(response, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  // ---- QR login routes (DESIGN.md 10.2) ------------------------------------

  /**
   * The login primitive, imported once and remembered.
   *
   * `createWeixinLogin` takes a `fetchImpl`, and the test seam replaces the whole
   * factory -- no test in this package may reach ilinkai.weixin.qq.com.
   */
  async function ensureLogin() {
    if (loginPrimitive !== undefined) return loginPrimitive;
    try {
      if (typeof loaders.login === 'function') {
        loginPrimitive = await loaders.login({ logger });
      } else {
        const mod = await import('../transport/login.mjs');
        loginPrimitive = mod.createWeixinLogin({});
      }
      lastLoginError = null;
    } catch (error) {
      loginPrimitive = null;
      lastLoginError = `login module unavailable: ${error?.message ?? error}`;
      bootTrace('login-unavailable', lastLoginError);
    }
    return loginPrimitive;
  }

  const loginBeginRoute = async (request, response) => {
    if (request.method !== 'POST') { json(response, 405, { ok: false, error: 'method-not-allowed' }); return; }
    try {
      const login = await ensureLogin();
      if (!login || typeof login.beginLogin !== 'function') {
        json(response, 200, { ok: false, code: 'login-unavailable', error: lastLoginError ?? 'login primitive unavailable' });
        return;
      }
      const result = await login.beginLogin({});
      const issuedAtMs = Date.now();
      // The handle stays here. The browser gets a displayable image and the
      // deadline, never the token it would need to poll on its own behalf.
      pendingQr = { qrcode: result.qrcode, baseUrl: result.baseUrl, issuedAtMs, expiresAtMs: issuedAtMs + QR_TTL_MS };
      lastLoginError = null;
      // `qrcode_img_content` is NOT an image: it is the content the QR encodes
      // (an https landing page). Handing it to an <img src> can never work --
      // fetching it returns text/html. So it is rendered here, where the `qrcode`
      // package is resolvable, and the browser gets a self-contained data URL.
      const qrImage = await renderQrDataUrl(result.qrcodeUrl);
      bootTrace('login-begin', `expiresAtMs=${pendingQr.expiresAtMs} baseUrlHost=${hostOf(result.baseUrl)} rendered=${Boolean(qrImage)}`);
      json(response, 200, { ok: true, qrcodeUrl: result.qrcodeUrl, qrImage, expiresAtMs: pendingQr.expiresAtMs });
    } catch (error) {
      lastLoginError = text(error?.message ?? error, 400);
      bootTrace('login-begin-failed', lastLoginError);
      json(response, 200, { ok: false, code: error?.code ?? 'begin-failed', error: lastLoginError });
    }
  };

  /**
   * One poll of the pending scan.
   *
   * The status is passed through verbatim for every state the UI has to render
   * itself (wait / scaned / need_verifycode / expired / ...). Only `confirmed`
   * and the two terminal branches change anything on this side.
   */
  const loginPollRoute = async (request, response) => {
    if (request.method !== 'POST') { json(response, 405, { ok: false, error: 'method-not-allowed' }); return; }
    try {
      const body = await readJson(request);
      const verifyCode = typeof body?.verifyCode === 'string' && body.verifyCode.trim() ? body.verifyCode.trim() : undefined;

      const login = await ensureLogin();
      if (!login || typeof login.pollLogin !== 'function') {
        json(response, 200, { ok: false, code: 'login-unavailable', error: lastLoginError ?? 'login primitive unavailable' });
        return;
      }
      if (!pendingQr) {
        // No begin, or the host restarted between begin and poll. Either way the
        // UI must start over -- guessing a token is not an option.
        json(response, 200, { ok: false, code: 'no-pending-qr', error: '没有进行中的扫码，请重新生成二维码。' });
        return;
      }
      if (Date.now() > pendingQr.expiresAtMs) {
        pendingQr = null;
        json(response, 200, { ok: true, status: 'expired' });
        return;
      }

      const result = await login.pollLogin({
        qrcode: pendingQr.qrcode,
        baseUrl: pendingQr.baseUrl,
        ...(verifyCode === undefined ? {} : { verifyCode }),
      });
      const status = result?.status;
      bootTrace('login-poll', `status=${status}`);

      if (status === 'scaned_but_redirect') {
        // The platform answered from a different access point: keep polling the
        // one it named, or the scan can never complete. Not part of the task
        // text, but it is the documented meaning of this status (B3) and it
        // costs one field.
        if (typeof result.baseUrl === 'string' && result.baseUrl) pendingQr.baseUrl = result.baseUrl;
        else bootTrace('login-redirect-without-base', 'scaned_but_redirect carried no usable baseUrl');
        json(response, 200, { ok: true, status });
        return;
      }

      if (status === 'confirmed') {
        const nextAccount = accountFromCredentials(result.credentials);
        if (!nextAccount) {
          json(response, 200, { ok: false, code: 'incomplete-login', error: lastLoginError });
          return;
        }
        // The token has done its job: drop it before doing anything that can
        // fail, so a retry of poll cannot replay one half-consumed scan.
        pendingQr = null;
        const activated = await activateAccount(nextAccount);
        if (!activated.ok) {
          // `code` is part of the HTTP contract the settings page reads, so it
          // stays a small vocabulary of our own; the raw reason (an errno, a
          // provider string) travels in `error`, where it cannot become a
          // condition the UI has to know about.
          const code = activated.code === 'invalid-account' ? 'invalid-account' : 'activation-failed';
          json(response, 200, { ...activated, ok: false, code });
          return;
        }
        json(response, 200, {
          ok: true,
          status: 'confirmed',
          account: { botId: maskId(nextAccount.botId), baseUrlHost: hostOf(nextAccount.baseUrl) },
        });
        return;
      }

      if (status === 'binded_redirect') {
        // This WeChat id is already bound somewhere. The reference implementation
        // reuses local credentials when it has them and reports "already bound"
        // when it does not (weixin-controller.mjs:467-479) -- there is nothing to
        // scan here, so this is not a failure of the flow, only of the premise.
        pendingQr = null;
        if (!account || !hasReachableCredential(account)) {
          json(response, 200, {
            ok: false,
            status,
            code: 'already-bound',
            error: '这个微信号已经绑定过，但本机没有可用凭据。请先用原账号登录，或换一个微信号。',
          });
          return;
        }
        // Reuse what we have: the design's steps 2-4, with the credential record
        // left exactly as it is.
        const reused = await activateAccount({ ...account, source: 'binded-redirect' }, { skipCredentialsWrite: true });
        if (!reused.ok) {
          json(response, 200, { ok: false, status, code: reused.code ?? 'activation-failed', ...reused });
          return;
        }
        json(response, 200, {
          ok: true,
          status,
          account: { botId: maskId(account.botId), baseUrlHost: hostOf(account.baseUrl) },
        });
        return;
      }

      if (status === 'expired' || status === 'verify_code_blocked') {
        // Both mean this QR is finished; the UI must generate a new one. Dropping
        // the token here is what makes the next poll answer `no-pending-qr`
        // instead of replaying a dead code.
        pendingQr = null;
      }
      json(response, 200, { ok: true, status });
    } catch (error) {
      lastLoginError = text(error?.message ?? error, 400);
      bootTrace('login-poll-failed', lastLoginError);
      // A thrown poll is a failed round trip, not a verdict on the scan: keep the
      // token so the next tick can retry (a timeout is a normal window here).
      json(response, 200, { ok: false, code: error?.code ?? 'poll-failed', error: lastLoginError });
    }
  };

  const routes = [
    [STATE_PATH, stateRoute],
    [TOGGLE_PATH, toggleRoute],
    [BEACON_PATH, beaconRoute],
    [ENABLED_PATH, enabledRoute],
    [PUSH_PATH, pushRoute],
    [LOGIN_BEGIN_PATH, loginBeginRoute],
    [LOGIN_POLL_PATH, loginPollRoute],
  ];

  const registerWith = (host) => {
    const server = host?.webServer;
    if (!server || typeof server.register !== 'function') {
      applyError ??= 'webServer service present but not registrable';
      bootTrace('routes-unavailable', applyError);
      return false;
    }
    const errors = [];
    for (const [path, handler] of routes) {
      const register = () => {
        const disposer = server.register({ kind: 'exact', path, handler });
        // Only claim success AFTER register() returned. Logging outside the
        // callback would make this trace lie: `effect` may swallow a throw from
        // it, and a route that is "registered" but answers 401 is exactly the
        // failure we spent several restarts chasing. The return value is logged
        // too -- if register() reports failure in-band instead of throwing, that
        // is the only place it would show up.
        bootTrace('route-registered', `${path} -> ${describeValue(disposer)}`);
        // Wrapping the disposer matters: if the owning fiber is torn down right
        // after apply, the routes are unregistered again and every request 401s
        // with no other symptom. That would look identical to "never registered".
        return () => {
          bootTrace('route-disposed', path);
          try { return disposer?.(); } catch { /* ignore */ }
        };
      };
      // A host context without `effect` still gets the route; it just cannot be
      // disposed. Refusing to register would be strictly worse.
      try {
        if (typeof host.effect === 'function') host.effect(register, `dsh-wechat-box: ${path}`);
        else register();
      } catch (error) {
        errors.push(`${path}: ${error?.message ?? error}`);
        bootTrace('route-failed', `${path} :: ${error?.stack ?? error?.message ?? error}`);
      }
    }
    if (errors.length > 0) {
      applyError ??= `route registration failed: ${errors.join('; ')}`;
      bootTrace('routes-unavailable', applyError);
      return false;
    }
    bootTrace('routes-registered', routes.map(([p]) => p).join(', '));
    return true;
  };

  // This whole block is deferred when it goes through ctx.inject: if that
  // callback never runs, apply() returns "successfully" with no routes at all
  // and nothing anywhere says why. Hence the traces at every hop.
  try {
    if (typeof ctx?.inject === 'function') {
      // Register on the server `ctx.inject` yields, NOT the plugin-level one.
      // The boot trace settled this: the two are DIFFERENT objects
      // (`sameAsPluginLevel=false`). All four routes register successfully on the
      // plugin-level server -- it even hands back a disposer -- and every request
      // still 401s, because that object is not the one serving HTTP. dsh-im
      // registers through this path and its route works.
      //
      // `inject: ['webServer']` still matters: it is what makes the loader apply
      // this plugin at all. It is just not the object that serves HTTP.
      bootTrace('webserver-plugin-level', `present=${Boolean(ctx?.webServer)} register=${describeValue(ctx?.webServer?.register)}`);
      const fiber = ctx.inject(['webServer'], (httpCtx) => {
        bootTrace('inject-webServer-resolved', `sameAsPluginLevel=${httpCtx?.webServer === ctx.webServer}`);
        registerWith(httpCtx);
      });
      if (fiber && typeof fiber.then === 'function') {
        fiber.then(
          () => bootTrace('inject-webServer-fiber-ready'),
          (error) => bootTrace('inject-webServer-fiber-rejected', error?.message ?? error),
        );
      }
    } else if (ctx?.webServer?.register) {
      // No ctx.inject at all: the plugin-level server is all we have.
      bootTrace('webserver-fallback', 'no ctx.inject; using the plugin-level server');
      registerWith(ctx);
    } else {
      applyError ??= 'no ctx.inject and no ctx.webServer: diagnostic routes unavailable';
      bootTrace('routes-unavailable', applyError);
    }
  } catch (error) {
    applyError ??= `route registration failed: ${error?.message ?? error}`;
    bootTrace('routes-threw', error?.stack ?? error?.message ?? error);
  }

  // The two services `/new` is built on. Deliberately here -- after the routes,
  // before the risky setup -- so that a host which has neither still ends up with
  // a plugin that installs, serves its diagnostics, and says exactly what `/new`
  // is missing. `ctx.inject` can throw synchronously (see credentialsService), so
  // it never runs unguarded.
  try {
    acquireHostServices();
  } catch (error) {
    bootTrace('host-services-threw', error?.stack ?? error?.message ?? error);
  }

  // ---- risky setup, fully contained: it can never stop the routes ----------

  try {
    await router.load();
    // Seed the mirror so replies carry the fence from the first message after a
    // restart, not only once the user re-selects something.
    currentSelection = await router.selectedId().catch(() => null);

    // The persisted Settings toggle wins over the bundle default.
    const stored = await readSettings();
    if (stored) {
      weixinEnabled = stored.weixinEnabled;
      weixinEnabledSource = stored.source;
    }

    account = await readAccount();
    lastUserId = account?.ownerUserId ?? null;
    bootTrace('account-loaded', `source=${account?.source} botId=${maskId(account?.botId)} credential=${account?.token ? 'token' : (account?.tokenRef ? 'reference' : 'not-in-account-file')}`);
    // Leftovers from a process that died mid-write; removed before anything reads
    // the directory, so they can never be mistaken for a second account.
    await sweepAccountTemps().catch(() => undefined);

    // The token for an account this plugin bound by scanning lives in the
    // credential record and nowhere else: the account file deliberately does not
    // carry one any more (writeAccountFile). So it is fetched HERE, before a
    // transport exists, and a missing record REFUSES the transport instead of
    // building one with an empty token -- a transport started without a token
    // answers every call with `token-missing`, which looks like a network fault
    // and hides the real cause ("the record is not there").
    //
    // The legacy dsh-im account is the exception, and is not asked for a record:
    // its secret is a reference the transport resolves itself.
    let credentialReady = true;
    if (account?.source === 'account-file') {
      const token = await tokenFromCredentialRecord(account);
      if (token) {
        account = { ...account, token, credentialSource: 'credential-record' };
      } else {
        credentialReady = false;
        bootTrace('transport-refused', lastAccountError);
      }
    }

    if (credentialReady) transport = await buildTransport(account);

    if (typeof ctx?.inject === 'function' || ctx?.on) {
      if (typeof loaders.bridge === 'function') {
        bridge = await loaders.bridge({ ctx, logger, onTurnComplete: (event) => onTurnComplete(event) });
      } else {
        const mod = await import('../harness/bridge.mjs');
        bridge = mod.installHarnessBridge(ctx, { logger, onTurnComplete: (event) => onTurnComplete(event) });
      }
    } else {
      bridgeError = 'no ctx.inject: cannot reach sessions';
    }

    if (!credentialReady) {
      // Also the settings page's note (`transportError` is what it renders), so
      // the reason reaches the user and not only the boot log.
      transportError = lastAccountError ?? 'the bound account has no reachable credential';
      logger.warn?.(`[wechat-box] transport NOT started: ${transportError}`);
    } else if (transport && !weixinEnabled) {
      transportError = 'transport disabled by config (weixinEnabled=false)';
      logger.info?.('[wechat-box] transport NOT started: set weixinEnabled=true to take over WeChat');
    } else if (transport) {
      await transport.start(onInbound);
      transportStarted = true;
      transportError = null;
    }

    // R7 waterfalls. Gated on the same valve that owns the transport: while
    // dsh-im is mounted it already answers these waterfalls with `prepend: true`,
    // and two answerers would both push the same request to WeChat.
    if (weixinEnabled && transportStarted) {
      enableInteractions();
      logger.info?.('[wechat-box] host questions and approvals will be answered over WeChat');
    }
  } catch (error) {
    applyError = `setup failed: ${error?.message ?? error}`;
    bootTrace('setup-failed', error?.stack ?? applyError);
    logger.warn?.(`[wechat-box] ${applyError}`);
  }
  // "The object exists" is not "it is running": a transport whose start() threw
  // must never be reported as ready, or a dead bridge looks healthy.
  if (!transport) {
    transportError ??= applyError ?? 'transport unavailable';
  } else if (!transportStarted && !transportError) {
    transportError = applyError ?? 'transport did not start';
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      bootTrace('teardown');
      try { disableInteractions(); } catch { /* ignore */ }
      try { bridge?.dispose?.(); } catch { /* ignore */ }
      try { void transport?.stop?.(); } catch { /* ignore */ }
    }, 'dsh-wechat-box: teardown');
  }

  if (typeof ctx?.provide === 'function') {
    ctx.provide('wechatBox', Object.freeze({
      version: 1,
      snapshot: () => router.snapshot(),
      setEnabled: (sessionId, enabled, title) => router.setEnabled(sessionId, enabled, title),
      status: () => ({
        weixinEnabled,
        transportReady: transport !== null && transportStarted,
        transportError,
        bridgeError,
        applyError,
        beacons: [...beacons],
      }),
      // Test/inspection seam. This used to be the return value of apply(), which
      // is what broke the plugin -- see the note on apply() below.
      internals: () => ({ router, transport, bridge, beacons, applyError, newChoice, hostServices }),
    }));
  }

  logger.info?.(
    `[wechat-box] ready (transport=${transport ? 'up' : 'down'}, bridge=${bridge ? 'up' : 'down'}`
    + `${applyError ? `, applyError=${applyError}` : ''})`,
  );
  // NOTE: applyInner deliberately returns nothing meaningful. See apply().
  return undefined;
}

// LAST LINE OF THE MODULE. Its presence in the boot log proves the module body
// evaluated to completion, which separates "the host imported the file" from
// "the host imported the file and then refused to apply it".
bootTrace('module-evaluated', `apply=${typeof apply} inject=${JSON.stringify(inject ?? null)}`);