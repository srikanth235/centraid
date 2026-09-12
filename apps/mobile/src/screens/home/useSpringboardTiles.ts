// Per-app data plumbing for the Home springboard (#708 A; #996 wave 5, R8).
//
// Home has no grant of its own: every read goes out under the OWNING app's id,
// so a tile shows only what its app may already read offline. The statements
// themselves live in ./home-tile-reads, where they are pinned against the
// seat's own page reader. Locker issues NO read: its items sit behind an
// online, session-gated RPC. A statement handed to a seat hook must keep a
// stable identity across renders or the tile re-reads on every one: the module
// constants already do, and the three that depend on render state (the month's
// expenses, the body and party lookups) are memoized here.
//
// A TILE IS A WINDOW, so each takes `useSeatWindow` and its `truncated` IS
// `countCapped` — the fact that the library ran past the window, told by the
// page's own cursor instead of inferred from a row count that happened to
// equal the limit.

import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { formatCurrencyMinor } from "@centraid/client/capture";
import type { ReplicaRow } from "@centraid/client/replica/native";
import { occurrenceExceptionsOf } from "@centraid/core/time";

import { useSeatPages, useSeatWindow } from "../../kit/hooks/useSeatPages";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { expandEvent } from "../../kit/schedule/recurrence";
import {
  hasPinnedThumbnailPack,
  pinnedThumbnailUri,
} from "../../lib/replica/thumbnail-pack";
import {
  expenseTileRead,
  HOME_BODY_LOOKUP,
  HOME_ORDERED_TILE_READS,
  HOME_PARTY_LOOKUP,
  HOME_TILE_LIMITS,
  HOME_TILE_READS,
  idList,
} from "./home-tile-reads";
import {
  combineTileStatus,
  countUpcoming,
  monthStartDate,
  openTasks,
  selectDocRows,
  selectFaces,
  selectNextEvent,
  selectNoteExcerpt,
  selectPhotoMosaic,
  selectTaskRows,
  sumMinor,
} from "./tile-model";
import type { AgendaOccurrence, TileData } from "./tile-model";

const AGENDA_HORIZON_DAYS = 30;
const AGENDA_COUNT_DAYS = 7;

const BODY_LOOKUP_ROWS = 12;

function topIds(rows: readonly ReplicaRow[], column: string): string[] {
  const ids = new Set<string>();
  for (const row of rows.slice(0, BODY_LOOKUP_ROWS)) {
    const value = row[column];
    if (typeof value === "string" && value) ids.add(value);
  }
  return [...ids];
}

const str = (value: unknown): string => (value == null ? "" : String(value));

