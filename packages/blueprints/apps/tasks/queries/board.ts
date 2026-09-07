/**
 * Task board as a bounded window, never a whole-table pull (#262): newest
 * open tasks by task_id (UUIDv7 creation order, caller-sized window, default
 * 500) plus the 50 most recently closed — exactly what the logbook shows;
 * beyond the window use FTS or grow it (`truncated` offers that). Open tasks
 * sort due-first, then priority (higher more urgent, 0 unset), then title,
 * subtasks nested; unfinished children of a completed or released parent
 * are promoted onto the open board (`nestTaskFamilies`). Closed top-level
 * tasks form the logbook. Everything comes from the vault — no rows of its
 * own; consent denial is first-class, receipt included.
 */
import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import type { RepresentationIndex } from "../../_shared/representation-reads.ts";
import { nestTaskFamilies } from "../when.ts";

/*
 * EVERY READ ON THIS BOARD IS A PAGE (#996 wave 4, R8). The declarative
 * vocabulary this replaces let each of these say `acceptTruncation: true` and
 * take whatever window the reader happened to have; there were ten of them in
 * this one file, and not one named the number it was relying on.
 *
 * The two reads that are the SCREEN — the open window and the logbook — take
 * one page each, sized by the caller. Everything else is a join over the set
 * those two returned: bounded by the window, so it is walked to the end with
 * `readPages`, which states its ceiling and throws rather than quietly
 * stopping. `from` names the physical table because a statement runs unchanged
 * on the seat's own file and on the gateway's paged door (W4-D2).
 */

/** The logbook is what the screen shows, so the read is the screen's size. */
const LOGBOOK_ROWS = 50;

/** One task row, as both task reads project it. */
const TASK_COLUMNS =
  "task_id, parent_task_id, project_id, section_id, status, title, " +
  "description, priority, due_at, completed_at, effort_min, rrule, tz, " +
  "recurrence_anchor, series_id, sort_order, created_at, updated_at";

/** The board draws the member's own unsettled task writes over its rows. */
const TASK_OVERLAY = { entity: "schedule.task", rowIdColumn: "task_id" };

/** Raw schedule.task row as the vault projects it (unread columns ride the index signature). */
interface RawTask {
  task_id: string;
  parent_task_id?: string | null;
  status: string;
  due_at?: string | null;
  completed_at?: string | null;
  priority?: number;
  title: string;
  [k: string]: unknown;
}
interface RawProject {
  project_id: string;
  name: string;
  area?: string | null;
  color?: string | null;
  sort_order: number;
}
interface RawSection {
  section_id: string;
  project_id: string;
  name: string;
  sort_order: number;
}
interface RawAttachment {
  attachment_id: string;
  target_type: string;
  target_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
  [k: string]: unknown;
}
interface RawContent {
  content_id: string;
  content_uri?: string;
  media_type?: string;
  title?: string | null;
  byte_size?: number;
  [k: string]: unknown;
}
interface RawLink {
  link_id: string;
  from_id: string;
  to_type: string;
  to_id: string;
  [k: string]: unknown;
}
interface RawTag {
  tag_id: string;
  target_id: string;
  concept_id: string;
  [k: string]: unknown;
}
interface DecoratedAttachment {
  attachment_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
  media_type: string;
  /** Bytes have no title of their own since #996 (R20(b)); an attachment is
   *  not a wrapper, so there is nothing here to carry one. */
  content_uri: string;
  byte_size: number;
}

/**
 * Group one subject type's attachments by target_id, each value joined to
 * its content item — shared attachment-projection shape every app copies
 * (core.attachment edges + core.content_item bytes).
 */
