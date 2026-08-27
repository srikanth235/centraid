// WHAT THE ROOM IS COMPOSING — one mutable bag in a ref, in the idiom the rest
// of this product already uses (`tasks/app-root.tsx`, the #834 exemplar).
//
// WHY IT IS NOT A DOZEN `useState`s. A draft is a dozen fields that change
// together — picking a division rewrites the typed cells, picking a group
// rewrites the payer — and putting each behind its own setter would make "the
// draft changed" a dozen renders whose order nobody controls. One bag, one
// bump, one render.
//
// WHAT IS *NOT* IN THE BAG, and the rule is the app's own: **anything that
// changes WHAT IS READ stays React state.** Which group the draft names and
// which expense is open both do — they decide which payload `ledger-reads.ts`
// asks for — so they sit beside the bag rather than inside it. The revision
// list is state for the same reason: it is a read.
//
// THE BAG IS HANDED OVER AS ITS REF, not dereferenced here. The component that
// renders it does the dereference, which is where a mutable bag is read in
// every other room in this product.
//
// THE OPEN EXPENSE IS AN ID, NEVER A ROW. Stashing the `LedgerEntry` a member
// clicked would leave the detail screen standing on a copy that stopped being
// true the moment a write landed. So this holds `expenseId`, the orchestrator
// re-finds the row in the group ledger it re-read, and until that read lands
// the route renders NOTHING — absent is not empty.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { RefObject } from "react";

import type { ComposeOverlay } from "./components/ComposeSheets.tsx";
import type { ExportDraft } from "./components/Export.tsx";
import {
  newExpenseDraft,
  newSettleDraft,
  prefillEntries,
} from "./draft-model.ts";
import type { ExpenseDraft, SettleDraft } from "./draft-model.ts";
import { newLineDraft } from "./line-model.ts";
import type { LineDraft } from "./line-model.ts";
import { selectionOf } from "./receipt-model.ts";
import type { LineSelection } from "./receipt-model.ts";
import type { ShelfId } from "./shelves.ts";
import type { Division } from "./split-model.ts";
import type { HistoryData, LedgerEntry, Revision } from "./types.ts";

/** What stands over the room, or nothing. One at a time, by construction. */
export type Overlay =
  | { kind: "more" }
  | { kind: "leave"; groupId: string }
  | { kind: "archive"; groupId: string; archived: boolean }
  /** A reminder about one stale balance, before it is prepared. It ALWAYS
   *  parks, so the sheet says so before the press rather than after. */
  | {
      kind: "nudge";
      partyId: string;
      name: string;
      groupId: string | null;
      asOfMinor: number;
      note: string;
    }
  /** `refused` is the removal guard's verdict, decided BEFORE the question is
   *  put: a member who appears on the ledger is never offered a commit. */
  | { kind: "remove"; partyId: string; name: string; refused: boolean }
  | ComposeOverlay
  | null;

export interface ComposeBag {
  overlay: Overlay;
  draft: ExpenseDraft;
  /** Is the draft an edit of an expense that already exists? */
  editing: boolean;
  settle: SettleDraft;
  exportDraft: ExportDraft;
  /** The receipt allocation, as the chips currently stand. */
  selection: LineSelection;
  /** Which receipt the chips were seeded from, so a re-read of the same one
   *  does not stamp on what the member has just been moving. */
  selectionFor: string | null;
}

function makeBag(today: string): ComposeBag {
  return {
    overlay: null,
    draft: newExpenseDraft({ groupId: null, payerId: "", today, currency: "" }),
    editing: false,
    settle: newSettleDraft({ fromId: "", toId: "", groupId: null, today }),
    exportDraft: { groupId: null, range: "all", format: "csv" },
    selection: {},
    selectionFor: null,
  };
}

export interface ComposeState {
  /** The bag itself. The COMPONENT dereferences it; nothing here does. */
  bagRef: RefObject<ComposeBag>;
  /** Redraw the room after a mutation to the bag. */
  bump: () => void;
  /** The group the composing routes need loaded, so the orchestrator can ask
   *  for exactly that one read and no other. */
  groupId: string | null;
  /** Which expense the detail and receipt routes stand over. */
  expenseId: string | null;
  /** Its revisions, or `null` while that read has not landed. */
  revisions: Revision[] | null;
  patchDraft: (patch: Partial<ExpenseDraft>) => void;
  setDivision: (
    division: Division,
    amountMinor: number,
    participants: readonly string[]
  ) => void;
  setEntry: (partyId: string, text: string) => void;
  /** What one payer put down. An empty string takes them off the payer set,
   *  which is how a member goes back to one payer without a mode switch. */
  setPayer: (partyId: string, text: string) => void;
  /** Rewrite the typed lines wholesale — add, edit or take one out. */
  setLines: (lines: readonly LineDraft[]) => void;
  addLine: () => void;
  patchSettle: (patch: Partial<SettleDraft>) => void;
  patchExport: (patch: Partial<ExportDraft>) => void;
  toggleLine: (lineId: string, partyId: string) => void;
  show: (overlay: Overlay) => void;
  close: () => void;
  openAdd: (seed: {
    groupId: string | null;
    payerId: string;
    today: string;
    currency: string;
  }) => void;
  openEdit: (draft: ExpenseDraft) => void;
  openExpense: (entry: Pick<LedgerEntry, "expense_id" | "group_id">) => void;
  openSettle: (seed: {
    fromId: string;
    toId: string;
    groupId: string | null;
    today: string;
  }) => void;
  /** Seed the receipt chips from what the vault already holds — once per
   *  receipt, so a re-read never stamps on a member's own moves. */
  seedSelection: (entry: LedgerEntry) => void;
}

