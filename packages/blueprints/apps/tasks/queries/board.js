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
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(subjectType, attachments, contentById) {
  const bySubject = new Map();
  for (const a of attachments) {
    if (a.subject_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.subject_id)) bySubject.set(a.subject_id, []);
    bySubject.get(a.subject_id).push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? 'application/octet-stream',
      title: content?.title ?? null,
      content_uri: content?.content_uri ?? '',
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

export default async ({ input, ctx }) => {
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
    const byId = new Map();
    for (const t of [...(openResult.rows ?? []), ...(closedResult.rows ?? [])]) {
      byId.set(t.task_id, t);
    }

    // Families stay whole across the window edge: a subtask only renders
    // under its parent, so first pull in any referenced parents the windows
    // missed (`in` needs a non-empty array — skip when there's nothing to
    // fetch)…
    const missingParentIds = [
      ...new Set(
        [...byId.values()].map((t) => t.parent_task_id).filter((id) => id && !byId.has(id)),
      ),
    ];
    if (missingParentIds.length > 0) {
      const parents = await ctx.vault.read({
        entity: 'schedule.task',
        where: [{ column: 'task_id', op: 'in', value: missingParentIds }],
        purpose,
      });
      for (const t of parents.rows ?? []) byId.set(t.task_id, t);
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
      for (const t of children.rows ?? []) byId.set(t.task_id, t);
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
    const contentIds = [...new Set((attachments.rows ?? []).map((a) => a.content_id))].filter(
      Boolean,
    );
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByTask = attachmentsBySubject('schedule.task', attachments.rows ?? [], contentById);

    const childrenOf = new Map();
    for (const task of rows) {
      if (!task.parent_task_id) continue;
      if (!childrenOf.has(task.parent_task_id)) childrenOf.set(task.parent_task_id, []);
      childrenOf.get(task.parent_task_id).push(task);
    }

    // Priority per RFC 5545: 1 is highest, 0 is unset (sorts after 9).
    const prio = (t) => (t.priority > 0 ? t.priority : 10);
    const byUrgency = (a, b) => {
      if (a.due_at == null && b.due_at != null) return 1;
      if (a.due_at != null && b.due_at == null) return -1;
      if (a.due_at != null && a.due_at !== b.due_at) {
        return String(a.due_at).localeCompare(String(b.due_at));
      }
      if (prio(a) !== prio(b)) return prio(a) - prio(b);
      return String(a.title).localeCompare(String(b.title));
    };

    const withAttachments = (task) => ({
      ...task,
      attachments: attByTask.get(task.task_id) ?? [],
    });

    const withChildren = (task) => {
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
    const truncated = (openResult.rows ?? []).length >= window;
    return {
      open,
      logbook,
      counts: { open: openCount, closed: rows.length - openCount },
      truncated,
      window,
    };
  } catch (err) {
    return {
      open: [],
      logbook: [],
      counts: { open: 0, closed: 0 },
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
