/**
 * dsh-wechat-box -- client half.
 *
 * Puts the per-conversation WeChat switch into the conversation header actions
 * slot (`conversation.session.header.actions`, kind=list, scope=session) -- the
 * row to the right of the chat title.
 *
 * WHY THERE IS A BEACON IN HERE
 * -----------------------------
 * The host SNAPSHOTS every `client.js` at startup (see
 * @deepseek-ai/dsh-client-modules), and bundle content changes only enter the
 * graph through the HMR `rebuilt()` hook. So every client-side change costs a
 * host restart -- which interrupts the user's session. A previous plugin of mine
 * rendered no button and I could not tell whether the bundle was never loaded,
 * the registration was rejected, or the component returned null. The beacon
 * removes that guesswork: it reports three stages to a host route, so ONE
 * restart tells us exactly how far the browser half got.
 *
 * Beacon stages:
 *   eval        the bundle body ran at all
 *   registered  slots.register() returned
 *   error       registration threw (detail = message)
 *   rendered    the component produced a button for a real session
 */
// The beacon lives at TOP LEVEL on purpose. The three stages answer three
// different questions, and the host snapshots this file at startup, so a silent
// failure has to be locatable from the outside:
//   eval       the bundle was fetched AND executed by the page
//   factory    the plugin was materialised (bundle factories run lazily)
//   registered the slot registration returned
//   error      something threw, with the message
var __WECHAT_BOX_BEACON = '/api/dsh-wechat-box/beacon';

function __wechatBoxBeacon(stage, detail) {
  try {
    fetch(__WECHAT_BOX_BEACON, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: stage, detail: detail === undefined ? null : String(detail).slice(0, 300) }),
      keepalive: true,
    }).catch(function () { /* diagnostics must never break the UI */ });
  } catch (error) { /* ignore */ }
}

__wechatBoxBeacon('eval', typeof window !== 'undefined' && window.__DSH_BOOT__ ? 'boot-present' : 'no-boot');

