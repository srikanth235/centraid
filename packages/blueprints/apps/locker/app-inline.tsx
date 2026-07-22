// Locker, inline (issue #505). The served entry (app.tsx) stays byte-for-byte
// for mobile WebViews + the visual harness; this co-located sibling re-expresses
// the SAME orchestration as ONE React tree for the shell's inline route.
// `logic.ts` (vault IO, item CRUD, nav/search, the clipboard-clear timer, the
// pure list/sidebar derivations), `format.ts`/`totp.ts` (categories, dates, real
// client-side TOTP + password generation) and the `components/*` are reused
// verbatim; app.tsx's single `createRoot($('stage'))` + imperative `render()`
// collapse into this component's bump-driven JSX. Reads/writes flow through the
// shell-installed `window.centraid` (backed by the replica), so mount awaits
// nothing over the network — first paint is local.
//
// Reveal / copy / TOTP are unchanged: reveal is `logic.toggleReveal` + React
// state, copy is `logic.copy` over `navigator.clipboard` (with the 30s
// clipboard-clear timer), and one-time codes are RFC-6238 TOTP computed
// client-side by totp.ts's `useTotp`. None of that touched chrome, so all three
// work identically inline (in fact the clipboard is MORE available here than in
// the served sandboxed iframe).
//
// Denial: unlike Tasks/Tally, this file keeps the served `#consentBanner` /
// `#consentDetail` / `#noticeBanner` nodes (rendered once by Chrome), so the
// reused logic.ts `applyDenied` / `notice` / `readFailed` drive them by id
// verbatim — the app shows its designed consent banner on a revoked read, never
// a blank pane (trap #8). `applyDenied` never touched `#root`, so there are no
// shell-owned-#root no-op concerns here; the frame's state classes are driven by
// React from `state`, not by app.tsx's `$('root').classList` calls.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from './react-core.min.js';
import { observeWidth, onDataChange, onFocusRefresh, readFailed } from './kit.js';
import {
  copy,
  createLogic,
  catCounts,
  currentPool,
  listTitle,
  sidebarCounts,
  sidebarTags,
} from './logic.ts';
import { LockerSidebar } from './components/Sidebar.tsx';
import { LockerList } from './components/List.tsx';
import { LockerDetail } from './components/Detail.tsx';
import { LockScreen } from './components/LockScreen.tsx';
import { Generator } from './components/Generator.tsx';
import { EditModal } from './components/EditModal.tsx';
import { Chrome } from './Chrome.tsx';
import itemsQuery from './queries/items.ts';
import itemQuery from './queries/item.ts';
import searchQuery from './queries/search.ts';
import trashQuery from './queries/trash.ts';
import type { AppData, AppState, LockerDetail as DetailItem, LockerRow } from './types.ts';
import type { InlineAppModule, InlineAppProps } from '../inline-types.ts';

// Vault entities this app's queries read — the doorbell filter re-derives only
// when a change names one of these (or names none, i.e. "this app acted").
const CHANGE_TABLES = ['locker.item', 'core.tag', 'core.concept', 'core.concept_scheme'];

// The detail pane already holds the full (secret-bearing) item — reuse it so
// edit never re-fetches. Map only the action-key fields into the form. Verbatim
// from app.tsx.
const EDIT_FIELD_KEYS = [
  'username',
  'password',
  'url',
  'otp_seed',
  'notes',
  'cardholder',
  'card_number',
  'expiry',
  'cvv',
  'brand',
  'content',
  'fullname',
  'email',
  'phone',
  'address',
  'network',
] as const;
type EditKey = (typeof EDIT_FIELD_KEYS)[number];

function makeState(): AppState {
  return {
    nav: { kind: 'all' },
    selectedId: null,
    detail: null,
    detailLoading: false,
    reveal: {},
    search: '',
    searchResults: null,
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
    genApply: null,
    edit: null,
    trashRows: [],
    watch: { compromised: 0, weak: 0, reused: 0, items: [] },
    denied: false,
    readFailedShown: false,
  };
}

interface ItemsPayload {
  items?: LockerRow[];
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string };
  watchtower?: { compromised?: number; weak?: number; reused?: number; items?: LockerRow[] };
}

