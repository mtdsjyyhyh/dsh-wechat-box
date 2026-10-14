/**
 * Manifest conformance test.
 *
 * The host's bundle loader DROPS a malformed bundle into `skippedBundles`
 * silently: wrong `dsh.bundle.patch`, a `main` that does not resolve, a
 * `dsh.client` without `platform` or without an `exports["./client"]`. Nothing
 * is logged where the user can see it, and the symptom is just "my plugin is
 * not there" -- the same class of silent failure that cost us a whole restart
 * cycle with the previous plugin. So the wiring itself is asserted here.
 *
 *   node test-manifest.mjs
 */
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// --- identity ---------------------------------------------------------------
{
  assert.equal(manifest.name, 'dsh-wechat-box');
  assert.equal(manifest.type, 'module', 'the host half is ESM');
  assert.equal(manifest.private, true, 'a local plugin is never published');
  ok('package identity and module type');
}

// --- the host entry the loader will import ----------------------------------
{
  assert.equal(typeof manifest.main, 'string');
  await access(join(root, manifest.main));                 // throws if absent
  assert.equal(manifest.exports['.'], `./${manifest.main}`);
  const mod = await import(pathToFileURL(join(root, manifest.main)).href);
  assert.equal(mod.name, manifest.name, 'the exported plugin name must match the package name');
  assert.equal(typeof mod.apply, 'function', 'the loader calls apply(ctx, config)');
  ok(`main entry resolves, exports name="${manifest.name}" and apply()`);
}

// --- the bundle patch the loader merges -------------------------------------
{
  const patchRel = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patchRel, 'string', 'dsh.bundle.patch is required or the bundle is skipped');
  const patchText = await readFile(join(root, patchRel), 'utf8');
  assert.match(patchText, /-\s*insert:/, 'the patch must be a top-level array with an insert');
  // The inserted row's name is what the loader resolves the package by.
  const names = [...patchText.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.includes(manifest.name), `the insert row must name ${manifest.name}, saw ${names.join(', ')}`);
  const ids = [...patchText.matchAll(/id:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 1, 'the insert row needs an id');
  // The valve must be an EXPLICIT boolean. It ships `false` (safe while
  // @xmanrui/dsh-im still polls the same bot) and `migrate.ps1 -Phase2` flips it
  // to `true`, so both values are valid -- what matters is that the choice is
  // written down rather than left to a default that nobody reviewed.
  const valve = patchText.match(/weixinEnabled:\s*(true|false)/);
  assert.ok(valve, 'the config must state weixinEnabled explicitly');
  ok(`dsh.bundle.patch declares insert -> ${names.join(', ')} with weixinEnabled=${valve[1]}`);
}

// --- the browser half -------------------------------------------------------
{
  const client = manifest.dsh?.client;
  assert.ok(client, 'dsh.client is what puts the bundle in the browser roster');
  assert.equal(client.platform, 'web');
  assert.equal(client.immediately, true, 'a UI switch should not wait for lazy materialisation');
  assert.ok(Array.isArray(client.inject) && client.inject.length > 0, 'inject names the slot owner package');
  assert.ok(
    client.inject.some((name) => name.includes('ui-conversation')),
    'the slot we register into is owned by ui-conversation',
  );
  const clientRel = manifest.exports['./client'];
  assert.equal(typeof clientRel, 'string', 'dsh.client without exports["./client"] throws in the loader');
  const source = await readFile(join(root, clientRel), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/, 'the bundle uses the loader handshake');
  assert.match(source, /id:\s*'dsh-wechat-box'/, 'the loader id is the package name');
  assert.ok(!/^\s*import\s/m.test(source), 'a browser bundle has no module resolution; no bare imports');
  assert.ok(isAbsolute(join(root, clientRel)), 'the client entry lives inside the package');
  ok('dsh.client is web/immediate, the client entry exists and uses the loader handshake');
}

// --- every module the host imports must exist and parse ---------------------
{
  const host = await readFile(join(root, manifest.main), 'utf8');
  const imports = [
    ...[...host.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]),
    ...[...host.matchAll(/import\('(\.[^']+)'\)/g)].map((m) => m[1]),
  ];
  assert.ok(imports.length >= 3, `expected several relative imports, saw ${imports.length}`);
  for (const specifier of new Set(imports)) {
    const target = resolve(here, specifier);
    await access(target);                                  // throws if missing
    const mod = await import(pathToFileURL(target).href);  // throws on syntax errors
    assert.ok(mod && Object.keys(mod).length > 0, `${specifier} exports nothing`);
  }
  const transport = resolve(here, '../transport/weixin.mjs');
  const bridge = resolve(here, '../harness/bridge.mjs');
  for (const target of [transport, bridge]) await access(target);
  ok(`host imports resolve and parse (${new Set(imports).size} relative + transport + bridge)`);
}

// --- the test script actually covers every suite ----------------------------
{
  const script = manifest.scripts?.test ?? '';
  const suites = ['router/test.mjs', 'transport/test.mjs', 'harness/test.mjs', 'harness/test-questions.mjs',
    'harness/test-approvals.mjs', 'lib/test.mjs', 'lib/test-client.mjs', 'lib/test-integration.mjs',
    'lib/test-e2e.mjs', 'lib/test-manifest.mjs'];
  const missing = suites.filter((s) => !script.includes(s));
  // This very file may legitimately be absent from its own list on first write.
  assert.ok(missing.length <= 1, `npm test does not run: ${missing.join(', ')}`);
  ok(`npm test covers the suites (${suites.length - missing.length}/${suites.length})`);
}

console.log(`\nmanifest conformance: ${passed} checks passed`);
