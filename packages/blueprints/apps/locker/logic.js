// Non-visual business logic: vault IO (write/act), item CRUD, nav/search,
// the clipboard-clear timer and the pure list/sidebar derivations.
// `createLogic` closes over app.jsx's own `state`/`data` (mutated in place,
// never reassigned) plus the render/refresh entry points app.jsx defines —
// the same factory shape tasks/notes/agenda's logic.js use. The pure
// derivations (`currentPool`/`sidebarCounts`/`catCounts`/`sidebarTags`) need
// no closure and are exported standalone so components can call them too.
import { debounce, outcomeMessage, toast } from './kit.js';
import { CAT_ORDER, byTitle, catOf } from './format.js';
import { genPassword } from './totp.js';

export function createLogic({ state, data, render, refresh }) {
  function notice(text) {
    const el = document.getElementById('noticeBanner');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  // Returns true when the write executed; otherwise narrates parked / failed
  // / denied honestly and returns false.
  function narrate(outcome) {
    if (outcome?.status === 'executed') {
      notice('');
      return true;
    }
    notice(outcomeMessage(outcome) ?? 'The write did not go through.');
    return false;
  }

  async function act(action, input) {
    try {
      return await window.centraid.write({ action, input });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
  }

  function applyDenied(d) {
    state.denied = true;
    document.getElementById('consentBanner').hidden = false;
    document.getElementById('consentDetail').textContent = d?.message ?? '';
    data.items = [];
    state.selectedId = null;
    state.detail = null;
    render();
  }

  // ---------- Item writes ----------

  async function toggleFav(sel) {
    const outcome = await act(sel.favorite ? 'unstar-item' : 'star-item', { item_id: sel.item_id });
    if (!narrate(outcome)) return;
    toast(sel.favorite ? 'Star removed · receipted.' : 'Starred · receipted.');
    if (state.detail && state.detail.item_id === sel.item_id) {
      state.detail = { ...state.detail, favorite: !sel.favorite };
    }
    await refresh();
  }

  async function trashItem(sel) {
    const outcome = await act('trash-item', { item_id: sel.item_id });
    if (!narrate(outcome)) return;
    toast('Moved to trash · receipted.', {
      undoLabel: 'Undo',
      onUndo: async () => {
        const back = await act('restore-item', { item_id: sel.item_id });
        if (narrate(back)) await refresh();
      },
    });
    state.selectedId = null;
    state.detail = null;
    state.showList = true;
    await refresh();
  }

  async function restoreItem(sel) {
    const outcome = await act('restore-item', { item_id: sel.item_id });
    if (!narrate(outcome)) return;
    toast('Restored · receipted.');
    state.selectedId = null;
    state.detail = null;
    state.showList = true;
    await refresh();
  }

  async function purgeItem(sel) {
    const outcome = await act('purge-item', { item_id: sel.item_id });
    if (!narrate(outcome)) return;
    toast('Deleted forever · receipted.');
    state.selectedId = null;
    state.detail = null;
    state.showList = true;
    await refresh();
  }

  // { mode: 'new'|'edit', id?, type, title, tags: string, alias, fields, allowedKeys }
  async function saveItem({ mode, id, type, title, tags, alias, fields, allowedKeys }) {
    if (!title.trim()) return undefined;
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    // Only the fields belonging to the chosen type (the backend drops the
    // rest too, but keep the payload clean).
    const allowed = new Set(allowedKeys);
    const input = { title: title.trim(), tags: tagList };
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.has(k) && v != null && v !== '') input[k] = v;
    }
    // Alias is write-safe from the UI: a non-empty value sets/changes it; a
    // blank field is left untouched (never clobbers an existing binding).
    // Clearing or reassigning is an assistant/CLI gesture.
    const aliasTrimmed = (alias || '').trim();
    if (aliasTrimmed) input.alias = aliasTrimmed;
    let outcome;
    if (mode === 'edit') {
      outcome = await act('edit-item', { item_id: id, ...input });
    } else {
      outcome = await act('add-item', { type, ...input });
    }
    if (!narrate(outcome)) return outcome;
    const savedId = mode === 'edit' ? id : (outcome?.output?.item_id ?? null);
    toast(mode === 'edit' ? 'Saved · receipted.' : 'Item saved · receipted.');
    await refresh();
    // Re-open the item we just wrote so its (possibly changed) secrets reload.
    if (savedId) await selectItem(savedId);
    return outcome;
  }

  // ---------- Selection / navigation ----------

  // Open an item: fetch its FULL fields (the only place secrets arrive) and
  // show the detail pane. Secrets stay in state.detail, never in the list
  // array.
  async function selectItem(id) {
    state.selectedId = id;
    state.detail = null;
    state.detailLoading = true;
    state.reveal = {};
    if (state.nav.kind === 'watch') state.nav = { kind: 'all' };
    state.showList = false;
    render();
    let res;
    try {
      res = await window.centraid.read({ query: 'item', input: { item_id: id } });
    } catch {
      res = null;
    }
    state.detailLoading = false;
    if (res?.vaultDenied) {
      applyDenied(res.vaultDenied);
      return;
    }
    // Ignore a stale open if the user moved on.
    if (state.selectedId !== id) return;
    state.detail = res?.item ?? null;
    render();
  }

  function setNav(nav) {
    state.nav = nav;
    state.selectedId = null;
    state.detail = null;
    state.search = '';
    state.searchResults = null;
    searchSeq += 1;
    state.sideOpen = false;
    state.showList = true;
    render();
  }

  function toggleTheme() {
    const dark = !state.dark;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (dark && !document.documentElement.style.getPropertyValue('--bg-l'))
      document.documentElement.style.setProperty('--bg-l', '10%');
    state.dark = dark;
    render();
  }

  function toggleReveal(fid) {
    // A fresh `state.reveal` object each time so the unmasked value never
    // lingers once the field/item that owned it is gone.
    state.reveal = { ...state.reveal, [fid]: !state.reveal[fid] };
    render();
  }

  // ---------- Generator ----------

  function regen() {
    state.genValue = genPassword({ len: state.genLen, num: state.genNum, sym: state.genSym });
    render();
  }

  // `applyFn`, when given, is called with the generated password once the
  // owner hits Copy — the bridge back into whichever field (in the edit
  // modal) opened the generator, without the generator needing to know
  // about the modal's own local React state.
  function openGenerator(applyFn) {
    state.gen = true;
    state.genApply = applyFn ?? null;
    regen();
  }

  function closeGen() {
    state.gen = false;
    state.genApply = null;
    render();
  }

  // ---------- Search ----------

  let searchSeq = 0;
  const applySearchInput = debounce(async (raw) => {
    state.search = raw;
    const q = raw.trim();
    const seq = ++searchSeq;
    if (!q) {
      state.searchResults = null;
      render();
      return;
    }
    let rows = [];
    try {
      const res = await window.centraid.read({ query: 'search', input: { term: q } });
      if (res?.vaultDenied) {
        applyDenied(res.vaultDenied);
        return;
      }
      rows = res?.items ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    render();
  }, 150);

  function clearSearch() {
    searchSeq += 1;
    state.search = '';
    state.searchResults = null;
    render();
  }

  return {
    notice,
    narrate,
    act,
    applyDenied,
    toggleFav,
    trashItem,
    restoreItem,
    purgeItem,
    saveItem,
    selectItem,
    setNav,
    toggleTheme,
    toggleReveal,
    regen,
    openGenerator,
    closeGen,
    applySearchInput,
    clearSearch,
  };
}

// ---------- Clipboard copy (standalone — no closure over app state) ----------

// Seconds a copied secret is allowed to live on the clipboard before we wipe
// it (issue #298 item 5): copy-password legitimately crosses into the OS
// clipboard, and from there into clipboard-history tools. We can't reach the
// native `org.nspasteboard.ConcealedType` mark from this sandboxed iframe
// (navigator.clipboard only speaks text/html/png), so the portable
// mitigation is a timed clear — and we only clear if the clipboard STILL
// holds the value we put there, never clobbering a later copy.
const CLIP_CLEAR_S = 30;
let clipClearTimer = null;
function scheduleClipboardClear(secret) {
  if (clipClearTimer) clearTimeout(clipClearTimer);
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  clipClearTimer = setTimeout(() => {
    clipClearTimer = null;
    const done = () => {};
    try {
      if (navigator.clipboard.readText) {
        navigator.clipboard.readText().then((cur) => {
          if (cur === secret) navigator.clipboard.writeText('').catch(done);
        }, done);
      }
      // No read permission → leave the clipboard alone rather than risk
      // wiping something the user copied since.
    } catch {
      /* clipboard unavailable */
    }
  }, CLIP_CLEAR_S * 1000);
}

export function copy(text, label, secret) {
  // writeText returns a promise — a sync try/catch never sees its rejection
  // (it surfaced as an unhandled NotAllowedError pageerror: the shell's app
  // iframe carries no clipboard-write permissions policy, see
  // apps/desktop/src/renderer/react/shell/routes/AppFrame.tsx). Toast
  // success only once the write actually lands; otherwise say so instead of
  // claiming a copy that never happened.
  const okToast = () =>
    toast((label || 'Copied') + ' copied' + (secret ? ' · clears in ' + CLIP_CLEAR_S + 's' : ''));
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    toast('Copy is unavailable here.');
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      if (secret) scheduleClipboardClear(text);
      okToast();
    },
    () => toast('Copy is unavailable here.'),
  );
}

