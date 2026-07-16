// Source for the JS injected into every app WebView. Defines the native
// half of `window.centraid` (notify/haptic/timer/transfer) and routes calls through
// `window.ReactNativeWebView.postMessage`.
//
// The body is wrapped in an IIFE to avoid leaking helpers onto the page.
// The gateway-injected SDK augments `window.centraid` (never overwrites),
// so the page ends up with both the data surface (read/write/describe from
// the gateway) and the device surface (notify/haptic/timer from here).
//
// The WebView loads apps through the tunnel's localhost proxy (or a
// token-less dev gateway), so no fetch shim / header tricks are needed —
// the page's own fetch()/EventSource just work.

import { CENTRAID_HANDSHAKE } from './protocol';

export const INJECTED_JS = `(function () {
  if (window.centraid) return;
  var handshake = ${JSON.stringify(CENTRAID_HANDSHAKE)};
  var pending = new Map();
  var nextId = 1;

  function send(method, args) {
    var id = 'c' + (nextId++);
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          __centraid: handshake,
          id: id,
          method: method,
          args: args,
        }));
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  // The RN side calls this with the response envelope.
  window.__centraidResolve = function (response) {
    var entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.value);
    } else {
      var err = new Error(response.error && response.error.message ? response.error.message : 'bridge error');
      err.code = response.error && response.error.code ? response.error.code : 'unknown';
      entry.reject(err);
    }
  };

  function fireAndForget(method, args) {
    // Haptics are best-effort; we don't surface failures to callers.
    send(method, args).catch(function () {});
  }

  window.centraid = {
    notify: {
      schedule: function (opts) { return send('notify.schedule', opts); },
      cancel: function (id) { return send('notify.cancel', { id: id }); },
    },
    haptic: {
      impact: function (style) { fireAndForget('haptic.impact', { style: style }); },
      selection: function () { fireAndForget('haptic.selection'); },
      success: function () { fireAndForget('haptic.success'); },
    },
    timer: {
      startBackground: function (opts) { return send('timer.startBackground', opts); },
      cancel: function (id) { return send('timer.cancel', { id: id }); },
    },
    transfer: {
      putBackground: function (opts) { return send('transfer.putBackground', opts); },
    },
  };
})(); true;`;
