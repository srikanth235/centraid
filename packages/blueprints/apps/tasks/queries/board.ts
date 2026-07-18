/**
 * The task board as a bounded window, never a whole-table pull (issue #262):
 * the newest open tasks by task_id (UUIDv7, so creation order; caller-sized,
 * default 500) plus the 50 most recently closed — exactly what the logbook
 * shows, so the read matches the UI instead of hauling the whole closed
 * history. Top-level open tasks come sorted (due first, then priority where
 * 1 is highest and 0 means unset, then title) with their subtasks nested;
 * closed top-level tasks form the logbook, most recently completed first.
 * Anything beyond the window is reachable through the FTS search query or by
 * growing the window (`truncated` tells the UI to offer that).
 *
 * Everything comes from the vault — this app holds no rows of its own; a
 * consent denial is a first-class outcome the UI renders, receipt included.
 */

/** Raw schedule.task row shape as the vault projects it (the fields this
 *  query reads; unread columns ride the index signature). */
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
interface RawAttachment {
  attachment_id: string;
  subject_type: string;
  subject_id: string;
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
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(
  subjectType: string,
  attachments: RawAttachment[],
  contentById: Map<string, RawContent>,
): Map<string, DecoratedAttachment[]> {
  // Blob-backed bytes serve as same-origin URLs (issue #296).
  const srcOf = (c: RawContent | undefined): string | undefined =>
    typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
      ? `/centraid/_vault/blobs/${c.content_id}`
      : c?.content_uri;
  const bySubject = new Map<string, DecoratedAttachment[]>();
  for (const a of attachments) {
    if (a.subject_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.subject_id)) bySubject.set(a.subject_id, []);
    bySubject.get(a.subject_id)!.push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? 'application/octet-stream',
      title: content?.title ?? null,
      content_uri: srcOf(content) ?? '',
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

const OPEN_STATUSES = ['needs-action', 'in-process'];
const CLOSED_STATUSES = ['completed', 'cancelled'];

export default async ({ input, ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  const OPEN = new Set(OPEN_STATUSES);
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  try {
    const [openResult, closedResult] = await Promise.all([
      ctx.vault.read({
        entity: 'schedule.task',
        where: [{ column: 'status', op: 'in', value: OPEN_STATUSES }],
        orderBy: { column: 'task_id', dir: 'desc' },
        limit: window,
        purpose,
      }),
      ctx.vault.read({
        entity: 'schedule.task',
        where: [{ column: 'status', op: 'in', value: CLOSED_STATUSES }],
        orderBy: { column: 'completed_at', dir: 'desc' },
        limit: 50,
        purpose,
      }),
    ]);
    const openRows = (openResult.rows ?? []) as unknown as RawTask[];
    const closedRows = (closedResult.rows ?? []) as unknown as RawTask[];
    const byId = new Map<string, RawTask>();
    for (const t of [...openRows, ...closedRows]) {
      byId.set(t.task_id, t);
    }

    // Families stay whole across the window edge: a subtask only renders
    // under its parent, so first pull in any referenced parents the windows
    // missed (`in` needs a non-empty array — skip when there's nothing to
    // fetch)…
    const missingParentIds = [
      ...new Set(
        [...byId.values()]
          .map((t) => t.parent_task_id)
          .filter((id): id is string => Boolean(id) && !byId.has(id as string)),
      ),
    ];
    if (missingParentIds.length > 0) {
      const parents = await ctx.vault.read({
        entity: 'schedule.task',
        where: [{ column: 'task_id', op: 'in', value: missingParentIds }],
        purpose,
      });
      for (const t of (parents.rows ?? []) as unknown as RawTask[]) byId.set(t.task_id, t);
    }

    // …then the reverse edge: every subtask of a fetched top-level task —
    // open ones so a windowed parent never renders with its still-to-do work
    // silently gone, closed ones so `done_children` counts the truth (the
    // read stays bounded: children of the windowed parents only).
    const topLevelIds = [...byId.values()].filter((t) => !t.parent_task_id).map((t) => t.task_id);
    if (topLevelIds.length > 0) {
      const children = await ctx.vault.read({
        entity: 'schedule.task',
        where: [{ column: 'parent_task_id', op: 'in', value: topLevelIds }],
        purpose,
      });
      for (const t of (children.rows ?? []) as unknown as RawTask[]) byId.set(t.task_id, t);
    }
    const rows = [...byId.values()];
    const taskIds = rows.map((t) => t.task_id);

    // Joins are `in`-bounded by the fetched set — attachment edges, then one
    // content pull covering only those attachments' bytes.
    const attachments =
      taskIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.attachment',
            where: [
              { column: 'subject_type', op: 'eq', value: 'schedule.task' },
              { column: 'subject_id', op: 'in', value: taskIds },
            ],
            purpose,
          })
        : { rows: [] };
    const attachmentRows = (attachments.rows ?? []) as unknown as RawAttachment[];
    const contentIds = [...new Set(attachmentRows.map((a) => a.content_id))].filter(Boolean);
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentRows = (contents.rows ?? []) as unknown as RawContent[];
    const contentById = new Map(contentRows.map((c) => [c.content_id, c]));
    const attByTask = attachmentsBySubject('schedule.task', attachmentRows, contentById);

    // Cross-references (issues #272 + #282): a task's description can @-mention
    // any vault entity. Read the live outbound links + their standoff anchors
    // and resolve the far-end cards (resolvable-if-linked — this app holds no
    // read scope on those domains). Mirrors the notes/library.js shape.
    const links =
      taskIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.link',
            where: [
              { column: 'from_type', op: 'eq', value: 'schedule.task' },
              { column: 'from_id', op: 'in', value: taskIds },
              { column: 'valid_to', op: 'is-null' },
            ],
            purpose,
          })
        : { rows: [] };
    const tags =
      taskIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.tag',
            where: [
              { column: 'target_type', op: 'eq', value: 'schedule.task' },
              { column: 'target_id', op: 'in', value: taskIds },
            ],
            purpose,
          })
        : { rows: [] };
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const tagConceptIds = [...new Set(tagRows.map((t) => t.concept_id))];
    const tagConcepts =
      tagConceptIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.concept',
            where: [{ column: 'concept_id', op: 'in', value: tagConceptIds }],
            purpose,
          })
        : { rows: [] };
    const tagConceptRows = (tagConcepts.rows ?? []) as unknown as Array<{
      concept_id: string;
      pref_label: string;
    }>;
    const tagLabelByConcept = new Map(tagConceptRows.map((c) => [c.concept_id, c.pref_label]));
    const tagsByTask = new Map<
      string,
      Array<{ tag_id: string; concept_id: string; label: string }>
    >();
    for (const t of tagRows) {
      if (!tagsByTask.has(t.target_id)) tagsByTask.set(t.target_id, []);
      tagsByTask.get(t.target_id)!.push({
        tag_id: t.tag_id,
        concept_id: t.concept_id,
        label: tagLabelByConcept.get(t.concept_id) ?? '?',
      });
    }
    const allTags = [...tagLabelByConcept.entries()]
      .map(([concept_id, label]) => ({ concept_id, label }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    const linkRows = (links.rows ?? []) as unknown as RawLink[];
    const uniqueRefs = [
      ...new Map(
        linkRows.map((l) => [`${l.to_type}/${l.to_id}`, { type: l.to_type, id: l.to_id }]),
      ).values(),
    ];
    const [resolved, anchors] = await Promise.all([
      uniqueRefs.length > 0
        ? ctx.vault.resolve({ refs: uniqueRefs, purpose })
        : Promise.resolve({ cards: [] as Array<Record<string, unknown>> }),
      linkRows.length > 0
        ? ctx.vault.read({
            entity: 'core.link_anchor',
            where: [{ column: 'link_id', op: 'in', value: linkRows.map((l) => l.link_id) }],
            purpose,
          })
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    const cardByRef = new Map(
      (resolved.cards ?? []).map((c) => [`${c.type as string}/${c.id as string}`, c]),
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
          status: 'unknown',
          title: null,
          subtitle: null,
          thumbnail_content_id: null,
        },
      });
    }

    const childrenOf = new Map<string, RawTask[]>();
    for (const task of rows) {
      if (!task.parent_task_id) continue;
      if (!childrenOf.has(task.parent_task_id)) childrenOf.set(task.parent_task_id, []);
      childrenOf.get(task.parent_task_id)!.push(task);
    }

    // Priority per RFC 5545: 1 is highest, 0 is unset (sorts after 9).
    const prio = (t: RawTask) => {
      const p = Number(t.priority ?? 0);
      return p > 0 ? p : 10;
    };
    const byUrgency = (a: RawTask, b: RawTask) => {
      if (a.due_at == null && b.due_at != null) return 1;
      if (a.due_at != null && b.due_at == null) return -1;
      if (a.due_at != null && a.due_at !== b.due_at) {
        return String(a.due_at).localeCompare(String(b.due_at));
      }
      if (prio(a) !== prio(b)) return prio(a) - prio(b);
      return String(a.title).localeCompare(String(b.title));
    };

    const withAttachments = (task: RawTask) => ({
      ...task,
      attachments: attByTask.get(task.task_id) ?? [],
      references: refsByTask.get(task.task_id) ?? [],
      tags: tagsByTask.get(task.task_id) ?? [],
    });

    const withChildren = (task: RawTask) => {
      const children = (childrenOf.get(task.task_id) ?? [])
        .toSorted(byUrgency)
        .map(withAttachments);
      return {
        ...withAttachments(task),
        children,
        done_children: children.filter((c) => !OPEN.has(c.status)).length,
      };
    };

    const topLevel = rows.filter((t) => !t.parent_task_id);
    const open = topLevel
      .filter((t) => OPEN.has(t.status))
      .toSorted(byUrgency)
      .map(withChildren);
    const logbook = topLevel
      .filter((t) => !OPEN.has(t.status))
      .toSorted((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')))
      .slice(0, 50)
      .map(withChildren);

    // Counts describe what was fetched, not the whole table — a full open
    // window means more open tasks exist beyond it, and `truncated` tells
    // the UI to offer "Show more".
    const openCount = rows.filter((t) => OPEN.has(t.status)).length;
    const truncated = openRows.length >= window;
    return {
      open,
      logbook,
      tags: allTags,
      counts: { open: openCount, closed: rows.length - openCount },
      truncated,
      window,
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      open: [],
      logbook: [],
      tags: [],
      counts: { open: 0, closed: 0 },
      vaultDenied: { code: e.code, message: e.message },
    };
  }
};