// ---------- Pure derivations (no closure — components may call directly) ----------

// The rows for the current nav → search → filter → sort by title.
export function currentPool(state, data) {
  if (state.nav.kind === 'trash') return [...state.trashRows].sort(byTitle);
  let pool = state.searchResults != null ? state.searchResults.slice() : data.items.slice();
  if (state.nav.kind === 'fav') pool = pool.filter((i) => i.favorite);
  else if (state.nav.kind === 'cat') pool = pool.filter((i) => i.type === state.nav.type);
  else if (state.nav.kind === 'tag')
    pool = pool.filter((i) => (i.tags || []).includes(state.nav.tag));
  return pool.sort(byTitle);
}

export function sidebarCounts(data, state) {
  const items = data.items;
  return {
    all: items.length,
    fav: items.filter((i) => i.favorite).length,
    watch: state.watch.compromised + state.watch.weak,
  };
}

export function catCounts(data) {
  const counts = {};
  for (const t of CAT_ORDER) counts[t] = data.items.filter((i) => i.type === t).length;
  return counts;
}

export function sidebarTags(data) {
  const allTags = [...new Set(data.items.flatMap((i) => i.tags || []))].sort();
  return allTags.map((tag) => ({
    tag,
    count: data.items.filter((i) => (i.tags || []).includes(tag)).length,
  }));
}

export function listTitle(nav) {
  const navTitles = { all: 'All items', fav: 'Favorites', watch: 'Watchtower', trash: 'Trash' };
  if (nav.kind === 'cat') return catOf(nav.type).label;
  if (nav.kind === 'tag') return '#' + nav.tag;
  return navTitles[nav.kind] || 'All items';
}