/** The selection logic lives in ./tile-model, where it is tested. */
export function useSpringboardTiles(): Map<string, TileData> {
  const { gatewayBase, online, vaultId } = useReplica();
  // `gatewayBase` stays cached while the tunnel is down; it is not proof the
  // bytes can be fetched, so remote-only photos wait rather than fail to load.
  const photoGatewayBase = online ? gatewayBase : undefined;
  // One clock reading per visit: reading the clock in a render body is impure,
  // and a ticker would re-render the springboard while nobody is looking.
  const [now, setNow] = useState(new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, [])
  );

  const photos = useSeatWindow("photos", HOME_ORDERED_TILE_READS.photos, {
    entity: "media.asset",
    rowIdColumn: "asset_id",
    limit: HOME_TILE_LIMITS.photos,
  });

  const documents = useSeatWindow("docs", HOME_ORDERED_TILE_READS.documents, {
    entity: "core.document",
    rowIdColumn: "document_id",
    limit: HOME_TILE_LIMITS.documents,
  });
  const docBodyIds = useMemo(
    () => topIds(documents.rows, "current_content_id"),
    [documents.rows]
  );
  const docContents = useSeatPages(
    "docs",
    useMemo(() => idList(HOME_BODY_LOOKUP, docBodyIds), [docBodyIds]),
    { entity: "core.content_item", rowIdColumn: "content_id" }
  );

  const notes = useSeatWindow("notes", HOME_ORDERED_TILE_READS.notes, {
    entity: "knowledge.note",
    rowIdColumn: "note_id",
    limit: HOME_TILE_LIMITS.notes,
  });
  const noteBodyIds = useMemo(
    () => topIds(notes.rows, "body_content_id"),
    [notes.rows]
  );
  const noteContents = useSeatPages(
    "notes",
    useMemo(() => idList(HOME_BODY_LOOKUP, noteBodyIds), [noteBodyIds]),
    { entity: "core.content_item", rowIdColumn: "content_id" }
  );

  const events = useSeatWindow("agenda", HOME_TILE_READS.events, {
    entity: "core.event",
    rowIdColumn: "event_id",
    limit: HOME_TILE_LIMITS.events,
  });
  const exceptions = useSeatWindow("agenda", HOME_TILE_READS.exceptions, {
    entity: "schedule.recurrence_exception",
    rowIdColumn: "exception_id",
    limit: HOME_TILE_LIMITS.exceptions,
  });

  const profiles = useSeatWindow("people", HOME_TILE_READS.profiles, {
    entity: "people.profile",
    rowIdColumn: "profile_id",
    limit: HOME_TILE_LIMITS.profiles,
  });
  const partyIds = useMemo(
    () => topIds(profiles.rows, "party_id"),
    [profiles.rows]
  );
  const parties = useSeatPages(
    "people",
    useMemo(() => idList(HOME_PARTY_LOOKUP, partyIds), [partyIds]),
    { entity: "core.party", rowIdColumn: "party_id" }
  );

  const tasks = useSeatWindow("tasks", HOME_TILE_READS.tasks, {
    entity: "schedule.task",
    rowIdColumn: "task_id",
    limit: HOME_TILE_LIMITS.tasks,
  });

  const monthStart = monthStartDate(now);
  const expenses = useSeatWindow(
    "tally",
    useMemo(() => expenseTileRead(monthStart), [monthStart]),
    {
      entity: "tally.expense",
      rowIdColumn: "expense_id",
      limit: HOME_TILE_LIMITS.expenses,
    }
  );
  const vault = useSeatWindow("tally", HOME_TILE_READS.vault, {
    entity: "core.vault",
    rowIdColumn: "vault_id",
    limit: HOME_TILE_LIMITS.vaults,
  });

  return useMemo(() => {
    const tiles = new Map<string, TileData>();

    // THE SEAT'S OWN VAULT IS THE SCOPE. A page row is the table's columns, so
    // it carries no `__centraidScopeId`; a seat holds ONE file, and that file's
    // vault is the scope every blob address on this tile belongs to. Without
    // it the address is built on an empty scope and no thumbnail resolves.
    const mosaic = selectPhotoMosaic(
      photos.rows,
      photoGatewayBase,
      pinnedThumbnailUri,
      vaultId ?? ""
    );
    tiles.set("photos", {
      appId: "photos",
      status: combineTileStatus([photos], mosaic.length > 0),
      count: photos.rows.length,
      countCapped: photos.truncated === true,
      countLabel: "photos",
      body: {
        kind: "photos",
        photos: mosaic,
        // R16 (#1014): the waiting copy is only honest about "the gateway" when
        // this phone holds no pinned pack for the vault.
        offlinePack: hasPinnedThumbnailPack(vaultId ?? ""),
      },
    });

    const docRows = selectDocRows(documents.rows, docContents.rows);
    tiles.set("docs", {
      appId: "docs",
      status: combineTileStatus([documents, docContents], docRows.length > 0),
      count: documents.rows.length,
      countCapped: documents.truncated === true,
      countLabel: "documents",
      body: { kind: "docs", rows: docRows },
    });

    const note = selectNoteExcerpt(notes.rows, noteContents.rows);
    tiles.set("notes", {
      appId: "notes",
      status: combineTileStatus([notes, noteContents], note !== undefined),
      count: notes.rows.length,
      countCapped: notes.truncated === true,
      countLabel: "notes",
      body: {
        kind: "notes",
        title: note?.title ?? "",
        excerpt: note?.excerpt ?? "",
      },
    });

    const occurrences = expandOccurrences(
      events.rows,
      exceptions.rows,
      now,
      AGENDA_HORIZON_DAYS
    );
    const next = selectNextEvent(occurrences, now, formatEventTime);
    tiles.set("agenda", {
      appId: "agenda",
      status: combineTileStatus([events, exceptions], next !== undefined),
      count: countUpcoming(occurrences, now, AGENDA_COUNT_DAYS),
      countLabel: "next 7 days",
      body: {
        kind: "agenda",
        title: next?.title ?? "",
        at: next?.at ?? "",
        after: next?.after ?? "",
      },
    });

    const names = new Map<string, string>();
    for (const party of parties.rows)
      names.set(str(party.party_id), str(party.display_name));
    const faces = selectFaces(profiles.rows, names);
    const peopleTotal = profiles.rows.filter(
      (row) => row.deleted_at == null
    ).length;
    tiles.set("people", {
      appId: "people",
      status: combineTileStatus([profiles, parties], faces.length > 0),
      count: peopleTotal,
      countCapped: profiles.truncated === true,
      countLabel: "people",
      body: {
        kind: "people",
        faces,
        more: Math.max(0, peopleTotal - faces.length),
      },
    });

    const taskRows = selectTaskRows(tasks.rows);
    tiles.set("tasks", {
      appId: "tasks",
      status: combineTileStatus([tasks], taskRows.length > 0),
      count: openTasks(tasks.rows).length,
      countCapped: tasks.truncated === true,
      countLabel: "open",
      body: { kind: "tasks", rows: taskRows },
    });

    tiles.set("tally", {
      appId: "tally",
      status: combineTileStatus([expenses, vault], expenses.rows.length > 0),
      count: expenses.rows.length,
      countCapped: expenses.truncated === true,
      countLabel: "this month",
      body: {
        kind: "tally",
        figure: formatCurrencyMinor(
          sumMinor(expenses.rows),
          str(vault.rows[0]?.base_currency) || "USD"
        ),
        caption: "spent this month",
      },
    });

    // No read, by design: `count` stays undefined so the header shows the
    // withheld glyph, and `unknown` keeps Locker from voting the vault empty.
    tiles.set("locker", {
      appId: "locker",
      status: "unknown",
      countLabel: "locked",
      body: { kind: "locker", locked: true },
    });

    return tiles;
  }, [
    docContents,
    documents,
    events,
    exceptions,
    expenses,
    photoGatewayBase,
    vaultId,
    noteContents,
    notes,
    now,
    parties,
    photos,
    profiles,
    tasks,
    vault,
  ]);
}