/**
 * The composing bag, its setters, and the read that belongs to ONE open
 * expense: its revision list.
 *
 * That read lives here rather than in `ledger-reads.ts` because it is not the
 * room's spine — nothing outside the expense route wants it, and re-reading a
 * hundred revisions on every change to the ledger would be a read nobody
 * asked for.
 */
export function useComposeState(seed: { today: string }): ComposeState {
  const [, bumpState] = useReducer((n: number) => n + 1, 0);
  const bagRef = useRef<ComposeBag>(makeBag(seed.today));
  const bump = useCallback(() => bumpState(), []);

  const [groupId, setGroupId] = useState<string | null>(null);
  const [expenseId, setExpenseId] = useState<string | null>(null);
  // The revision list AND the expense it belongs to, as one value. Two states
  // would let a render catch the rows of the expense a member has just left
  // standing under the name of the one they just opened.
  const [history, setHistory] = useState<{
    forExpense: string;
    rows: Revision[] | null;
  } | null>(null);

  const patchDraft = useCallback(
    (patch: Partial<ExpenseDraft>) => {
      const bag = bagRef.current;
      bag.draft = { ...bag.draft, ...patch };
      if (patch.groupId !== undefined) setGroupId(patch.groupId);
      bump();
    },
    [bump]
  );

  /** Choosing a division REWRITES the typed cells, because the cells' unit
   *  changed: percentages left standing as pence would be a table that read as
   *  itself and meant something else. */
  const setDivision = useCallback(
    (
      division: Division,
      amountMinor: number,
      participants: readonly string[]
    ) => {
      const bag = bagRef.current;
      bag.draft = {
        ...bag.draft,
        division,
        entries: prefillEntries(
          division,
          amountMinor,
          participants,
          bag.draft.payerId
        ),
        // A By-line table opens with one empty line: a table with no rows is a
        // control with nothing to press.
        lines:
          division === "lines" && bag.draft.lines.length === 0
            ? [newLineDraft()]
            : bag.draft.lines,
      };
      bump();
    },
    [bump]
  );

  const setEntry = useCallback(
    (partyId: string, text: string) => {
      const bag = bagRef.current;
      bag.draft = {
        ...bag.draft,
        entries: { ...bag.draft.entries, [partyId]: text },
      };
      bump();
    },
    [bump]
  );

  const setPayer = useCallback(
    (partyId: string, text: string) => {
      const bag = bagRef.current;
      const payers = { ...bag.draft.payers };
      // A PAYER WHO PUT DOWN NOTHING IS NOT A PAYER. Leaving an empty cell in
      // the map would make the sum check fail on a row nobody meant to add.
      if (text.trim() === "") delete payers[partyId];
      else payers[partyId] = text;
      bag.draft = { ...bag.draft, payers };
      bump();
    },
    [bump]
  );

  const setLines = useCallback(
    (lines: readonly LineDraft[]) => {
      const bag = bagRef.current;
      bag.draft = { ...bag.draft, lines: [...lines] };
      bump();
    },
    [bump]
  );

  const addLine = useCallback(() => {
    const bag = bagRef.current;
    bag.draft = { ...bag.draft, lines: [...bag.draft.lines, newLineDraft()] };
    bump();
  }, [bump]);

  const patchSettle = useCallback(
    (patch: Partial<SettleDraft>) => {
      const bag = bagRef.current;
      bag.settle = { ...bag.settle, ...patch };
      if (patch.groupId !== undefined) setGroupId(patch.groupId);
      bump();
    },
    [bump]
  );

  const patchExport = useCallback(
    (patch: Partial<ExportDraft>) => {
      const bag = bagRef.current;
      bag.exportDraft = { ...bag.exportDraft, ...patch };
      bump();
    },
    [bump]
  );

  const toggleLine = useCallback(
    (lineId: string, partyId: string) => {
      const bag = bagRef.current;
      const current = bag.selection[lineId] ?? [];
      bag.selection = {
        ...bag.selection,
        [lineId]: current.includes(partyId)
          ? current.filter((id) => id !== partyId)
          : [...current, partyId],
      };
      bump();
    },
    [bump]
  );

  const show = useCallback(
    (overlay: Overlay) => {
      bagRef.current.overlay = overlay;
      bump();
    },
    [bump]
  );

  const close = useCallback(() => {
    bagRef.current.overlay = null;
    bump();
  }, [bump]);

  const openAdd = useCallback(
    (args: {
      groupId: string | null;
      payerId: string;
      today: string;
      currency: string;
    }) => {
      const bag = bagRef.current;
      bag.draft = newExpenseDraft(args);
      bag.editing = false;
      bag.overlay = null;
      setGroupId(args.groupId);
      bump();
    },
    [bump]
  );

  const openEdit = useCallback(
    (draft: ExpenseDraft) => {
      const bag = bagRef.current;
      bag.draft = draft;
      bag.editing = true;
      bag.overlay = null;
      setGroupId(draft.groupId);
      bump();
    },
    [bump]
  );

  const openExpense = useCallback(
    (entry: Pick<LedgerEntry, "expense_id" | "group_id">) => {
      bagRef.current.overlay = null;
      setGroupId(entry.group_id);
      setExpenseId(entry.expense_id);
      bump();
    },
    [bump]
  );

  const openSettle = useCallback(
    (args: {
      fromId: string;
      toId: string;
      groupId: string | null;
      today: string;
    }) => {
      const bag = bagRef.current;
      bag.settle = newSettleDraft(args);
      bag.overlay = null;
      setGroupId(args.groupId);
      bump();
    },
    [bump]
  );

  const seedSelection = useCallback(
    (entry: LedgerEntry) => {
      const bag = bagRef.current;
      if (!entry.receipt || bag.selectionFor === entry.expense_id) return;
      bag.selection = selectionOf(entry.receipt.lines);
      bag.selectionFor = entry.expense_id;
      bump();
    },
    [bump]
  );

  // THE OPEN EXPENSE'S REVISION LIST. One read, keyed by the expense — not by
  // the ledger, which changes for a hundred reasons that have nothing to do
  // with this expense's history.
  useEffect(() => {
    if (expenseId === null) return;
    let live = true;
    void (async () => {
      let data: HistoryData | null = null;
      try {
        data = await window.centraid.read<HistoryData>({
          query: "history",
          input: { expense_id: expenseId },
        });
      } catch {
        // A THROW IS NOT AN EMPTY HISTORY. `null` keeps the section absent
        // rather than claiming this expense was never edited.
        data = null;
      }
      if (live)
        setHistory({
          forExpense: expenseId,
          rows: data?.revisions ?? null,
        });
    })();
    return () => {
      live = false;
    };
  }, [expenseId]);

  return {
    bagRef,
    bump,
    groupId,
    expenseId,
    // A list that belongs to another expense is ABSENT here, not shown under
    // this one's name.
    revisions:
      history && history.forExpense === expenseId ? history.rows : null,
    patchDraft,
    setDivision,
    setEntry,
    setPayer,
    setLines,
    addLine,
    patchSettle,
    patchExport,
    toggleLine,
    show,
    close,
    openAdd,
    openEdit,
    openExpense,
    openSettle,
    seedSelection,
  };
}

/**
 * An authed `blob:` URL for the receipt photograph, or `null`.
 *
 * The shell's document origin is not the gateway — the installable PWA rides
 * the iroh tunnel and desktop runs from `file://` — so a relative `src` on a
 * `/_vault/blobs/…` path resolves nowhere and carries no credential. A host
 * without the door draws the placeholder rather than a broken image box.
 *
 * ONE MINT PER PATH, keyed by the path it was minted for, so a re-render never
 * asks for a second one and a stale URL is never shown beside a new receipt.
 */
export function useReceiptShot(
  contentUri: string | undefined,
  shelf: ShelfId,
  receiptShelf: ShelfId
): string | null {
  const [minted, setMinted] = useState<{ path: string; url: string } | null>(
    null
  );
  const wanted = shelf === receiptShelf ? (contentUri ?? null) : null;

  useEffect(() => {
    if (wanted === null) return;
    let live = true;
    void (async () => {
      let url: string | null = null;
      try {
        url = (await window.centraid.blobUrl?.(wanted)) ?? null;
      } catch {
        url = null;
      }
      if (live && url !== null) setMinted({ path: wanted, url });
    })();
    return () => {
      live = false;
    };
  }, [wanted]);

  return minted && minted.path === wanted ? minted.url : null;
}
