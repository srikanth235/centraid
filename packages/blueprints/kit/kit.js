// governance: allow-repo-hygiene file-size-limit the kit is the single canonical bundle every app loads verbatim (UX primitives + charts + the folded Ask-your-vault controller); it is served as one file, so splitting it would fracture that one-request contract without reducing surface
// Centraid blueprint kit — the shared UX substrate for template apps.
//
// Canonical (and ONLY) copy: packages/blueprints/kit/kit.js. Apps don't
// carry their own copies — the app-engine runtime serves `kit.js` /
// `kit.css` from this dir (`sharedAssetsDir`, wired to `KIT_DIR`) whenever
// an app folder has no override of its own. Edit here, and every app —
// bundled template or deployed clone — picks it up on next load.
//
// Everything here is presentation plumbing the 14 apps used to hand-roll
// with drift: outcome toasts, loading/error states, confirm-to-act, money
// and local-date formatting, letter avatars, and small SVG charts. App
// logic stays in each app.js.
//
// The presentation PRIMITIVES (avatar, meter, charts, skeleton, toast, mention
// chip, reference strip) are now native Web Components defined in `elements.js`
// (issue #327). Importing it here runs the `customElements.define()` calls; the
// factory functions below (`letterAvatar`, `lineChart`, `toast`, …) construct +
// configure those elements, so app code that calls them is unchanged. The
// live-network controllers (Ask driver, @-mention popover/field) stay as the
// imperative controllers they always were — see the excluded set in issue #327.
import { entityKindLabel } from './elements.js';

// Re-export the shared kind-label helper (its definition moved to elements.js,
// where the mention-chip and reference-strip components also need it).
export { entityKindLabel };

// ---------- Native haptics (feature-detected, best-effort) ----------

// The mobile shell exposes `window.centraid.haptic.*` on its native bridge;
// the desktop iframe has no such surface. Feature-detect and swallow every
// failure so the kit behaves identically wherever the app renders.
function haptic(kind) {
  try {
    window.centraid?.haptic?.[kind]?.();
  } catch {
    /* bridge absent or refused — visual feedback already covers it */
  }
}

// ---------- Toasts (the one feedback channel that follows the user) ----------

let toastHost = null;

function ensureToastHost() {
  if (toastHost) return toastHost;
  toastHost = document.createElement('div');
  toastHost.className = 'kit-toasts';
  toastHost.setAttribute('role', 'status');
  toastHost.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastHost);
  return toastHost;
}

/**
 * Show a transient toast. Options:
 *  - undoLabel/onUndo: renders an action button (e.g. Undo) that runs once.
 *  - duration: ms before auto-dismiss (default 5000; sticky if 0).
 */
