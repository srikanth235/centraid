// ONE share sheet (issue #726 P6, web + mobile in spirit — this is the web
// half; apps/mobile/src/kit/share/ShareSheet.tsx is the native one). A
// give/lend toggle over ONE destination list — the member's own other
// vaults and every linked person, mixed, never sorted or labelled by where a
// destination physically lives (D3).
//
// REPLACES the P0 interim "Copy to ⟨sole destination⟩" shortcut
// (`sharing.ts`'s `soleDestination`/`copyActionLabel`/`destinationBlockedReason`)
// — that shortcut only ever offered the ONE other writable scope and refused
// outright the moment a second destination (or a linked person) existed. This
// sheet is what "choosing one is not available on this device yet" was
// waiting for.
import { useEffect, useRef, useState } from "react";

import type { InlineScope } from "../inline-types.ts";
import type { PlaceableItemType } from "./placement-registry.ts";
import {
  GIVE_IRREVOCABLE_WARNING,
  lendScopeNote,
  loadShareDestinations,
  searchReachWarning,
  shareBlockedReason,
  wholeLibraryLendScope,
} from "./share-kit.ts";
import type { LendSearchReach, ShareDestination } from "./share-kit.ts";

import styles from "./ShareSheet.module.css";

export type ShareVerb = "give" | "lend";

export interface ShareSheetProps {
  open: boolean;
  onClose: () => void;
  /** The scope the shared thing (or the whole library, for a lend) lives in
   *  right now. */
  sourceScopeId: string;
  scopes: readonly InlineScope[];
  /** Which verbs this call site can honestly offer. A give needs a concrete
   *  item set (`itemIds`); a lend needs a declared entity family
   *  (`mintedIdFamilies`) — pass only what applies. */
  verbs: readonly ShareVerb[];
  /** What a GIVE copies. Ignored when `verbs` excludes `"give"`. */
  itemType?: PlaceableItemType;
  itemIds?: readonly string[];
  /** What a LEND opens a window over (`ScopeAppDeclaration.mintedIdFamilies`)
   *  and the human name the lend note uses. Ignored when `verbs` excludes
   *  `"lend"`. */
  mintedIdFamilies?: readonly string[];
  appLabel?: string;
  /**
   * Override the GIVE execution for `itemIds`, e.g. Photos' selection bar
   * routing through its own tested `copy-into-scope` batch command instead
   * of N sequential `place()` calls. Absent falls back to the generic
   * per-item `window.centraid.place()` loop below (what Lightbox's
   * single-item give, and any app with no specialized batch command, use).
   */
  giveMany?: (
    destination: ShareDestination
  ) => Promise<{ ok: boolean; message: string }>;
  onDone: (outcome: { verb: ShareVerb; ok: boolean; message: string }) => void;
}

type Stage = "pick" | "confirm" | "busy";

