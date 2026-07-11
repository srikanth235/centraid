// Locker — everything, locked up. A personal password manager as a
// projection over the personal vault. Every row is a locker.item; the list
// payload is secret-free (only the single-item query returns passwords,
// card numbers, CVVs, OTP seeds and note bodies), so secrets never ride a
// list and are never logged. Copy and reveal are the only ways a secret
// leaves a field. One-time codes are real RFC-6238 TOTP computed
// client-side from the seed once it is read (see totp.js); the password
// generator runs entirely in the browser. Watchtower flags weak / reused /
// compromised (weak + reused derived server-side, compromised a stored
// breach flag). Favorites are the vault-canonical flags-scheme star. Every
// write is a typed vault command — consent-checked and receipted. The app
// stores nothing of its own: revoke the grant and this page goes dark.
//
// React port: module-level `state`/`data` (mutated in place, never
// reassigned) plus a `render()` orchestrator — the same
// tasks/notes/agenda/docs pattern, adapted for the one difference here: the
// original Lit app had NO static chrome markup in index.html (sidebar/list/
// detail were entirely Lit-rendered), so this port mounts a single React
// root at `#stage` and renders the sidebar/list/detail/overlays as siblings
// on every render() call, instead of one root per pre-existing container.
// `logic.js` holds the non-visual business logic (vault IO, item CRUD,
// nav/search, the clipboard-clear timer); `format.js` the pure category/date
// helpers; `totp.js` the real crypto (TOTP + password generation).
// `components/` holds pure functions of props.
import { createRoot } from './react-core.min.js';
import { readFailed, showSkeleton } from './kit.js';
import {
  copy,
  createLogic,
  catCounts,
  currentPool,
  listTitle,
  sidebarCounts,
  sidebarTags,
} from './logic.js';
import { LockerSidebar } from './components/Sidebar.jsx';
import { LockerList } from './components/List.jsx';
import { LockerDetail } from './components/Detail.jsx';
import { LockScreen } from './components/LockScreen.jsx';
import { Generator } from './components/Generator.jsx';
import { EditModal } from './components/EditModal.jsx';

const $ = (id) => document.getElementById(id);

// ---------- State ----------
// `data.items` are the secret-free decorated rows from the `items` query.
// Secrets live only in `state.detail` (from the single-item `item` query)
// and never touch this array. Neither is reassigned — always mutated in
// place so logic.js's closure over them stays valid.

const data = { items: [], truncated: false };

const state = {
  nav: { kind: 'all' }, // all | fav | watch | cat(type) | tag(tag) | trash
  selectedId: null,
  detail: null, // full item from `item` query (holds secrets)
  detailLoading: false,
  reveal: {}, // fieldId -> bool
  search: '',
  searchResults: null, // null when not searching; else the vault's matches
  dark: document.documentElement.dataset.theme === 'dark',
  narrow: false,
  sideOpen: false,
  showList: true,
  locked: false,
  gen: false,
  genLen: 20,
  genNum: true,
  genSym: true,
  genValue: '',
  genApply: null, // callback the open generator's Copy pushes the value into
  edit: null, // { mode, id?, type, title, fields:{}, tags:'', alias } — seed for EditModal
  // view-scoped row pools populated by refresh() for the current nav
  trashRows: [],
  watch: { compromised: 0, weak: 0, reused: 0, items: [] },
  denied: false,
  readFailedShown: false,
};

// ---------- Logic instance ----------
// `render`/`refresh` are `function` declarations (hoisted), so `logic` can
// close over them here even though they're defined further down the file.

const logic = createLogic({ state, data, render, refresh });

// ---------- Edit / new plumbing ----------

function openNew() {
  state.edit = { mode: 'new', type: 'login', title: '', fields: {}, tags: '', alias: '' };
  state.sideOpen = false;
  render();
}

