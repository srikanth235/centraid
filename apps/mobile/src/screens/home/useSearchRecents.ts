// Search overlay empty state: RECENTS + suggestion chips from real vault rows
// (#708; #996 wave 5, R8), following the useSpringboardTiles idiom — five
// statements over the seat, each ONE page of the window the shelf draws, and
// an order only where "newest" is the actual claim. Locker is absent: its
// items sit behind an online, session-gated RPC.

import { useMemo } from "react";

import type { ReplicaRow } from "@centraid/client/replica/native";
import type { PageQuery } from "@centraid/core/page";
import { apps } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

import { useSeatWindow } from "../../kit/hooks/useSeatPages";
import { selectSearchRecents, selectSuggestionChips } from "./search-model";
import type { RecentSourceRow } from "./search-model";

/** Per-kind read ceiling — only the newest handful survives the capped list. */
const READ_LIMIT = 20;
const RECENTS_SHOWN = 8;
// ONE line of three short terms (v4 :6012), never a wrapping rail.
const SUGGESTIONS_SHOWN = 3;

const appMetaById = new Map(apps.map((meta) => [meta.id, meta]));

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toRows(
  appMeta: AppMetaResolved | undefined,
  appId: string,
  kind: string,
  rows: readonly ReplicaRow[],
  idColumn: string,
  labelColumn: string,
  metaColumn?: string
): RecentSourceRow[] {
  return rows.flatMap((row): RecentSourceRow[] => {
    const id = str(row[idColumn]);
    const label = str(row[labelColumn]);
    if (!id || !label) return [];
    const meta = metaColumn ? str(row[metaColumn]) : undefined;
    return [
      {
        appId,
        appLabel: appMeta?.name ?? appId,
        appColor: appMeta?.color,
        appIconKey: appMeta?.iconKey ?? "Sparkle",
        kind,
        id,
        label,
        ...(meta ? { meta } : {}),
      },
    ];
  });
}

export interface SearchRecentsResult {
  recents: RecentSourceRow[];
  suggestions: string[];
}

/** The five shelves, as statements. Module constants: a statement handed to a
 *  seat hook must keep one identity across renders or the shelf re-reads. */
const RECENT_READS = {
  notes: {
    name: "phone.search.notes",
    select: "note_id, title, updated_at",
    from: "knowledge_note",
    where: "deleted_at IS NULL",
    order: { sortColumn: "updated_at", pkColumn: "note_id", descending: true },
  },
  documents: {
    name: "phone.search.documents",
    select: "document_id, title, updated_at",
    from: "core_document",
    where: "deleted_at IS NULL",
    order: {
      sortColumn: "updated_at",
      pkColumn: "document_id",
      descending: true,
    },
  },
  expenses: {
    name: "phone.search.expenses",
    select: "expense_id, description, spent_on",
    from: "tally_expense",
    where: "deleted_at IS NULL",
    order: {
      sortColumn: "spent_on",
      pkColumn: "expense_id",
      descending: true,
    },
  },
  photos: {
    name: "phone.search.photos",
    select: "asset_id, kind, captured_at",
    from: "media_asset",
    where: "deleted_at IS NULL",
    order: {
      sortColumn: "captured_at",
      pkColumn: "asset_id",
      descending: true,
    },
  },
  // Chips only: `core_party` has no edit timestamp, so people never enter
  // RECENTS, and the page orders on the key it already has.
  parties: {
    name: "phone.search.parties",
    select: "party_id, display_name",
    from: "core_party",
    order: { sortColumn: "party_id", pkColumn: "party_id", descending: false },
  },
} satisfies Record<string, PageQuery>;

export function useSearchRecents(): SearchRecentsResult {
  const notes = useSeatWindow("notes", RECENT_READS.notes, {
    entity: "knowledge.note",
    rowIdColumn: "note_id",
    limit: READ_LIMIT,
  });
  const documents = useSeatWindow("docs", RECENT_READS.documents, {
    entity: "core.document",
    rowIdColumn: "document_id",
    limit: READ_LIMIT,
  });
  const expenses = useSeatWindow("tally", RECENT_READS.expenses, {
    entity: "tally.expense",
    rowIdColumn: "expense_id",
    limit: READ_LIMIT,
  });
  const photos = useSeatWindow("photos", RECENT_READS.photos, {
    entity: "media.asset",
    rowIdColumn: "asset_id",
    limit: READ_LIMIT,
  });
  const parties = useSeatWindow("people", RECENT_READS.parties, {
    entity: "core.party",
    rowIdColumn: "party_id",
    limit: READ_LIMIT,
  });

  return useMemo(() => {
    const noteRows = toRows(
      appMetaById.get("notes"),
      "notes",
      "note",
      notes.rows,
      "note_id",
      "title",
      "updated_at"
    );
    const docRows = toRows(
      appMetaById.get("docs"),
      "docs",
      "doc",
      documents.rows,
      "document_id",
      "title",
      "updated_at"
    );
    const expenseRows = toRows(
      appMetaById.get("tally"),
      "tally",
      "expense",
      expenses.rows,
      "expense_id",
      "description",
      "spent_on"
    );
    const photoAppMeta = appMetaById.get("photos");
    const photoRows: RecentSourceRow[] = photos.rows.flatMap(
      (row): RecentSourceRow[] => {
        const id = str(row.asset_id);
        const capturedAt = str(row.captured_at);
        if (!id) return [];
        return [
          {
            appId: "photos",
            appLabel: photoAppMeta?.name ?? "Photos",
            appColor: photoAppMeta?.color,
            appIconKey: photoAppMeta?.iconKey ?? "Camera",
            kind: row.kind === "video" ? "video" : "photo",
            id,
            label: row.kind === "video" ? "Video" : "Photo",
            ...(capturedAt ? { meta: capturedAt } : {}),
          },
        ];
      }
    );

    const recents = selectSearchRecents(
      [...photoRows, ...noteRows, ...docRows, ...expenseRows],
      RECENTS_SHOWN
    );

    const personNames = parties.rows.flatMap((row) => {
      const name = str(row.display_name);
      return name ? [name] : [];
    });
    const suggestions = selectSuggestionChips(
      [
        ...noteRows.map((row) => row.label),
        ...docRows.map((row) => row.label),
        ...expenseRows.map((row) => row.label),
        ...personNames,
      ],
      SUGGESTIONS_SHOWN
    );

    return { recents, suggestions };
  }, [documents.rows, expenses.rows, notes.rows, parties.rows, photos.rows]);
}