function Root({ rootRef }: InlineAppProps): ReactNode {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Gates the drawer's slide transition: false until one frame after mount so
  // the pre-paint narrow snap (useLayoutEffect below) applies with no animation.
  const [ready, setReady] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<AppState>(makeState());
  const dataRef = useRef<AppData>({ items: [], truncated: false });
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);

  // Verbatim from app.tsx's refresh(), minus the served skeleton (reads are
  // local off the replica). Denial routes through logic.applyDenied, which now
  // drives the real #consentBanner/#consentDetail Chrome renders.
  const refresh = useCallback(async () => {
    const state = stateRef.current;
    const data = dataRef.current;
    const logic = logicRef.current!;
    let next: ItemsPayload;
    try {
      next = await window.centraid.read<ItemsPayload>({ query: 'items', input: { limit: 300 } });
    } catch {
      readFailed(document.getElementById('noticeBanner'));
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
    const consent = document.getElementById('consentBanner');
    if (consent) (consent as HTMLElement).hidden = true;

    data.items = next?.items ?? [];
    data.truncated = Boolean(next?.truncated);

    // Watchtower counts come free with the items read (issue #404): that query
    // already unseals passwords once to derive weak/reused, so it returns the
    // summary rather than a second full read + receipted unseal.
    if (next?.watchtower) {
      state.watch = {
        compromised: next.watchtower.compromised ?? 0,
        weak: next.watchtower.weak ?? 0,
        reused: next.watchtower.reused ?? 0,
        items: next.watchtower.items ?? [],
      };
    }
    await window.centraid
      .read<{ items?: AppData['items']; vaultDenied?: unknown }>({ query: 'trash' })
      .then((r) => {
        if (r && !r.vaultDenied) state.trashRows = r.items ?? [];
      })
      .catch(() => {});

    // Drop a selection whose item vanished (unless it now lives in trash).
    if (
      state.selectedId &&
      !data.items.some((i) => i.item_id === state.selectedId) &&
      !state.trashRows.some((i) => i.item_id === state.selectedId)
    ) {
      state.selectedId = null;
      state.detail = null;
    }
    bump();
  }, []);

  if (!logicRef.current) {
    logicRef.current = createLogic({
      state: stateRef.current,
      data: dataRef.current,
      render: bump,
      refresh,
    });
  }
  const logic = logicRef.current;

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef],
  );

  // ---- Edit / new / lock plumbing (verbatim from app.tsx, render → bump) ----
  const openNew = useCallback(() => {
    const state = stateRef.current;
    state.edit = {
      mode: 'new',
      type: 'login',
      title: '',
      fields: {},
      tags: '',
      alias: '',
      urlMatchPolicy: 'registrable-domain',
    };
    state.sideOpen = false;
    bump();
  }, []);

  const openEdit = useCallback((sel: DetailItem) => {
    const fields: Record<string, string> = {};
    for (const k of EDIT_FIELD_KEYS) {
      const v = sel[k as EditKey];
      if (v != null) fields[k] = v;
    }
    stateRef.current.edit = {
      mode: 'edit',
      id: sel.item_id,
      type: sel.type,
      title: sel.title,
      fields,
      tags: (sel.tags || []).join(', '),
      alias: sel.alias || '',
      urlMatchPolicy: sel.url_match_policy === 'exact-host' ? 'exact-host' : 'registrable-domain',
    };
    bump();
  }, []);

  const closeEdit = useCallback(() => {
    stateRef.current.edit = null;
    bump();
  }, []);

  const submitEdit = useCallback(
    async (payload: Parameters<typeof logic.saveItem>[0]) => {
      const outcome = await logicRef.current!.saveItem(payload);
      // Only close on an executed write — parked/failed/denied leave the modal
      // open (the notice banner explains why), same as app.tsx's submitEdit.
      if (outcome?.status === 'executed') {
        stateRef.current.edit = null;
        bump();
      }
    },
    [logic],
  );

  // Seed the narrow layout BEFORE the first paint. The served app sets
  // is-narrow pre-render from clientWidth; here observeWidth in the mount effect
  // below only fires post-paint, so without this the sidebar would paint as an
  // in-flow pane and then the reused Sidebar.module.css `transition: transform`
  // would slide it out — a visible flash at narrow widths (issue #505). Runs in
  // useLayoutEffect (after commit, before paint) and bumps synchronously, so the
  // FIRST painted frame is already narrow with the drawer hidden. The slide
  // transition stays gated on `.ready` (set one frame later) so this snap is
  // instant.
  useLayoutEffect(() => {
    const el = rootElRef.current;
    if (!el) return;
    const isNarrow = el.clientWidth < 860;
    if (isNarrow !== stateRef.current.narrow) {
      stateRef.current.narrow = isNarrow;
      bump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pre-paint seed, refs stable (#505)
  }, []);
  // Enable the drawer slide transition only after the first painted frame, so
  // the mount-time narrow snap above is instant and user open/close still
  // animate (and a Tasks→Locker remount snaps cleanly too).
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // ---- chrome wiring: doorbell, focus refresh, layered Escape, width ----
  useEffect(() => {
    const stopDoorbell = onDataChange(CHANGE_TABLES, refresh);
    const stopFocus = onFocusRefresh(refresh);
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const state = stateRef.current;
      if (state.edit) {
        closeEdit();
        return;
      }
      if (state.gen) {
        logicRef.current!.closeGen();
        return;
      }
      if (state.sideOpen) {
        state.sideOpen = false;
        bump();
      }
    };
    window.addEventListener('keydown', onKey);
    const el = rootElRef.current;
    // Component-width driven responsive via a ResizeObserver (matches app.tsx).
    const stopWidth = el
      ? observeWidth(el, 860, (narrow: boolean) => {
          if (narrow === stateRef.current.narrow) return;
          stateRef.current.narrow = narrow;
          if (!narrow) stateRef.current.sideOpen = false;
          bump();
        })
      : () => {};
    void refresh();
    return () => {
      window.removeEventListener('keydown', onKey);
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  const state = stateRef.current;
  const data = dataRef.current;
  const pool = currentPool(state, data);

  // The whole surface, mirroring app.tsx's render() one-for-one — sidebar / list
  // / detail as slots on the frame, overlays in the display:contents host.
  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome
    // gets real width — otherwise it collapses to content width and the
    // component-width narrow observer wrongly flips to the phone drawer layout.
    <div
      ref={setRoot}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <Chrome
        narrow={state.narrow}
        sideOpen={state.sideOpen}
        showList={state.showList}
        denied={state.denied}
        ready={ready}
        sidebar={
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
              bump();
            }}
            onLock={() => {
              state.locked = true;
              bump();
            }}
            onToggleTheme={() => logic.toggleTheme()}
          />
        }
        list={
          <LockerList
            pool={pool}
            listTitle={listTitle(state.nav)}
            allCount={data.items.length}
            search={state.search}
            selectedId={state.selectedId}
            onOpenSide={() => {
              state.sideOpen = true;
              bump();
            }}
            onSelect={(id) => logic.selectItem(id)}
            onSearchInput={(value) => {
              state.search = value;
              bump();
              logic.applySearchInput(value);
            }}
            onClearSearch={() => logic.clearSearch()}
          />
        }
        detail={
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
              bump();
            }}
            onSelect={(id) => logic.selectItem(id)}
            onToggleReveal={(fid) => logic.toggleReveal(fid)}
            onToggleFav={(sel) => logic.toggleFav(sel)}
            onEdit={openEdit}
            onTrash={(sel) => logic.trashItem(sel)}
            onRestore={(sel) => logic.restoreItem(sel)}
            onPurge={(sel) => logic.purgeItem(sel)}
          />
        }
        overlays={
          <>
            {state.locked ? (
              <LockScreen
                onUnlock={() => {
                  state.locked = false;
                  bump();
                }}
              />
            ) : null}
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
          </>
        }
      />
    </div>
  );
}

const lockerInlineApp: InlineAppModule = {
  appId: 'locker',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    items: { default: itemsQuery },
    item: { default: itemQuery },
    search: { default: searchQuery },
    trash: { default: trashQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'locker',
    placeholder: 'Ask your locker…',
    intro:
      'Ask me to find a login, add a card, or generate a strong password. Writes show for your approval before they touch the vault — secrets never leave a field unless you copy or reveal them.',
    suggest: ['Find my GitHub login', 'Add a new credit card', 'Which passwords are weak?'],
  },
  Root,
};

export default lockerInlineApp;
