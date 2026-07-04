/**
 * Task search as a vault projection: the FTS5 index inside the vault does
 * the matching (title + description), so the app never pulls the whole
 * schedule.task table to grep it — vault data has no upper bound. Only the
 * matched rows come back, joined with their attachments to mirror the board
 * projection's per-task shape row-for-row, plus a hit snippet.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { tasks: [] };
  try {
    const matches = await ctx.vault.search({
      entity: 'schedule.task',
      query: term,
      limit: 100,
      purpose,
    });
    const hits = matches.rows ?? [];
    if (hits.length === 0) return { tasks: [] };
    const taskIds = hits.map((t) => t.task_id);
    // Attachments only for the matched tasks — the join stays as narrow as
    // the match set, never a whole-table pull.
    const attachments = await ctx.vault.read({
      entity: 'core.attachment',
      where: [
        { column: 'subject_type', op: 'eq', value: 'schedule.task' },
        { column: 'subject_id', op: 'in', value: taskIds },
      ],
      purpose,
    });
    const attachmentRows = attachments.rows ?? [];
    const contentIds = [...new Set(attachmentRows.map((a) => a.content_id))];
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByTask = new Map();
    for (const a of attachmentRows) {
      const content = contentById.get(a.content_id);
      if (!attByTask.has(a.subject_id)) attByTask.set(a.subject_id, []);
      attByTask.get(a.subject_id).push({
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
    for (const list of attByTask.values()) {
      list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
    }
    // Vault order is rank order (best match first) — keep it.
    const tasks = hits.map(({ _rank, _snippet, ...task }) => ({
      ...task,
      attachments: attByTask.get(task.task_id) ?? [],
      snippet: typeof _snippet === 'string' ? _snippet : '',
    }));
    return { tasks };
  } catch (err) {
    return { tasks: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
