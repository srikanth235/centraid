// WHAT THE ROUTES BEYOND THE LIST DO, as one hook.
//
// The orchestrator owns the boundary — the session, the permit, the wipe — and
// it owns the ONE write door and the ONE read. This module owns the handlers
// the eight other routes hang off, so `app-root.tsx` stays the file about the
// boundary rather than growing a second job.
//
// EVERY WRITE STILL GOES THROUGH THE ONE DOOR. Nothing here calls
// `window.centraid.write`; it calls the `act` it was handed, which publishes
// every outcome — executed, queued, parked or failed — on the one status line.
// The one read here is Search's, which returns the SAME secret-free row shape
// the list draws.
//
// AND EVERY SECRET IT TOUCHES IS ALREADY IN THE BAG'S ENUMERATED HALF. The
// form's typed values are `editSeed`, the generator's output is `generated`,
// the search term and its results are `searchTerm` / `searchResults` — four of
// the fields `wipeSecretState` empties. This hook holds no state of its own.

import { useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";

import type { Bag } from "./bag.ts";
import {
  draftFrom,
  emptySeed,
  isReady,
  retype,
  seedFromDetail,
} from "./draft.ts";
import { generate } from "./gen-model.ts";
import type { GenOptions } from "./gen-model.ts";
import {
  EDIT_CREATED,
  EDIT_SAVED,
  EDIT_TITLE_MISSING,
  GEN_REGENERATED,
  GEN_SEEDED,
  PURGED,
  PURGE_PARKED,
  RESTORED_WHOLE,
} from "./route-copy.ts";
import { EDIT } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type {
  CheckKey,
  ItemDraftSeed,
  LockerDetail,
  LockerItemType,
  LockerRow,
} from "./types.ts";
import {
  addItemWrite,
  editItemWrite,
  purgeWrite,
  restoreWrite,
} from "./writes.ts";
import type { LockerWrite } from "./writes.ts";

/** How long a typed term settles before the vault is asked. Short enough that
 *  a member never waits on a keystroke, long enough that a word is one read. */
const SEARCH_SETTLE_MS = 150;

/** How the orchestrator's write door is called from here. `text` may be a
 *  function of the settled status, because a purge that PARKED and a purge
 *  that ran are two different sentences and the member is owed the true one. */
export interface ActOutcome {
  text: string | ((status: string) => string);
  undo?: () => void;
}

export interface RouteActsInput {
  bagRef: RefObject<Bag>;
  act: (write: LockerWrite, outcome: ActOutcome) => Promise<void>;
  bump: () => void;
  go: (shelf: ShelfId) => void;
  /** Copy a secret, with the sentence that says the clipboard clears itself. */
  copySecret: (value: string, label: string) => void;
  /** The ONE status line. A generator draw is not a write, and it still
   *  resolves out loud — because "nothing was saved" is the fact a member has
   *  to be able to rely on here. */
  publish: (text: string) => void;
}

export interface RouteActs {
  handleEditChange: (seed: ItemDraftSeed) => void;
  handleRetype: (type: LockerItemType) => void;
  handleSave: () => void;
  /** Open the editor over an item that is already on screen. The seed is
   *  built BEFORE the route changes, because leaving the item screen drops
   *  the detail — which is the point of dropping it. */
  handleEditDetail: (detail: LockerDetail | null) => void;
  handleNewItem: () => void;
  /** Generate a password INTO the form, without leaving it. The route of its
   *  own still exists for a member who wants a string with no item in mind. */
  handleGenerateInto: (key: string) => void;
  handleGenOptions: (options: GenOptions) => void;
  handleRegenerate: () => void;
  handleCopyGenerated: () => void;
  handlePutOnItem: () => void;
  handleQuery: (value: string) => void;
  handleClearQuery: () => void;
  handleRetrySearch: () => void;
  handleRestore: (itemId: string) => void;
  handleAskPurge: (itemId: string) => void;
  handlePurge: (itemId: string) => void;
  handleShowVerdict: (key: CheckKey) => void;
}

export function useRouteActs(input: RouteActsInput): RouteActs {
  const { bagRef, act, bump, go, copySecret, publish } = input;
  // The keystroke timer. It is TOUCHED ONLY FROM THE EVENT HANDLER below,
  // never during render — a ref read while a component is painting is a value
  // React may already have thrown away.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draw = useCallback(
    (options: GenOptions): void => {
      bagRef.current.genOptions = options;
      bagRef.current.generated = generate(options);
      publish(GEN_REGENERATED);
      bump();
    },
    [bagRef, bump, publish]
  );

  /** The one read this module makes. It answers the SAME secret-free row shape
   *  the list draws — there is no code path from here to a secret value. */
  const runSearch = useCallback(
    (term: string): void => {
      const bag = bagRef.current;
      const seq = bag.searchSeq;
      if (!term.trim()) {
        bag.searchResults = null;
        bag.searchStatus = "resting";
        bump();
        return;
      }
      void window.centraid
        .read<{ items?: LockerRow[]; vaultDenied?: unknown }>({
          query: "search",
          input: { term },
        })
        .then((payload) => {
          // A late answer never overwrites a newer term.
          if (seq !== bagRef.current.searchSeq) return;
          // A denial is not a miss: an index that refused was not read, and
          // "nothing matches" would be a claim nobody verified.
          const denied = Boolean(payload?.vaultDenied);
          bagRef.current.searchResults = denied ? null : (payload?.items ?? []);
          bagRef.current.searchStatus = denied ? "unreachable" : "ready";
          bump();
        })
        .catch(() => {
          if (seq !== bagRef.current.searchSeq) return;
          bagRef.current.searchResults = null;
          bagRef.current.searchStatus = "unreachable";
          bump();
        });
    },
    [bagRef, bump]
  );

  const handleQuery = useCallback(
    (value: string): void => {
      const bag = bagRef.current;
      bag.searchTerm = value;
      bag.searchSeq += 1;
      bag.searchStatus = value.trim() ? "searching" : "resting";
      bump();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => runSearch(value), SEARCH_SETTLE_MS);
    },
    [bagRef, bump, runSearch]
  );

  const handleSave = useCallback((): void => {
    const seed = bagRef.current.editSeed;
    if (!seed) return;
    if (!isReady(seed)) {
      bagRef.current.editError = EDIT_TITLE_MISSING;
      bump();
      return;
    }
    bagRef.current.editError = "";
    const draft = draftFrom(seed);
    const write =
      seed.mode === "edit" && seed.itemId
        ? editItemWrite({ ...draft, itemId: seed.itemId })
        : addItemWrite(draft);
    // The typed secret leaves the bag the moment the payload is built: it is
    // in flight, and a form nobody is looking at should not still be holding
    // a password.
    bagRef.current.editSeed = null;
    bagRef.current.generated = "";
    go(null);
    void act(write, { text: seed.mode === "edit" ? EDIT_SAVED : EDIT_CREATED });
  }, [act, bagRef, bump, go]);

  const handleEditChange = useCallback(
    (seed: ItemDraftSeed): void => {
      bagRef.current.editSeed = seed;
      bagRef.current.editError = "";
      bump();
    },
    [bagRef, bump]
  );

  const handleRetype = useCallback(
    (type: LockerItemType): void => {
      const seed = bagRef.current.editSeed ?? emptySeed(type);
      bagRef.current.editSeed = retype(seed, type);
      bump();
    },
    [bagRef, bump]
  );

  const handleEditDetail = useCallback(
    (detail: LockerDetail | null): void => {
      bagRef.current.editSeed = detail ? seedFromDetail(detail) : emptySeed();
      bagRef.current.editError = "";
      go(EDIT);
    },
    [bagRef, go]
  );

  const handleNewItem = useCallback((): void => {
    bagRef.current.editSeed = emptySeed();
    bagRef.current.editError = "";
    go(EDIT);
  }, [bagRef, go]);

  const handleGenerateInto = useCallback(
    (key: string): void => {
      const seed = bagRef.current.editSeed ?? emptySeed();
      bagRef.current.editSeed = {
        ...seed,
        fields: { ...seed.fields, [key]: generate(bagRef.current.genOptions) },
      };
      publish(GEN_REGENERATED);
      bump();
    },
    [bagRef, bump, publish]
  );

  const handleGenOptions = useCallback(
    (options: GenOptions): void => draw(options),
    [draw]
  );

  const handleRegenerate = useCallback((): void => {
    draw(bagRef.current.genOptions);
  }, [bagRef, draw]);

  const handleCopyGenerated = useCallback((): void => {
    const value = bagRef.current.generated;
    if (value) copySecret(value, "Password");
  }, [bagRef, copySecret]);

  const handlePutOnItem = useCallback((): void => {
    const value = bagRef.current.generated;
    const seed = bagRef.current.editSeed ?? emptySeed();
    // Seeded BEFORE the route changes, so the value travels in the one field a
    // lock already erases rather than through the route.
    bagRef.current.editSeed = {
      ...seed,
      fields: { ...seed.fields, password: value },
    };
    go(EDIT);
    bagRef.current.generated = "";
    publish(GEN_SEEDED);
    bump();
  }, [bagRef, bump, go, publish]);

  const handleClearQuery = useCallback(
    (): void => handleQuery(""),
    [handleQuery]
  );

  const handleRetrySearch = useCallback((): void => {
    handleQuery(bagRef.current.searchTerm);
  }, [bagRef, handleQuery]);

  const handleRestore = useCallback(
    (itemId: string): void => {
      void act(restoreWrite(itemId), { text: RESTORED_WHOLE });
    },
    [act]
  );

  const handleAskPurge = useCallback(
    (itemId: string): void => {
      bagRef.current.confirm = { kind: "purge", itemId };
      bump();
    },
    [bagRef, bump]
  );

  const handlePurge = useCallback(
    (itemId: string): void => {
      bagRef.current.confirm = null;
      bump();
      // No Undo: there is no reverse write for a purge, and offering one would
      // be the single worst promise this app could make.
      void act(purgeWrite(itemId), {
        text: (status) => (status === "parked" ? PURGE_PARKED : PURGED),
      });
    },
    [act, bagRef, bump]
  );

  /** The rows behind ONE verdict — the same derivation the count came from
   *  (`format.matchesCheck`), so the list can never answer a different set
   *  from the number that was pressed. */
  const handleShowVerdict = useCallback(
    (check: CheckKey): void => {
      bagRef.current.filter = { kind: "verdict", check };
      go(null);
    },
    [bagRef, go]
  );

  // ONE STABLE OBJECT. The orchestrator hands these to the frame from an
  // effect, so a bag rebuilt on every render would re-contribute the app bar
  // on every render — the shape of a loop, in the one place this app can least
  // afford one.
  return useMemo(
    () => ({
      handleEditChange,
      handleRetype,
      handleSave,
      handleEditDetail,
      handleNewItem,
      handleGenerateInto,
      handleGenOptions,
      handleRegenerate,
      handleCopyGenerated,
      handlePutOnItem,
      handleQuery,
      handleClearQuery,
      handleRetrySearch,
      handleRestore,
      handleAskPurge,
      handlePurge,
      handleShowVerdict,
    }),
    [
      handleEditChange,
      handleRetype,
      handleSave,
      handleEditDetail,
      handleNewItem,
      handleGenerateInto,
      handleGenOptions,
      handleRegenerate,
      handleCopyGenerated,
      handlePutOnItem,
      handleQuery,
      handleClearQuery,
      handleRetrySearch,
      handleRestore,
      handleAskPurge,
      handlePurge,
      handleShowVerdict,
    ]
  );
}