export function toast(text, { undoLabel, onUndo, duration = 5000 } = {}) {
  haptic('success');
  const host = ensureToastHost();
  const el = document.createElement('kit-toast');
  el.text = text;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (undoLabel && onUndo) {
    el.undoLabel = undoLabel;
    el.addEventListener('kit-undo', () => {
      dismiss();
      onUndo();
    });
  }
  el.addEventListener('kit-dismiss', dismiss);
  host.appendChild(el);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

/** The shared translation of a typed-command outcome into a human sentence. */
export function outcomeMessage(outcome) {
  if (outcome?.status === 'parked') {
    return 'Waiting for your approval — it lands once you confirm it in vault settings.';
  }
  if (outcome?.status === 'failed') {
    return `The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`;
  }
  if (outcome?.status === 'denied') {
    return `Denied by consent${outcome.reason ? `: ${outcome.reason}` : '.'}`;
  }
  return null;
}

// ---------- Loading and read-error states ----------

/** Fill a container with shimmer rows while the first read is in flight. */
export function showSkeleton(container, rows = 3) {
  container.innerHTML = '';
  const el = document.createElement('kit-skeleton');
  el.rows = rows;
  container.appendChild(el);
}

/**
 * Surface a failed read in the app's notice banner instead of silence —
 * a broken vault must not look like an empty one.
 */
export function readFailed(bannerEl) {
  if (!bannerEl) return;
  bannerEl.textContent = 'Couldn’t reach the vault — retrying when you come back.';
  bannerEl.hidden = false;
}

// ---------- Confirm-to-act (arm on first click, run on second) ----------

/**
 * Returns true when the click should proceed. First click arms the button
 * (label swap + auto-disarm after `timeout` ms); second click confirms.
 */
export function armConfirm(btn, { armedLabel = 'Sure?', timeout = 3000 } = {}) {
  if (btn.dataset.kitArmed === 'true') {
    clearTimeout(Number(btn.dataset.kitArmTimer));
    delete btn.dataset.kitArmed;
    btn.textContent = btn.dataset.kitLabel ?? btn.textContent;
    return true;
  }
  haptic('selection');
  btn.dataset.kitArmed = 'true';
  btn.dataset.kitLabel = btn.textContent;
  btn.textContent = armedLabel;
  btn.dataset.kitArmTimer = String(
    setTimeout(() => {
      delete btn.dataset.kitArmed;
      btn.textContent = btn.dataset.kitLabel ?? btn.textContent;
    }, timeout),
  );
  return false;
}

// ---------- Formatting ----------

/** Minor units → localized currency string ("€12.34"), tolerant of gaps. */
export function fmtMoney(minor, currency) {
  const value = Number(minor ?? 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

/** The viewer's local YYYY-MM-DD for an instant — never the UTC slice. */
export function localDayKey(dateish) {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return String(dateish).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The viewer's local YYYY-MM for an instant. */
export function localMonthKey(dateish) {
  return localDayKey(dateish).slice(0, 7);
}

/** "5m" / "3h" / "2d" / "Mar 4" — the inbox-style relative timestamp. */
export function relTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / (60 * 24))}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function debounce(fn, ms = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Letter avatars ----------

/** A letter avatar element with a deterministic hashed hue (see `<kit-avatar>`). */
export function letterAvatar(name, { size = '2.25rem' } = {}) {
  const el = document.createElement('kit-avatar');
  el.name = String(name ?? '?');
  el.size = size;
  return el;
}

// ---------- SVG chart primitives (native elements — see elements.js) ----------
// The chart geometry now lives in the `<kit-line-chart>` / `<kit-bar-chart>`
// custom elements; these factories build + configure them so callers that
// append the returned element keep working.

/**
 * A time-aware line chart element: points are {x: epochMs, y: number}. Renders a
 * line, soft area fill, and an emphasized last point (see `<kit-line-chart>`).
 */
export function lineChart(points, { width = 640, height = 160, label = 'Trend' } = {}) {
  const el = document.createElement('kit-line-chart');
  el.points = points ?? [];
  el.width = width;
  el.height = height;
  el.label = label;
  return el;
}

/** Horizontal proportion bar element (e.g. cost share behind a row's amount). */
export function barSpan(ratio) {
  const el = document.createElement('kit-meter');
  el.ratio = ratio;
  return el;
}

/** Vertical bar chart element for period totals: items are {label, value} (see `<kit-bar-chart>`). */
export function barChart(items, { width = 640, height = 160, label = 'Totals' } = {}) {
  const el = document.createElement('kit-bar-chart');
  el.items = items ?? [];
  el.width = width;
  el.height = height;
  el.label = label;
  return el;
}

// ============================================================================
//  "Ask your vault" controller — folded in from the former standalone kit-ask.js
//  so every app ships a single synced kit.js (evaluated via app.js's
//  `import './kit.js'`) instead of a second <script>. The IIFE below runs at
//  module-eval time — before app.js's body — so `window.kitAsk` is ready to wire.
//  Reads window.KIT_ASK (set inline in index.html before app.js) and mounts the
//  Ask button + panel onto [data-ask-mount].
//
//  By default the panel drives itself against the real vault surfaces:
//    - POST  <app>/_turn                        — the app's declared-handler
//      agent (SSE stream). Writes the agent makes flow through the same
//      dispatcher + vault consent gates as every other caller.
//    - GET   /centraid/_vault/parked            — when a turn's write parks,
//      the matching invocation is looked up and rendered as a proposed-write
//      card. Nothing is written without the owner's say-so.
//    - POST  /centraid/_vault/parked/<id>       — Approve/Discard post the
//      real {approve} decision and render the actual InvokeOutcome.
//    - GET   /centraid/_vault/status + /apps    — the context chip reflects
//      the app's true grant state instead of a hardcoded label.
//  An app can take over the conversation with:
//    kitAsk.onAsk(async (text) => { ...custom driver... })
// ============================================================================

(function () {
  var cfg = window.KIT_ASK || {};

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  var MIC =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

  function panelHTML() {
    var scope = esc(cfg.scope || 'this app');
    var sugg = (cfg.suggest || [])
      .map(function (s) {
        return '<button type="button" class="kit-ask-chip">' + esc(s) + '</button>';
      })
      .join('');
    var intro =
      cfg.intro ||
      'Ask me to add, change, find or remove anything here. I’ll show the change for your approval before it touches the vault.';
    return (
      '<div class="kit-ask-ov" id="kitAskOverlay" hidden><div class="kit-ask-panel" role="dialog" aria-modal="true" aria-label="Ask your vault">' +
      '<div class="kit-ask-head"><h2>Ask</h2><span class="kit-ask-note">a projection of your vault</span><button type="button" class="kit-ask-x" aria-label="Close">✕</button></div>' +
      '<div class="kit-ask-context"><span class="kit-ask-scope">Scope · ' +
      scope +
      '</span><span class="kit-ask-scope" data-kit-grant>read + write · consent-gated</span></div>' +
      '<div class="kit-ask-log" role="log" aria-live="polite"><div class="kit-msg ai">' +
      esc(intro) +
      '</div></div>' +
      '<div class="kit-ask-suggest">' +
      sugg +
      '</div>' +
      '<form class="kit-ask-compose"><button type="button" class="kit-ask-mic" aria-label="Voice">' +
      MIC +
      '</button><input placeholder="' +
      esc(cfg.placeholder || 'Ask…') +
      '" aria-label="Ask"><button class="kit-ask-send" type="submit" aria-label="Send">→</button></form>' +
      '</div></div>'
    );
  }

  function init() {
    if (window.kitAsk) return; // once
    var mount =
      document.querySelector('[data-ask-mount]') ||
      document.querySelector('.head-tools') ||
      document.querySelector('.head') ||
      document.body;
    if (
      mount.classList &&
      (mount.classList.contains('head') || mount.classList.contains('head-tools'))
    ) {
      mount.style.flexWrap = 'wrap';
    }
    var btn = el(
      '<button type="button" class="kit-ask-btn" id="kitAskBtn"><span class="kit-spark">✦</span> Ask</button>',
    );
    mount.appendChild(btn);

    var ov = el(panelHTML());
    document.body.appendChild(ov);
    var panel = ov.querySelector('.kit-ask-panel');
    var log = ov.querySelector('.kit-ask-log');
    var form = ov.querySelector('.kit-ask-compose');
    var input = form.querySelector('input');
    var lastFocus = null;

    var grantChecked = false;
    function open() {
      lastFocus = document.activeElement;
      ov.hidden = false;
      if (!grantChecked) {
        grantChecked = true;
        refreshGrantChip(ov.querySelector('[data-kit-grant]'));
      }
      setTimeout(function () {
        input && input.focus();
      }, 60);
    }
    function close() {
      ov.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    btn.addEventListener('click', open);
    ov.querySelector('.kit-ask-x').addEventListener('click', close);
    ov.addEventListener('click', function (e) {
      if (e.target === ov) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !ov.hidden) close();
    });
    ov.querySelectorAll('.kit-ask-chip').forEach(function (c) {
      c.addEventListener('click', function () {
        input.value = c.textContent;
        input.focus();
      });
    });

    var handler = null;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      api.user(v);
      input.value = '';
      if (handler) handler(v);
    });

    function bubble(cls, html) {
      var m = el('<div class="kit-msg ' + cls + '"></div>');
      m.innerHTML = html;
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    }

    var api = {
      open: open,
      close: close,
      /** append a user bubble (escaped) */
      user: function (t) {
        return bubble('user', esc(t));
      },
      /** append an assistant bubble (HTML allowed — caller sanitises) */
      ai: function (html) {
        return bubble('ai', html);
      },
      /** show a typing indicator; returns { done() } */
      typing: function () {
        var t = el('<div class="kit-ask-typing"><i></i><i></i><i></i></div>');
        log.appendChild(t);
        log.scrollTop = log.scrollHeight;
        return {
          done: function () {
            if (t.parentNode) t.remove();
          },
        };
      },
      /** a completed, receipted action (with optional Undo) */
      applied: function (o) {
        o = o || {};
        var a = el(
          '<div class="kit-ask-applied"><span class="ck">✓</span><span class="ac-t">' +
            esc(o.title) +
            '<span class="ac-s">' +
            esc(o.receipt || 'saved as a receipt') +
            '</span></span>' +
            (o.onUndo ? '<button class="ac-undo">Undo</button>' : '') +
            '</div>',
        );
        log.appendChild(a);
        var u = a.querySelector('.ac-undo');
        if (u)
          u.addEventListener('click', function () {
            o.onUndo();
            a.remove();
          });
        log.scrollTop = log.scrollHeight;
        return a;
      },
      /**
       * A consent-gated proposed write.
       *
       * `onApprove` / `onDiscard` may return a promise — the card shows a
       * busy state until it settles and renders the REAL outcome: resolve
       * with `{ok: true, receipt?}` to swap to an applied receipt, or
       * `{ok: false, note}` (or reject) to keep the card and surface the
       * refusal honestly. A sync/void `onApprove` keeps the legacy
       * immediate-swap behavior.
       */
      propose: function (o) {
        o = o || {};
        var diff = o.diff
          ? '<div class="kit-aa-diff"><span class="d1">' +
            esc(o.diff[0]) +
            '</span> → <span class="d2">' +
            esc(o.diff[1]) +
            '</span></div>'
          : '';
        var card = el(
          '<div class="kit-ask-action"><span class="aa-label">Proposed write · needs your ok</span>' +
            '<div class="aa-title">' +
            esc(o.title) +
            '</div><div class="aa-detail">' +
            esc(o.detail || '') +
            '</div>' +
            diff +
            '<div class="aa-btns"><button class="kit-aa-approve">Approve</button>' +
            (o.onEdit ? '<button class="kit-aa-ghost aa-edit">Edit</button>' : '') +
            '<button class="kit-aa-ghost aa-discard">Discard</button></div></div>',
        );
        log.appendChild(card);
        function setBusy(busy) {
          card.querySelectorAll('button').forEach(function (b) {
            b.disabled = busy;
          });
          card.classList.toggle('aa-busy', busy);
        }
        function note(text) {
          var n =
            card.querySelector('.aa-note') || card.appendChild(el('<div class="aa-note"></div>'));
          n.textContent = text;
          log.scrollTop = log.scrollHeight;
        }
        function swapApplied(receipt) {
          card.replaceWith(
            el(
              '<div class="kit-ask-applied"><span class="ck">✓</span><span class="ac-t">' +
                esc(o.title) +
                '<span class="ac-s">' +
                esc(receipt || 'approved · saved as a receipt') +
                '</span></span></div>',
            ),
          );
          log.scrollTop = log.scrollHeight;
        }
        card.querySelector('.kit-aa-approve').addEventListener('click', function () {
          var settled = o.onApprove ? o.onApprove() : undefined;
          if (!settled || typeof settled.then !== 'function') return swapApplied();
          setBusy(true);
          settled.then(
            function (r) {
              if (r && r.ok === false) {
                setBusy(false);
                note(r.note || 'The vault refused this write.');
                return;
              }
              swapApplied(r && r.receipt);
            },
            function (err) {
              setBusy(false);
              note(String((err && err.message) || err || 'Approval failed.'));
            },
          );
        });
        var edit = card.querySelector('.aa-edit');
        if (edit)
          edit.addEventListener('click', function () {
            o.onEdit();
          });
        card.querySelector('.aa-discard').addEventListener('click', function () {
          var settled = o.onDiscard ? o.onDiscard() : undefined;
          if (!settled || typeof settled.then !== 'function') return card.remove();
          setBusy(true);
          settled.then(
            function () {
              card.remove();
            },
            function (err) {
              setBusy(false);
              note(String((err && err.message) || err || 'Discard failed.'));
            },
          );
        });
        log.scrollTop = log.scrollHeight;
        return card;
      },
      /**
       * Override the natural-language handler. Without an override the
       * panel drives the app's own `_turn` agent (declared handlers +
       * vault consent gates) — see `makeVaultDriver`.
       */
      onAsk: function (fn) {
        handler = fn;
      },
    };
    window.kitAsk = api;

    // Default brain: the app's _turn conversation agent. Registered after
    // `window.kitAsk` exists so an app.js `onAsk` call simply replaces it.
    if (!cfg.demo) handler = makeVaultDriver(api);

    if (cfg.demo) playDemo(api, cfg.demo);
    document.dispatchEvent(new CustomEvent('kitask:ready'));
  }

  // ---------- Default vault driver (real surfaces only, no stubs) ----------

  /** App id as pinned by the runtime's injected change bridge; null in bare previews. */
  function appId() {
    return (window.centraid && window.centraid.appId) || null;
  }

  /** Base for app-scoped routes. Absolute when the bridge pinned an app id. */
  function appBase() {
    var id = appId();
    return id ? '/centraid/' + encodeURIComponent(id) + '/' : '';
  }

  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try {
          j = t ? JSON.parse(t) : null;
        } catch (_) {}
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }

  /**
   * Reflect the app's REAL grant state in the context chip, read from the
   * vault plane's owner surface. On any failure the default design-contract
   * label stays — we never claim a state we couldn't verify.
   */
  function refreshGrantChip(chip) {
    if (!chip || !appId()) return;
    fetchJson('/centraid/_vault/status')
      .then(function (s) {
        if (!s.ok || !s.body || s.body.active !== true) {
          chip.textContent = 'no vault connected';
          return;
        }
        return fetchJson('/centraid/_vault/apps').then(function (a) {
          var apps = (a.ok && a.body && a.body.apps) || [];
          var mine = apps.filter(function (x) {
            return x.appId === appId();
          })[0];
          if (!mine) {
            chip.textContent = 'not enrolled — vault calls deny';
            return;
          }
          var grants = mine.grants || [];
          if (!grants.length) {
            chip.textContent = 'no grant yet — writes deny or park';
            return;
          }
          var verbs = {};
          grants.forEach(function (g) {
            (g.scopes || []).forEach(function (sc) {
              String(sc.verbs || '')
                .split(',')
                .forEach(function (v) {
                  if (v.trim()) verbs[v.trim()] = 1;
                });
            });
          });
          var list = Object.keys(verbs);
          chip.textContent = (list.length ? list.join(' + ') : 'granted') + ' · consent-gated';
        });
      })
      .catch(function () {
        /* unreachable plane — leave the default label */
      });
  }

  /**
   * Default conversation driver: POST the question to the app's `_turn`
   * agent and translate its SSE stream into panel bubbles. Writes the agent
   * makes flow through the dispatcher + vault consent gates like any other
   * caller; one that PARKS surfaces here as a proposed-write card whose
   * Approve/Discard post the owner's real decision to
   * `/centraid/_vault/parked/<invocationId>`. Nothing is fabricated: every
   * bubble is agent text, every card a real parked invocation, and every
   * failure is surfaced as the error it was.
   */
  function makeVaultDriver(api) {
    var convKey = 'kitask:conversation:' + (appId() || location.pathname);
    var convId = null;
    function conversationId() {
      if (convId) return convId;
      try {
        convId = sessionStorage.getItem(convKey);
      } catch (_) {}
      if (!convId) {
        convId =
          window.crypto && crypto.randomUUID
            ? crypto.randomUUID()
            : 'kitask-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        try {
          sessionStorage.setItem(convKey, convId);
        } catch (_) {}
      }
      return convId;
    }

    /** Post the owner's decision on one parked invocation; returns the InvokeOutcome. */
    function confirmParked(invocationId, approve) {
      return fetchJson('/centraid/_vault/parked/' + encodeURIComponent(invocationId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approve: approve }),
      }).then(function (r) {
        if (!r.ok) {
          throw new Error(
            (r.body && (r.body.message || r.body.error)) ||
              'confirmation failed (' + r.status + ')',
          );
        }
        return r.body;
      });
    }

    function shortVal(v) {
      var s = typeof v === 'string' ? v : JSON.stringify(v);
      s = String(s == null ? '' : s);
      return s.length > 60 ? s.slice(0, 57) + '…' : s;
    }

    /** Look up a freshly-parked invocation on the consent surface and render its card. */
    function renderParked(invocationId) {
      return fetchJson('/centraid/_vault/parked').then(function (r) {
        var list = (r.ok && r.body && r.body.parked) || [];
        var entry = list.filter(function (p) {
          return p.invocationId === invocationId;
        })[0];
        if (!entry) {
          api.ai(
            esc(
              'A write parked for your approval but is no longer pending — it may have been handled from another surface.',
            ),
          );
          return;
        }
        var input = entry.input || {};
        var detail = Object.keys(input)
          .map(function (k) {
            return k + ': ' + shortVal(input[k]);
          })
          .join(' · ');
        api.propose({
          title: entry.command,
          detail: (entry.caller ? entry.caller + ' · ' : '') + (detail || 'no input'),
          onApprove: function () {
            return confirmParked(invocationId, true).then(function (outcome) {
              if (outcome && outcome.status === 'executed') {
                return { ok: true, receipt: 'approved · receipt ' + outcome.receiptId };
              }
              if (outcome && outcome.status === 'replayed')
                return { ok: true, receipt: 'already applied' };
              return {
                ok: false,
                note: (outcome && outcome.reason) || 'The vault refused this write.',
              };
            });
          },
          onDiscard: function () {
            return confirmParked(invocationId, false);
          },
        });
      });
    }

    /** Probe a tool result for a vault InvokeOutcome (bare or nested under `output`). */
    function outcomeOf(x) {
      if (!x || typeof x !== 'object') return null;
      if (typeof x.status === 'string') return x;
      if (x.output && typeof x.output === 'object' && typeof x.output.status === 'string') {
        return x.output;
      }
      return null;
    }

    return function ask(text) {
      var typing = api.typing();
      var stream = null; // the streaming assistant bubble
      function say(t) {
        typing.done();
        return api.ai(esc(t));
      }
      function append(delta) {
        typing.done();
        if (!stream) stream = api.ai('');
        stream.textContent += delta;
      }
      function handleEvent(type, ev) {
        if (type === 'assistant.delta' && ev && typeof ev.delta === 'string') {
          append(ev.delta);
        } else if (type === 'tool.result') {
          var o = outcomeOf(ev && ev.result);
          if (o && o.status === 'parked' && o.invocationId) renderParked(o.invocationId);
          else if (o && o.status === 'denied') {
            say(
              'The vault denied that write' +
                (o.reason ? ': ' + o.reason : '.') +
                ' Grant this app access from Settings → Vault to allow it.',
            );
          }
        } else if (type === 'final') {
          if (ev && ev.text && (!stream || !stream.textContent)) say(ev.text);
        } else if (type === 'error') {
          say('The agent hit an error: ' + ((ev && ev.message) || 'unknown'));
        } else if (type === 'aborted') {
          say('The turn was aborted before it finished.');
        }
      }
      function frame(raw) {
        var type = null;
        var data = '';
        raw.split('\n').forEach(function (line) {
          if (line.indexOf('event:') === 0) type = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
        });
        if (!type || type === 'end') return;
        var ev = null;
        try {
          ev = data ? JSON.parse(data) : null;
        } catch (_) {}
        handleEvent(type, ev);
      }
      fetch(appBase() + '_turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversationId(), message: text }),
      })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (t) {
              var j = null;
              try {
                j = t ? JSON.parse(t) : null;
              } catch (_) {}
              if (res.status === 503 && j && j.error === 'no_conversation_runner') {
                say(
                  'No coding agent is configured to answer yet — open Settings → Agents, pick one, and ask again.',
                );
              } else {
                say(
                  'The gateway refused the turn (' +
                    res.status +
                    (j && j.message ? ' · ' + j.message : '') +
                    ').',
                );
              }
            });
          }
          var reader = res.body.getReader();
          var dec = new TextDecoder();
          var buf = '';
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return;
              buf += dec.decode(r.value, { stream: true });
              var i;
              while ((i = buf.indexOf('\n\n')) !== -1) {
                var raw = buf.slice(0, i);
                buf = buf.slice(i + 2);
                if (raw && raw.charAt(0) !== ':') frame(raw);
              }
              return pump();
            });
          }
          return pump();
        })
        .catch(function (err) {
          say("Couldn't reach the vault gateway — " + String((err && err.message) || err));
        })
        .then(function () {
          typing.done();
        });
    };
  }

  // Preview-only sample turn so the flow is visible without a live vault.
  function playDemo(api, d) {
    api.open();
    if (d.applied) api.applied(d.applied);
    if (d.q) {
      api.user(d.q);
      var t = api.typing();
      setTimeout(function () {
        t.done();
        if (d.a) api.ai(d.a);
        if (d.propose) api.propose(d.propose);
        if (d.q2) {
          api.user(d.q2);
          api.typing();
        }
      }, 750);
    }
  }

  // Kick off once everything above is defined (var MIC included).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// ============================================================================
