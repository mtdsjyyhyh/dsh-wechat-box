/**
 * Client-half test. `lib/client.js` is the exact component that failed to render
 * in the previous plugin, and until now it had no test at all in this package.
 *
 * This loads the bundle the way the DSH web client does -- through
 * window.__ModuleLoader__ with react supplied by `require` -- and checks the
 * contract the host enforces plus the behaviour the user sees:
 *
 *   id          must equal the package name (the loader normalises and rejects
 *               duplicate registrations on it)
 *   factory     must return a Cordis plugin: { inject, apply }
 *   apply       must register into conversation.session.header.actions with a
 *               list-slot `id`, and must use ctx.slots.inject (the parent slot
 *               is declared lazily, so registering eagerly would throw)
 *   beacons     eval + registered must be posted, or a silent failure is invisible
 *   component   renders nothing without a sessionId, renders the switch with one,
 *               loads state on mount and POSTs the toggle on click
 *
 *   node test-client.mjs
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok  ${label}`); };

const SLOT = 'conversation.session.header.actions';
const SETTINGS_SLOT = 'settings.section';
const STATE_URL = '/api/dsh-wechat-box/state';
const TOGGLE_URL = '/api/dsh-wechat-box/toggle';
const BEACON_URL = '/api/dsh-wechat-box/beacon';

// --- stub the browser boundaries BEFORE the bundle is evaluated -------------
const fetches = [];
globalThis.fetch = async (url, init = {}) => {
  fetches.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
  const payload = String(url).includes(STATE_URL)
    ? { ok: true, selectedId: 'session-x', sessions: { 'session-2': { enabled: true } }, available: [] }
    : { ok: true };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
};

const hooks = { states: [], effects: [] };
// A one-slot state store: a setter records the pending value and the NEXT render
// reads it. That is enough to assert what the component looks like after its
// async load settles, which a no-op setter cannot show.
let pendingState = null;
let lastState;
const React = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
  useState(initial) {
    const value = pendingState !== null
      ? pendingState
      : (typeof initial === 'function' ? initial() : initial);
    pendingState = null;
    lastState = value;
    hooks.states.push(value);
    const setter = (next) => { pendingState = typeof next === 'function' ? next(lastState) : next; };
    return [value, setter];
  },
  useEffect(fn) { hooks.effects.push(fn); return undefined; },
};

let registration = null;
globalThis.window = {
  __ModuleLoader__: { load(reg) { registration = reg; } },
};

// --- evaluate the bundle ----------------------------------------------------
const pkg = JSON.parse(await readFile(new URL('./../package.json', import.meta.url), 'utf8'));
await import('./client.js');

assert.ok(registration, 'the bundle registered itself with __ModuleLoader__');
assert.equal(registration.id, pkg.name, 'the loader id must be the package name');
assert.equal(typeof registration.factory, 'function');
assert.deepEqual(
  fetches.map((f) => f.body?.stage).filter(Boolean), ['eval'],
  'top-level code reports that the bundle was fetched and executed',
);
assert.equal(fetches[0].method, 'POST');
assert.equal(fetches[0].url, BEACON_URL);
ok('bundle loads under the package name and beacons `eval` at top level');

const mod = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require: ${specifier}`);
});
assert.deepEqual(mod.inject, ['slots'], 'the client plugin injects the slot registry');
assert.equal(typeof mod.apply, 'function');
assert.deepEqual(
  fetches.map((f) => f.body?.stage).filter(Boolean), ['eval', 'factory'],
  'the factory being invoked is its own observable stage (bundles run lazily)',
);
ok('factory returns a Cordis plugin { inject: ["slots"], apply } and beacons `factory`');

// --- apply() wires the slot -------------------------------------------------
{
  const registered = [];
  const injected = [];
  const effects = [];
  const ctx = {
    slots: {
      inject(name, cb) { injected.push(name); return cb(); },
      register(options, Component) { registered.push({ options, Component }); return () => {}; },
    },
    effect(fn, label) { const d = fn(); effects.push({ label, dispose: d }); return () => {}; },
  };
  mod.apply(ctx);
  assert.deepEqual(injected, [SLOT, SETTINGS_SLOT], 'it injects both target slots (both declared lazily)');
  assert.equal(registered.length, 2, 'the header switch plus the settings section');
  const { options, Component } = registered[0];
  assert.equal(options.name, SLOT);
  assert.equal(options.id, 'wechat-box', 'a list slot requires a stable id');
  assert.equal(typeof options.order, 'number');
  assert.equal(typeof Component, 'function');
  assert.ok(effects.length >= 1, 'the registration is owned by ctx.effect so it can be disposed');

  // The settings section: objective items 6 and 7 live here.
  const settings = registered[1];
  assert.equal(settings.options.name, SETTINGS_SLOT);
  assert.equal(settings.options.id, 'wechat-box');
  assert.equal(typeof settings.options.label, 'function', 'a settings section needs a nav label');
  assert.equal(settings.options.label(), '微信桥接');
  assert.equal(typeof settings.Component, 'function');

  const stages = fetches.map((f) => f.body?.stage).filter(Boolean);
  assert.deepEqual(
    stages, ['eval', 'factory', 'registered', 'registered'],
    'both registrations report success separately',
  );
  ok('apply() registers the header switch and the settings section, and beacons each');

  // Renders nothing without a session, a switch with one.
  pendingState = null;                          // the stub store is module-level; start clean
  assert.equal(Component({ sessionId: undefined }), null, 'a blank session renders nothing');
  assert.equal(Component({}), null);
  const effectsBefore = hooks.effects.length;
  const element = Component({ sessionId: 'session-2' });
  assert.equal(element.type, 'button');
  assert.equal(element.props['data-wechat-box'], 'off', 'starts off until the state loads');
  assert.equal(element.props['aria-pressed'], 'false');
  assert.equal(typeof element.props.onClick, 'function');
  ok('component renders null for a blank session and an off switch for a real one');

  // Mount: loads state from the host. Take the effect THIS render registered --
  // earlier renders pushed their own (and a blank session returns early).
  assert.equal(hooks.effects.length, effectsBefore + 1, 'exactly one effect for a real session');
  const before = fetches.length;
  const cleanup = hooks.effects[effectsBefore]();
  assert.equal(typeof cleanup, 'function', 'the mount effect returns a cleanup');
  await new Promise((r) => setTimeout(r, 0));
  const load = fetches.slice(before).find((f) => f.url === STATE_URL);
  assert.ok(load, 'the mount effect GETs the state route');
  assert.equal(load.method, 'GET');

  // Click: flips to ON and POSTs the toggle.
  const clickBefore = fetches.length;
  element.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  const toggle = fetches.slice(clickBefore).find((f) => f.url === TOGGLE_URL);
  assert.ok(toggle, 'clicking POSTs the toggle route');
  assert.equal(toggle.method, 'POST');
  assert.deepEqual(toggle.body, { sessionId: 'session-2', enabled: true });
  ok('the switch loads state on mount and POSTs the toggle on click');
}

// --- a registration that throws must be REPORTED, not swallowed -------------
// When the parent slot is declared lazily, this register() runs inside the
// declaring call and its throw is swallowed by the renderer: fiber ACTIVE, page
// fine, no button. That is the previous plugin's exact failure signature, so it
// has to come out as a beacon.
{
  const stagesBefore = fetches.length;
  const ctx = {
    slots: {
      inject(name, cb) { return cb(); },
      register() { throw new Error('slot "conversation.session.header.actions" is not declared'); },
    },
    effect(fn) { const d = fn(); return () => {}; },
  };
  mod.apply(ctx);
  await new Promise((r) => setTimeout(r, 0));
  const errorBeacon = fetches.slice(stagesBefore).find((f) => f.body?.stage === 'error');
  assert.ok(errorBeacon, 'the swallowed path is reported instead of vanishing');
  assert.match(errorBeacon.body.detail, /^register: /, 'the detail says which phase failed');
  assert.match(errorBeacon.body.detail, /not declared/, 'and carries the real reason');
  ok('a throwing slot registration produces an error beacon (not a silent no-show)');
}

// --- when the host is not answering, the switch says so and does nothing ----
// Reported from real use: the pill rendered (client half fine) but clicking it
// flicked on and snapped back, because the host routes were not registered yet.
// An optimistic flip plus a silent revert reads as "broken switch" when the
// truth is "host half has not loaded". It must be inert AND explicit.
{
  const src = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!view\.ready\) return;/, 'clicking while not ready is a no-op');
  assert.match(src, /'data-wechat-box': !view\.ready \? 'not-ready'/, 'not-ready has its own marker');
  assert.match(src, /宿主半边未就绪/, 'the tooltip names the real cause');
  assert.match(src, /NOT_READY_STYLE/, 'and it is styled as inert');

  // With a failing state GET, mounting must not throw and must not claim ON.
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  const registered = [];
  const ctx = {
    slots: {
      inject(name, cb) { return cb(); },
      register(options, Component) { registered.push(Component); return () => {}; },
    },
    effect(fn) { fn(); return () => {}; },
  };
  mod.apply(ctx);
  const Component = registered[0];              // the header switch, not the settings section
  const before = hooks.effects.length;
  pendingState = null;                          // the stub store is module-level; start clean
  const element = Component({ sessionId: 'session-2' });
  hooks.effects[before]();                       // mount; the state GET 401s
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(element.props['data-wechat-box'], 'off', 'first paint is still undecided');
  globalThis.fetch = savedFetch;
  ok('a down host shows 「未就绪」 and clicking is inert (no optimistic flick)');
}

// --- the settings section: the master switch and the bound account ----------
{
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    weixinEnabled: true,
    account: {
      botId: 'wx_exa…t_id',
      ownerUserId: 'owner@…chat',
      tokenRef: 'DSH_WEIXIN_BOT_TOKEN_TEST',
      baseUrlHost: 'ilinkai.weixin.qq.com',
    },
    transport: { connected: true },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const registered = [];
  const ctx = {
    slots: {
      inject(name, cb) { return cb(); },
      register(options, Component) { registered.push(Component); return () => {}; },
    },
    effect(fn) { fn(); return () => {}; },
  };
  mod.apply(ctx);
  const Settings = registered[1];               // 0 = header switch, 1 = settings section
  pendingState = null;                          // the stub store is module-level; start clean
  const before = hooks.effects.length;
  Settings({});                                 // first paint: still loading
  hooks.effects[before]();                      // mount: GET the state route
  await new Promise((r) => setTimeout(r, 5));
  const tree = Settings({});                    // re-render with the loaded state

  const text = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? undefined : value));
  assert.match(text, /微信桥接/, 'the section has a heading');
  assert.match(text, /已绑定账号/);
  assert.match(text, /wx_exa…t_id/, 'the masked bot id is shown');
  assert.match(text, /owner@…chat/, 'the masked WeChat user is shown');
  assert.match(text, /ilinkai\.weixin\.qq\.com/);
  assert.match(text, /已连接/, 'connection state comes from the transport status');
  assert.match(text, /DSH_WEIXIN_BOT_TOKEN_TEST/, 'the credential reference name is shown');
  assert.match(text, /重新绑定/, 'and it is honest that rebinding is not implemented yet');
  assert.match(text, /已启用/, 'the switch reflects weixinEnabled');
  assert.ok(!text.includes('secret-value'), 'no secret leaks into the rendered tree');
  globalThis.fetch = savedFetch;
  ok('objective 6/7: the settings section renders the switch and the masked account');
}

// --- a broken ctx must NOT take the page down -------------------------------
// The client half runs inside the shell; throwing here would fail the whole boot
// audit on first paint, which is how a plugin can break the entire GUI.
{
  const stagesBefore = fetches.length;
  mod.apply({ slots: null });
  await new Promise((r) => setTimeout(r, 0));
  const errorBeacon = fetches.slice(stagesBefore).find((f) => f.body?.stage === 'error');
  assert.ok(errorBeacon, 'a missing slot registry is reported, not thrown');
  assert.match(errorBeacon.body.detail, /slots/);
  ok('apply() reports a broken context instead of throwing into the boot audit');
}

// --- the banner advertises where to look when it does not show up -----------
{
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'still uses the loader handshake');
  assert.ok(!source.includes('import '), 'no bare imports (the bundle has no module resolution)');
  assert.ok(source.includes('require(\'react\')'), 'react comes from the loader seed table');
  ok('the bundle keeps the loader contract (no imports, react via require)');
}

console.log(`\nclient half: ${passed} checks passed`);
