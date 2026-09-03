// governance: allow-repo-hygiene file-size-limit — Locker's authentication, its inactivity and background erasure, and the mutable UI state around them are ONE lifecycle (#872); splitting those invariants across owners is how secret cleanup comes to fail open.
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
  const [now, setNow] = useState(() => Date.now());

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const bagRef = useRef<Bag>(makeBag());
  const sessionRef = useRef<SessionState>(bootSession());

  const bag = bagRef.current;
  const session = sessionRef.current;

  const applySession = useCallback((next: SessionState): void => {
    sessionRef.current = next;
    bagRef.current.sessionToken = next.token;
  }, []);

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
      bagRef.current.searchStatus = "resting";
      bagRef.current.editError = "";
      setLoaded(false);
      setShelf(null);
      bump();
      if (notifyHost && token) {
        void ask({ operation: "lock", sessionToken: token }).catch(() => {});
      }
    },
    [applySession, ask]
  );

  const refresh = useCallback(async (): Promise<void> => {
    const token = bagRef.current.sessionToken;
    if (!isOpen(sessionRef.current) || !token) return;
    let next: ItemsPayload;
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
      bagRef.current.trashRows = [];
    }
    bump();
  }, [relock]);

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

  const publish = useCallback(
    (text: string): void => publishOutcome(frame, { text }),
    [frame]
  );

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

  const askPermit = useCallback(
    (request: PermitRequest): void => {
      bagRef.current.permitRequest = request;
      setSessionError("");
      bump();
    },
    [setSessionError]
  );

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
      bagRef.current.permit = spend();
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
      if (field.includes(":") || field === PASSKEY_KEY_FIELD) return;
      askPermit({ itemId: detail.item_id, field });
    },
    [askPermit]
  );

  const copyRevealed = useCallback(
    (field: string): void => {
      const value = bagRef.current.revealed[field];
      if (!value) return;
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

  const copyFreshSecret = useCallback(
    (value: string, label: string): void => {
      void copySecret(value, label).then((outcome) =>
        publishOutcome(frame, { text: outcome.text })
      );
    },
    [frame]
  );

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

  const revealCount = Object.keys(bag.revealedAt).length;
  useVisibleInterval(() => setNow(Date.now()), 1000, revealCount > 0);

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

  const reach = libraryReachability({
    hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
    readFailed: readFailedState,
  });
  const gate = {
    setup: session.phase === "setup",
    locked: session.phase === "locked" || session.phase === "unknown",
    denied: consent !== null,
    refused: false,
  };
  const shut = suppressesNavigation(gate);
  const current = gatedShelf(gate, shelf);
  const rows = rowsFor(bag.items, bag.filter);
  const onDeviceWrites = bag.items.filter(isQueued).length;
  const openRow = bag.items.find((row) => row.item_id === bag.openItemId);

  const go = useCallback((next: ShelfId): void => {
    setShelf(next);
    bagRef.current.moreOpen = false;
    bagRef.current.confirm = null;
    bagRef.current.revealed = {};
    bagRef.current.revealedAt = {};
    if (next === ACCESS) {
      bagRef.current.accessItemId = bagRef.current.openItemId;
      bagRef.current.accessEntries = null;
      bagRef.current.accessWindow = null;
    }
    if (next !== ITEM) {
      bagRef.current.detail = null;
      bagRef.current.openItemId = null;
    }
    if (next !== EDIT) {
      bagRef.current.editSeed = null;
      bagRef.current.editError = "";
      bagRef.current.sidecarDraft = emptySidecarDraft();
    }
    if (next !== GEN) bagRef.current.generated = "";
    if (next === GEN && !bagRef.current.generated) {
      bagRef.current.generated = generate(bagRef.current.genOptions);
    }
    bump();
  }, []);

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

  const hasImportDoor = importDoorPresent();

  useEffect(() => {
    if (shut) return;
    if (current === ACCESS)
      void surfaces.handleLoadAccess(bagRef.current.accessItemId);
    if (current === IMPORT) void surfaces.handleLoadBatches();
  }, [current, shut, surfaces]);

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

  const handedOff = compact || narrow;
  const barCount = shut || !showsItems(current) ? null : rows.length;
  const openItem = current === ITEM ? bag.detail : null;
  const itemSecret = openItem ? primarySealedField(openItem.type) : null;
  const quietField = itemSecret === OPEN_ITEM ? null : itemSecret;
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