// Cross-referencing (issues #272 + #282) — owner link writes + the reference
// strip. Referencing is a SHELL capability, not an app capability: the sole
// creation gesture is the inline `@`-mention (attachMentionPopover, below),
// which browses/searches the vault at owner trust (via the gateway's
// /_vault/picker surface, every read receipted); the user picks ONE row and
// the app receives only that row's card. The link is asserted with the
// owner-device credential (POST /_vault/links → core.link_entities,
// asserted_by='owner') — the pick is the consent, scoped to one row, so the
// app never needs read scopes on the foreign domain. Rendering the linked
// entity later rides ctx.vault.resolve's resolvable-if-linked rule.
// ============================================================================

// `entityKindLabel` (and its `PICK_KIND_LABELS` table) moved to elements.js,
// where the mention-chip and reference-strip components need it; it is imported
// and re-exported at the top of this file.

/**
 * Assert a link as the owner (the pick already carried the intent):
 * `from`/`to` are `{type, id}`; relation defaults to `references`. An
 * optional `selector` ({exact, prefix, suffix, start}, issue #282) writes an
 * inline standoff anchor atomically with the link.
 * Returns the vault's InvokeOutcome — `{status: 'executed', …}` on success.
 */
export async function createReference(from, to, relation, selector) {
  const r = await fetch('/centraid/_vault/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from_type: from.type,
      from_id: from.id,
      to_type: to.type,
      to_id: to.id,
      relation: relation || 'references',
      ...(selector ? { selector } : {}),
    }),
  });
  return r.json();
}

