// governance: allow-repo-hygiene file-size-limit — Locker's authentication,
// inactivity/background erasure, and mutable UI state form one React lifecycle;
// splitting those invariants across owners would make secret cleanup fail-open.
// Locker — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. The shell's InlineAppModule
// descriptor imports `Root` and `CHANGE_TABLES` from here and adds the query
// wiring; there is deliberately no parallel served-system-app entry.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { LockerDetail } from "./components/Detail.tsx";
import { EditModal } from "./components/EditModal.tsx";
import { Generator } from "./components/Generator.tsx";
import { LockerList } from "./components/List.tsx";
import { LockScreen } from "./components/LockScreen.tsx";
import { LockerSidebar } from "./components/Sidebar.tsx";
import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
} from "./kit.ts";
import {
  clearSecretClipboard,
  copy,
  createLogic,
  catCounts,
  currentPool,
  listTitle,
  sidebarCounts,
  sidebarTags,
} from "./logic.ts";
import type {
  AppData,
  AppState,
  LockerDetail as DetailItem,
  LockerRow,
} from "./types.ts";

// Vault entities this app's queries read — the doorbell filter re-derives only
// when a change names one of these (or names none, i.e. "this app acted").
export const CHANGE_TABLES = [
  "locker.item",
  "core.tag",
  "core.concept",
  "core.concept_scheme",
];

// The detail pane already holds the full (secret-bearing) item — reuse it so
// edit never re-fetches. Map only the action-key fields into the form. Verbatim
// from app.tsx.
const EDIT_FIELD_KEYS = [
  "username",
  "password",
  "url",
  "otp_seed",
  "notes",
  "cardholder",
  "card_number",
  "expiry",
  "cvv",
  "brand",
  "content",
  "fullname",
  "email",
  "phone",
  "address",
  "network",
] as const;
type EditKey = (typeof EDIT_FIELD_KEYS)[number];

function makeState(): AppState {
  return {
    nav: { kind: "all" },
    selectedId: null,
    detail: null,
    detailLoading: false,
    reveal: {},
    search: "",
    searchResults: null,
    narrow: false,
    sideOpen: false,
    showList: true,
    locked: true,
    authConfigured: null,
    authSession: null,
    authBusy: false,
    authError: "",
    revealItemId: null,
    reauthOpen: false,
    gen: false,
    genLen: 20,
    genNum: true,
    genSym: true,
    genValue: "",
    genApply: null,
    edit: null,
    trashRows: [],
    watch: { compromised: 0, weak: 0, reused: 0, items: [] },
    denied: false,
    readFailedShown: false,
  };
}

/**
 * Erase every secret-bearing or secret-derived client value when the gateway
 * says the session is no longer valid. Keeping this outside the component lets
 * the refresh-expiry path and the explicit lock path share the same invariant.
 */
function wipeSecretState(state: AppState, data: AppData): void {
  state.locked = true;
  state.authSession = null;
  state.authBusy = false;
  state.authError = "";
  state.revealItemId = null;
  state.reauthOpen = false;
  state.selectedId = null;
  state.detail = null;
  state.detailLoading = false;
  state.reveal = {};
  state.edit = null;
  state.gen = false;
  state.genValue = "";
  state.genApply = null;
  state.search = "";
  state.searchResults = null;
  state.trashRows = [];
  state.watch = { compromised: 0, weak: 0, reused: 0, items: [] };
  data.items = [];
  data.truncated = false;
  clearSecretClipboard();
}

interface ItemsPayload {
  items?: LockerRow[];
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string };
  watchtower?: {
    compromised?: number;
    weak?: number;
    reused?: number;
    items?: LockerRow[];
  };
  authRequired?: boolean;
  configured?: boolean;
}

interface AuthPayload {
  ok: boolean;
  configured: boolean;
  authenticated?: boolean;
  sessionToken?: string;
  itemToken?: string;
  expiresAt?: string;
  retryAfterMs?: number;
  code?: string;
  message?: string;
}

