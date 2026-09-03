import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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

export type Overlay =
  | { kind: "more" }
  | { kind: "leave"; groupId: string }
  | { kind: "archive"; groupId: string; archived: boolean }
  | {
      kind: "nudge";
      partyId: string;
      name: string;
      groupId: string | null;
      asOfMinor: number;
      note: string;
    }
  | { kind: "remove"; partyId: string; name: string; refused: boolean }
  | ComposeOverlay
  | null;

export interface ComposeBag {
  overlay: Overlay;
  draft: ExpenseDraft;
  editing: boolean;
  settle: SettleDraft;
  exportDraft: ExportDraft;
  selection: LineSelection;
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
  bagRef: RefObject<ComposeBag>;
  bump: () => void;
  groupId: string | null;
  expenseId: string | null;
  revisions: Revision[] | null;
  patchDraft: (patch: Partial<ExpenseDraft>) => void;
  setDivision: (
    division: Division,
    amountMinor: number,
    participants: readonly string[]
  ) => void;
  setEntry: (partyId: string, text: string) => void;
  setPayer: (partyId: string, text: string) => void;
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
  seedSelection: (entry: LedgerEntry) => void;
}

export function useComposeState(seed: { today: string }): ComposeState {
  const [, bumpState] = useReducer((n: number) => n + 1, 0);
  const bagRef = useRef<ComposeBag>(makeBag(seed.today));
  const bump = useCallback(() => bumpState(), []);

  const [groupId, setGroupId] = useState<string | null>(null);
  const [expenseId, setExpenseId] = useState<string | null>(null);
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

  const revisions =
    history && history.forExpense === expenseId ? history.rows : null;

  return useMemo(
    () => ({
      bagRef,
      bump,
      groupId,
      expenseId,
      revisions,
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
    }),
    [
      bagRef,
      bump,
      groupId,
      expenseId,
      revisions,
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
    ]
  );
}

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