/** End a link (temporal — the row survives with valid_to set). */
export async function removeReference(linkId) {
  const r = await fetch('/centraid/_vault/links/' + encodeURIComponent(linkId), {
    method: 'DELETE',
  });
  return r.json();
}

/**
 * Render the reference strip — the durable home of a note/doc's cross-refs
 * and the landing zone an inline anchor degrades to (issues #272 + #282).
 * This is the ONE canonical strip renderer: every consumer of references
 * (Notes now, Docs when it adopts) calls it so the strip, its card states,
 * and the anchored/orphaned distinction render identically everywhere.
 *
 * Presentation-only — it never writes. The app owns persistence: pass
 * `onRemove(ref)` to show a remove control (the app runs removeReference +
 * whatever refresh it needs); omit it for a read-only strip.
 *
 * Each `ref` is `{link_id, card, selector?}` where `card` is a resolver card
 * ({type, title, subtitle, status: live|trashed|missing|denied}). `selector`
 * present ⇒ the reference is anchored; pass `inlineIds` (a Set of link_ids
 * currently resolved inline in the body) and the tile flags itself "in text"
 * vs "in strip". Plain picker links (no selector) wear no flag.
 *
 * Options: {inlineIds?: Set<string>, onRemove?: (ref) => void, emptyText?: string}.
 *
 * The tile rendering lives in the `<kit-reference-strip>` custom element
 * (elements.js); this adapter mounts a single instance inside `stripEl` and
 * feeds it the props, so existing callers that pass their own container keep
 * working while the DOM/behaviour is owned by one component.
 */