export function Root({ rootRef }: InlineAppProps): ReactNode {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [loaded, setLoaded] = useState(false);
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
    if (!state.authSession || state.locked) return;
    let next: ItemsPayload;
    try {
      next = await window.centraid.read<ItemsPayload>({
        query: "items",
        input: { limit: 300, auth_session: state.authSession },
      });
    } catch {
      readFailed(document.querySelector<HTMLElement>("#noticeBanner"));
      state.readFailedShown = true;
      setLoaded(true);
      return;
    }
    if (next.authRequired) {
      state.authConfigured = next.configured ?? state.authConfigured;
      wipeSecretState(state, data);
      setLoaded(true);
      bump();
      return;
    }
    if (state.readFailedShown) {
      state.readFailedShown = false;
      logic.notice("");
    }
    if (next?.vaultDenied) {
      logic.applyDenied(next.vaultDenied);
      setLoaded(true);
      return;
    }
    state.denied = false;
    const consent = document.querySelector("#consentBanner");
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
      .read<{ items?: AppData["items"]; vaultDenied?: unknown }>({
        query: "trash",
      })
      .then((r) => {
        if (r && !r.vaultDenied) state.trashRows = r.items ?? [];
      })
      .catch((error: unknown) => {
        // Trash is advisory UI; a failed pull must not leave the unlock
        // surface looking successful with a stale list — surface in console.
        console.warn(
          "locker trash refresh failed",
          error instanceof Error ? error.message : error
        );
      });

    // Drop a selection whose item vanished (unless it now lives in trash).
    if (
      state.selectedId &&
      !data.items.some((i) => i.item_id === state.selectedId) &&
      !state.trashRows.some((i) => i.item_id === state.selectedId)
    ) {
      state.selectedId = null;
      state.detail = null;
    }
    setLoaded(true);
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

  const clearSecretState = useCallback(() => {
    wipeSecretState(stateRef.current, dataRef.current);
    bump();
  }, []);

  const authenticate = useCallback(
    async (input: Record<string, unknown>): Promise<AuthPayload> =>
      window.centraid.read<AuthPayload>({ query: "auth", input }),
    []
  );

  const lockNow = useCallback(
    (notifyHost = true) => {
      const sessionToken = stateRef.current.authSession;
      clearSecretState();
      if (notifyHost && sessionToken) {
        void authenticate({
          operation: "lock",
          sessionToken,
        }).catch((error: unknown) => {
          // Host-side lock is security-relevant; never swallow silently.
          console.warn(
            "locker host lock failed",
            error instanceof Error ? error.message : error
          );
        });
      }
    },
    [authenticate, clearSecretState]
  );

  const submitUnlock = useCallback(
    async (secret: string) => {
      const state = stateRef.current;
      state.authBusy = true;
      state.authError = "";
      bump();
      let result: AuthPayload;
      try {
        result = await authenticate({
          operation: state.authConfigured === false ? "configure" : "unlock",
          secret,
        });
      } catch {
        result = {
          ok: false,
          configured: state.authConfigured ?? false,
          message: "Locker authentication needs an online gateway.",
        };
      }
      state.authBusy = false;
      state.authConfigured = result.configured;
      if (!result.ok || !result.sessionToken) {
        state.authError =
          result.message ??
          (result.retryAfterMs
            ? `Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.`
            : "The passphrase was not accepted.");
        bump();
        return;
      }
      state.authSession = result.sessionToken;
      state.locked = false;
      state.authError = "";
      setLoaded(false);
      bump();
      await refresh();
    },
    [authenticate, refresh]
  );

  const submitItemAuthorization = useCallback(
    async (secret: string) => {
      const state = stateRef.current;
      const itemId = state.revealItemId;
      const sessionToken = state.authSession;
      if (!itemId || !sessionToken) {
        lockNow();
        return;
      }
      state.authBusy = true;
      state.authError = "";
      bump();
      let result: AuthPayload;
      try {
        result = await authenticate({
          operation: "authorize-item",
          sessionToken,
          secret,
          itemId,
        });
      } catch {
        result = {
          ok: false,
          configured: true,
          message: "Re-authentication needs an online gateway.",
        };
      }
      state.authBusy = false;
      if (result.code === "SESSION_EXPIRED") {
        lockNow(false);
        return;
      }
      if (!result.ok || !result.itemToken) {
        state.authError =
          result.message ??
          (result.retryAfterMs
            ? `Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.`
            : "The passphrase was not accepted.");
        bump();
        return;
      }
      state.revealItemId = null;
      state.reauthOpen = false;
      state.authError = "";
      bump();
      await logicRef.current!.selectItem(
        itemId,
        sessionToken,
        result.itemToken
      );
    },
    [authenticate, lockNow]
  );

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef]
  );

  // ---- Edit / new / lock plumbing (verbatim from app.tsx, render → bump) ----
  const openNew = useCallback(() => {
    const state = stateRef.current;
    state.edit = {
      mode: "new",
      type: "login",
      title: "",
      fields: {},
      tags: "",
      alias: "",
      urlMatchPolicy: "registrable-domain",
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
      mode: "edit",
      id: sel.item_id,
      type: sel.type,
      title: sel.title,
      fields,
      tags: (sel.tags || []).join(", "),
      alias: sel.alias || "",
      urlMatchPolicy:
        sel.url_match_policy === "exact-host"
          ? "exact-host"
          : "registrable-domain",
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
      if (outcome?.status === "executed") {
        stateRef.current.edit = null;
        bump();
      }
    },
    []
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
      const state = stateRef.current;
      const target = e.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (
        e.key === "/" &&
        !editing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !state.locked
      ) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("#lockerSearchInput")?.focus();
        return;
      }
      if (
        e.key.toLowerCase() === "n" &&
        !editing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !state.locked &&
        !state.edit &&
        !state.gen
      ) {
        e.preventDefault();
        openNew();
        return;
      }
      if (e.key !== "Escape") return;
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
    window.addEventListener("keydown", onKey);
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
    void authenticate({ operation: "status" })
      .then((status) => {
        const state = stateRef.current;
        state.authConfigured = status.configured;
        // `status` normally receives no token and therefore boots locked.
        // A host may resume an already user-present in-memory session (the
        // local app-boot harness exercises this path); persisted tokens can
        // never do so because the gateway forgets them on restart.
        state.locked = !(status.authenticated && status.sessionToken);
        state.authSession =
          status.authenticated && status.sessionToken
            ? status.sessionToken
            : null;
        state.authError = status.ok
          ? ""
          : (status.message ?? "Locker authentication is unavailable.");
        bump();
        if (!state.locked) void refresh();
      })
      .catch(() => {
        const state = stateRef.current;
        state.authConfigured = null;
        state.authError = "Locker authentication needs an online gateway.";
        bump();
      });
    return () => {
      window.removeEventListener("keydown", onKey);
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, [authenticate, closeEdit, refresh]);

  // A live Locker session lasts at most five inactive minutes. Any background
  // transition locks immediately; foreground interaction only resets the
  // local timer while a host session exists.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      const state = stateRef.current;
      if (!state.locked && state.authSession) {
        timer = setTimeout(() => lockNow(), 5 * 60 * 1000);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") lockNow();
      else arm();
    };
    window.addEventListener("pointerdown", arm, { passive: true });
    window.addEventListener("keydown", arm);
    document.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [lockNow]);

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
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Chrome
        narrow={state.narrow}
        loading={!state.locked && !loaded}
        sideOpen={state.sideOpen}
        showList={state.showList}
        denied={state.denied}
        locked={state.locked || state.reauthOpen}
        ready={ready}
        sidebar={
          <LockerSidebar
            counts={sidebarCounts(data, state)}
            catCounts={catCounts(data)}
            tags={sidebarTags(data)}
            trashCount={state.trashRows.length}
            nav={state.nav}
            onNav={(nav) => logic.setNav(nav)}
            onNewItem={openNew}
            onCloseSide={() => {
              state.sideOpen = false;
              bump();
            }}
            onLock={() => lockNow()}
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
            onSelect={(id) => {
              state.revealItemId = id;
              state.reauthOpen = true;
              state.authError = "";
              bump();
            }}
            onSearchInput={(value) => {
              state.search = value;
              bump();
              logic.applySearchInput(value);
            }}
            onClearSearch={() => logic.clearSearch()}
            onNewItem={openNew}
          />
        }
        detail={
          <LockerDetail
            mode={
              state.nav.kind === "watch"
                ? "watch"
                : state.selectedId && (state.detail || state.detailLoading)
                  ? "item"
                  : "empty"
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
            onSelect={(id) => {
              state.revealItemId = id;
              state.reauthOpen = true;
              state.authError = "";
              bump();
            }}
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
                configured={state.authConfigured}
                busy={state.authBusy}
                error={state.authError}
                onSubmit={submitUnlock}
              />
            ) : null}
            {!state.locked && state.reauthOpen ? (
              <LockScreen
                mode="item"
                configured={true}
                busy={state.authBusy}
                error={state.authError}
                onSubmit={submitItemAuthorization}
                onCancel={() => {
                  state.revealItemId = null;
                  state.reauthOpen = false;
                  state.authError = "";
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
                  copy(state.genValue, "Password", true);
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