function expandOccurrences(
  events: readonly ReplicaRow[],
  exceptions: readonly ReplicaRow[],
  now: Date,
  horizonDays: number
): AgendaOccurrence[] {
  const to = new Date(now.getTime() + horizonDays * 86_400_000);
  return events.flatMap((row) => {
    const id = str(row.event_id);
    const start = str(row.dtstart);
    if (!id || !start || row.status === "cancelled") return [];
    return expandEvent(
      {
        id,
        summary: str(row.summary) || "Untitled event",
        start,
        end: row.dtend == null ? start : str(row.dtend),
        ...(row.start_tz == null ? {} : { timezone: str(row.start_tz) }),
        ...(row.rrule == null ? {} : { rrule: str(row.rrule) }),
        status: row.status == null ? "confirmed" : str(row.status),
      },
      now,
      to,
      64,
      // The home tile reads its skips through the one adapter too (#996,
      // ruling R21; drift ONT-25) — it had the same wrong column name.
      occurrenceExceptionsOf(
        exceptions as unknown as Record<string, unknown>[],
        { seriesType: "core.event", seriesId: id }
      )
    ).map((occurrence) => ({
      instanceKey: occurrence.instanceKey,
      summary: occurrence.summary,
      start: occurrence.start,
    }));
  });
}

/** `Wed 11 · 08:15`. Weekday AND day-of-month, because a bare weekday is
 *  ambiguous past a week out; today drops the date half. */
function formatEventTime(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const today = new Date();
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  const clock = when.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return clock;
  const day = when.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
  });
  return `${day} · ${clock}`;
}
