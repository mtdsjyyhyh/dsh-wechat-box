/**
 * LIVE probe for the new transport: sends exactly ONE real WeChat message.
 *
 * Why this is safe while @xmanrui/dsh-im is still running:
 *   it only calls `ilink/bot/sendmessage`. It never calls `getupdates`, so it
 *   cannot steal messages or advance the shared long-poll cursor.
 *   (Sending does not touch the cursor at all.)
 *
 * What it verifies for real (none of which the unit tests can):
 *   - the credential is readable and parsed out of the real .credentials.yaml
 *   - the auth headers and base_info are accepted by the platform
 *   - the send body shape is accepted
 *   - a seeded context_token (carried over from dsh-im) still works
 *
 * It also SEEDS the new transport's state file with dsh-im's context token, so
 * phase 2 can send proactively without waiting for a fresh inbound message.
 *
 *   node live-probe.mjs          # dry: prepare + report, do not send
 *   node live-probe.mjs --send   # actually send one message
 *
 * Secrets are never printed: only lengths and hashes.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { createWeixinTransport, extractYamlScalar } from './weixin.mjs';

const SEND = process.argv.includes('--send');
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const mask = (v) => (typeof v === 'string' && v ? `${v.slice(0, 4)}…(${v.length} chars)` : '(none)');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// --- 1. account ------------------------------------------------------------
const configPath = join(HOME, 'integrations', 'dsh-weixin', 'config.json');
const account = (JSON.parse(await readFile(configPath, 'utf8')).accounts ?? [])[0];
if (!account) fail(`no account in ${configPath}`);
console.log(`account     : botId=${account.botId} tokenRef=${account.tokenRef}`);
console.log(`baseUrl     : ${account.baseUrl}`);
console.log(`ownerUserId : ${mask(account.ownerUserId)}`);

// --- 2. bot token (never printed) ------------------------------------------
const credentialsPath = join(HOME, '.credentials.yaml');
const token = extractYamlScalar(await readFile(credentialsPath, 'utf8'), account.tokenRef);
if (!token) fail(`token ${account.tokenRef} not found in ${credentialsPath}`);
const credentialHash = createHash('sha256').update(token).digest('hex');
console.log(`token       : found, sha256=${credentialHash.slice(0, 12)}…`);

// --- 3. carry over dsh-im's context token ----------------------------------
const dshImStatePath = join(HOME, 'integrations', 'dsh-weixin', 'accounts', account.botId, 'state.json');
let seed = null;
try {
  const raw = JSON.parse(await readFile(dshImStatePath, 'utf8'));
  const entry = raw?.contextTokens?.users?.[account.ownerUserId];
  if (entry?.token) {
    seed = {
      token: entry.token,
      seq: entry.seq === undefined || entry.seq === null ? null : String(entry.seq),
      messageTimeMs: Number.isFinite(entry.messageTimeMs) ? entry.messageTimeMs : null,
      receivedAt: Number.isFinite(entry.receivedAt) ? entry.receivedAt : Date.now(),
    };
    console.log(`context tok : carried over from dsh-im (seq=${seed.seq}, token ${mask(entry.token)})`);
  } else {
    console.log('context tok : NOT available in dsh-im state');
  }
} catch (error) {
  console.log(`context tok : cannot read dsh-im state (${error.code ?? error.message})`);
}

// --- 4. seed the new transport's own state file ----------------------------
const statePath = join(HOME, 'storages', 'wechat-box-transport.json');
const state = {
  version: 1,
  credentialHash,
  // Empty cursor on purpose: this probe must never look like it consumed a
  // batch, and phase 2 starts polling from "now".
  getUpdatesBuf: '',
  seenMessageIds: [],
  contextTokens: seed ? { [account.ownerUserId]: seed } : {},
  updatedAt: Date.now(),
};
await mkdir(dirname(statePath), { recursive: true });
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
console.log(`state seeded: ${statePath}`);

// --- 5. send one real message ----------------------------------------------
const transport = createWeixinTransport({
  botId: account.botId,
  accountId: account.accountId,
  baseUrl: account.baseUrl,
  tokenRef: account.tokenRef,
  credentialsPath,
  statePath,
  logger: { info() {}, warn: (m) => console.log(`  warn: ${m}`), error: (m) => console.log(`  err : ${m}`) },
});

await transport.ready();
console.log(`context in state after ready: ${transport.stateSnapshot?.().contextTokens ? 'ok' : 'unknown'}`);

if (!SEND) {
  console.log('\nDRY RUN -- nothing sent. Re-run with --send to push one real message.');
  process.exit(0);
}

const text = '【新传输层实测】这条由 dsh-wechat-box 自己发出（未经过 dsh-im）。收到即证明：凭据解析、鉴权头、发送体、context_token 全部可用。';
const result = await transport.sendText(account.ownerUserId, text);
console.log(`\nsendText -> ${JSON.stringify({ ...result, response: undefined })}`);
if (result.ok) {
  console.log('LIVE SEND OK -- transport is verified against the real platform (send path).');
  process.exit(0);
}
console.error('LIVE SEND FAILED');
process.exit(1);
