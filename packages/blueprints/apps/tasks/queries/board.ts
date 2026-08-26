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
import { nestTaskFamilies } from "../when.ts";

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
  title: string | null;
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
  contentById: Map<string, RawContent>
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
      media_type: content?.media_type ?? "application/octet-stream",
      title: content?.title ?? null,
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
  const purpose = "dpv:ServiceProvision";
  const OPEN = new Set(OPEN_STATUSES);
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  try {
    const [openResult, closedResult, projectsResult, sectionsResult] =
      await Promise.all([
        ctx.vault.read({
          entity: "schedule.task",
          where: [{ column: "status", op: "in", value: OPEN_STATUSES }],
          orderBy: { column: "task_id", dir: "desc" },
          limit: window,
          purpose,
        }),
        ctx.vault.read({
          entity: "schedule.task",
          where: [{ column: "status", op: "in", value: CLOSED_STATUSES }],
          orderBy: { column: "completed_at", dir: "desc" },
          limit: 50,
          purpose,
        }),
        ctx.vault.read({
          entity: "schedule.project",
          where: [{ column: "archived_at", op: "is-null" }],
          orderBy: { column: "sort_order", dir: "asc" },
          purpose,
        }),
        ctx.vault.read({
          entity: "schedule.section",
          orderBy: { column: "sort_order", dir: "asc" },
          purpose,
        }),
      ]);
    const openRows = (openResult.rows ?? []) as unknown as RawTask[];
    const closedRows = (closedResult.rows ?? []) as unknown as RawTask[];
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
      const parents = await ctx.vault.read({
        entity: "schedule.task",
        where: [{ column: "task_id", op: "in", value: missingParentIds }],
        purpose,
      });
      for (const t of (parents.rows ?? []) as unknown as RawTask[])
        byId.set(t.task_id, t);
    }

    // …then the reverse edge: every subtask of a fetched top-level task —
    // open so a windowed parent's to-do work isn't silently gone, closed
    // so `done_children` counts true (children of windowed parents only).
    const topLevelIds = [...byId.values()]
      .filter((t) => !t.parent_task_id)
      .map((t) => t.task_id);
    if (topLevelIds.length > 0) {
      const children = await ctx.vault.read({
        entity: "schedule.task",
        where: [{ column: "parent_task_id", op: "in", value: topLevelIds }],
        purpose,
      });
      for (const t of (children.rows ?? []) as unknown as RawTask[])
        byId.set(t.task_id, t);
    }
    const rows = [...byId.values()];
    const taskIds = rows.map((t) => t.task_id);

    // Joins are `in`-bounded by the fetched set.
    const attachments =
      taskIds.length > 0
        ? await ctx.vault.read({
            entity: "core.attachment",
            where: [
              { column: "target_type", op: "eq", value: "schedule.task" },
              { column: "target_id", op: "in", value: taskIds },
            ],
            purpose,
          })
        : { rows: [] };
    const attachmentRows = (attachments.rows ??
      []) as unknown as RawAttachment[];
    const contentIds = [
      ...new Set(attachmentRows.map((a) => a.content_id)),
    ].filter(Boolean);
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: "core.content_item",
            where: [{ column: "content_id", op: "in", value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentRows = (contents.rows ?? []) as unknown as RawContent[];
    const contentById = new Map(contentRows.map((c) => [c.content_id, c]));
    const attByTask = attachmentsBySubject(
      "schedule.task",
      attachmentRows,
      contentById
    );

    // Cross-references (#272, #282): @-mentioned entities resolve via live
    // links + anchors; cards resolvable-if-linked.
    const links =
      taskIds.length > 0
        ? await ctx.vault.read({
            entity: "core.link",
            where: [
              { column: "from_type", op: "eq", value: "schedule.task" },
              { column: "from_id", op: "in", value: taskIds },
              { column: "valid_to", op: "is-null" },
            ],
            purpose,
          })
        : { rows: [] };
    const tags =
      taskIds.length > 0
        ? await ctx.vault.read({
            entity: "core.tag",
            where: [
              { column: "target_type", op: "eq", value: "schedule.task" },
              { column: "target_id", op: "in", value: taskIds },
            ],
            purpose,
          })
        : { rows: [] };
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const tagConceptIds = [...new Set(tagRows.map((t) => t.concept_id))];
    const tagConcepts =
      tagConceptIds.length > 0
        ? await ctx.vault.read({
            entity: "core.concept",
            where: [{ column: "concept_id", op: "in", value: tagConceptIds }],
            purpose,
          })
        : { rows: [] };
    const tagConceptRows = (tagConcepts.rows ?? []) as unknown as Array<{
      concept_id: string;
      pref_label: string;
    }>;
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

    const linkRows = (links.rows ?? []) as unknown as RawLink[];
    const uniqueRefs = [
      ...new Map(
        linkRows.map((l) => [
          `${l.to_type}/${l.to_id}`,
          { type: l.to_type, id: l.to_id },
        ])
      ).values(),
    ];
    const [resolved, anchors] = await Promise.all([
      uniqueRefs.length > 0
        ? ctx.vault.resolve({ refs: uniqueRefs, purpose })
        : Promise.resolve({ cards: [] as Array<Record<string, unknown>> }),
      linkRows.length > 0
        ? ctx.vault.read({
            entity: "core.link_anchor",
            where: [
              {
                column: "link_id",
                op: "in",
                value: linkRows.map((l) => l.link_id),
              },
            ],
            purpose,
          })
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    const cardByRef = new Map(
      (resolved.cards ?? []).map((c) => [
        `${c.type as string}/${c.id as string}`,
        c,
      ])
    );
    const anchorRows = (anchors.rows ?? []) as unknown as Array<{
      link_id: string;
      selector_json: string;
    }>;
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
    // tells the UI to offer "Show more".
    const openCount = rows.filter((t) => OPEN.has(t.status)).length;
    const truncated = openRows.length >= window;
    return {
      open,
      logbook,
      projects: (projectsResult.rows ?? []) as unknown as RawProject[],
      sections: (sectionsResult.rows ?? []) as unknown as RawSection[],
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
