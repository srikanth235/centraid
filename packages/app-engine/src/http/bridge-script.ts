/**
 * Inline `<script>` that wires the runtime's `_changes` SSE stream into the
 * page as both a `CustomEvent('centraid:datachange')` and a sugar API:
 *
 *     window.centraid.onChange(refresh)   // returns an unsubscribe fn
 *     window.addEventListener('centraid:datachange', e => …)   // vanilla
 *
 * Auto-injected into every served HTML right after `<head>` so it runs
 * before user `<script>`s parse. The CSP nonce stamper (which runs after
 * this) tags the tag so `script-src 'self'` accepts it. The script also
 * augments — never overwrites — `window.centraid`, so the mobile bridge's
 * `centraid.haptic` / `centraid.notify` namespace coexists.
 *
 * Reconnect (issue #404 radio hygiene): EventSource auto-reconnects on
 * transient drops; when it lands in CLOSED (`readyState === 2`) we re-open on
 * an exponential backoff with jitter (1s → cap 30s, reset to 1s on a
 * successful `open`) instead of a flat 5s hammer. The stream is also paused —
 * the socket closed, freeing a server subscriber slot — while the document is
 * hidden (`visibilitychange`/`pagehide`) and reconnected when it returns
 * (`pageshow` or visible again), so a backgrounded mobile tab stops holding a
 * radio open. The `window.centraid.onChange` contract is unchanged.
 */
// Inline bridge baked into every served HTML. Two responsibilities:
//
// 1. **Change feed.** Subscribes to `_changes` SSE and exposes
//    `window.centraid.onChange(cb)` + the `centraid:datachange` event.
//
// 2. **Three-tool helpers.** Issue #107 removed the per-handler
//    `_run` / `_data/<name>` routes; in their place is one shim at
//    `/centraid/_tool/<toolName>`. To keep templates terse we inject
//    `window.centraid.write({action,input})`, `.read({query,input})`,
//    and `.describe(filter?)`. They derive the app id from
//    `location.pathname` (`/centraid/<id>/...`) so the bridge is
//    portable across apps without per-app code-gen.
export function changeBridgeScript(draft?: { appId: string; toolUrl: string }): string {
  // Live mode sniffs the app id from `/centraid/<id>/…` and posts tools at
  // `/centraid/_tool/`. Draft mode pins both: the path's first segment is
  // `_draft`, so the sniff would mis-read it, and tool calls must hit the
  // draft shim so the session worktree's handlers run.
  const idAndTool = draft
    ? `var appId=${JSON.stringify(draft.appId)};w.centraid.appId=appId;var toolUrl=${JSON.stringify(draft.toolUrl)};`
    : `var m=/(?:^|\\/)centraid\\/([^/]+)\\//.exec(w.location.pathname);var appId=m?decodeURIComponent(m[1]):null;w.centraid.appId=appId;var toolUrl='/centraid/_tool/';`;
  return `<script>(function(){var w=window;w.centraid=w.centraid||{};var listeners=new Set();w.centraid.onChange=function(cb){if(typeof cb!=='function')return function(){};listeners.add(cb);return function(){listeners.delete(cb);};};${idAndTool}function callTool(name,body){return fetch(toolUrl+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.text().then(function(t){var j=null;try{j=t?JSON.parse(t):null;}catch(_){}if(!r.ok){var err=j&&j.message?j.message:('tool '+name+' failed: '+r.status);var e=new Error(err);e.code=j&&j.code;e.status=r.status;throw e;}return j;});});}w.centraid.write=function(opts){if(!opts||!opts.action)return Promise.reject(new Error('write requires {action}'));return callTool('centraid_write',{app:appId,action:opts.action,input:opts.input});};w.centraid.read=function(opts){if(!opts||!opts.query)return Promise.reject(new Error('read requires {query}'));return callTool('centraid_read',{app:appId,query:opts.query,input:opts.input});};w.centraid.describe=function(filter){var body=Object.assign({},filter||{});if(!body.app&&appId)body.app=appId;return callTool('centraid_describe',body);};if(typeof EventSource!=='function')return;var es=null,delay=1000,timer=null,paused=false;var MIN=1000,MAX=30000;function clearTimer(){if(timer){clearTimeout(timer);timer=null;}}function drop(){clearTimer();if(es){try{es.close();}catch(_){}es=null;}}function schedule(){clearTimer();if(paused)return;var wait=Math.round(delay*(0.5+Math.random()));delay=Math.min(MAX,delay*2);timer=setTimeout(function(){timer=null;connect();},wait);}function connect(){if(paused||es)return;try{es=new EventSource('_changes');}catch(_){es=null;schedule();return;}es.addEventListener('open',function(){delay=MIN;});es.addEventListener('change',function(ev){var d;try{d=JSON.parse(ev.data);}catch(_){d={tables:[],ts:Date.now()};}try{w.dispatchEvent(new CustomEvent('centraid:datachange',{detail:d}));}catch(_){}listeners.forEach(function(cb){try{cb(d);}catch(_){}});});es.addEventListener('error',function(){if(es&&es.readyState===2){drop();schedule();}});}function resume(){paused=false;delay=MIN;clearTimer();connect();}function pause(){paused=true;drop();}try{document.addEventListener('visibilitychange',function(){if(document.hidden)pause();else resume();});}catch(_){}try{w.addEventListener('pagehide',pause);}catch(_){}try{w.addEventListener('pageshow',resume);}catch(_){}if(document&&document.hidden){paused=true;}else{connect();}})();</script>`;
}

export function injectChangeBridge(html: string, draft?: { appId: string; toolUrl: string }): string {
  // Inject right after the opening <head>. If the document has no <head>
  // (rare in practice but legal HTML) the script falls through unchanged
  // — better to leave the doc intact than guess where to splice.
  const m = /<head\b[^>]*>/i.exec(html);
  if (!m) return html;
  const insertAt = m.index + m[0].length;
  return html.slice(0, insertAt) + changeBridgeScript(draft) + html.slice(insertAt);
}

