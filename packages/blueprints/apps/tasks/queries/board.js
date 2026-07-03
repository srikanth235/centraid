/**
 * The task board: every canonical task from schedule.task, shaped for a
 * Things-style view. Top-level open tasks come sorted (due first, then
 * priority where 1 is highest and 0 means unset, then title) with their
 * subtasks nested; closed top-level tasks form a logbook, most recently
 * completed first. Subtasks always render under their parent, whichever
 * side of the board the parent is on.
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

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const OPEN = new Set(['needs-action', 'in-process']);
  try {
    const [result, contents, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'schedule.task', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'schedule.task' }],
        purpose,
      }),
    ]);
    const rows = result.rows ?? [];
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
    const open = topLevel.filter((t) => OPEN.has(t.status)).toSorted(byUrgency).map(withChildren);
    const logbook = topLevel
      .filter((t) => !OPEN.has(t.status))
      .toSorted((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')))
      .slice(0, 50)
      .map(withChildren);

    const openCount = rows.filter((t) => OPEN.has(t.status)).length;
    return { open, logbook, counts: { open: openCount, closed: rows.length - openCount } };
  } catch (err) {
    return {
      open: [],
      logbook: [],
      counts: { open: 0, closed: 0 },
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