// The detail pane already holds the full (secret-bearing) item — reuse it
// so edit never re-fetches. Map only the action-key fields into the form.
const EDIT_FIELD_KEYS = [
  'username', 'password', 'url', 'otp_seed', 'notes',
  'cardholder', 'card_number', 'expiry', 'cvv', 'brand',
  'content', 'fullname', 'email', 'phone', 'address', 'network',
];
function openEdit(sel) {
  const fields = {};
  for (const k of EDIT_FIELD_KEYS) if (sel[k] != null) fields[k] = sel[k];
  state.edit = {
    mode: 'edit',
    id: sel.item_id,
    type: sel.type,
    title: sel.title,
    fields,
    tags: (sel.tags || []).join(', '),
    alias: sel.alias || '',
  };
  render();
}
function closeEdit() {
  state.edit = null;
  render();
}
async function submitEdit(payload) {
  const outcome = await logic.saveItem(payload);
  // Only close on an executed write — parked/failed/denied leave the modal
  // open (the notice banner, updated by saveItem's narrate(), explains why),
  // same as the original saveEdit()'s early `if (!narrate(outcome)) return;`.
  if (outcome?.status === 'executed') {
    state.edit = null;
    render();
  }
}

// ---------- Lock ----------

function lock() {
  state.locked = true;
  render();
}
function unlock() {
  state.locked = false;
  render();
}

// ---------- Root ----------
// Mounted lazily on the first render() call (after the initial refresh()
// resolves, or immediately on a denied read) — until then `#stage` still
// shows the raw skeleton showSkeleton() painted at boot, matching the
// original's "chrome mounts once, on first render" timing.

let stageRoot = null;
function ensureRoot() {
  if (!stageRoot) stageRoot = createRoot($('stage'));
  return stageRoot;
}

function render() {
  const rootEl = $('root');
  rootEl.classList.toggle('denied', state.denied);
  rootEl.classList.toggle('is-narrow', state.narrow);
  rootEl.classList.toggle('side-open', state.narrow && state.sideOpen);
  rootEl.classList.toggle('show-list', state.showList);

  const pool = currentPool(state, data);

  ensureRoot().render(
    <>
      <LockerSidebar
        counts={sidebarCounts(data, state)}
        catCounts={catCounts(data)}
        tags={sidebarTags(data)}
        trashCount={state.trashRows.length}
        nav={state.nav}
        dark={state.dark}
        onNav={(nav) => logic.setNav(nav)}
        onNewItem={openNew}
        onCloseSide={() => {
          state.sideOpen = false;
          render();
        }}
        onLock={lock}
        onToggleTheme={() => logic.toggleTheme()}
      />
      <LockerList
        pool={pool}
        listTitle={listTitle(state.nav)}
        allCount={data.items.length}
        search={state.search}
        selectedId={state.selectedId}
        onOpenSide={() => {
          state.sideOpen = true;
          render();
        }}
        onSelect={(id) => logic.selectItem(id)}
        onSearchInput={(value) => {
          state.search = value;
          render();
          logic.applySearchInput(value);
        }}
        onClearSearch={() => logic.clearSearch()}
      />
      <LockerDetail
        mode={
          state.nav.kind === 'watch'
            ? 'watch'
            : state.selectedId && (state.detail || state.detailLoading)
              ? 'item'
              : 'empty'
        }
        watch={state.watch}
        detail={state.detail}
        reveal={state.reveal}
        onBack={() => {
          state.showList = true;
          state.selectedId = null;
          state.detail = null;
          render();
        }}
        onSelect={(id) => logic.selectItem(id)}
        onToggleReveal={(fid) => logic.toggleReveal(fid)}
        onToggleFav={(sel) => logic.toggleFav(sel)}
        onEdit={openEdit}
        onTrash={(sel) => logic.trashItem(sel)}
        onRestore={(sel) => logic.restoreItem(sel)}
        onPurge={(sel) => logic.purgeItem(sel)}
      />
      {/* Overlay layer — order matters: the generator can be opened from
      inside the edit modal, and (matching the original DOM order) the edit
      modal paints after it, so re-opening the generator while editing still
      stacks the same way it always did. */}
      <div data-kit-host>
        {state.locked ? <LockScreen onUnlock={unlock} /> : null}
        {state.gen ? (
          <Generator
            genLen={state.genLen}
            genNum={state.genNum}
            genSym={state.genSym}
            genValue={state.genValue}
            onRegen={() => logic.regen()}
            onSetLen={(n) => {
              state.genLen = n;
              logic.regen();
            }}
            onToggleNum={() => {
              state.genNum = !state.genNum;
              logic.regen();
            }}
            onToggleSym={() => {
              state.genSym = !state.genSym;
              logic.regen();
            }}
            onClose={() => logic.closeGen()}
            onUse={() => {
              // If a password field is waiting for it, drop the value there; always copy.
              state.genApply?.(state.genValue);
              copy(state.genValue, 'Password', true);
              logic.closeGen();
            }}
          />
        ) : null}
        {state.edit ? (
          <EditModal
            edit={state.edit}
            onClose={closeEdit}
            onSave={submitEdit}
            onOpenGenerator={(applyFn) => logic.openGenerator(applyFn)}
          />
        ) : null}
      </div>
    </>,
  );
}