window.__ModuleLoader__.load({
  id: 'dsh-wechat-box',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    var SLOT = 'conversation.session.header.actions';
    var SETTINGS_SLOT = 'settings.section';
    var STATE_URL = '/api/dsh-wechat-box/state';
    var TOGGLE_URL = '/api/dsh-wechat-box/toggle';
    var ENABLED_PATH = '/api/dsh-wechat-box/enabled';
    var LOGIN_BEGIN_URL = '/api/dsh-wechat-box/login/begin';
    var LOGIN_POLL_URL = '/api/dsh-wechat-box/login/poll';
    var beacon = __wechatBoxBeacon;

    beacon('factory', 'materialised');

    var ON_STYLE = {
      display: 'inline-flex', alignItems: 'center', gap: '6px', height: '26px',
      padding: '0 9px', borderRadius: '999px',
      border: '1px solid rgba(7,193,96,0.45)', background: 'rgba(7,193,96,0.14)',
      color: '#07c160', font: 'inherit', fontSize: '12px', lineHeight: 1,
      cursor: 'pointer', whiteSpace: 'nowrap',
    };
    var OFF_STYLE = {
      display: 'inline-flex', alignItems: 'center', gap: '6px', height: '26px',
      padding: '0 9px', borderRadius: '999px',
      border: '1px solid rgba(128,128,128,0.35)', background: 'transparent',
      color: 'inherit', font: 'inherit', fontSize: '12px', lineHeight: 1,
      cursor: 'pointer', opacity: 0.72, whiteSpace: 'nowrap',
    };
    // Host half not answering: look inert and be inert, rather than pretending
    // the click worked and snapping back.
    var NOT_READY_STYLE = Object.assign({}, OFF_STYLE, {
      borderStyle: 'dashed',
      opacity: 0.6,
      cursor: 'default',
    });
    var DOT = { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto' };
    var LINK_STYLE = {
      display: 'inline-flex', alignItems: 'center', height: '26px', padding: '0 10px',
      borderRadius: '6px', border: '1px solid rgba(7,193,96,0.45)',
      background: 'rgba(7,193,96,0.12)', color: '#07c160',
      font: 'inherit', fontSize: '12px', lineHeight: 1, cursor: 'pointer', whiteSpace: 'nowrap',
    };
    var PANEL_STYLE = {
      margin: '8px 0', padding: '12px', borderRadius: '8px',
      border: '1px solid rgba(128,128,128,0.25)', background: 'rgba(128,128,128,0.06)',
      display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start',
    };
    // The QR image comes straight from the platform over https; it is rendered as
    // an <img src>, never as markup, so nothing the platform returns can become
    // HTML in this page.
    var QR_STYLE = {
      width: '180px', height: '180px', objectFit: 'contain',
      background: '#ffffff', borderRadius: '6px', padding: '6px',
    };
    var INPUT_STYLE = {
      height: '28px', padding: '0 8px', borderRadius: '6px',
      border: '1px solid rgba(128,128,128,0.4)', background: 'transparent',
      color: 'inherit', font: 'inherit', fontSize: '13px', width: '120px',
    };
    var MUTED = { fontSize: '12px', opacity: 0.7, lineHeight: 1.6 };

    function readJson(promise) {
      return promise.then(function (response) {
        if (!response || !response.ok) throw new Error('http ' + (response && response.status));
        return response.json();
      });
    }

    // A mutable box that survives re-renders, and nothing more: the real client
    // provides `useRef`, and the fallback only exists so that a runtime without
    // it renders the panel (with a box that is rebuilt per render) instead of
    // throwing into the page's boot audit.
    function useBox(initial) {
      if (typeof React.useRef === 'function') return React.useRef(initial);
      return { current: initial };
    }

    function WechatBoxToggle(props) {
      var sessionId = props && props.sessionId;
      var pair = React.useState({ loaded: false, enabled: false, ready: true, selected: false });
      var view = pair[0];
      var setView = pair[1];

      React.useEffect(function () {
        if (!sessionId) return undefined;
        var live = true;
        var load = function () {
          readJson(fetch(STATE_URL, { headers: { accept: 'application/json' } }))
            .then(function (data) {
              if (!live) return;
              var entry = data && data.sessions ? data.sessions[sessionId] : undefined;
              setView({
                loaded: true,
                enabled: !!(entry && entry.enabled),
                ready: data.selectedId !== undefined || data.ok !== false,
                selected: data.selectedId === sessionId,
              });
            })
            .catch(function () {
              if (live) setView({ loaded: true, enabled: false, ready: false, selected: false });
            });
        };
        load();
        // The switch can be flipped from OUTSIDE this page -- `/session <id>
        // open|close` from WeChat, or `/session <id> close` while the pill is on
        // screen. Reading state once on mount left the pill green after a WeChat
        // close, i.e. the UI contradicted the host. So: poll slowly while
        // visible, and refresh immediately when the tab regains focus, which is
        // exactly the moment the user comes back from WeChat to look at it.
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          load();
        }, 5000);
        // Node keeps the event loop alive for a pending timer; `unref` is a no-op
        // in the browser and keeps the test runner from hanging on this interval.
        if (timer && typeof timer.unref === 'function') timer.unref();
        var onFocus = function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          load();
        };
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('focus', onFocus);
          document.addEventListener('visibilitychange', onFocus);
        }
        return function () {
          live = false;
          clearInterval(timer);
          if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
          }
        };
      }, [sessionId]);

      if (!sessionId) return null;

      var toggle = function () {
        // If the host half is not answering, clicking must NOT pretend to work:
        // a switch that flicks on and snaps back reads as "broken", when the
        // real message is "the host has not loaded this route yet". Say so.
        if (!view.ready) return;
        var next = !view.enabled;
        setView({ loaded: true, enabled: next, ready: true, selected: next });
        readJson(fetch(TOGGLE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, enabled: next }),
        })).catch(function () {
          setView({ loaded: true, enabled: false, ready: false, selected: false });
        });
      };

      var label = !view.ready ? '微信 未就绪' : (view.enabled ? '微信 已连通' : '微信');
      var title = !view.ready
        ? '宿主半边未就绪：dsh-wechat-box 的宿主进程还没注册这条路由（通常需要重启一次 DSH）。'
        : view.enabled
          ? '这个对话与微信双向连通（微信发消息进这里，回答回到微信）。点一下断开。'
          : '把这个对话连到微信：开关打开后双向互通。关着时微信仍可用编号选中并单向发一条。';
      return React.createElement(
        'button',
        {
          type: 'button',
          onClick: toggle,
          style: !view.ready ? NOT_READY_STYLE : (view.enabled ? ON_STYLE : OFF_STYLE),
          title: title,
          'aria-pressed': view.enabled ? 'true' : 'false',
          'data-wechat-box': !view.ready ? 'not-ready' : (view.enabled ? 'on' : 'off'),
        },
        React.createElement('span', {
          style: Object.assign({}, DOT, {
            background: !view.ready ? '#d97706' : (view.enabled ? '#07c160' : 'currentColor'),
            opacity: view.enabled || !view.ready ? 1 : 0.5,
          }),
        }),
        React.createElement('span', null, label),
      );
    }

    // ---- Settings section (objective items 6 and 7) -------------------------
    // A section in Settings rather than another header button: this is where
    // "turn the plugin off" belongs, and it is also the natural home for "which
    // account am I bound to".
    function Row(label, value, extra) {
      return React.createElement('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' },
      },
        React.createElement('span', { style: { minWidth: '96px', opacity: 0.65, fontSize: '12px' } }, label),
        React.createElement('span', { style: { fontSize: '13px', wordBreak: 'break-all' } }, value),
        extra ? React.createElement('span', { style: { fontSize: '12px', opacity: 0.6 } }, extra) : null,
      );
    }

    // What each login status means, in the words the user needs. The platform's
    // status strings are the protocol's vocabulary; these are the instructions.
    var LOGIN_STATUS_TEXT = {
      wait: '等待扫码：用微信扫上面的二维码。',
      scaned: '已扫码，请在手机上点击确认。',
      need_verifycode: '需要配对码：输入手机上显示的数字。',
      verify_code_blocked: '配对码错误次数过多，这个二维码已作废，请重新生成。',
      expired: '二维码已过期，请重新生成。',
      scaned_but_redirect: '已扫码，正在切换接入点，请继续在手机上确认。',
      binded_redirect: '这个微信号已经绑定过。',
    };

    function WechatBoxSettings() {
      // ONE state object for the whole panel: the account/switch view plus the
      // QR mini-flow. It is deliberately a single `useState` -- the two halves
      // are read together on every render, and two independent slots made
      // "which hook does this setter belong to" a question the component must
      // never have to answer (it was a real bug while this was being written).
      var pair = React.useState({
        view: {
          loaded: false, ready: false, enabled: false,
          account: null, transport: null, note: null, loginError: null,
        },
        // phase: idle -> beginning -> qr -> done | error. One object per phase
        // stops "done but the QR is still on screen" from being reachable.
        login: {
          phase: 'idle', qrcodeUrl: null, qrImage: null, status: null, text: null,
          verifyCode: '', account: null, error: null, verifyError: null,
        },
      });
      var state = pair[0];
      var setState = pair[1];
      var view = state.view;
      var login = state.login;

      // Functional updates only: a setter that closed over the render-time value
      // would drop a concurrent change to the other half.
      var setView = function (next) {
        setState(function (previous) { return Object.assign({}, previous, { view: next }); });
      };
      var setLogin = function (next) {
        setState(function (previous) { return Object.assign({}, previous, { login: next }); });
      };
      var patchView = function (patch) {
        setState(function (previous) {
          return Object.assign({}, previous, { view: Object.assign({}, previous.view, patch) });
        });
      };
      var patchLogin = function (patch) {
        setState(function (previous) {
          return Object.assign({}, previous, { login: Object.assign({}, previous.login, patch) });
        });
      };
      // A box that makes every async continuation check that it is still wanted,
      // so a poll or a fetch that lands after the panel is gone does not write
      // state into a dead component.
      //
      // NOTE: the mount/unmount effect that maintains it is registered LAST in
      // this component, on purpose. Effects run in registration order, and the
      // first one has to stay "load the state" -- the settings panel already had
      // exactly one effect, and a previous version inserted this one in front of
      // it, which silently made the panel never load anything.
      var aliveRef = useBox(true);
      // The pairing code the user typed, readable from inside the running poll
      // loop. It lives in a box rather than in the effect's dependency list so
      // that typing it does not tear the loop down and rebuild it.
      var verifyCodeRef = useBox('');
      // Bumped by the UI whenever something changed that the loop is waiting for.
      // Without it the loop can stall for good: the user types the pairing code,
      // the loop's next tick happens to have run a moment earlier, and nothing
      // schedules another one -- a QR that simply stops polling, with the panel
      // still saying "waiting for the code".
      var wakeRef = useBox(0);

      var load = function () {
        return readJson(fetch(STATE_URL, { headers: { accept: 'application/json' } }))
          .then(function (data) {
            if (!aliveRef.current) return;
            setView({
              loaded: true, ready: true,
              enabled: data.weixinEnabled === true,
              account: data.account || null,
              transport: data.transport || null,
              note: data.applyError || data.transportError || null,
              loginError: data.login ? data.login.error : null,
            });
            return data;
          })
          .catch(function () {
            if (!aliveRef.current) return;
            setView({
              loaded: true, ready: false, enabled: false,
              account: null, transport: null,
              note: '宿主半边未就绪', loginError: null,
            });
            return null;
          });
      };

      React.useEffect(function () {
        load();
        // Same reason as the header pill: the master switch can be flipped from
        // WeChat (`/session <id> close`) or by another page, so a panel that only
        // reads state on mount shows a stale answer.
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          load();
        }, 5000);
        // Node keeps the event loop alive for a pending timer; `unref` is a no-op
        // in the browser and keeps the test runner from hanging on this interval.
        if (timer && typeof timer.unref === 'function') timer.unref();
        var onFocus = function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          load();
        };
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('focus', onFocus);
          document.addEventListener('visibilitychange', onFocus);
        }
        return function () {
          clearInterval(timer);
          if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
          }
        };
      }, []);

      var flip = function () {
        if (!view.ready) return;
        var next = !view.enabled;
        patchView({ enabled: next });
        readJson(fetch(ENABLED_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })).then(function (data) {
          patchView({ enabled: data.weixinEnabled === true, note: null });
        }).catch(function () {
          load();                                  // resync instead of guessing
        });
      };

      // Ask the host for a fresh QR. Every failure -- including "the host half is
      // not there" -- has to come back as something the user can read, because
      // the one thing this flow must never do is show a blank panel.
      var beginLogin = function () {
        if (!aliveRef.current) return Promise.resolve();
        setLogin({
          phase: 'beginning', qrcodeUrl: null, qrImage: null, status: null, text: null,
          verifyCode: '', account: null, error: null, verifyError: null,
        });
        return readJson(fetch(LOGIN_BEGIN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })).then(function (data) {
          if (!aliveRef.current) return;
          if (!data || data.ok !== true || !data.qrcodeUrl) {
            setLogin({
              phase: 'error', qrcodeUrl: null, status: null, text: null,
              verifyCode: '', account: null,
              error: (data && data.error) || '宿主没有返回二维码', verifyError: null,
            });
            return;
          }
          setLogin({
            phase: 'qr', qrcodeUrl: data.qrcodeUrl, qrImage: data.qrImage || null, status: 'wait',
            text: LOGIN_STATUS_TEXT.wait, verifyCode: '', account: null, error: null, verifyError: null,
          });
        }).catch(function (error) {
          if (!aliveRef.current) return;
          setLogin({
            phase: 'error', qrcodeUrl: null, status: null, text: null,
            verifyCode: '', account: null,
            error: '宿主半边未就绪（' + ((error && error.message) || error) + '），无法开始扫码。',
            verifyError: null,
          });
        });
      };

      var submitVerifyCode = function () {
        var code = String(login.verifyCode || '').trim();
        if (!/^\d{4,8}$/.test(code)) {
          // The controller validates this exact shape (weixin-controller.mjs);
          // failing here is faster and clearer than a round trip that says no.
          patchLogin({ verifyError: '配对码是 4–8 位数字。' });
          return;
        }
        // Hand the code to the loop and poke it: the loop may already have taken
        // its last look and gone quiet while waiting for exactly this.
        verifyCodeRef.current = code;
        wakeRef.current += 1;
        patchLogin({ verifyError: null });
      };

      var pollLogin = function (verifyCode) {
        var body = verifyCode ? { verifyCode: verifyCode } : {};
        return readJson(fetch(LOGIN_POLL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));
      };

      // Poll while the QR is on screen. 1s is the platform's own cadence
      // (transport/login.mjs POLL_INTERVAL_MS).
      React.useEffect(function () {
        if (login.phase !== 'qr') return undefined;
        var cancelled = false;
        var status = login.status;
        var started = Date.now();
        var timer = null;
        var inFlight = false;
        var seenWake = wakeRef.current;
        // Attempt numbers that are due. The waiter asks for the lowest one nobody
        // has taken yet, so a wake-up is never lost and there is never more than
        // one timer.
        var attempts = [];
        // A step that decides when to look again, and never leaves the loop with
        // nothing scheduled while the QR is still on screen.
        var tick = function (attempt) {
          if (cancelled || !aliveRef.current) return;
          if (timer) { clearTimeout(timer); timer = null; }
          // The QR dies after 5 minutes; saying so locally beats polling a dead
          // token until the host finally reports `expired`.
          if (Date.now() - started > 5 * 60 * 1000) {
            patchLogin({ status: 'expired', text: LOGIN_STATUS_TEXT.expired });
            return;
          }
          if (status === 'expired' || status === 'verify_code_blocked') return;
          // `need_verifycode` is a question, not a state to retry blindly: with no
          // code in hand the loop simply stops asking (DESIGN.md 10.4). The UI
          // pokes it once the code is typed -- see the wake-up in the waiter.
          if (status === 'need_verifycode' && !verifyCodeRef.current) return;
          var code = status === 'need_verifycode' ? verifyCodeRef.current : null;
          inFlight = true;
          pollLogin(code)
            .then(function (data) {
              inFlight = false;
              if (cancelled || !aliveRef.current) return;
              if (!data) return;
              if (data.status === 'confirmed' || (data.status === 'binded_redirect' && data.ok === true)) {
                setLogin({
                  phase: 'done', status: data.status, verifyCode: '',
                  text: data.status === 'confirmed' ? '绑定成功。' : '这个微信号已绑定，已直接启用。',
                  account: data.account || null, qrcodeUrl: null, error: null, verifyError: null,
                });
                load();
                beacon('login-bound', data.status);
                return;
              }
              if (data.ok !== true && data.code) {
                // already-bound and activation failures are terminal: retrying the
                // same poll would ask the same question again.
                patchLogin({
                  phase: 'error', qrcodeUrl: null,
                  text: data.status ? LOGIN_STATUS_TEXT[data.status] : null,
                  error: data.error || data.code,
                });
                return;
              }
              status = data.status;
              patchLogin({
                status: data.status,
                text: LOGIN_STATUS_TEXT[data.status] || ('状态：' + data.status),
              });
              if (data.status === 'expired' || data.status === 'verify_code_blocked') return;
              attempts.push(attempt + 1);
            })
            .catch(function (error) {
              inFlight = false;
              if (cancelled || !aliveRef.current) return;
              // A single failed round trip is not a verdict on the scan: say so
              // and keep trying, or a dropped request looks like a dead flow.
              patchLogin({
                text: '轮询失败，正在重试…（' + ((error && error.message) || error) + '）',
              });
              attempts.push(attempt + 1);
            });
        };
        var waiter = setInterval(function () {
          if (cancelled || !aliveRef.current) return;
          if (timer || inFlight) return;
          if (wakeRef.current !== seenWake) {
            // The user did something the loop was waiting for (typed the pairing
            // code): poll again now, whatever the loop was holding on to.
            seenWake = wakeRef.current;
            attempts = [0];
          }
          if (attempts.length === 0) return;
          var attempt = attempts.shift();
          timer = setTimeout(function () { tick(attempt); }, 1000);
        }, 200);
        // The loop is not what keeps the host process alive; the page is.
        waiter.unref?.();
        // attempt 0 is the first poll, one second after the code appears.
        attempts.push(0);
        return function () {
          cancelled = true;
          clearInterval(waiter);
          if (timer) clearTimeout(timer);
        };
        // Depends on the PHASE only. The status lives in this loop's own variable
        // (it is the result of the loop's last request, so nothing else can
        // change it) and the pairing code lives in a box: re-registering on every
        // change would throw the loop away while a request was still in flight.
      }, [login.phase]);

      // Registered last so it can never displace the load effect (see the note
      // where `aliveRef` is created).
      React.useEffect(function () {
        aliveRef.current = true;
        return function () { aliveRef.current = false; };
      }, []);

      var ready = view.ready;
      var switchButton = React.createElement('button', {
        type: 'button',
        onClick: flip,
        disabled: !ready,
        style: !ready ? NOT_READY_STYLE : (view.enabled ? ON_STYLE : OFF_STYLE),
        'data-wechat-box-settings': !ready ? 'not-ready' : (view.enabled ? 'on' : 'off'),
      }, view.enabled ? '已启用' : '已停用');

      var account = view.account;

      var bindPanel = null;
      if (login.phase !== 'idle') {
        var children = [];
        if (login.phase === 'beginning') {
          children.push(React.createElement('div', { key: 'busy', style: MUTED }, '正在获取二维码…'));
        }
        if (login.qrImage || login.qrcodeUrl) {
          // `qrImage` is the QR the host rendered into an SVG data URL.
          // `qrcodeUrl` on its own is NOT displayable: it is the content the QR
          // encodes (an https landing page), so an <img> pointed at it returns
          // text/html and the user sees nothing. When rendering failed we hand
          // over the address instead of a broken image.
          children.push(login.qrImage
            ? React.createElement('img', {
              key: 'qr', src: login.qrImage, alt: '微信扫码绑定', style: QR_STYLE,
              'data-wechat-box-qr': '1',
            })
            : React.createElement('div', { key: 'qr-fallback', style: { fontSize: '12px', wordBreak: 'break-all' } },
              '二维码渲染失败。请在手机上把下面这个地址生成二维码后扫码：',
              React.createElement('br', null),
              React.createElement('a', { href: login.qrcodeUrl, target: '_blank', rel: 'noreferrer' }, login.qrcodeUrl)));
        }
        if (login.text) {
          children.push(React.createElement('div', { key: 'text', style: { fontSize: '13px' } }, login.text));
        }
        if (login.status === 'need_verifycode') {
          children.push(React.createElement('div', {
            key: 'verify', style: { display: 'flex', alignItems: 'center', gap: '8px' },
          },
            React.createElement('input', {
              type: 'text', inputMode: 'numeric', value: login.verifyCode,
              placeholder: '配对码', style: INPUT_STYLE, 'data-wechat-box-verify': '1',
              onChange: function (event) {
                patchLogin({ verifyCode: event.target.value, verifyError: null });
              },
            }),
            React.createElement('button', {
              type: 'button', onClick: submitVerifyCode, style: LINK_STYLE,
              'data-wechat-box-verify-submit': '1',
            }, '提交'),
          ));
        }
        if (login.verifyError) {
          children.push(React.createElement('div', {
            key: 'verify-error', style: { fontSize: '12px', color: '#d97706' },
          }, login.verifyError));
        }
        if (login.error) {
          children.push(React.createElement('div', {
            key: 'error', style: { fontSize: '12px', color: '#d97706', lineHeight: 1.6 },
            'data-wechat-box-login-error': '1',
          }, String(login.error)));
        }
        if (login.account) {
          children.push(React.createElement('div', { key: 'account', style: MUTED },
            '已绑定：' + login.account.botId
            + (login.account.baseUrlHost ? '（' + login.account.baseUrlHost + '）' : '')));
        }
        var terminal = login.phase === 'done' || login.phase === 'error'
          || login.status === 'expired' || login.status === 'verify_code_blocked';
        children.push(React.createElement('div', {
          key: 'actions', style: { display: 'flex', gap: '8px', alignItems: 'center' },
        },
          terminal
            ? React.createElement('button', {
              type: 'button', onClick: beginLogin, style: LINK_STYLE,
              'data-wechat-box-relogin': '1',
            }, '重新生成二维码')
            : null,
          React.createElement('button', {
            type: 'button', style: OFF_STYLE,
            onClick: function () {
              setLogin({
                phase: 'idle', qrcodeUrl: null, qrImage: null, status: null, text: null,
                verifyCode: '', account: null, error: null, verifyError: null,
              });
            },
          }, '关闭'),
        ));
        bindPanel = React.createElement('div', {
          style: PANEL_STYLE, 'data-wechat-box-login': login.phase,
        }, children);
      }

      var bindButton = React.createElement('button', {
        type: 'button',
        onClick: beginLogin,
        disabled: !ready,
        style: !ready ? NOT_READY_STYLE : LINK_STYLE,
        'data-wechat-box-bind': !ready ? 'not-ready' : (login.phase === 'idle' ? 'idle' : login.phase),
      }, '绑定新账号');

      var connected = !!(view.transport && view.transport.connected);
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '620px' } },
        React.createElement('h3', { style: { margin: '4px 0 8px', fontSize: '14px' } }, '微信桥接'),
        ready ? null : React.createElement('div', {
          style: { marginBottom: '8px', padding: '8px 10px', borderRadius: '6px', background: 'rgba(217,119,6,0.12)', fontSize: '12px' },
        }, '宿主半边未就绪：宿主进程还没注册这条路由（通常需要重启一次 DSH）。下面的开关暂不可用。'),
        Row('插件', switchButton, ready ? null : view.note),
        Row('已绑定账号', account ? account.botId : (ready ? '未绑定' : '—'), account ? account.baseUrlHost : null),
        Row('微信用户', account ? account.ownerUserId : '—'),
        Row('连接状态', connected ? '已连接' : '未连接',
          view.transport && view.transport.lastError ? String(view.transport.lastError) : null),
        Row('凭据引用', account ? account.tokenRef : '—'),
        React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0 2px' },
        },
          React.createElement('span', { style: { fontSize: '13px' } }, '扫码绑定'),
          bindButton,
        ),
        bindPanel,
        React.createElement('p', { style: { marginTop: '10px', fontSize: '12px', opacity: 0.65, lineHeight: 1.6 } },
          '关闭后：传输层断开，插件不再收发微信消息，也不接管提问与审批；已保存的对话开关保持不变。',
          React.createElement('br', null),
          '绑定新账号会替换当前账号：扫码确认后新的凭据写入账号文件，旧账号的传输层停止；'
          + '中途失败会自动回滚到原来的账号。重新绑定微信账号不需要重启 DSH。'),
      );
    }

    var inject = ['slots'];

    function apply(ctx) {
      if (!ctx || !ctx.slots) {
        beacon('error', 'no ctx.slots');
        return;
      }
      try {
        ctx.effect(function () {
          return ctx.slots.inject(SLOT, function () {
            // This callback runs INSIDE the declaring register() call when the
            // parent slot is declared lazily -- which is the normal case here,
            // because conversation.session.header only appears once the chat
            // view mounts. A throw in this position is SWALLOWED by the slot
            // renderer (it stops the entry and re-throws in a microtask): the
            // fiber stays ACTIVE, the page looks healthy, and nothing renders.
            // That is exactly the signature of the previous plugin's missing
            // button, so the failure is caught here and turned into a beacon
            // instead of a console line nobody reads.
            try {
              var unregister = ctx.slots.register({
                name: SLOT,
                id: 'wechat-box',
                order: 30,
              }, WechatBoxToggle);
              beacon('registered', SLOT);
              return unregister;
            } catch (error) {
              beacon('error', 'register: ' + ((error && error.message) || error));
              return function () {};
            }
          });
        }, 'dsh-wechat-box: conversation header switch');

        // Settings section: the on/off switch and the bound account.
        ctx.effect(function () {
          return ctx.slots.inject(SETTINGS_SLOT, function () {
            try {
              var unregister = ctx.slots.register({
                name: SETTINGS_SLOT,
                id: 'wechat-box',
                order: 40,
                label: function () { return '微信桥接'; },
              }, WechatBoxSettings);
              beacon('registered', SETTINGS_SLOT);
              return unregister;
            } catch (error) {
              beacon('error', 'settings register: ' + ((error && error.message) || error));
              return function () {};
            }
          });
        }, 'dsh-wechat-box: settings section');
      } catch (error) {
        beacon('error', 'inject: ' + ((error && error.message) || error));
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.WechatBoxToggle = WechatBoxToggle;
    exports.WechatBoxSettings = WechatBoxSettings;
    exports.__beacon = beacon;
    return module.exports;
  },
});
