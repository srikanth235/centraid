// The Search overlay's empty state — RECENTS + SUGGESTION CHIPS, both
// derived from real replica rows (issue #708, mobile close-out). No query
// typed yet is not "nothing to show": it is a chance to surface what the
// vault already holds, the same way Home's springboard does.
//
// Reads follow the useSpringboardTiles.ts idiom exactly — bounded `limit`,
// `orderBy` only where "newest" is the actual claim being made, one memoized
// request per read so `useReplicaQuery` doesn't re-fire every render:
//
//  - notes / docs: `updated_at` is edit time, read + ordered on the same way
//    the springboard's own tiles already do.
//  - tally: `spent_on` is the closest replica column to "when this was
//    captured" — the same column the springboard's tally tile filters on.
//  - photos: `captured_at` on `media.asset`, the springboard photos
//    tile's own ordering column. The asset has no title, so its recents
//    label is its kind ("Photo" / "Video") — never an invented caption.
//  - people: read only to seed suggestion chips with a real name; people
//    have no edit timestamp on this shape, so they never enter RECENTS.
//
// Locker is absent for the same reason it is absent from ./blueprint-search:
// its items have no replica shape on mobile at all.

import { useMemo } from "react";

import type { ReplicaRow } from "@centraid/client/replica/native";
import { apps } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import type { NativeReadRequest } from "../../lib/replica/native-session";
import { selectSearchRecents, selectSuggestionChips } from "./search-model";
import type { RecentSourceRow } from "./search-model";

/** Read ceiling per kind — small, because only the newest handful of each
 *  ever survives into the merged, capped RECENTS list. */
const READ_LIMIT = 20;
const RECENTS_SHOWN = 8;
// The handoff's `try` row is ONE line of three short terms (v4 .dc.html
// :6012 — `['Pemberton','right of way','Ana']`), never a wrapping rail.
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

export function useSearchRecents(): SearchRecentsResult {
  const notes = useReplicaQuery(
    "notes",
    useMemo(
      (): NativeReadRequest => ({
        entity: "knowledge.note",
        where: [{ column: "deleted_at", op: "is-null" }],
        orderBy: { column: "updated_at", dir: "desc" },
        limit: READ_LIMIT,
      }),
      []
    )
  );
  const documents = useReplicaQuery(
    "docs",
    useMemo(
      (): NativeReadRequest => ({
        entity: "core.document",
        where: [{ column: "deleted_at", op: "is-null" }],
        orderBy: { column: "updated_at", dir: "desc" },
        limit: READ_LIMIT,
      }),
      []
    )
  );
  const expenses = useReplicaQuery(
    "tally",
    useMemo(
      (): NativeReadRequest => ({
        entity: "tally.expense",
        where: [{ column: "deleted_at", op: "is-null" }],
        orderBy: { column: "spent_on", dir: "desc" },
        limit: READ_LIMIT,
      }),
      []
    )
  );
  const photos = useReplicaQuery(
    "photos",
    useMemo(
      (): NativeReadRequest => ({
        entity: "media.asset",
        where: [{ column: "deleted_at", op: "is-null" }],
        orderBy: { column: "captured_at", dir: "desc" },
        limit: READ_LIMIT,
      }),
      []
    )
  );
  // Suggestion-only: a person's name earns a chip, but `core.party` carries
  // no edit timestamp, so people never enter RECENTS. Reading `core.party`
  // directly (not `people.profile`, which has no `display_name` column —
  // see useSpringboardTiles' two-step profiles→parties join) keeps this a
  // single bounded read.
  const parties = useReplicaQuery(
    "people",
    useMemo(
      (): NativeReadRequest => ({
        entity: "core.party",
        limit: READ_LIMIT,
      }),
      []
    )
  );

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