export function renderReferenceStrip(stripEl, refs, options = {}) {
  const { inlineIds, onRemove, emptyText } = options;
  let strip = stripEl.firstElementChild;
  if (!strip || strip.tagName !== 'KIT-REFERENCE-STRIP') {
    stripEl.innerHTML = '';
    strip = document.createElement('kit-reference-strip');
    stripEl.appendChild(strip);
  }
  strip.refs = refs ?? [];
  strip.inlineIds = inlineIds ?? null;
  strip.onRemove = onRemove ?? null;
  strip.emptyText = emptyText ?? '';
}

/**
 * Move (selector object) or clear (selector null) the standoff anchor of a
 * live link — the re-anchor / re-baseline half of inline references (issue
 * #282). A locator write: the link judgment itself is untouched, so clearing
 * demotes the reference to strip-only.
 */
export async function reanchorReference(linkId, selector) {
  const r = await fetch('/centraid/_vault/links/' + encodeURIComponent(linkId), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selector: selector ?? null }),
  });
  return r.json();
}

// ============================================================================
// Inline anchored references (issue #282) — the standoff-anchor half of
// cross-referencing. A reference stays a core.link edge; these helpers give
// it an inline presentation over a PLAIN text body: a W3C-style selector
// points into the words from outside, the read view resolves selectors to
// spans, and a broken selector degrades to the strip — never a wrong chip.
// Anchor resolution runs here in the kit (one implementation for every
// consumer) and is presentation-only: it never writes.
// ============================================================================

/** Context window captured either side of a mention (chars). */
const MENTION_CONTEXT = 24;

/**
 * Build the standoff selector for the words at [start, end) of `text`:
 * TextQuoteSelector (exact + surrounding context) belt, TextPositionSelector
 * (start, in UTF-16 code units) suspenders.
 */
export function computeMentionSelector(text, start, end) {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - MENTION_CONTEXT), start),
    suffix: text.slice(end, end + MENTION_CONTEXT),
    start,
  };
}

