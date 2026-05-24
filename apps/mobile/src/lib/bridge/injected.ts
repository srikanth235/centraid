// Source for the JS injected into every app WebView. Defines
// `window.centraid` and routes calls through `window.ReactNativeWebView.postMessage`.
//
// The body is wrapped in an IIFE to avoid leaking helpers onto the page. We
// also patch `window.fetch` so that any in-page request to the configured
// gateway origin (or relative `/centraid/...` path) is proxied through the
// bridge — that's where native attaches the bearer token. WKWebView's
// `source.headers` only covers the initial document GET, not sub-resource
// fetches the page itself makes.

import { CENTRAID_HANDSHAKE } from './protocol';

/**
 * Build the JS to inject into a WebView pointed at `gatewayOrigin`. The
 * origin is baked in at injection time so the fetch shim can recognize
 * which requests to proxy without re-asking native.
 */
export function buildInjectedJs(gatewayOrigin: string): string {
  const origin = JSON.stringify(gatewayOrigin);
  return `(function () {
  if (window.centraid) return;
  var handshake = ${JSON.stringify(CENTRAID_HANDSHAKE)};
  var gatewayOrigin = ${origin};
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
  };

  // --- fetch shim ---
  // Resolve a request URL against the page origin so we can compare against
  // the configured gateway. Relative URLs (in-app _changes SSE, plus
  // /centraid/_tool/* POSTs that the injected
  // window.centraid.read/write/describe helpers issue) resolve against
  // the WebView's location, which is the gateway origin itself.
  function resolveUrl(input) {
    if (typeof input === 'string') {
      try { return new URL(input, window.location.href).toString(); } catch (e) { return input; }
    }
    if (input && typeof input.url === 'string') return input.url;
    return String(input);
  }

  function isGatewayUrl(u) {
    if (!gatewayOrigin) return false;
    try { return new URL(u).origin === gatewayOrigin; } catch (e) { return false; }
  }

  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach(function (v, k) { out[k] = v; });
      return out;
    }
    if (Array.isArray(h)) {
      for (var i = 0; i < h.length; i++) { out[h[i][0]] = h[i][1]; }
      return out;
    }
    if (typeof h === 'object') {
      for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) out[k] = h[k]; }
    }
    return out;
  }

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = resolveUrl(input);
    if (!isGatewayUrl(url)) {
      return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
    }
    var method = (init && init.method) || (input && input.method) || 'GET';
    var headers = headersToObject(init && init.headers);
    var bodyText;
    if (init && init.body != null) {
      bodyText = typeof init.body === 'string' ? init.body : String(init.body);
    }
    return send('gateway.fetch', {
      url: url,
      method: method,
      headers: headers,
      body: bodyText,
    }).then(function (r) {
      // The bridge returns body as text; reconstruct a Response so callers
      // can use .json()/.text() as if it had come from the network.
      return new Response(r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    });
  };
})(); true;`;
}

/**
 * @deprecated Use `buildInjectedJs(gatewayOrigin)` so the fetch shim can
 * recognize gateway-origin requests. Kept for callers that don't have an
 * origin handy; the fetch shim becomes a no-op.
 */
export const INJECTED_JS = buildInjectedJs('');