// ---------- Refresh ----------

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'items', input: { limit: 300 } });
  } catch {
    readFailed($('noticeBanner'));
    state.readFailedShown = true;
    return;
  }
  if (state.readFailedShown) {
    state.readFailedShown = false;
    logic.notice('');
  }
  if (next?.vaultDenied) {
    logic.applyDenied(next.vaultDenied);
    return;
  }
  state.denied = false;
  $('consentBanner').hidden = true;

  data.items = next?.items ?? [];
  data.truncated = Boolean(next?.truncated);

  // Pull the derived views used by the sidebar badge, watchtower and trash.
  // Watchtower counts feed the sidebar badge so it's fetched every refresh
  // (bounded and cheap); trash is only needed for its own list.
  await Promise.all([
    window.centraid
      .read({ query: 'watchtower' })
      .then((r) => {
        if (r && !r.vaultDenied) {
          state.watch = {
            compromised: r.compromised ?? 0,
            weak: r.weak ?? 0,
            reused: r.reused ?? 0,
            items: r.items ?? [],
          };
        }
      })
      .catch(() => {}),
    window.centraid
      .read({ query: 'trash' })
      .then((r) => {
        if (r && !r.vaultDenied) state.trashRows = r.items ?? [];
      })
      .catch(() => {}),
  ]);

  // Drop a selection whose item vanished (unless it now lives in trash).
  if (
    state.selectedId &&
    !data.items.some((i) => i.item_id === state.selectedId) &&
    !state.trashRows.some((i) => i.item_id === state.selectedId)
  ) {
    state.selectedId = null;
    state.detail = null;
  }
  render();
}

// ---------- Responsive: component-width driven ----------

function measure() {
  const root = $('root');
  const forced = document.documentElement.getAttribute('data-app-width') === 'narrow';
  const narrow = forced || root.clientWidth < 860;
  if (narrow !== state.narrow) {
    state.narrow = narrow;
    if (!narrow) state.sideOpen = false;
    render();
  }
}

// ---------- Global keydown (layered Escape) ----------

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.edit) {
    closeEdit();
    return;
  }
  if (state.gen) {
    logic.closeGen();
    return;
  }
  if (state.sideOpen) {
    state.sideOpen = false;
    render();
  }
});
window.addEventListener('resize', measure);
window.addEventListener('focus', refresh);

// ---------- Boot ----------

state.narrow = $('root').clientWidth < 860;
$('root').classList.toggle('is-narrow', state.narrow);
showSkeleton($('stage'), 6);
measure();
setInterval(measure, 250);
refresh();
