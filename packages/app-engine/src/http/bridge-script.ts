// governance: allow-repo-hygiene file-size-limit pre-existing cohesive bridge module; decomposition is outside issue #417
/**
 * Inline bridge baked into every served app HTML.
 *
 * The bridge keeps the established Promise-based three-tool helpers and the
 * `centraid:datachange` / `centraid.onChange` compatibility contract. In a
 * managed shell iframe it handshakes with the parent, which fans out one
 * authenticated vault change tail to all apps. A standalone app that gets no
 * parent acknowledgement shortly after boot falls back to its legacy local
 * `_changes` EventSource. That compatibility source retains the issue #404
 * hidden-page pause and jittered reconnect backoff.
 *
 * Concurrent identical `read()` calls share one fetch and each caller can
 * abort independently. `write()` remains non-deduped and both helpers retain
 * their original Promise return values.
 */
export function changeBridgeScript(draft?: { appId: string; basePath: string }): string {
  // Live mode sniffs the app id from `/centraid/<id>/…` and addresses the app
  // RPC routes under `/centraid/<id>/` (issue #505). Draft mode pins both
  // because its first path segment is `_draft` and its handlers run through the
  // draft session worktree at `/centraid/_draft/<sessionId>/<id>/`.
  const idAndTool = draft
    ? `var appId=${JSON.stringify(draft.appId)};w.centraid.appId=appId;var baseUrl=${JSON.stringify(draft.basePath)};`
    : `var locationPath=w.location.pathname;try{if(opaqueBaseUrl)locationPath=new URL(opaqueBaseUrl).pathname;}catch(_){}var m=/(?:^|\\/)centraid\\/([^/]+)\\//.exec(locationPath);var appId=w.centraid.appId||(m?decodeURIComponent(m[1]):null);w.centraid.appId=appId;var baseUrl=appId?('/centraid/'+encodeURIComponent(appId)+'/'):null;`;

  return `<script>(function(){var w=window;w.centraid=w.centraid||{};
var opaqueBaseUrl=typeof w.centraid.opaqueBaseUrl==='string'?w.centraid.opaqueBaseUrl:null;
var nativeFetch=typeof w.fetch==='function'?w.fetch.bind(w):null;
var listeners=new Set();
w.centraid.onChange=function(cb){
  if(typeof cb!=='function')return function(){};
  listeners.add(cb);
  return function(){listeners.delete(cb);};
};
${idAndTool}
function rpcRequest(url,method,body,signal){
  var init={method:method,headers:{'content-type':'application/json'}};
  if(body!==undefined)init.body=JSON.stringify(body);
  if(signal)init.signal=signal;
  if(!baseUrl)return Promise.reject(new Error('app id is unknown'));
  return (opaqueBaseUrl?opaqueFetch:fetch)(url,init).then(function(r){
    return r.text().then(function(t){
      var j=null;
      try{j=t?JSON.parse(t):null;}catch(_){}
      if(!r.ok){
        var err=j&&j.message?j.message:('request failed: '+r.status);
        var e=new Error(err);e.code=j&&j.code;e.status=r.status;throw e;
      }
      return j;
    });
  });
}
function actionUrl(name){return baseUrl+'actions/'+encodeURIComponent(name);}
function queryUrl(name){return baseUrl+'queries/'+encodeURIComponent(name);}
function callAction(name,input,intentId,signal){var body={input:input};if(intentId!==undefined)body.intentId=intentId;return rpcRequest(actionUrl(name),'POST',body,signal);}
function callQuery(name,input,signal){return rpcRequest(queryUrl(name),'POST',{input:input},signal);}
var replicaManaged=false,replicaPort=null,replicaSeq=1,replicaPending={},liveSeq=1,liveEntries={};
var documentNonce=typeof w.centraid.documentNonce==='string'?w.centraid.documentNonce:null;
try{var nonceMatch=/(?:^|&)bridge=([^&]*)/.exec((w.location.hash||'').replace(/^#/,''));if(nonceMatch)documentNonce=decodeURIComponent(nonceMatch[1]);}catch(_){}
function postReplica(message,transfer){if(!replicaPort)throw replicaErr('replica port is not ready','REPLICA_NOT_READY');replicaPort.postMessage(message,transfer||[]);}
function replicaErr(message,code){var e=new Error(message||'replica unavailable');e.code=code||'REPLICA_UNAVAILABLE';return e;}
function replicaCall(type,body,signal){
  if(!replicaManaged||!replicaPort||!w.parent||w.parent===w)return Promise.reject(replicaErr());
  var id=replicaSeq++,timer,onAbort;
  return new Promise(function(resolve,reject){
    function finish(fn,value){
      if(!replicaPending[id])return;delete replicaPending[id];
      if(timer)clearTimeout(timer);
      if(signal&&onAbort){try{signal.removeEventListener('abort',onAbort);}catch(_){}}
      fn(value);
    }
    onAbort=function(){finish(reject,mkAbortErr());};
    replicaPending[id]={resolve:function(v){finish(resolve,v);},reject:function(e){finish(reject,e);}};
    timer=setTimeout(function(){finish(reject,replicaErr(type==='centraid:resource'?'app resource request timed out':'replica request timed out'));},type==='centraid:resource'?60000:10000);
    if(signal){
      if(signal.aborted){onAbort();return;}
      try{signal.addEventListener('abort',onAbort);}catch(_){}
    }
    try{var transfers=[];if(type==='centraid:resource'&&body&&body.request&&body.request.body instanceof ArrayBuffer)transfers.push(body.request.body);postReplica(Object.assign({type:type,id:id,appId:appId},body||{}),transfers);}
    catch(e){finish(reject,e);}
  });
}
function opaqueResolveUrl(input){
  if(!opaqueBaseUrl)return new URL(input,w.location.href).href;
  var base=new URL(opaqueBaseUrl),url=new URL(input,opaqueBaseUrl);
  if(url.protocol==='data:'||url.protocol==='blob:')return url.href;
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw replicaErr('app resource protocol is not allowed','APP_RESOURCE_DENIED');
  if(url.origin!==base.origin)throw replicaErr('app resource escaped the shell origin','APP_RESOURCE_DENIED');
  var marker='/__centraid_iroh__/',end=base.pathname.indexOf('/',marker.length);
  if(end<marker.length)throw replicaErr('app resource scope is invalid','APP_RESOURCE_DENIED');
  var scope=base.pathname.slice(0,end);
  if(url.pathname.slice(0,marker.length)===marker&&url.pathname.slice(0,scope.length+1)!==scope+'/')throw replicaErr('app resource selected another session','APP_RESOURCE_DENIED');
  if(url.pathname.slice(0,scope.length+1)!==scope+'/')url=new URL(scope+url.pathname+url.search+url.hash,base.origin);
  if(url.pathname.slice(0,scope.length+1)!==scope+'/')throw replicaErr('app resource escaped its session','APP_RESOURCE_DENIED');
  return url.href;
}
function opaqueFetch(input,init){
  if(!opaqueBaseUrl){if(!nativeFetch)return Promise.reject(replicaErr('fetch unavailable'));return nativeFetch(input,init);}
  var raw=(typeof Request==='function'&&input instanceof Request)?input.url:String(input);
  var resolved;
  try{resolved=opaqueResolveUrl(raw);}catch(error){return Promise.reject(error);}
  if(/^data:|^blob:/.test(resolved)){if(!nativeFetch)return Promise.reject(replicaErr('fetch unavailable'));return nativeFetch(input,init);}
  var request;
  try{
    request=(typeof Request==='function'&&input instanceof Request)?new Request(input,init):new Request(resolved,init);
  }catch(error){return Promise.reject(error);}
  var method=(request.method||'GET').toUpperCase();
  var bodyPromise=(method==='GET'||method==='HEAD')?Promise.resolve(new ArrayBuffer(0)):request.clone().arrayBuffer();
  return bodyPromise.then(function(body){
    return replicaCall('centraid:resource',{request:{url:opaqueResolveUrl(request.url),method:method,headers:Array.from(request.headers.entries()),body:body}},request.signal);
  }).then(function(result){
    if(!result||typeof result.status!=='number')throw replicaErr('invalid app resource response','APP_RESOURCE_INVALID');
    var noBody=result.status===101||result.status===103||result.status===204||result.status===205||result.status===304;
    return new Response(noBody?null:result.body,{status:result.status,statusText:result.statusText||'',headers:result.headers||[]});
  });
}
if(opaqueBaseUrl&&nativeFetch)w.fetch=opaqueFetch;
function installOpaqueMediaBridge(){
  if(!opaqueBaseUrl||typeof Element!=='function'||typeof URL!=='function')return;
  var nativeSet=Element.prototype.setAttribute;
  var pending=new WeakMap(),cache=new Map(),objectUrls=[];
  function localValue(value){return /^(?:data:|blob:|about:)/i.test(String(value));}
  function stateFor(el){var state=pending.get(el);if(!state){state={};pending.set(el,state);}return state;}
  function load(value){
    var url=opaqueResolveUrl(String(value)),known=cache.get(url);
    if(known)return known;
    var work=opaqueFetch(url).then(function(response){if(!response.ok)throw replicaErr('media failed: '+response.status,'APP_RESOURCE_FAILED');return response.blob();}).then(function(blob){var out=URL.createObjectURL(blob);objectUrls.push(out);return out;});
    cache.set(url,work);work.catch(function(){if(cache.get(url)===work)cache.delete(url);});return work;
  }
  function assign(el,attribute,value,nativeSetter){
    value=String(value==null?'':value);
    if(!value||localValue(value)){delete stateFor(el)[attribute];if(nativeSetter)nativeSetter.call(el,value);else nativeSet.call(el,attribute,value);return;}
    var state=stateFor(el),token={value:value};state[attribute]=token;
    load(value).then(function(blobUrl){
      if(state[attribute]!==token)return;
      token.blobUrl=blobUrl;
      if(nativeSetter)nativeSetter.call(el,blobUrl);else nativeSet.call(el,attribute,blobUrl);
    },function(){if(state[attribute]===token){delete state[attribute];try{el.dispatchEvent(new Event('error'));}catch(_){}}});
  }
  function patch(proto,property,attribute){
    if(!proto)return;var descriptor=Object.getOwnPropertyDescriptor(proto,property);
    if(!descriptor||!descriptor.get||!descriptor.set||descriptor.configurable===false)return;
    try{Object.defineProperty(proto,property,{configurable:true,enumerable:descriptor.enumerable,get:function(){var state=pending.get(this),value=state&&state[attribute];return value&&value.value?value.value:descriptor.get.call(this);},set:function(value){assign(this,attribute,value,descriptor.set);}});}catch(_){}
  }
  patch(typeof HTMLImageElement==='function'?HTMLImageElement.prototype:null,'src','src');
  patch(typeof HTMLMediaElement==='function'?HTMLMediaElement.prototype:null,'src','src');
  patch(typeof HTMLVideoElement==='function'?HTMLVideoElement.prototype:null,'poster','poster');
  patch(typeof HTMLSourceElement==='function'?HTMLSourceElement.prototype:null,'src','src');
  patch(typeof HTMLObjectElement==='function'?HTMLObjectElement.prototype:null,'data','data');
  patch(typeof HTMLEmbedElement==='function'?HTMLEmbedElement.prototype:null,'src','src');
  function mediaAttribute(el,name){
    name=String(name).toLowerCase();var tag=el&&el.tagName;
    return (name==='src'&&(tag==='IMG'||tag==='VIDEO'||tag==='AUDIO'||tag==='SOURCE'||tag==='EMBED'))||(name==='poster'&&tag==='VIDEO')||(name==='data'&&tag==='OBJECT');
  }
  Element.prototype.setAttribute=function(name,value){if(mediaAttribute(this,name)&&!localValue(value)){assign(this,String(name).toLowerCase(),value);return;}return nativeSet.call(this,name,value);};
  try{new MutationObserver(function(records){records.forEach(function(record){var el=record.target,name=record.attributeName;if(!name||!mediaAttribute(el,name))return;var value=el.getAttribute(name);if(value&&!localValue(value))assign(el,name,value);});}).observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:['src','poster','data']});}catch(_){}
  document.addEventListener('click',function(event){
    var anchor=event.target&&event.target.closest?event.target.closest('a[download]'):null;
    if(!anchor)return;var href=anchor.getAttribute('href');if(!href||localValue(href))return;
    event.preventDefault();load(href).then(function(blobUrl){var copy=document.createElement('a');nativeSet.call(copy,'href',blobUrl);copy.download=anchor.download||'download';copy.style.display='none';document.body.appendChild(copy);copy.click();copy.remove();},function(){});
  },true);
  try{w.addEventListener('pagehide',function(){objectUrls.forEach(function(url){try{URL.revokeObjectURL(url);}catch(_){}});objectUrls=[];});}catch(_){}
}
installOpaqueMediaBridge();
function onlineGuard(){
  var guard={error:null};
  guard.mark=function(reason){if(!guard.error){guard.error=replicaErr('Query requires the online vault: '+reason,'ONLINE_ONLY');guard.error.name='OnlineOnlyError';}return guard.error;};
  return guard;
}
function guardedRow(envelope,guard){
  var missing={};
  (envelope.oversizedFields||[]).forEach(function(k){missing[k]='oversized field '+k;});
  var undisclosed=envelope.hasUnavailableFields===true;
  function unavailable(target,k){return typeof k==='string'&&(missing[k]||(undisclosed&&!(k in target)));}
  function fail(k){throw guard.mark((typeof k==='string'&&missing[k])||'accessing undisclosed unavailable fields');}
  return new Proxy(Object.assign({},envelope.values||{}),{
    get:function(target,key){if(unavailable(target,key))fail(key);return target[key];},
    has:function(target,key){if(unavailable(target,key))fail(key);return key in target;},
    ownKeys:function(target){if(Object.keys(missing).length||undisclosed)fail();return Reflect.ownKeys(target);},
    getOwnPropertyDescriptor:function(target,key){if(unavailable(target,key))fail(key);return Object.getOwnPropertyDescriptor(target,key);}
  });
}
function rememberDependency(entry,dep){
  if(!dep||!dep.shapeId||!dep.entity)return;
  entry.dependencies[dep.shapeId+'\u0000'+dep.entity]={shapeId:dep.shapeId,entity:dep.entity};
}
function localVault(entry,guard,signal){
  function effect(name){return function(){return Promise.reject(guard.mark(name+' is online-only'));};}
  return {
    read:function(request){
      return replicaCall('centraid:replica-read',{request:request},signal).then(function(result){
        rememberDependency(entry,result&&result.dependency);
        var cursor=result&&result.cursor;
        return {
          rows:((result&&result.rows)||[]).map(function(row){return guardedRow(row,guard);}),
          receiptId:cursor?('replica:'+cursor.epoch+':'+cursor.seq):'replica:local',
          dependency:result&&result.dependency
        };
      });
    },
    search:function(request){
      return replicaCall('centraid:replica-search',{request:request},signal).then(function(result){
        rememberDependency(entry,result&&result.dependency);
        var cursor=result&&result.cursor;
        return {
          rows:((result&&result.rows)||[]).map(function(row){return guardedRow(row,guard);}),
          receiptId:cursor?('replica:'+cursor.epoch+':'+cursor.seq):'replica:local',
          dependency:result&&result.dependency
        };
      });
    },
    invoke:effect('invoke'),query:effect('query'),
    describe:effect('describe'),parked:effect('parked'),changes:effect('changes'),
    resolve:effect('resolve'),reveal:effect('reveal'),content:effect('content')
  };
}
function queryModuleUrl(query){return new URL('./_query/'+encodeURIComponent(query)+'.mjs',opaqueBaseUrl||w.location.href).href;}
function loadQueryModule(url){
  if(typeof w.centraid.__loadQuery==='function')return w.centraid.__loadQuery(url);
  if(!opaqueBaseUrl)return import(url);
  return opaqueFetch(url).then(function(response){if(!response.ok)throw replicaErr('query bundle failed: '+response.status,'QUERY_BUNDLE_UNAVAILABLE');return response.text();}).then(function(source){
    var blobUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    return import(blobUrl).then(function(mod){URL.revokeObjectURL(blobUrl);return mod;},function(error){URL.revokeObjectURL(blobUrl);throw error;});
  });
}
var queryPrewarm=null;
function rememberedOpaqueApp(){
  if(!opaqueBaseUrl)return false;
  try{
    var path=new URL(opaqueBaseUrl).pathname,marker='/__centraid_iroh__/',at=path.indexOf(marker);
    if(at<0)return false;
    return path.slice(at+marker.length).split('/')[0].slice(0,2)==='d-';
  }catch(_){return false;}
}
/** Fill the durable SW bucket without evaluating query modules or surfacing best-effort failures. */
function prewarmQueryBundles(){
  if(!rememberedOpaqueApp())return Promise.resolve();
  if(queryPrewarm)return queryPrewarm;
  queryPrewarm=Promise.resolve().then(function(){
    return opaqueFetch(new URL('./app.json',opaqueBaseUrl).href,{method:'GET',headers:{accept:'application/json'},cache:'no-cache'});
  }).then(function(response){
    if(!response||!response.ok)return null;
    return response.text().then(function(text){try{return JSON.parse(text);}catch(_){return null;}});
  }).then(function(manifest){
    var declared=manifest&&Array.isArray(manifest.queries)?manifest.queries:[],seen={},names=[];
    declared.slice(0,256).forEach(function(entry){
      var name=typeof entry==='string'?entry:(entry&&entry.name);
      if(typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)&&!seen[name]){seen[name]=true;names.push(name);}
    });
    return Promise.all(names.map(function(name){
      return opaqueFetch(queryModuleUrl(name),{method:'GET',headers:{accept:'application/javascript'},cache:'no-cache'}).then(function(response){
        return response&&typeof response.text==='function'?response.text().then(function(){},function(){}):undefined;
      },function(){});
    }));
  }).then(function(){},function(){});
  return queryPrewarm;
}
function runLocalQuery(opts,entry,signal){
  var guard=onlineGuard();entry.dependencies={};
  var ctx={
    abortSignal:signal,
    fetch:function(){return Promise.reject(guard.mark('fetch is online-only'));},
    vault:localVault(entry,guard,signal)
  };
  var log={info:function(){},warn:function(){},error:function(){}};
  return loadQueryModule(queryModuleUrl(opts.query)).then(function(mod){
    if(!mod||typeof mod.default!=='function')throw replicaErr('query bundle has no default export','QUERY_BUNDLE_INVALID');
    return mod.default({params:{},query:opts.input||{},input:opts.input,app:{id:appId,dir:''},log:log,ctx:ctx});
  }).then(function(value){if(guard.error)throw guard.error;entry.server=false;return value;});
}
function syncParentSubscription(entry){
  if(!entry.listeners||entry.listeners.size===0||entry.server||!replicaManaged){
    if(entry.registered){try{postReplica({type:'centraid:replica-unsubscribe',appId:appId,subscriptionId:entry.liveId});}catch(_){}entry.registered=false;}
    return;
  }
  var dependencies=Object.keys(entry.dependencies||{}).map(function(k){return entry.dependencies[k];});
  if(!dependencies.length){
    if(entry.registered){try{postReplica({type:'centraid:replica-unsubscribe',appId:appId,subscriptionId:entry.liveId});}catch(_){}entry.registered=false;}
    return;
  }
  try{postReplica({type:'centraid:replica-subscribe',appId:appId,subscriptionId:entry.liveId,dependencies:dependencies});entry.registered=true;}catch(_){}
}
function canFallbackOnline(error){
  var code=error&&error.code;
  return code==='ONLINE_ONLY'||code==='REPLICA_UNAVAILABLE'||code==='REPLICA_NOT_READY'||code==='REPLICA_REBOOTSTRAP_REQUIRED';
}
function executeRead(opts,entry,signal){
  if(!replicaManaged){
    entry.server=true;
    return callQuery(opts.query,opts.input,signal).then(function(value){syncParentSubscription(entry);return value;});
  }
  return runLocalQuery(opts,entry,signal).catch(function(error){
    if(signal&&signal.aborted)throw mkAbortErr();
    if(!canFallbackOnline(error))throw error;
    entry.server=true;entry.dependencies={};
    return callQuery(opts.query,opts.input,signal);
  }).then(function(value){syncParentSubscription(entry);return value;});
}
function rerunLive(entry){
  if(!entry||!entry.listeners||entry.listeners.size===0)return;
  if(entry.rerunning){entry.dirty=true;return;}
  entry.rerunning=true;entry.dirty=false;
  var ctl=(typeof AbortController==='function')?new AbortController():null;
  executeRead(entry.opts,entry,ctl?ctl.signal:undefined).then(function(value){
    entry.listeners.forEach(function(cb){try{cb(value);}catch(_){}});
  },function(){}).then(function(){entry.rerunning=false;if(entry.dirty)rerunLive(entry);});
}
function rerunServerLives(){Object.keys(liveEntries).forEach(function(id){var e=liveEntries[id];if(e&&e.server)rerunLive(e);});}
function mkAbortErr(){var e=new Error('aborted');e.name='AbortError';return e;}
w.centraid.write=function(opts){
  if(!opts||!opts.action)return Promise.reject(new Error('write requires {action}'));
  // Sealed inputs are online-only in v1. An explicit policy bypasses the
  // replica-write path so the payload can never enter the shell's durable or
  // in-memory intent queue. (Opaque online transport may still use the
  // capability MessagePort.) Network failures must never fall back to queuing.
  if(opts.onlineOnly===true){
    return callAction(opts.action,opts.input,undefined,opts.signal);
  }
  if(replicaManaged){
    return replicaCall('centraid:replica-write',{
      action:opts.action,input:opts.input,
      optimistic:Array.isArray(opts.optimistic)?opts.optimistic:[],
      intentId:opts.intentId
    },opts.signal).catch(function(error){
      if(error&&error.code!=='REPLICA_UNAVAILABLE'&&error.code!=='REPLICA_NOT_READY')throw error;
      return callAction(opts.action,opts.input,opts.intentId,opts.signal);
    });
  }
  return callAction(opts.action,opts.input,undefined,opts.signal);
};
var inflight={};
function readKey(q,i){try{return JSON.stringify([q,i===undefined?null:i]);}catch(_){return null;}}
w.centraid.read=function(opts){
  if(!opts||!opts.query)return Promise.reject(new Error('read requires {query}'));
  var key=readKey(opts.query,opts.input);
  var entry=key!=null?inflight[key]:null;
  if(!entry){
    var ctl=(typeof AbortController==='function')?new AbortController():null;
    entry={refs:0,aborted:0,ctl:ctl,opts:{query:opts.query,input:opts.input},liveId:'live-'+(liveSeq++),listeners:new Set(),dependencies:{},registered:false,server:!replicaManaged};
    entry.promise=executeRead(entry.opts,entry,ctl?ctl.signal:undefined);
    if(key!=null){
      var clear=function(){if(inflight[key]===entry)delete inflight[key];};
      entry.promise.then(clear,clear);inflight[key]=entry;
    }
  }
  entry.refs++;
  var sig=opts.signal,done=false,onAbort;
  var ret=new Promise(function(resolve,reject){
    onAbort=function(){
      if(done)return;done=true;
      if(sig){try{sig.removeEventListener('abort',onAbort);}catch(_){}}
      entry.aborted++;
      if(entry.ctl&&entry.aborted>=entry.refs){try{entry.ctl.abort();}catch(_){}}
      reject(mkAbortErr());
    };
    entry.promise.then(function(v){
      if(done)return;done=true;
      if(sig){try{sig.removeEventListener('abort',onAbort);}catch(_){}}
      resolve(v);
    },function(e){
      if(done)return;done=true;
      if(sig){try{sig.removeEventListener('abort',onAbort);}catch(_){}}
      reject(e);
    });
    if(sig){
      if(sig.aborted){onAbort();}
      else{try{sig.addEventListener('abort',onAbort);}catch(_){}}
    }
  });
  ret.abort=function(){if(onAbort)onAbort();};
  ret.subscribe=function(cb){
    if(typeof cb!=='function')return function(){};
    entry.listeners.add(cb);liveEntries[entry.liveId]=entry;syncParentSubscription(entry);
    entry.promise.then(function(value){if(entry.listeners.has(cb)){try{cb(value);}catch(_){}}},function(){});
    return function(){
      entry.listeners.delete(cb);
      if(entry.listeners.size===0){syncParentSubscription(entry);delete liveEntries[entry.liveId];}
    };
  };
  return ret;
};
w.centraid.describe=function(filter){
  var parts=[];
  if(filter&&typeof filter.action==='string')parts.push('action='+encodeURIComponent(filter.action));
  if(filter&&typeof filter.query==='string')parts.push('query='+encodeURIComponent(filter.query));
  var qs=parts.length?('?'+parts.join('&')):'';
  return rpcRequest(baseUrl+'_describe'+qs,'GET',undefined);
};

function legacyDetail(change){
  if(!change||typeof change!=='object')return {tables:[],ts:Date.now()};
  if(Array.isArray(change.tables))return change;
  var entity=typeof change.entity==='string'?change.entity:null;
  var at=typeof change.changedAt==='string'?Date.parse(change.changedAt):NaN;
  return Object.assign({},change,{
    tables:entity?[entity]:[],
    ts:Number.isFinite(at)?at:Date.now(),
    source:change.source||'vault-replica'
  });
}
function emitOne(change){
  var detail=legacyDetail(change);
  try{w.dispatchEvent(new CustomEvent('centraid:datachange',{detail:detail}));}catch(_){}
  listeners.forEach(function(cb){try{cb(detail);}catch(_){}});
}
function emitChanges(payload){
  var values=Array.isArray(payload)?payload:(payload&&Array.isArray(payload.changes)?payload.changes:[payload]);
  values.forEach(emitOne);
  rerunServerLives();
}

var es=null,reconnectTimer=null,handshakeTimer=null;
var delay=1000,paused=false,fallbackEnabled=false,parentManaged=false;
var MIN=1000,MAX=30000,HANDSHAKE_MS=500;
function clearReconnect(){if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}}
function clearHandshake(){if(handshakeTimer){clearTimeout(handshakeTimer);handshakeTimer=null;}}
function drop(){
  clearReconnect();
  if(es){try{es.close();}catch(_){}es=null;}
}
function schedule(){
  clearReconnect();
  if(paused||!fallbackEnabled||parentManaged)return;
  var wait=Math.round(delay*(0.5+Math.random()));
  delay=Math.min(MAX,delay*2);
  reconnectTimer=setTimeout(function(){reconnectTimer=null;connect();},wait);
}
function connect(){
  if(paused||es||!fallbackEnabled||parentManaged||typeof EventSource!=='function')return;
  try{es=new EventSource('_changes');}catch(_){es=null;schedule();return;}
  es.addEventListener('open',function(){delay=MIN;});
  es.addEventListener('change',function(ev){
    var detail;
    try{detail=JSON.parse(ev.data);}catch(_){detail={tables:[],ts:Date.now()};}
    emitChanges(detail);
  });
  es.addEventListener('error',function(){
    if(es&&es.readyState===2){drop();schedule();}
  });
}
function startFallback(){
  clearHandshake();
  if(parentManaged)return;
  fallbackEnabled=true;
  connect();
}
function useParent(){
  parentManaged=true;
  fallbackEnabled=false;
  clearHandshake();
  drop();
}
function onReplicaPortMessage(ev){
  var msg=ev&&ev.data;
  if(!msg||typeof msg!=='object')return;
  if(msg.type==='centraid:replica-result'){
    var pending=replicaPending[msg.id];if(!pending)return;
    if(msg.ok)pending.resolve(msg.result);
    else pending.reject(replicaErr(msg.error||'replica request failed',msg.code));
    return;
  }
  if(msg.type==='centraid:replica-invalidate'){
    rerunLive(liveEntries[msg.subscriptionId]);return;
  }
  if(msg.type==='centraid:changes-parent'){useParent();return;}
  if(!parentManaged)return;
  if(msg.type==='centraid:vault-change')emitChanges(msg.detail);
  else if(msg.type==='centraid:vault-rebootstrap'){
    try{w.dispatchEvent(new CustomEvent('centraid:rebootstrap',{detail:msg.detail}));}catch(_){}
    rerunServerLives();
  }
}
function bindReplicaPort(port){
  if(!port)return;
  try{if(replicaPort)replicaPort.close();}catch(_){}
  replicaPort=port;
  try{replicaPort.addEventListener('message',onReplicaPortMessage);replicaPort.start();}
  catch(_){replicaPort.onmessage=onReplicaPortMessage;}
  replicaManaged=true;
  prewarmQueryBundles();
}
function onParentMessage(ev){
  if(!w.parent||ev.source!==w.parent)return;
  var msg=ev.data;
  if(!msg||typeof msg!=='object'||msg.type!=='centraid:replica-parent')return;
  if(msg.documentNonce!==documentNonce||!ev.ports||!ev.ports[0])return;
  bindReplicaPort(ev.ports[0]);
}
try{w.addEventListener('message',onParentMessage);}catch(_){}
function resume(){paused=false;delay=MIN;clearReconnect();connect();}
function pause(){paused=true;drop();}
try{document.addEventListener('visibilitychange',function(){if(document.hidden)pause();else resume();});}catch(_){}
try{w.addEventListener('pagehide',pause);}catch(_){}
try{w.addEventListener('pageshow',resume);}catch(_){}
if(document&&document.hidden)paused=true;
var hasParent=false;
try{hasParent=!!w.parent&&w.parent!==w;}catch(_){}
if(hasParent){
  handshakeTimer=setTimeout(startFallback,HANDSHAKE_MS);
  try{
    w.parent.postMessage({type:'centraid:changes-ready',appId:appId,documentNonce:documentNonce},'*');
    w.parent.postMessage({type:'centraid:replica-ready',appId:appId,documentNonce:documentNonce},'*');
  }catch(_){startFallback();}
}else startFallback();
})();</script>`;
}

export function injectChangeBridge(
  html: string,
  draft?: { appId: string; basePath: string },
): string {
  // Inject right after the opening <head>. If the document has no <head>
  // (rare in practice but legal HTML) the script falls through unchanged.
  const m = /<head\b[^>]*>/i.exec(html);
  if (!m) return html;
  const insertAt = m.index + m[0].length;
  return html.slice(0, insertAt) + changeBridgeScript(draft) + html.slice(insertAt);
}
