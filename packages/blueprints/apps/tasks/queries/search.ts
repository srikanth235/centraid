/**
 * Task search as a vault projection: the FTS5 index inside the vault does
 * the matching (title + description), so the app never pulls the whole
 * schedule.task table to grep it — vault data has no upper bound. Only the
 * matched rows come back, joined with their attachments to mirror the board
 * projection's per-task shape row-for-row, plus a hit snippet.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 */

interface RawSearchTask {
  task_id: string;
  _rank?: unknown;
  _snippet?: unknown;
  [k: string]: unknown;
}
interface RawAttachment {
  attachment_id: string;
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

export default async ({ input, ctx }: HandlerArgs) => {
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
    const hits = (matches.rows ?? []) as unknown as RawSearchTask[];
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
    const attachmentRows = (attachments.rows ?? []) as unknown as RawAttachment[];
    const contentIds = [...new Set(attachmentRows.map((a) => a.content_id))];
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
    // Blob-backed bytes serve as same-origin URLs (issue #296).
    const srcOf = (c: RawContent | undefined): string | undefined =>
      typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c?.content_uri;
    const attByTask = new Map<string, DecoratedAttachment[]>();
    for (const a of attachmentRows) {
      const content = contentById.get(a.content_id);
      if (!attByTask.has(a.subject_id)) attByTask.set(a.subject_id, []);
      attByTask.get(a.subject_id)!.push({
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
    const e = err as { code?: string; message?: string };
    return { tasks: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