// Deterministic normalization for the last resolution rung: collapse
// whitespace runs, fold smart quotes. Zero fuzzy risk — every normalized hit
// is still an exact hit modulo these two classes. The map carries normalized
// indices back to raw ones.
function normalizeWithMap(text) {
  let out = '';
  const map = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    let ch = text[i];
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      out += ' ';
      map.push(i);
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    if (ch === '‘' || ch === '’') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

// How much of the stored context survives around an occurrence — matching
// outward from the boundary, so nearby identical quotes separate cleanly.
function contextScore(body, occStart, occEnd, sel) {
  const prefix = sel.prefix ?? '';
  const suffix = sel.suffix ?? '';
  let score = 0;
  for (let k = 1; k <= prefix.length; k += 1) {
    if (body[occStart - k] === prefix[prefix.length - k]) score += 1;
    else break;
  }
  for (let k = 0; k < suffix.length; k += 1) {
    if (body[occEnd + k] === suffix[k]) score += 1;
    else break;
  }
  return score;
}

function occurrencesOf(haystack, needle) {
  const out = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

/**
 * Resolve standoff anchors to text spans — the global one-span-per-anchor
 * assignment (issue #282, Q2's layered ladder). `anchors` is a list of
 * `{link_id, selector: {exact, prefix, suffix, start}}`; the result maps
 * link_id → {start, end} in raw body offsets. An anchor that wins no span is
 * simply absent — an ORPHAN, rendered in the strip only.
 *
 * Ladder per anchor: exact occurrences (context-scored, nearest-to-stored-
 * position tiebreak; a position-verified match is just the perfect score) →
 * whitespace/smart-quote-normalized occurrences → orphan. NO fuzzy matching:
 * a wrong chip is a lie, a strip chip is honest. Arbitration is global —
 * each occurrence goes to at most one anchor and spans never overlap, so an
 * irreducibly ambiguous pair (same quote, same context) yields one inline
 * chip and one strip entry instead of a double render.
 */
export function assignAnchors(body, anchors) {
  const candidates = [];
  let norm = null;
  for (const anchor of anchors) {
    const sel = anchor.selector;
    if (!sel || typeof sel.exact !== 'string' || sel.exact.length === 0) continue;
    let spans = occurrencesOf(body, sel.exact).map((at) => ({
      start: at,
      end: at + sel.exact.length,
      normalized: 0,
    }));
    if (spans.length === 0) {
      norm = norm ?? normalizeWithMap(body);
      const needle = normalizeWithMap(sel.exact).text;
      if (needle.length > 0) {
        spans = occurrencesOf(norm.text, needle).map((at) => ({
          start: norm.map[at],
          end: norm.map[at + needle.length - 1] + 1,
          normalized: 1,
        }));
      }
    }
    for (const span of spans) {
      candidates.push({
        linkId: anchor.link_id,
        start: span.start,
        end: span.end,
        normalized: span.normalized,
        score: contextScore(body, span.start, span.end, sel),
        posDist: Math.abs(span.start - (Number.isFinite(sel.start) ? sel.start : 0)),
      });
    }
  }
  // Best claims first: exact before normalized, most context, nearest to the
  // stored position, then document order for full determinism.
  candidates.sort(
    (a, b) =>
      a.normalized - b.normalized ||
      b.score - a.score ||
      a.posDist - b.posDist ||
      a.start - b.start,
  );
  const assigned = new Map();
  const claimed = [];
  for (const c of candidates) {
    if (assigned.has(c.linkId)) continue;
    if (claimed.some(([s, e]) => c.start < e && s < c.end)) continue;
    assigned.set(c.linkId, { start: c.start, end: c.end });
    claimed.push([c.start, c.end]);
  }
  return assigned;
}

// Caret pixel position inside a textarea, via the classic mirror-div
// technique: clone the metrics that shape line wrapping, lay out the text up
// to `index`, and read where a marker span lands.
const MIRROR_STYLES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'textIndent',
];

function caretRect(textarea, index) {
  const mirror = document.createElement('div');
  const style = getComputedStyle(textarea);
  for (const prop of MIRROR_STYLES) mirror.style[prop] = style[prop];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  const lineHeight = marker.offsetHeight || parseFloat(style.lineHeight) || 20;
  mirror.remove();
  const box = textarea.getBoundingClientRect();
  return {
    top: box.top + top - textarea.scrollTop,
    left: box.left + left - textarea.scrollLeft,
    height: lineHeight,
  };
}

/**
 * The inline `@`-mention gesture over a plain textarea (issue #282). Typing
 * `@` at a word boundary opens a caret-anchored popover of pickable entity
 * cards; typing filters it CLIENT-SIDE over one batch fetched when the
 * popover opened — one receipted owner read per gesture, never per
 * keystroke (the receipt stays legible as "the owner opened the picker").
 *
 * The kit only runs the gesture: on pick it calls `onPick(card, range)` with
 * `range = {start, end}` covering `@token` in the textarea's value, and the
 * APP inserts the plain words and asserts the (anchored) link — text stays
 * plain, the reference stays structural.
 *
 * Options: {kinds?: string[], exclude?: {type, id}, onPick(card, range)}.
 * Returns a detach() that removes every listener.
 */
export function attachMentionPopover(textarea, options = {}) {
  let pop = null;
  let cards = null; // the one batch fetched for this popover
  let fetchSeq = 0;
  let atIndex = -1;
  let selected = 0;

  function close() {
    if (pop) pop.remove();
    pop = null;
    cards = null;
    atIndex = -1;
    selected = 0;
    fetchSeq += 1; // orphan any in-flight fetch
  }

  function tokenAtCaret() {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    const upto = textarea.value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;
    const before = at === 0 ? '' : upto[at - 1];
    if (before && !/[\s(]/.test(before)) return null;
    const token = upto.slice(at + 1);
    if (token.length > 40 || token.includes('\n')) return null;
    return { at, caret, token };
  }

  function filtered() {
    const gesture = tokenAtCaret();
    const term = (gesture?.token ?? '').trim().toLowerCase();
    const excluded = options.exclude
      ? (c) => c.type === options.exclude.type && c.id === options.exclude.id
      : () => false;
    return (cards ?? [])
      .filter((c) => !excluded(c))
      .filter((c) => {
        if (!term) return true;
        const hay = `${c.title ?? ''} ${c.subtitle ?? ''} ${entityKindLabel(c.type)}`.toLowerCase();
        return hay.includes(term);
      })
      .slice(0, 8);
  }

  function pick(card) {
    const gesture = tokenAtCaret();
    close();
    if (!gesture || !options.onPick) return;
    options.onPick(card, { start: gesture.at, end: gesture.caret });
  }

  function renderList() {
    if (!pop) return;
    const list = pop.firstChild;
    list.innerHTML = '';
    const visible = filtered();
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
    if (cards && visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'kit-mention-empty';
      empty.textContent = 'Nothing in your vault matches that.';
      list.appendChild(empty);
      return;
    }
    visible.forEach((card, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'kit-mention-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === selected ? 'true' : 'false');
      const kind = document.createElement('span');
      kind.className = 'kit-mention-kind';
      kind.textContent = entityKindLabel(card.type);
      const title = document.createElement('span');
      title.className = 'kit-mention-title';
      title.textContent = card.title ?? `${entityKindLabel(card.type)} ${card.id.slice(-6)}`;
      row.append(kind, title);
      // pointerdown, not click: keep the textarea focused through the pick.
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pick(card);
      });
      list.appendChild(row);
    });
  }

  function place() {
    if (!pop || atIndex < 0) return;
    const rect = caretRect(textarea, atIndex);
    const width = Math.min(320, window.innerWidth - 16);
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    pop.style.top = `${Math.min(rect.top + rect.height + 4, window.innerHeight - 60)}px`;
    pop.style.width = `${width}px`;
  }

  async function open(gesture) {
    atIndex = gesture.at;
    selected = 0;
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'kit-mention-pop';
      pop.setAttribute('role', 'listbox');
      pop.setAttribute('aria-label', 'Mention an entity from your vault');
      const list = document.createElement('div');
      list.className = 'kit-mention-list';
      list.dataset.state = 'loading';
      pop.appendChild(list);
      const note = document.createElement('p');
      note.className = 'kit-mention-note';
      note.textContent = 'Picking links only the picked item — receipted.';
      pop.appendChild(note);
      document.body.appendChild(pop);
    }
    place();
    if (cards === null) {
      const mine = ++fetchSeq;
      const params = new URLSearchParams();
      params.set('limit', '25');
      if (options.kinds && options.kinds.length) params.set('kinds', options.kinds.join(','));
      let batch = [];
      try {
        const r = await fetch('/centraid/_vault/picker?' + params.toString());
        const body = r.ok ? await r.json() : null;
        batch = (body && body.cards) || [];
      } catch {
        batch = [];
      }
      if (mine !== fetchSeq || !pop) return; // closed while loading
      cards = batch;
      delete pop.firstChild.dataset.state;
    }
    renderList();
  }

  function onInput() {
    const gesture = tokenAtCaret();
    if (!gesture) {
      close();
      return;
    }
    if (pop && gesture.at === atIndex) renderList();
    else open(gesture);
  }

  function onKeydown(e) {
    if (!pop) return;
    const visible = filtered();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      selected = (selected + delta + Math.max(1, visible.length)) % Math.max(1, visible.length);
      renderList();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && visible.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(visible[selected]);
    }
  }

  function onBlur() {
    // pointerdown picks already ran preventDefault, so a real blur means the
    // gesture is over — but a programmatic open (a button that inserts `@`
    // and re-focuses the textarea) blurs then immediately refocuses, so only
    // close if focus actually left the field.
    setTimeout(() => {
      if (document.activeElement !== textarea) close();
    }, 80);
  }

  textarea.addEventListener('input', onInput);
  // Capture phase: while the popover is open its Enter/Arrows must win over
  // the app's own editor keydown handlers (e.g. checklist continuation).
  textarea.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('blur', onBlur);
  textarea.addEventListener('click', onInput);
  return function detach() {
    close();
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('keydown', onKeydown, true);
    textarea.removeEventListener('blur', onBlur);
    textarea.removeEventListener('click', onInput);
  };
}

