// Per-app data plumbing for the Home springboard (#708 A).
//
// Home has no grant of its own: every read goes out under the OWNING app's id,
// so a tile shows only what its app may already read offline. The requests
// themselves — and the reasons each one is bounded in WORK and not merely in
// rows returned — live in ./home-tile-reads, where they are pinned against the
// mounted reader's SQL. Locker issues NO read: its items sit behind an online,
// session-gated RPC. A request handed to `useReplicaQuery` must keep a stable
// identity across renders or the tile re-reads on every one: the module
// constants already do, and the two that depend on render state (the month's
// expenses, the body lookups) are memoized here.

import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { formatCurrencyMinor } from "@centraid/client/capture";
import type { ReplicaRow } from "@centraid/client/replica/native";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import type { ReplicaQueryState } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { expandEvent } from "../../kit/schedule/recurrence";
import { pinnedThumbnailUri } from "../../lib/replica/thumbnail-pack";
import {
  expenseTileRead,
  HOME_ORDERED_TILE_READS,
  HOME_TILE_LIMITS,
  HOME_TILE_READS,
  idFilter,
} from "./home-tile-reads";
import {
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
import type { AgendaOccurrence, TileData, TileStatus } from "./tile-model";

const AGENDA_HORIZON_DAYS = 30;
const AGENDA_COUNT_DAYS = 7;

const BODY_LOOKUP_ROWS = 12;

/** `unavailable` and a failed read stay `unknown` — neither is evidence the
 *  app is empty, and only a settled empty read may claim first-run. */
function combineStatus(
  states: readonly ReplicaQueryState[],
  hasContent: boolean
): TileStatus {
  if (hasContent) return "content";
  if (states.some((state) => state.loading)) return "loading";
  if (
    states.some(
      (state) => state.connection === "unavailable" || state.error !== undefined
    )
  )
    return "unknown";
  return "empty";
}

function capped(rows: readonly unknown[], limit: number): boolean {
  return rows.length >= limit;
}

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
  const { gatewayBase, online } = useReplica();
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

  const photos = useReplicaQuery("photos", HOME_ORDERED_TILE_READS.photos);

  const documents = useReplicaQuery("docs", HOME_ORDERED_TILE_READS.documents);
  const docBodyIds = useMemo(
    () => topIds(documents.rows, "current_content_id"),
    [documents.rows]
  );
  const docContents = useReplicaQuery(
    "docs",
    useMemo(
      () => idFilter("core.content_item", "content_id", docBodyIds),
      [docBodyIds]
    )
  );

  const notes = useReplicaQuery("notes", HOME_ORDERED_TILE_READS.notes);
  const noteBodyIds = useMemo(
    () => topIds(notes.rows, "body_content_id"),
    [notes.rows]
  );
  const noteContents = useReplicaQuery(
    "notes",
    useMemo(
      () => idFilter("core.content_item", "content_id", noteBodyIds),
      [noteBodyIds]
    )
  );

  const events = useReplicaQuery("agenda", HOME_TILE_READS.events);
  const exceptions = useReplicaQuery("agenda", HOME_TILE_READS.exceptions);

  const profiles = useReplicaQuery("people", HOME_TILE_READS.profiles);
  const partyIds = useMemo(
    () => topIds(profiles.rows, "party_id"),
    [profiles.rows]
  );
  const parties = useReplicaQuery(
    "people",
    useMemo(() => idFilter("core.party", "party_id", partyIds), [partyIds])
  );

  const tasks = useReplicaQuery("tasks", HOME_TILE_READS.tasks);

  const monthStart = monthStartDate(now);
  const expenses = useReplicaQuery(
    "tally",
    useMemo(() => expenseTileRead(monthStart), [monthStart])
  );
  const vault = useReplicaQuery("tally", HOME_TILE_READS.vault);

  return useMemo(() => {
    const tiles = new Map<string, TileData>();

    const mosaic = selectPhotoMosaic(
      photos.rows,
      photoGatewayBase,
      pinnedThumbnailUri
    );
    tiles.set("photos", {
      appId: "photos",
      status: combineStatus([photos], mosaic.length > 0),
      count: photos.rows.length,
      countCapped: capped(photos.rows, HOME_TILE_LIMITS.photos),
      countLabel: "photos",
      body: { kind: "photos", photos: mosaic },
    });

    const docRows = selectDocRows(documents.rows, docContents.rows);
    tiles.set("docs", {
      appId: "docs",
      status: combineStatus([documents, docContents], docRows.length > 0),
      count: documents.rows.length,
      countCapped: capped(documents.rows, HOME_TILE_LIMITS.documents),
      countLabel: "documents",
      body: { kind: "docs", rows: docRows },
    });

    const note = selectNoteExcerpt(notes.rows, noteContents.rows);
    tiles.set("notes", {
      appId: "notes",
      status: combineStatus([notes, noteContents], note !== undefined),
      count: notes.rows.length,
      countCapped: capped(notes.rows, HOME_TILE_LIMITS.notes),
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
      status: combineStatus([events, exceptions], next !== undefined),
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
      status: combineStatus([profiles, parties], faces.length > 0),
      count: peopleTotal,
      countCapped: capped(profiles.rows, HOME_TILE_LIMITS.profiles),
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
      status: combineStatus([tasks], taskRows.length > 0),
      count: openTasks(tasks.rows).length,
      countCapped: capped(tasks.rows, HOME_TILE_LIMITS.tasks),
      countLabel: "open",
      body: { kind: "tasks", rows: taskRows },
    });

    tiles.set("tally", {
      appId: "tally",
      status: combineStatus([expenses, vault], expenses.rows.length > 0),
      count: expenses.rows.length,
      countCapped: capped(expenses.rows, HOME_TILE_LIMITS.expenses),
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
      exceptions
        .filter((exception) => exception.target_id === id)
        .map((exception) => ({
          originalStart: str(exception.original_start),
          action: exception.action === "override" ? "override" : "skip",
          scope: exception.scope === "future" ? "future" : "occurrence",
        }))
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