export function ShareSheet(props: ShareSheetProps) {
  const { open, onClose, sourceScopeId, scopes, verbs } = props;
  const [verb, setVerb] = useState<ShareVerb>(verbs[0] ?? "give");
  const [destinations, setDestinations] = useState<ShareDestination[] | null>(
    null
  );
  const [targetId, setTargetId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("pick");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // The sheet should re-fetch destinations only when it (re)opens, never on
  // every scope/verb array identity change while it's already showing — so
  // the effect below reads the LATEST props through this ref instead of
  // declaring them as dependencies. The ref is synced in its own effect
  // (never written during render) and declared first so it's current by
  // the time the open-triggered effect below runs in the same commit.
  const openInputsRef = useRef({ sourceScopeId, scopes, verbs });
  useEffect(() => {
    openInputsRef.current = { sourceScopeId, scopes, verbs };
  });

  useEffect(() => {
    if (!open) return;
    const {
      sourceScopeId: openSourceScopeId,
      scopes: openScopes,
      verbs: openVerbs,
    } = openInputsRef.current;
    setVerb(openVerbs[0] ?? "give");
    setStage("pick");
    setErrorMessage(null);
    setDestinations(null);
    setTargetId(null);
    let live = true;
    void loadShareDestinations(openSourceScopeId, openScopes)
      .then((list) => {
        if (!live) return;
        setDestinations(list);
        setTargetId(list[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setDestinations([]);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Share destinations could not be loaded."
        );
      });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    const prior =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog
      .querySelector<HTMLElement>("input, select, button:not([disabled])")
      ?.focus();
    return () => {
      if (dialog.open) dialog.close();
      prior?.focus();
    };
  }, [open]);

  if (!open) return null;

  const blocked = destinations ? shareBlockedReason(destinations) : null;
  const target = destinations?.find((d) => d.id === targetId) ?? null;
  const appLabel = props.appLabel ?? "this app";

  const runGive = async (): Promise<void> => {
    if (!target) return;
    setStage("busy");
    if (props.giveMany) {
      const outcome = await props.giveMany(target);
      props.onDone({ verb: "give", ...outcome });
      onClose();
      return;
    }
    const { itemType, itemIds } = props;
    if (!itemType || !itemIds?.length) return;
    const outcomes = await Promise.all(
      itemIds.map((itemId) =>
        window.centraid.place!({
          linkToken: crypto.randomUUID(),
          kind: "add",
          itemType,
          itemId,
          sourceVaultId: sourceScopeId,
          targetVaultId: target.id,
        })
          .then((result) => result.status === "executed")
          .catch(() => false)
      )
    );
    const failures = outcomes.filter((ok) => !ok).length;
    const count = itemIds.length;
    props.onDone({
      verb: "give",
      ok: failures === 0,
      message:
        failures === 0
          ? `Given to ${target.label}.`
          : `${count - failures} of ${count} given to ${target.label}; the rest did not land.`,
    });
    onClose();
  };

  const runLend = async (): Promise<void> => {
    if (!target || !props.mintedIdFamilies?.length) return;
    setStage("busy");
    const scopeDecl = wholeLibraryLendScope(props.mintedIdFamilies);
    try {
      const result = await window.centraid.lend!({
        linkToken: crypto.randomUUID(),
        // The lend's own item type is the ENTITY FAMILY being lent (the
        // whole library, per the file header), never the GIVE's `itemType`
        // prop — a call site can legitimately give one item type (an album,
        // say) and lend a different one (the library it lives in).
        itemType: props.mintedIdFamilies[0] as never,
        scopes: scopeDecl,
        sourceVaultId: sourceScopeId,
        targetVaultId: target.id,
      });
      const settled =
        result.status === "executed" || result.status === "established";
      // Named at MASK-SELECTION time (#726 P4 D10): the gateway's `/edges`
      // response for this lend carries `searchReach`
      // (`lend-search-reach.ts`'s `ScopeSearchReach`), threaded through the
      // client wire's `InlineLendResult` and the ambient `CentraidClient.
      // lend()` return type (both `searchReach?: LendSearchReach[]`-shaped)
      // all the way to here.
      const reach: LendSearchReach[] | undefined = result.searchReach;
      const warning = settled ? searchReachWarning(reach, target.label) : null;
      props.onDone({
        verb: "lend",
        ok: settled,
        message: settled
          ? `Lending to ${target.label}.${warning ? ` ${warning}` : ""}`
          : (result.reason ?? `Not lent to ${target.label}.`),
      });
    } catch (error) {
      props.onDone({
        verb: "lend",
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : `Not lent to ${target.label}.`,
      });
    }
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="kit-modal-back"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="kit-modal" style={{ maxWidth: "420px" }}>
        <h2>Share</h2>

        {verbs.length > 1 ? (
          <div className={`kit-seg stretch ${styles.toggle}`}>
            {verbs.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={verb === candidate ? "on" : ""}
                aria-pressed={verb === candidate}
                onClick={() => {
                  setVerb(candidate);
                  setStage("pick");
                }}
              >
                {candidate === "give" ? "Give" : "Lend"}
              </button>
            ))}
          </div>
        ) : null}

        {verb === "lend" ? (
          <p className={styles.note}>{lendScopeNote(appLabel)}</p>
        ) : null}

        {destinations === null ? (
          <p className={styles.note}>Finding places to share to…</p>
        ) : blocked ? (
          <p className={styles.note}>{blocked}</p>
        ) : (
          <select
            className={styles.destList}
            aria-label="Destination"
            size={Math.min(destinations.length, 6)}
            value={targetId ?? ""}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {destinations.map((dest) => (
              <option key={dest.id} value={dest.id} className={styles.destItem}>
                {dest.label}
              </option>
            ))}
          </select>
        )}

        {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

        {verb === "give" && stage === "confirm" ? (
          <p className={styles.warn}>{GIVE_IRREVOCABLE_WARNING}</p>
        ) : null}

        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          {verb === "give" ? (
            stage === "confirm" ? (
              <button
                type="button"
                className="kit-btn primary"
                disabled={!target}
                onClick={() => void runGive()}
              >
                Give — can’t undo
              </button>
            ) : (
              <button
                type="button"
                className="kit-btn primary"
                disabled={!target || stage === "busy"}
                onClick={() => setStage("confirm")}
              >
                Continue
              </button>
            )
          ) : (
            <button
              type="button"
              className="kit-btn primary"
              disabled={!target || stage === "busy"}
              onClick={() => void runLend()}
            >
              {stage === "busy" ? "Lending…" : "Lend"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** Re-exported so a "stop lending" control elsewhere in the app quotes the
 *  exact same wording — never "take back" (D7). */
export { STOP_LENDING_LABEL } from "./share-kit.ts";