// ---------- Inline-chip rendering (shared read-view helpers, issue #282) ----------
// A resolved standoff anchor renders the mentioned words as a chip showing the
// resolver's LIVE card title — rename the target and the chip follows, while
// the body bytes stay the plain words that were typed. These are the pieces a
// read view reuses; the app supplies its own block/markdown layout and calls
// appendWithChips for each rendered text chunk.

/** The live-card chip element for one resolved anchor span (see `<kit-mention-chip>`). */
export function mentionChip(ref) {
  const chip = document.createElement('kit-mention-chip');
  chip.card = ref.card ?? {};
  return chip;
}

/**
 * Resolve a body's anchored references to inline spans (issue #282). `refs` is
 * the app's live reference list (`{link_id, selector, card}`); returns
 * `[{start, end, link_id, card}]` for the anchors that currently resolve, via
 * the global one-span-per-anchor assignment. Pure presentation — no writes.
 */
export function resolveInlineSpans(body, refs) {
  const anchored = (refs ?? []).filter((r) => r.selector);
  if (anchored.length === 0) return [];
  const assigned = assignAnchors(String(body ?? ''), anchored);
  return anchored
    .filter((r) => assigned.has(r.link_id))
    .map((r) => ({ ...assigned.get(r.link_id), link_id: r.link_id, card: r.card }));
}

/** The set of link_ids currently resolved inline in `body` (strip flagging). */
export function inlineLinkIds(body, refs) {
  return new Set(resolveInlineSpans(body, refs).map((r) => r.link_id));
}

/**
 * Append one rendered chunk of body text to `el`, swapping any anchor span
 * that falls fully inside it for its chip. `absStart` is the chunk's offset
 * in the whole decoded body — the space assignAnchors speaks. `renderPlain(el,
 * seg)` renders the non-chip text (default: a text node; a markdown app passes
 * its inline renderer). A span straddling a chunk boundary renders as plain
 * text — the chip is presentation, degrading is free.
 */
export function appendWithChips(el, text, absStart, spans, renderPlain) {
  const plain = renderPlain || ((node, seg) => node.appendChild(document.createTextNode(seg)));
  const absEnd = absStart + text.length;
  const inside = (spans ?? [])
    .filter((r) => r.start >= absStart && r.end <= absEnd)
    .toSorted((a, b) => a.start - b.start);
  const literal = (seg) => {
    if (seg) plain(el, seg);
  };
  if (inside.length === 0) {
    literal(text);
    return;
  }
  let cursor = absStart;
  for (const r of inside) {
    literal(text.slice(cursor - absStart, r.start - absStart));
    el.appendChild(mentionChip(r));
    cursor = r.end;
  }
  literal(text.slice(cursor - absStart));
}