function attachmentsBySubject(
  subjectType: string,
  attachments: RawAttachment[],
  contentById: Map<string, RawContent>,
  representations: RepresentationIndex
): Map<string, DecoratedAttachment[]> {
  // Blob-backed bytes serve as same-origin URLs (#296).
  const srcOf = (c: RawContent | undefined): string | undefined =>
    typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
      ? `/centraid/_vault/blobs/${c.content_id}`
      : c?.content_uri;
  const bySubject = new Map<string, DecoratedAttachment[]>();
  for (const a of attachments) {
    if (a.target_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.target_id)) bySubject.set(a.target_id, []);
    bySubject.get(a.target_id)!.push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      // The ATTACHMENT's own reading of the bytes (#996, R20(b)); bytes
      // carry neither a media type nor a title of their own.
      media_type:
        representations.byOwner.get(
          ownerKey("core.attachment", a.attachment_id)
        ) ??
        representations.byContent.get(a.content_id) ??
        "application/octet-stream",
      content_uri: srcOf(content) ?? "",
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

const OPEN_STATUSES = ["needs-action", "in-process"];
const CLOSED_STATUSES = ["completed", "cancelled"];

export default async function boardHandler({ input, ctx }: HandlerArgs) {
  const OPEN = new Set(OPEN_STATUSES);
  // THE WINDOW IS A PAGE (#996 wave 4, R8). The old ceiling was 2,000 rows and
  // was never the reader's real one; the host's measured ceiling is
  // `MAX_PAGE_ROWS`, and asking past it was always answered with fewer rows and
  // no way to continue. `truncated` now carries a real continuation.
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 500);
  try {
    const openTasks = await ctx.vault.page<RawTask>({
      query: {
        name: "tasks.board.open",
        select: TASK_COLUMNS,
        from: "schedule_task",
        where: "status IN (?, ?)",
        bind: [...OPEN_STATUSES],
        order: {
          sortColumn: "task_id",
          pkColumn: "task_id",
          descending: true,
        },
      },
      limit: window,
      overlay: TASK_OVERLAY,
    });
    const closedTasks = await ctx.vault.page<RawTask>({
      query: {
        name: "tasks.board.logbook",
        select: TASK_COLUMNS,
        from: "schedule_task",
        where: "status IN (?, ?)",
        bind: [...CLOSED_STATUSES],
        order: {
          sortColumn: "completed_at",
          pkColumn: "task_id",
          descending: true,
        },
      },
      limit: LOGBOOK_ROWS,
      overlay: TASK_OVERLAY,
    });
    // The project and section lists are the board's own chrome: small, and
    // read whole. `readPages` states the ceiling the old `acceptTruncation`
    // left to whatever the reader's default happened to be.
    const projectRows = await readPages<RawProject>(ctx, {
      name: "tasks.board.projects",
      select: "project_id, name, area, color, sort_order",
      from: "schedule_project",
      where: "archived_at IS NULL",
      order: {
        sortColumn: "sort_order",
        pkColumn: "project_id",
        descending: false,
      },
    });
    const sectionRows = await readPages<RawSection>(ctx, {
      name: "tasks.board.sections",
      select: "section_id, project_id, name, sort_order",
      from: "schedule_section",
      order: {
        sortColumn: "sort_order",
        pkColumn: "section_id",
        descending: false,
      },
    });
    const openRows = openTasks.rows;
    const closedRows = closedTasks.rows;
    const byId = new Map<string, RawTask>();
    for (const t of [...openRows, ...closedRows]) {
      byId.set(t.task_id, t);
    }

    // Families stay whole across the window edge: fetch any referenced
    // parents the windows missed (`in` needs a non-empty array).
    const missingParentIds = [
      ...new Set(
        [...byId.values()]
          .map((t) => t.parent_task_id)
          .filter((id): id is string => Boolean(id) && !byId.has(id as string))
      ),
    ];
    if (missingParentIds.length > 0) {
      const parentIn = inList("task_id", missingParentIds);
      for (const t of await readPages<RawTask>(ctx, {
        name: "tasks.board.parents",
        select: TASK_COLUMNS,
        from: "schedule_task",
        where: parentIn.sql,
        bind: parentIn.bind,
        order: {
          sortColumn: "task_id",
          pkColumn: "task_id",
          descending: false,
        },
      }))
        byId.set(t.task_id, t);
    }

    // …then the reverse edge: every subtask of a fetched top-level task —
    // open so a windowed parent's to-do work isn't silently gone, closed
    // so `done_children` counts true (children of windowed parents only).
    const topLevelIds = [...byId.values()]
      .filter((t) => !t.parent_task_id)
      .map((t) => t.task_id);
    if (topLevelIds.length > 0) {
      const childIn = inList("parent_task_id", topLevelIds);
      for (const t of await readPages<RawTask>(ctx, {
        name: "tasks.board.children",
        select: TASK_COLUMNS,
        from: "schedule_task",
        where: childIn.sql,
        bind: childIn.bind,
        order: {
          sortColumn: "task_id",
          pkColumn: "task_id",
          descending: false,
        },
      }))
        byId.set(t.task_id, t);
    }
    const rows = [...byId.values()];
    const taskIds = rows.map((t) => t.task_id);

    // Joins are `in`-bounded by the fetched set, and walked to the end of it.
    const attachmentRows =
      taskIds.length > 0
        ? await readPages<RawAttachment>(ctx, {
            name: "tasks.board.attachments",
            select:
              "attachment_id, target_type, target_id, content_id, role, is_primary",
            from: "core_attachment",
            where: `target_type = ? AND ${inList("target_id", taskIds).sql}`,
            bind: ["schedule.task", ...taskIds],
            order: {
              sortColumn: "attachment_id",
              pkColumn: "attachment_id",
              descending: false,
            },
          })
        : [];
    const contentIds = [
      ...new Set(attachmentRows.map((a) => a.content_id)),
    ].filter(Boolean);
    const contentRows =
      contentIds.length > 0
        ? await readPages<RawContent>(ctx, {
            name: "tasks.board.contents",
            select: "content_id, content_uri, byte_size",
            from: "core_content_item",
            where: inList("content_id", contentIds).sql,
            bind: [...contentIds],
            order: {
              sortColumn: "content_id",
              pkColumn: "content_id",
              descending: false,
            },
          })
        : [];
    // Bytes carry no media type since #996 (R20(b)) — the attachment's own
    // representation says what it reads them as.
    const representations = await readRepresentations({ ctx, contentIds });
    const contentById = new Map(contentRows.map((c) => [c.content_id, c]));
    const attByTask = attachmentsBySubject(
      "schedule.task",
      attachmentRows,
      contentById,
      representations
    );

    // Cross-references (#272, #282): @-mentioned entities resolve via live
    // links + anchors; cards resolvable-if-linked.
    const linkRows =
      taskIds.length > 0
        ? await readPages<RawLink>(ctx, {
            name: "tasks.board.links",
            select: "link_id, from_id, to_type, to_id",
            from: "core_link",
            where: `from_type = ? AND valid_to IS NULL AND ${inList("from_id", taskIds).sql}`,
            bind: ["schedule.task", ...taskIds],
            order: {
              sortColumn: "link_id",
              pkColumn: "link_id",
              descending: false,
            },
          })
        : [];
    const tagRows =
      taskIds.length > 0
        ? await readPages<RawTag>(ctx, {
            name: "tasks.board.tags",
            select: "tag_id, target_id, concept_id",
            from: "core_tag",
            where: `target_type = ? AND ${inList("target_id", taskIds).sql}`,
            bind: ["schedule.task", ...taskIds],
            order: {
              sortColumn: "tag_id",
              pkColumn: "tag_id",
              descending: false,
            },
          })
        : [];
    const tagConceptIds = [...new Set(tagRows.map((t) => t.concept_id))];
    const tagConceptRows =
      tagConceptIds.length > 0
        ? await readPages<{ concept_id: string; pref_label: string }>(ctx, {
            name: "tasks.board.tag-concepts",
            select: "concept_id, pref_label",
            from: "core_concept",
            where: inList("concept_id", tagConceptIds).sql,
            bind: [...tagConceptIds],
            order: {
              sortColumn: "concept_id",
              pkColumn: "concept_id",
              descending: false,
            },
          })
        : [];
    const tagLabelByConcept = new Map(
      tagConceptRows.map((c) => [c.concept_id, c.pref_label])
    );
    const tagsByTask = new Map<
      string,
      Array<{ tag_id: string; concept_id: string; label: string }>
    >();
    for (const t of tagRows) {
      if (!tagsByTask.has(t.target_id)) tagsByTask.set(t.target_id, []);
      tagsByTask.get(t.target_id)!.push({
        tag_id: t.tag_id,
        concept_id: t.concept_id,
        label: tagLabelByConcept.get(t.concept_id) ?? "?",
      });
    }
    const allTags = [...tagLabelByConcept.entries()]
      .map(([concept_id, label]) => ({ concept_id, label }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    const uniqueRefs = [
      ...new Map(
        linkRows.map((l) => [
          `${l.to_type}/${l.to_id}`,
          { type: l.to_type, id: l.to_id },
        ])
      ).values(),
    ];
    const [resolved, anchorRows] = await Promise.all([
      uniqueRefs.length > 0
        ? ctx.vault.resolve({ refs: uniqueRefs })
        : Promise.resolve({ cards: [] as Array<Record<string, unknown>> }),
      linkRows.length > 0
        ? readPages<{ link_id: string; selector_json: string }>(ctx, {
            name: "tasks.board.link-anchors",
            select: "anchor_id, link_id, selector_json",
            from: "core_link_anchor",
            where: inList(
              "link_id",
              linkRows.map((l) => l.link_id)
            ).sql,
            bind: linkRows.map((l) => l.link_id),
            order: {
              sortColumn: "anchor_id",
              pkColumn: "anchor_id",
              descending: false,
            },
          })
        : Promise.resolve([] as { link_id: string; selector_json: string }[]),
    ]);
    const cardByRef = new Map(
      (resolved.cards ?? []).map((c) => [
        `${c.type as string}/${c.id as string}`,
        c,
      ])
    );
    const selectorByLink = new Map<string, unknown>();
    for (const a of anchorRows) {
      try {
        selectorByLink.set(a.link_id, JSON.parse(a.selector_json));
      } catch {
        // an unreadable selector is just an unanchored reference
      }
    }
    const refsByTask = new Map<string, Array<Record<string, unknown>>>();
    for (const l of linkRows) {
      if (!refsByTask.has(l.from_id)) refsByTask.set(l.from_id, []);
      refsByTask.get(l.from_id)!.push({
        link_id: l.link_id,
        selector: selectorByLink.get(l.link_id) ?? null,
        card: cardByRef.get(`${l.to_type}/${l.to_id}`) ?? {
          type: l.to_type,
          id: l.to_id,
          status: "unknown",
          title: null,
          subtitle: null,
          thumbnail_content_id: null,
        },
      });
    }

    // Priority per Todoist: higher is more urgent, 0 is unset (sorts last).
    const prio = (t: RawTask) => Number(t.priority ?? 0);
    const byUrgency = (a: RawTask, b: RawTask) => {
      if (a.due_at == null && b.due_at != null) return 1;
      if (a.due_at != null && b.due_at == null) return -1;
      if (a.due_at != null && a.due_at !== b.due_at) {
        return String(a.due_at).localeCompare(String(b.due_at));
      }
      if (prio(a) !== prio(b)) return prio(b) - prio(a);
      return String(a.title).localeCompare(String(b.title));
    };

    // A REPEATING TASK NEVER STACKS, and the collapse arithmetic lives in
    // ONE place — `ctx.time` (packages/core/src/time). Rows leave here with
    // the summariser's words + the collapse's two numbers so no surface ever
    // sees an RRULE string or re-counts a missed period for itself.
    const nowIso = new Date().toISOString();
    const withRecurrence = (task: RawTask) => {
      const rrule = typeof task.rrule === "string" ? task.rrule : null;
      const start = typeof task.due_at === "string" ? task.due_at : null;
      if (!rrule || !start) return {};
      const collapsed = ctx.time.collapseMissedOccurrences({
        rrule,
        scheduledStart: start,
        ...(typeof task.recurrence_tz === "string"
          ? { timeZone: task.recurrence_tz }
          : {}),
        ...(task.recurrence_anchor === "completion" ||
        task.recurrence_anchor === "scheduled"
          ? { anchor: task.recurrence_anchor }
          : {}),
        now: nowIso,
        ...(typeof task.completed_at === "string"
          ? { lastCompletedAt: task.completed_at }
          : {}),
      });
      return {
        recurrence_summary: ctx.time.describeRecurrence(rrule),
        missed: collapsed.missed,
        next_due: collapsed.nextDue,
      };
    };

    const withAttachments = (task: RawTask) => ({
      ...task,
      attachments: attByTask.get(task.task_id) ?? [],
      references: refsByTask.get(task.task_id) ?? [],
      tags: tagsByTask.get(task.task_id) ?? [],
      ...withRecurrence(task),
    });

    const withChildren = (task: RawTask, children: RawTask[]) => {
      const nested = children.toSorted(byUrgency).map(withAttachments);
      return {
        ...withAttachments(task),
        children: nested,
        done_children: nested.filter((c) => !OPEN.has(c.status)).length,
      };
    };

    const families = nestTaskFamilies(rows, withChildren);
    const open = families.open.toSorted(byUrgency);
    const logbook = families.logbook
      .toSorted((a, b) =>
        String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? ""))
      )
      .slice(0, 50);

    // Counts describe what was fetched, not the whole table; `truncated`
    // tells the UI to offer "Show more". It is the PAGE's own answer now —
    // a cursor exists or it does not — rather than the guess the old read left
    // it as (`openRows.length >= window`, which cannot tell a window that
    // filled exactly from one that ran out).
    const openCount = rows.filter((t) => OPEN.has(t.status)).length;
    const truncated = openTasks.next !== undefined;
    return {
      open,
      logbook,
      projects: projectRows,
      sections: sectionRows,
      tags: allTags,
      counts: { open: openCount, closed: rows.length - openCount },
      truncated,
      window,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      open: [],
      logbook: [],
      projects: [],
      sections: [],
      tags: [],
      counts: { open: 0, closed: 0 },
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
