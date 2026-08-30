// governance: allow-repo-hygiene file-size-limit — Locker's authentication, its inactivity and background erasure, and the mutable UI state around them are ONE lifecycle (#872); splitting those invariants across owners is how secret cleanup comes to fail open.
// Locker — the sealed room, query-free React tree (rebuilt for #872). Holds
// `Root` plus everything it needs that does NOT depend on the node-side
// `./queries/*` handler modules; `app-inline.tsx` pairs it with those.
//
// THE STATE IDIOM IS DOCS' AND TASKS': a mutable bag in a ref plus a bump
// reducer. Here it earns itself twice over. Once for the usual reason — one
// tree, thirteen routes, one read — and once for a reason only this app has:
// THE SECRET-BEARING SLICE OF THAT BAG IS `SecretBag` (session.ts), which
// nothing serialises, nothing logs and nothing writes to a durable store, and
// which `wipeSecretState` empties as a unit. Put a revealed password in a
// `useState` and it becomes a value React may retain across a suspended
// render; put it in the bag and its whole lifetime is one enumerated wipe.
//
// EVERY FRAME CONTRIBUTION COMES FROM AN EFFECT. The bar and the band render
// ABOVE this app, so contributing during render would be updating a component
// that is already painting.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
} from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { MoreSheet } from "../_shared/MoreSheet.tsx";
import { libraryReachability } from "../_shared/view-state-kit.ts";
import { useVisibleInterval } from "../_shared/visible-interval.ts";
import type { InlineAppProps } from "../inline-types.ts";
import { WINDOW_MAX, WINDOW_STEP, makeBag } from "./bag.ts";
import type { Bag } from "./bag.ts";
import { Chrome } from "./Chrome.tsx";
import { copyMetadata, copySecret } from "./clipboard.ts";
import { ItemScreen } from "./components/Item.tsx";
import { Lenses } from "./components/Lenses.tsx";
import { LockerList } from "./components/List.tsx";
import { Lock } from "./components/Lock.tsx";
import { Confirm, PermitGate } from "./components/PermitGate.tsx";
import { Rail } from "./components/Rail.tsx";
import { Screens, isRoutedScreen } from "./components/Screens.tsx";
import { DeniedGate, Notices } from "./components/States.tsx";
import { PASSKEY_KEY_FIELD, sidecarAskOf } from "./field-model.ts";
import {
  OPEN_ITEM,
  clockAt,
  isConflicted,
  isParked,
  isQueued,
  primarySealedField,
  rowsFor,
  typeCounts,
} from "./format.ts";
import { appBar, bandClaim } from "./frame.tsx";
import { generate } from "./gen-model.ts";
import { isRevealExpired, permitFromAuth, spend } from "./permits.ts";
import type { PermitRequest, SidecarTarget } from "./permits.ts";
import { useRouteActs } from "./route-acts.ts";
import {
  EXPORT_CONFIRM_LABEL,
  EXPORT_CONFIRM_TITLE,
  MORE_CLOSE,
  MORE_FOOT,
  MORE_TITLE,
  PURGE_CONFIRM_LABEL,
  PURGE_CONFIRM_TITLE,
  SURFACE_META,
  SURFACE_TITLE,
} from "./route-copy.ts";
import {
  SESSION_IDLE_MS,
  afterStatus,
  emptySidecarDraft,
  afterUnlock,
  bootSession,
  isOpen,
  lock,
  locksOnVisibility,
  wipeSecretState,
} from "./session.ts";
import type { SessionState } from "./session.ts";
import {
  ACCESS,
  EDIT,
  EXPORT,
  GEN,
  IMPORT,
  ITEM,
  MORE_SHELVES,
  TRASH,
  backRow,
  gatedShelf,
  railShelf,
  shelfFromSegment,
  showsItems,
  showsRail,
  suppressesNavigation,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { importDoorPresent, useSurfaceActs } from "./surface-acts.ts";
import type {
  AuthPayload,
  ItemsPayload,
  LockerDetail,
  LockerRow,
} from "./types.ts";
import {
  CONFLICT_COMPARE_BODY,
  EXPORT_LEDE,
  FIELD_LABEL,
  ITEMS_STATUS,
  OFFLINE_WHY_BODY,
  PURGE_PARKED_BODY,
  RESTORED,
  ROUTE_STATUS,
  STARRED,
  TRASHED,
  TRASH_CONFIRM_BODY,
  UNSTARRED,
} from "./view-copy.ts";
import { restoreWrite, starWrite, trashWrite } from "./writes.ts";

/** The doorbell filter: the vault entities this app's queries read. */
export const CHANGE_TABLES = [
  "locker.item",
  "core.tag",
  "core.concept",
  "core.concept_scheme",
];

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [shelf, setShelf] = useState<ShelfId>(null);
  const [narrow, setNarrow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [readFailedState, setReadFailedState] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // One clock for the whole room, ticking once a second while something is
  // revealed. A permit's countdown and the note under it must not straddle a
  // second and disagree about how long is left.
  const [now, setNow] = useState(() => Date.now());

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const bagRef = useRef<Bag>(makeBag());
  const sessionRef = useRef<SessionState>(bootSession());

  const bag = bagRef.current;
  const session = sessionRef.current;

  /**
   * THE ONE DOOR through which the session changes. The token has two readers
   * — the state machine, which needs it to describe itself, and the bag, whose
   * enumerated wipe is what guarantees it is erased — so it is written to both
   * here and nowhere else.
   */
  const applySession = useCallback((next: SessionState): void => {
    sessionRef.current = next;
    bagRef.current.sessionToken = next.token;
  }, []);

  /** A refusal, in the host's words, on the gate that asked for it. Goes
   *  through the same door so the token and the session can never come apart
   *  by way of a convenience setter. */
  const setSessionError = useCallback(
    (text: string): void => {
      applySession({ ...sessionRef.current, error: text });
    },
    [applySession]
  );

  const ask = useCallback(
    (input: Record<string, unknown>): Promise<AuthPayload> =>
      window.centraid.read<AuthPayload>({ query: "auth", input }),
    []
  );

  /**
   * THE ONE DOOR OUT. Every path that ends a session runs through here — the
   * idle timer, the hidden window, an `authRequired` read and a
   * `SESSION_EXPIRED` permit — so the client wipe and the HOST lock can never
   * come apart. A client that forgot only its own copy would leave a live
   * session on the gateway, which is the worst possible half of a lock.
   *
   * `notifyHost` is false only where the host is the one telling US the session
   * is gone; asking it to lock a session it has already dropped is noise.
   */
  const relock = useCallback(
    (notifyHost = true): void => {
      const token = bagRef.current.sessionToken;
      applySession(lock(sessionRef.current));
      wipeSecretState(bagRef.current);
      bagRef.current.items = [];
      bagRef.current.truncated = false;
      bagRef.current.openItemId = null;
      bagRef.current.reauthExpired = false;
      bagRef.current.lastMatchedAt = null;
      // The search's own four-state scaffold goes back to resting with the
      // term the wipe just took: a "no matches" panel standing over a query
      // nobody can see any more is a claim about a search that is gone.
      bagRef.current.searchStatus = "resting";
      bagRef.current.editError = "";
      setLoaded(false);
      setShelf(null);
      bump();
      if (notifyHost && token) {
        void ask({ operation: "lock", sessionToken: token }).catch(() => {
          // The client copy is already gone, which is the half this seat
          // controls. A host that could not be reached will expire the session
          // on its own five-minute clock.
        });
      }
    },
    [applySession, ask]
  );

  // ---- the read -------------------------------------------------------------

  const refresh = useCallback(async (): Promise<void> => {
    const token = bagRef.current.sessionToken;
    if (!isOpen(sessionRef.current) || !token) return;
    let next: ItemsPayload;
    // THE ARCHIVED SHELF IS A DIFFERENT READ, not a client-side slice:
    // archived items are out of the default window by construction, so a
    // filter over rows that were never fetched would draw an empty shelf over
    // a full one.
    const archived = bagRef.current.filter.kind === "archived";
    try {
      next = await window.centraid.read<ItemsPayload>({
        query: "items",
        input: {
          limit: bagRef.current.windowSize,
          auth_session: token,
          ...(archived ? { archived: true } : {}),
        },
      });
    } catch {
      setReadFailedState(true);
      setLoaded(true);
      return;
    }
    setReadFailedState(false);
    // The host says the session is gone: relock rather than render a list the
    // member is no longer entitled to.
    if (next?.authRequired) {
      relock(false);
      setLoaded(true);
      return;
    }
    const denied = next?.vaultDenied;
    setConsent(denied ? { message: denied.message ?? "" } : null);
    setLoaded(true);
    if (denied) {
      bagRef.current.items = [];
      bump();
      return;
    }
    bagRef.current.items = next?.items ?? [];
    bagRef.current.truncated = Boolean(next?.truncated);
    // THE HONEST DENOMINATOR. `total` is the count the vault made; it is
    // ABSENT when the count could not be read, and the foot then says what it
    // knows rather than inventing one (`format.windowEndCopy`).
    bagRef.current.total = typeof next?.total === "number" ? next.total : null;
    bagRef.current.archivedCount = next?.archivedCount ?? 0;
    bagRef.current.lastMatchedAt = new Date().toISOString();
    try {
      const trash = await window.centraid.read<{
        items?: LockerRow[];
        vaultDenied?: unknown;
      }>({ query: "trash" });
      bagRef.current.trashRows =
        trash && !trash.vaultDenied ? (trash.items ?? []) : [];
    } catch {
      // Trash is an advisory count on a rail row; a failed pull leaves it
      // unstated rather than stale.
      bagRef.current.trashRows = [];
    }
    bump();
  }, [relock]);

  /**
   * Every write goes through one door, so every outcome lands on the ONE
   * status line and every failure is narrated rather than swallowed.
   *
   * The outcome's text may be a FUNCTION OF THE SETTLED STATUS, because some
   * of this app's writes settle two different ways and the member is owed the
   * true one: a purge asked for on a device that is not the owner's parks, and
   * saying "purged" over a park would be the app appearing to have done
   * something it has not (README-Locker §4, "Parked").
   */
  const act = useCallback(
    async (
      write: {
        action: string;
        input: Record<string, unknown>;
        onlineOnly?: true;
      },
      outcome: {
        text: string | ((status: string) => string);
        undo?: () => void;
      }
    ): Promise<void> => {
      let settled: VaultOutcome;
      try {
        settled = await window.centraid.write(write);
      } catch (error) {
        publishOutcome(frame, {
          text: String((error as { message?: string })?.message ?? error),
        });
        return;
      }
      const status = settled?.status ?? "executed";
      publishOutcome(frame, {
        ...outcome,
        text:
          typeof outcome.text === "function"
            ? outcome.text(status)
            : outcome.text,
      });
      await refresh();
    },
    [frame, refresh]
  );

  /** The one status line, for narrations that are not writes. */
  const publish = useCallback(
    (text: string): void => publishOutcome(frame, { text }),
    [frame]
  );

  // ---- the boundary ---------------------------------------------------------

  const submitPassphrase = useCallback(
    async (secret: string): Promise<void> => {
      setBusy(true);
      const configuring = sessionRef.current.configured === false;
      let payload: AuthPayload;
      try {
        payload = await ask({
          operation: configuring ? "configure" : "unlock",
          secret,
        });
      } catch {
        payload = { ok: false, message: "Unlocking needs the gateway." };
      }
      setBusy(false);
      applySession(afterUnlock(sessionRef.current, payload));
      bump();
      if (isOpen(sessionRef.current)) {
        setLoaded(false);
        await refresh();
      }
    },
    [applySession, ask, refresh]
  );

  /** Open the permit gate. Both `Reveal` and `Copy` land here: copying a secret
   *  without seeing it is still taking it, and costs the same permit. */
  const askPermit = useCallback(
    (request: PermitRequest): void => {
      bagRef.current.permitRequest = request;
      setSessionError("");
      bump();
    },
    [setSessionError]
  );

  /**
   * Read the one item the permit authorises. The ONLY secret-bearing read in
   * this app, and it spends the permit on its way in.
   *
   * ONE PERMIT, ONE REVEAL (#873). A `sidecar` target moves what the permit
   * buys — the sealed row hanging off the item rather than the item's own
   * columns — because the vault deletes the item token before plaintext leaves
   * it, so the two cannot both be bought with one confirmation. The plaintext
   * comes back as the return value and is never put on the detail.
   */
  const openWithPermit = useCallback(
    async (
      itemId: string,
      itemToken: string,
      sidecar?: SidecarTarget
    ): Promise<string | null> => {
      const token = bagRef.current.sessionToken;
      if (!token) return null;
      let payload: {
        item?: LockerDetail | null;
        sidecar?: { value?: string | null } | null;
        vaultDenied?: { message?: string } | null;
      };
      try {
        payload = await window.centraid.read({
          query: "item",
          input: {
            item_id: itemId,
            auth_session: token,
            item_token: itemToken,
            ...(sidecar ? { sidecar } : {}),
          },
        });
      } catch {
        publishOutcome(frame, { text: "The reveal did not go through." });
        return null;
      }
      // A denial on the ONE secret-bearing read is the app's denied state, in
      // the vault's own words — never a blank pane that reads as an item with
      // nothing in it.
      if (payload?.vaultDenied) {
        setConsent({ message: payload.vaultDenied.message ?? "" });
        return null;
      }
      bagRef.current.detail = payload?.item ?? null;
      bagRef.current.openItemId = itemId;
      bump();
      return payload?.sidecar?.value ?? null;
    },
    [frame]
  );

  const confirmPermit = useCallback(
    async (secret: string): Promise<void> => {
      const request = bagRef.current.permitRequest;
      const token = bagRef.current.sessionToken;
      if (!request || !token) return;
      setBusy(true);
      let payload: AuthPayload;
      try {
        payload = await ask({
          operation: "authorize-item",
          sessionToken: token,
          secret,
          itemId: request.itemId,
        });
      } catch {
        payload = {
          ok: false,
          message: "Re-authentication needs the gateway.",
        };
      }
      setBusy(false);
      const outcome = permitFromAuth(request, payload);
      if (outcome.kind === "relock") {
        // SESSION_EXPIRED came from the host: it has already forgotten this
        // session, so the client only has to catch up.
        relock(false);
        return;
      }
      if (outcome.kind === "refused") {
        setSessionError(outcome.message);
        bump();
        return;
      }
      bagRef.current.permit = outcome.permit;
      bagRef.current.permitRequest = null;
      bagRef.current.reauthExpired = false;
      setSessionError("");
      setShelf(ITEM);
      const fromSidecar = await openWithPermit(
        request.itemId,
        outcome.permit.token,
        request.sidecar
      );
      // ONE SHOT. The token bought exactly the read above; nothing keeps it.
      bagRef.current.permit = spend();
      // The field the member asked for is the field that opens — and only it.
      // A sidecar's plaintext came back BESIDE the item; an item column's came
      // back on it. Either way exactly one key lands in the bag.
      const detail = bagRef.current.detail as Record<string, unknown> | null;
      const value = request.sidecar ? fromSidecar : detail?.[request.field];
      if (typeof value === "string" && value.length > 0) {
        bagRef.current.revealed = { [request.field]: value };
        bagRef.current.revealedAt = { [request.field]: Date.now() };
      }
      setNow(Date.now());
      bump();
    },
    [ask, openWithPermit, relock, setSessionError]
  );

  const conceal = useCallback((field: string): void => {
    const { [field]: droppedValue, ...values } = bagRef.current.revealed;
    const { [field]: droppedAt, ...stamps } = bagRef.current.revealedAt;
    void droppedValue;
    void droppedAt;
    bagRef.current.revealed = values;
    bagRef.current.revealedAt = stamps;
    bump();
  }, []);

  /**
   * ASK FOR ONE SEALED ROW, wherever on the screen it sits. An item's own
   * column needs nothing but its name; a sealed SIDECAR row (#873) carries the
   * vault row the permit will be spent on, resolved out of the detail this pane
   * is already holding — an address, never a value. A key that names no
   * revealable row mints nothing rather than opening a gate over a permit
   * nobody could spend.
   */
  const askReveal = useCallback(
    (field: string): void => {
      const detail = bagRef.current.detail;
      if (!detail) return;
      const sidecar = sidecarAskOf(field, detail);
      if (sidecar) {
        askPermit({
          itemId: detail.item_id,
          field,
          sidecar: sidecar.target,
          label: sidecar.label,
        });
        return;
      }
      // A namespaced key that resolved to nothing names a sidecar row this
      // detail does not have. It opens no gate: a permit minted for it could
      // buy nothing, and asking for a passphrase to buy nothing is worse than
      // the control never having been pressed.
      if (field.includes(":") || field === PASSKEY_KEY_FIELD) return;
      askPermit({ itemId: detail.item_id, field });
    },
    [askPermit]
  );

  const copyRevealed = useCallback(
    (field: string): void => {
      const value = bagRef.current.revealed[field];
      if (!value) return;
      // A sidecar is named by its own row, because no static table can hold a
      // label a member typed.
      const label =
        FIELD_LABEL[field] ??
        sidecarAskOf(field, bagRef.current.detail)?.label ??
        "Value";
      void copySecret(value, label).then((outcome) =>
        publishOutcome(frame, { text: outcome.text })
      );
    },
    [frame]
  );

  const copyPlain = useCallback(
    (value: string, label: string): void => {
      void copyMetadata(value, label).then((outcome) =>
        publishOutcome(frame, { text: outcome.text })
      );
    },
    [frame]
  );

  /** Copy a secret that came from nowhere but this device — the generator's
   *  output. It arms the SAME thirty-second clipboard clock a revealed value
   *  does, and says so, because a generated password on the clipboard is a
   *  secret whether or not the vault has ever seen it. */
  const copyFreshSecret = useCallback(
    (value: string, label: string): void => {
      void copySecret(value, label).then((outcome) =>
        publishOutcome(frame, { text: outcome.text })
      );
    },
    [frame]
  );

  // ---- wiring: boot, doorbell, focus, width, the session's two clocks -------

  useEffect(() => {
    let live = true;
    void ask({ operation: "status" })
      .then((status) => {
        if (!live) return;
        applySession(afterStatus(sessionRef.current, status));
        bump();
        if (isOpen(sessionRef.current)) void refresh();
      })
      .catch(() => {
        if (!live) return;
        applySession({
          ...sessionRef.current,
          error: "Locker authentication needs the gateway.",
        });
        bump();
      });
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => void refresh());
    const stopFocus = onFocusRefresh(() => void refresh());
    return () => {
      live = false;
      stopDoorbell();
      stopFocus();
    };
  }, [applySession, ask, refresh]);

  useEffect(() => {
    const element = rootElRef.current;
    if (!element) return;
    return observeWidth(element, 720, (isNarrow: boolean) => {
      bagRef.current.narrow = isNarrow;
      setNarrow(isNarrow);
    });
  }, []);

  // FIVE MINUTES, SLIDING — and a hidden window ends it AT ONCE. Both live in
  // one effect because they are one rule; splitting them is how a lock comes
  // to happen on one path and not the other.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      const current = sessionRef.current;
      if (!isOpen(current)) return;
      sessionRef.current = { ...current, lastActivityAt: Date.now() };
      timer = setTimeout(() => relock(), SESSION_IDLE_MS);
    };
    const onVisibility = (): void => {
      if (locksOnVisibility(document.visibilityState)) relock();
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
  }, [relock]);

  // The revealed field's own second hand. It ticks ONLY while something is
  // revealed — a countdown running over a screen with nothing on it would be
  // a heartbeat this app has no reason to have — and, since #883 C4, only while
  // the document is visible. A countdown behind another window is the same
  // heartbeat with the screen switched off; the catch-up fire on return means
  // the number that comes back is the real remaining time and the expiry sweep
  // below runs against it immediately.
  const revealCount = Object.keys(bag.revealedAt).length;
  useVisibleInterval(() => setNow(Date.now()), 1000, revealCount > 0);

  // A reveal outlives neither its permit nor the member's attention: once the
  // countdown reaches zero the value leaves the bag, without being asked — and
  // the app SAYS the permit expired, so a field that concealed itself is never
  // mistaken for a field that was never open.
  useEffect(() => {
    let changed = false;
    for (const [field, at] of Object.entries(bagRef.current.revealedAt)) {
      if (!isRevealExpired(at, now)) continue;
      const { [field]: droppedValue, ...values } = bagRef.current.revealed;
      const { [field]: droppedAt, ...stamps } = bagRef.current.revealedAt;
      void droppedValue;
      void droppedAt;
      bagRef.current.revealed = values;
      bagRef.current.revealedAt = stamps;
      bagRef.current.reauthExpired = true;
      changed = true;
    }
    if (changed) bump();
  }, [now]);

  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      rootElRef.current = element;
      rootRef(element);
    },
    [rootRef]
  );

  // ---- what the room knows about itself ------------------------------------

  const reach = libraryReachability({
    hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
    readFailed: readFailedState,
  });
  const gate = {
    setup: session.phase === "setup",
    locked: session.phase === "locked" || session.phase === "unknown",
    denied: consent !== null,
    // The shell walls the viewer seat before this Root ever mounts
    // (packages/client `InlineAppRoute` + `inlineAppSeats.ts`), so this app
    // never sees it. Named anyway: the rule belongs in one table.
    refused: false,
  };
  const shut = suppressesNavigation(gate);
  const current = gatedShelf(gate, shelf);
  const rows = rowsFor(bag.items, bag.filter);
  const onDeviceWrites = bag.items.filter(isQueued).length;
  const openRow = bag.items.find((row) => row.item_id === bag.openItemId);

  /**
   * Navigation — and the one thing it must do besides change the route: A
   * REVEALED VALUE DOES NOT SURVIVE LEAVING THE SCREEN IT WAS REVEALED ON.
   * Not because the permit would still be live (it is one shot and already
   * spent), but because a value left in the bag is a value on screen the next
   * time this route paints.
   */
  const go = useCallback((next: ShelfId): void => {
    setShelf(next);
    bagRef.current.moreOpen = false;
    bagRef.current.confirm = null;
    bagRef.current.revealed = {};
    bagRef.current.revealedAt = {};
    // ARRIVING AT THE ACCESS HISTORY FROM AN OPEN ITEM NARROWS IT TO THAT
    // ITEM, and arriving from anywhere else widens it back. The narrowing is
    // captured HERE because the next two lines drop the open item, which is
    // exactly what dropping it is for — and "which item was I looking at" is
    // the question the history is being opened to answer.
    if (next === ACCESS) {
      bagRef.current.accessItemId = bagRef.current.openItemId;
      bagRef.current.accessEntries = null;
      bagRef.current.accessWindow = null;
    }
    if (next !== ITEM) {
      bagRef.current.detail = null;
      bagRef.current.openItemId = null;
    }
    // A HALF-TYPED SECRET DOES NOT SURVIVE LEAVING THE FORM, and a generated
    // string does not survive leaving the generator. Both are secrets nobody
    // has saved; a value left in the bag is a value on screen the next time
    // that route paints. The one path that carries a generated string ONTO
    // the form writes it into the seed before it calls this.
    if (next !== EDIT) {
      bagRef.current.editSeed = null;
      bagRef.current.editError = "";
      // The sidecar editors hold a half-typed sealed value and a half-pasted
      // passkey key. Both are secrets nobody has saved, and neither survives
      // leaving the form any more than the column form's own values do.
      bagRef.current.sidecarDraft = emptySidecarDraft();
    }
    if (next !== GEN) bagRef.current.generated = "";
    // The generator draws on arrival: an empty bordered container with three
    // chip rows under it is a control panel for a string nobody asked for.
    if (next === GEN && !bagRef.current.generated) {
      bagRef.current.generated = generate(bagRef.current.genOptions);
    }
    bump();
  }, []);

  /** OPENING AN ITEM, from wherever the row was found — the list, the search
   *  results, or a verdict in Review. It opens the PERMIT GATE, never the
   *  item: the gate is minted against the field THIS TYPE seals, so a card is
   *  asked for its number, a note for its body, and an identity for the read
   *  itself (a type that seals nothing still has a read to authorise). */
  const openGate = useCallback(
    (itemId: string): void => {
      const row = bagRef.current.items.find((item) => item.item_id === itemId);
      const type =
        row?.type ??
        bagRef.current.searchResults?.find((item) => item.item_id === itemId)
          ?.type;
      askPermit({ itemId, field: primarySealedField(type ?? "login") });
    },
    [askPermit]
  );

  const acts = useRouteActs({
    bagRef,
    act,
    bump,
    go,
    copySecret: copyFreshSecret,
    publish,
  });

  const surfaces = useSurfaceActs({ bagRef, bump, publish, refresh });

  // FEATURE-DETECTED ONCE, so every consumer reads the same answer and a
  // re-render cannot make the surface change its mind about what it has.
  const hasImportDoor = importDoorPresent();

  // The two surfaces with a read of their own pull it on ARRIVAL. Neither
  // rides the items doorbell: an access history is not a projection of the
  // item list, and a draft batch is not in the vault at all.
  useEffect(() => {
    if (shut) return;
    if (current === ACCESS)
      void surfaces.handleLoadAccess(bagRef.current.accessItemId);
    if (current === IMPORT) void surfaces.handleLoadBatches();
  }, [current, shut, surfaces]);

  // ---- the body -------------------------------------------------------------

  const scroll = ((): ReactNode => {
    if (gate.denied) return <DeniedGate message={consent?.message ?? ""} />;
    if (gate.setup || gate.locked) {
      return (
        <Lock
          mode={gate.setup ? "setup" : "lock"}
          busy={busy}
          error={session.error}
          onSubmit={(secret) => void submitPassphrase(secret)}
        />
      );
    }
    if (current === ITEM && bag.detail) {
      return (
        <ItemScreen
          detail={bag.detail}
          {...(openRow ? { row: openRow } : {})}
          revealed={bag.revealed}
          revealedAt={bag.revealedAt}
          now={now}
          onReveal={askReveal}
          onCopySecret={copyRevealed}
          onCopyCode={(code) => copyPlain(code, "Code")}
          onConceal={conceal}
          onCopyMetadata={copyPlain}
          onOpenAddress={(url) => window.open(url, "_blank", "noopener")}
          onStar={() => {
            const detail = bag.detail;
            if (!detail) return;
            void act(starWrite(detail.item_id, Boolean(detail.favorite)), {
              text: detail.favorite ? UNSTARRED : STARRED,
            });
          }}
          onGenerate={() => go(GEN)}
          onArchive={() => {
            const detail = bag.detail;
            if (!detail) return;
            acts.handleArchive(detail.item_id, Boolean(detail.archived));
          }}
          onDuplicate={() => {
            const detail = bag.detail;
            if (detail) acts.handleDuplicate(detail.item_id);
          }}
          onTrash={() => {
            bagRef.current.confirm = {
              kind: "trash",
              itemId: bag.detail?.item_id ?? "",
            };
            bump();
          }}
        />
      );
    }
    if (isRoutedScreen(current)) {
      return (
        <Screens
          shelf={current}
          bag={bag}
          loaded={loaded}
          offline={reach === "unreachable"}
          busy={busy}
          now={now}
          acts={acts}
          surfaces={surfaces}
          hasImportDoor={hasImportDoor}
          onOpenItem={openGate}
          onCancelEdit={() => go(null)}
        />
      );
    }
    return (
      <LockerList
        rows={rows}
        windowCount={bag.items.length}
        total={bag.total}
        loaded={loaded}
        truncated={bag.truncated}
        onOpen={openGate}
        onCopyUsername={(row) => copyPlain(row.subtitle ?? "", "Username")}
        onShowMore={() => {
          bagRef.current.windowSize = Math.min(
            bagRef.current.windowSize + WINDOW_STEP,
            WINDOW_MAX
          );
          void refresh();
        }}
        onImport={() => go(IMPORT)}
        onAdd={acts.handleNewItem}
      />
    );
  })();

  const overlays = ((): ReactNode => {
    if (bag.permitRequest) {
      const request = bag.permitRequest;
      return (
        <PermitGate
          itemTitle={
            bag.items.find((row) => row.item_id === request.itemId)?.title ?? ""
          }
          fieldLabel={request.label ?? FIELD_LABEL[request.field] ?? "Value"}
          busy={busy}
          error={session.error}
          onConfirm={(secret) => void confirmPermit(secret)}
          onCancel={() => {
            bagRef.current.permitRequest = null;
            setSessionError("");
            bump();
          }}
        />
      );
    }
    // THE EXPORT'S CONFIRM. It names the consequence — §6's lede, whole — and
    // it is destructive in the `--net` tone, because what it writes leaves the
    // vault's protection entirely.
    if (bag.exportConfirm) {
      return (
        <Confirm
          title={EXPORT_CONFIRM_TITLE}
          body={EXPORT_LEDE}
          label={EXPORT_CONFIRM_LABEL}
          destructive
          onCancel={surfaces.handleCancelExport}
          onConfirm={surfaces.handleRunExport}
        />
      );
    }
    if (bag.confirm?.kind === "purge") {
      const itemId = bag.confirm.itemId;
      // IRREVERSIBLE, AND THE CONFIRM NAMES THE CONSEQUENCE rather than asking
      // whether the member is sure. It also names what happens off-owner
      // BEFORE the act, so a park is never a surprise dressed as a success.
      return (
        <Confirm
          title={PURGE_CONFIRM_TITLE}
          body={PURGE_PARKED_BODY}
          label={PURGE_CONFIRM_LABEL}
          destructive
          onCancel={() => {
            bagRef.current.confirm = null;
            bump();
          }}
          onConfirm={() => acts.handlePurge(itemId)}
        />
      );
    }
    if (bag.confirm) {
      const itemId = bag.confirm.itemId;
      return (
        <Confirm
          title="Trash this item?"
          body={TRASH_CONFIRM_BODY}
          label="Trash"
          destructive
          onCancel={() => {
            bagRef.current.confirm = null;
            bump();
          }}
          onConfirm={() => {
            bagRef.current.confirm = null;
            bagRef.current.detail = null;
            bagRef.current.revealed = {};
            bagRef.current.revealedAt = {};
            setShelf(null);
            // Trashing is the ONE act in this app with a true reverse write,
            // which is the only reason it offers Undo.
            void act(trashWrite(itemId), {
              text: TRASHED,
              undo: () => {
                void act(restoreWrite(itemId), { text: RESTORED });
              },
            });
          }}
        />
      );
    }
    return null;
  })();

  // ---- what Locker contributes to the FRAME ---------------------------------

  const handedOff = compact || narrow;
  const barCount = shut || !showsItems(current) ? null : rows.length;
  // THE BAR'S QUIET VERB. On an item it copies the field THIS TYPE seals — and
  // it is withheld entirely on a type that seals nothing, because a `Copy` on
  // an identity would open a gate that could return no value.
  const openItem = current === ITEM ? bag.detail : null;
  const itemSecret = openItem ? primarySealedField(openItem.type) : null;
  const quietField = itemSecret === OPEN_ITEM ? null : itemSecret;
  // A ROUTE THAT IS ITSELF ONE ACT CONTRIBUTES NO VERB. `New item` over the
  // add / edit form would discard the form it sits above, and `Generate` over
  // the generator would be a button pointing at the screen it is on — so both
  // are withheld here rather than drawn and made to mean something else.
  const barIsBare =
    current === EDIT ||
    current === GEN ||
    current === EXPORT ||
    current === IMPORT;
  useEffect(() => {
    frame.setAppBar(
      appBar({
        shelf: current,
        ...(bag.detail ? { itemTitle: bag.detail.title } : {}),
        count: barCount,
        compact: handedOff,
        gated: shut,
        // `New item`, or `Edit` on an item — and on an item the seed is built
        // from the detail BEFORE the route changes, because leaving the item
        // screen drops that detail, which is exactly what it is for.
        ...(shut || barIsBare
          ? {}
          : {
              onPrimary: () =>
                current === ITEM
                  ? acts.handleEditDetail(bag.detail)
                  : acts.handleNewItem(),
            }),
        ...(shut || barIsBare || (current === ITEM && !quietField)
          ? {}
          : {
              ...(quietField ? { quietField } : {}),
              onQuiet: () =>
                openItem && quietField
                  ? askPermit({ itemId: openItem.item_id, field: quietField })
                  : go(GEN),
            }),
      })
    );
  }, [
    frame,
    current,
    barCount,
    handedOff,
    shut,
    barIsBare,
    go,
    acts,
    askPermit,
    bag.detail,
    openItem,
    quietField,
  ]);

  // THE ROUTE'S AMBIENT SENTENCE, on the ONE status line — keyed on the route
  // and the gate ALONE. A write's outcome lands on the same line, so an effect
  // that also watched the row count would wipe "Moved to trash · receipted"
  // the instant the re-read came back.
  useEffect(() => {
    const key = shut
      ? gate.setup
        ? "setup"
        : gate.denied
          ? "items"
          : "lock"
      : current === null
        ? "items"
        : String(current).replace("built-in:", "");
    frame.setStatus(ROUTE_STATUS[key] ?? ITEMS_STATUS);
  }, [frame, current, shut, gate.setup, gate.denied]);

  useEffect(() => {
    if (!handedOff || shut) {
      frame.claimBand(null);
      return;
    }
    frame.claimBand(
      bandClaim(
        railShelf(current),
        (segment) => go(shelfFromSegment(segment)),
        () => {
          bagRef.current.moreOpen = true;
          bump();
        }
      )
    );
  }, [frame, current, handedOff, shut, go]);

  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
    };
  }, [frame]);

  const back = backRow(current);

  return (
    <div
      ref={setRoot}
      data-gateway-status={reach === "unreachable" ? "down" : undefined}
      data-locker-shelf={String(current)}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Chrome
        narrow={narrow}
        loading={!shut && !loaded}
        consent={consent}
        slots={{
          rail:
            shut || narrow || !showsRail(current) ? null : (
              <Rail
                shelf={current}
                filter={bag.filter}
                rows={bag.items}
                typeCounts={typeCounts(bag.items)}
                trashCount={bag.trashRows.length}
                archivedCount={bag.archivedCount}
                onFilter={(filter) => {
                  // Crossing into or out of the archived shelf is a different
                  // READ, so it re-runs one; every other lens is a slice of
                  // the window already in hand.
                  const wasArchived = bagRef.current.filter.kind === "archived";
                  bagRef.current.filter = filter;
                  setShelf(null);
                  bump();
                  if (wasArchived !== (filter.kind === "archived")) {
                    void refresh();
                  }
                }}
                onGo={go}
              />
            ),
          // The tool row carries the back row on every route above the root,
          // and the LENSES on Items — which are the rail's own rows, so a
          // narrow surface with no rail still reaches every filter rather than
          // losing half the navigation with the column.
          toolbar:
            shut || (!back && !showsItems(current)) ? null : (
              <>
                {back ? (
                  <button
                    type="button"
                    className="kit-plain-btn kit-small"
                    onClick={() => go(back.shelf)}
                  >
                    {back.label}
                  </button>
                ) : null}
                {showsItems(current) ? (
                  <Lenses
                    filter={bag.filter}
                    onFilter={(filter) => {
                      bagRef.current.filter = filter;
                      bump();
                    }}
                  />
                ) : null}
              </>
            ),
          notices: shut ? null : (
            <Notices
              onDeviceWrites={onDeviceWrites}
              offline={reach === "unreachable"}
              onWhyOffline={() =>
                publishOutcome(frame, { text: OFFLINE_WHY_BODY })
              }
              // Offline and stale are two facts, not one said twice: the first
              // names what still works, the second names WHEN this replica
              // last matched. The second is withheld until a read has actually
              // landed — a lag time nobody measured is not a fact.
              staleAt={
                reach === "unreachable" && bag.lastMatchedAt
                  ? clockAt(bag.lastMatchedAt)
                  : null
              }
              onRefresh={() => void refresh()}
              conflict={bag.items.some(isConflicted)}
              onCompare={() =>
                publishOutcome(frame, { text: CONFLICT_COMPARE_BODY })
              }
              parked={bag.trashRows.some(isParked)}
              onReviewParked={() => {
                publishOutcome(frame, { text: PURGE_PARKED_BODY });
                go(TRASH);
              }}
              reauth={bag.reauthExpired}
            />
          ),
          scroll,
          overlays,
          moreSheet:
            bag.moreOpen && !shut ? (
              <MoreSheet
                label={MORE_TITLE}
                title={MORE_TITLE}
                rows={MORE_SHELVES.map((entry) => ({
                  key: String(entry),
                  label: SURFACE_TITLE[String(entry)] ?? String(entry),
                  ...(SURFACE_META[String(entry)] === undefined
                    ? {}
                    : { note: SURFACE_META[String(entry)] }),
                  select: () => go(entry),
                }))}
                footer={MORE_FOOT}
                closeLabel={MORE_CLOSE}
                onClose={() => {
                  bagRef.current.moreOpen = false;
                  bump();
                }}
              />
            ) : null,
        }}
      />
    </div>
  );
}