// ---------- The @-mention field (turnkey cross-references, issues #272/#282) ----------
// Bundles the whole "@ works" behaviour so ANY app's <textarea> gains inline
// cross-references in a few lines: the caret popover, the pick→insert→assert
// (re-anchor-don't-duplicate), and the 4b reconcile-on-save (re-baseline live
// selectors, temporal-retract orphans, reversible Undo). Presentation +
// gesture only — the app still owns the body bytes, persistence, and the
// reference list (which it reads from its own core.link + core.link_anchor
// query). Everything below is a projection of that list.
//
// options:
//   from        () => {type,id} | {type,id} | null   — the entity mentions attach to
//   references  () => Array<{link_id, selector, card}> (live, mutated in place)
//   onChange    () => void                            — re-render strip/read-view after a mutation
//   relation    string = 'references'
//   kinds       string[]?                             — restrict the picker
//   onError     (outcome) => void?                    — vault refusal (default: a toast)
// returns { detach(), reconcile(body): Promise, startMention() }.
export function attachMentionField(textarea, options = {}) {
  const relation = options.relation || 'references';
  const getFrom = () =>
    (typeof options.from === 'function' ? options.from() : options.from) || null;
  const getRefs = () => {
    const r = typeof options.references === 'function' ? options.references() : options.references;
    return r || [];
  };
  const changed = () => options.onChange && options.onChange();
  const fail = (outcome, label) => {
    if (options.onError) options.onError(outcome);
    else toast(`Couldn’t link ${label}.`);
  };

  async function onPick(card, range) {
    const from = getFrom();
    if (!from) return;
    if (card.type === from.type && card.id === from.id) {
      toast('You can’t reference this record from itself.');
      return;
    }
    const refs = getRefs();
    const anchored = refs.filter((r) => r.selector);
    // Re-anchor, don't duplicate: an edge to this entity whose words were
    // edited away (orphaned BEFORE this insertion) takes the new selector
    // instead of minting a second judgment.
    const preAssigned = assignAnchors(textarea.value, anchored);
    const orphan = refs.find(
      (r) =>
        r.selector &&
        !preAssigned.has(r.link_id) &&
        r.card?.type === card.type &&
        r.card?.id === card.id,
    );
    const label = card.title ?? entityKindLabel(card.type);
    textarea.setRangeText(label, range.start, range.end, 'end');
    textarea.focus();
    // One synthetic input event lets the app's own handler sync its draft and
    // schedule its save — no duplicated bookkeeping here.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const selector = computeMentionSelector(
      textarea.value,
      range.start,
      range.start + label.length,
    );
    const outcome = orphan
      ? await reanchorReference(orphan.link_id, selector)
      : await createReference(from, card, relation, selector);
    if (outcome?.status !== 'executed') {
      fail(outcome, label);
      return;
    }
    if (orphan) orphan.selector = selector;
    else refs.push({ link_id: outcome.output?.link_id, selector, card });
    toast(`${orphan ? 'Re-linked' : 'Linked'} ${label}.`);
    changed();
  }

  const detachPopover = attachMentionPopover(textarea, {
    ...(options.kinds ? { kinds: options.kinds } : {}),
    onPick,
  });

  // Reconcile runs when a save lands (the app's debounce is the "settled"
  // signal). Serialized so two quick saves can't race the same edge. The
  // subject is captured at call time (opts.from / opts.references) so a
  // navigation during the async window can't retarget it at the wrong record.
  let chain = Promise.resolve();
  function reconcile(body, opts = {}) {
    const from = opts.from ?? getFrom();
    const refs = opts.references ?? getRefs();
    chain = chain.then(() => doReconcile(body, from, refs)).catch(() => {});
    return chain;
  }
  async function doReconcile(body, from, refs) {
    const anchored = refs.filter((r) => r.selector);
    if (anchored.length === 0) return;
    const assigned = assignAnchors(body, anchored);
    const orphans = [];
    for (const ref of anchored) {
      const span = assigned.get(ref.link_id);
      if (!span) {
        orphans.push(ref);
        continue;
      }
      // Re-baseline: keep the stored selector current with the saved body so
      // drift never accumulates and resolution needs no fuzzy rung.
      const fresh = computeMentionSelector(body, span.start, span.end);
      const cur = ref.selector;
      if (
        cur.exact !== fresh.exact ||
        cur.prefix !== fresh.prefix ||
        cur.suffix !== fresh.suffix ||
        cur.start !== fresh.start
      ) {
        const outcome = await reanchorReference(ref.link_id, fresh);
        if (outcome?.status === 'executed') ref.selector = fresh;
      }
    }
    if (orphans.length === 0) return;
    const retracted = [];
    for (const ref of orphans) {
      const outcome = await removeReference(ref.link_id);
      if (outcome?.status === 'executed') retracted.push(ref);
    }
    if (retracted.length === 0) return;
    for (const ref of retracted) {
      const i = refs.indexOf(ref);
      if (i >= 0) refs.splice(i, 1);
    }
    changed();
    const names = retracted.map((r) => r.card?.title ?? entityKindLabel(r.card?.type)).join(', ');
    toast(
      retracted.length === 1
        ? `Unlinked ${names} — its mention left the text.`
        : `Unlinked ${retracted.length} references whose mentions left the text.`,
      {
        undoLabel: 'Undo',
        // Undo re-asserts a FRESH, anchorless edge (history is never rewritten;
        // an anchorless link lives in the strip, exempt from re-retraction —
        // so it can't oscillate against the still-missing words).
        onUndo: async () => {
          if (!from) return;
          for (const ref of retracted) {
            const outcome = await createReference(from, ref.card, relation);
            if (outcome?.status === 'executed') {
              refs.push({ link_id: outcome.output?.link_id, selector: null, card: ref.card });
            }
          }
          changed();
        },
      },
    );
  }

  // Drop an `@` at the caret and open the popover (a discoverability shim for
  // a button). The app makes the textarea visible/editable first.
  function startMention() {
    textarea.focus();
    const pos = textarea.selectionStart ?? textarea.value.length;
    const prev = pos > 0 ? textarea.value[pos - 1] : '';
    textarea.setRangeText(prev && !/[\s(]/.test(prev) ? ' @' : '@', pos, pos, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  return { detach: detachPopover, reconcile, startMention };
}
