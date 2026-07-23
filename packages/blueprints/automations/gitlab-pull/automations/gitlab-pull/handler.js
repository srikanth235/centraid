/**
 * pull.gitlab connector — read-only ingest through the connection broker.
 * Stages into the vault review band via sync.stage_rows; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.gitlab';
const LABEL = 'personal';
const API = 'https://gitlab.com/api/v4';
const AUTH = { 'PRIVATE-TOKEN': '{{connection:api_key}}' };
const MAX_PAGES_PER_RUN = 3;

async function api(ctx, path, opts = {}) {
  const headers = { ...AUTH, ...(opts.headers || {}) };
  const res = await ctx.fetch({
    url: path.startsWith('http') ? path : `${API}${path}`,
    headers,
    method: opts.method || 'GET',
    body: opts.body,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${KIND} auth failed (${res.status}): ${res.text.slice(0, 200)}`);
  }
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `${KIND} ${String(path).split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
  }
  if (!res.text) return {};
  return JSON.parse(res.text);
}

function toRow(item, kindWord) {
  const ref = item.references && item.references.full ? item.references.full : '#' + item.iid;
  return {
    entity_type: 'social.message',
    external_id: 'gitlab:' + kindWord + ':' + item.id,
    payload: {
      messageId: 'gitlab:' + kindWord + ':' + item.id,
      subject: '[' + ref + '] ' + (item.title || ''),
      fromName: (item.author && item.author.username) || null,
      fromEmail: null,
      sentAt: item.created_at,
      body:
        kindWord +
        ' is ' +
        (item.state || 'open') +
        (item.description ? '\n\n' + String(item.description).slice(0, 4000) : ''),
      threadKey: 'gitlab:' + kindWord + ':' + item.id,
    },
    updatedAt: item.updated_at,
  };
}

export default async ({ ctx, log }) => {
  const me = await api(ctx, '/user');
  const principal = me.username || String(me.id);
  const begin = await ctx.vault.invoke({
    command: 'sync.begin_run',
    input: { kind: KIND, label: LABEL, principal: principal },
    purpose: PURPOSE,
  });
  const opened = begin && begin.output ? begin.output : begin;
  if (opened.refused) {
    return { summary: `skipped: ${opened.reason}`, output: { skipped: true } };
  }
  const { connection_id: connectionId, run_id: runId, cursors } = opened;

  try {
    const since = cursors && cursors['gitlab.updated_after'];
    const rows = [];
    let nextCursor = since || null;
    const params = new URLSearchParams({
      scope: 'all',
      state: 'all',
      order_by: 'updated_at',
      sort: 'asc',
      per_page: '50',
    });
    if (since) params.set('updated_after', String(since));
    const issues = await api(ctx, '/issues?' + params.toString());
    for (const issue of issues) {
      const row = toRow(issue, 'issue');
      if (!nextCursor || row.updatedAt > nextCursor) nextCursor = row.updatedAt;
      delete row.updatedAt;
      rows.push(row);
    }
    const mrs = await api(ctx, '/merge_requests?' + params.toString());
    for (const mr of mrs) {
      const row = toRow(mr, 'mr');
      if (!nextCursor || row.updatedAt > nextCursor) nextCursor = row.updatedAt;
      delete row.updatedAt;
      rows.push(row);
    }
    let staged = 0;
    let published = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const outcome = await ctx.vault.invoke({
        command: 'sync.stage_rows',
        input: { kind: KIND, label: LABEL, rows: rows.slice(i, i + 500) },
        purpose: PURPOSE,
      });
      const out = outcome && outcome.output ? outcome.output : {};
      staged += rows.slice(i, i + 500).length;
      if (out.published) published += (out.published.created || 0) + (out.published.updated || 0);
    }

    if (typeof nextCursor !== 'undefined' && nextCursor) {
      await ctx.vault.invoke({
        command: 'sync.set_cursor',
        input: { connection_id: connectionId, key: 'gitlab.updated_after', value: nextCursor },
        purpose: PURPOSE,
      });
    }
    await ctx.vault.invoke({
      command: 'sync.finish_run',
      input: { run_id: runId, ok: true, staged, published },
      purpose: PURPOSE,
    });
    log.info(`${KIND}: ${staged} staged`);
    return {
      summary: `pulled ${staged} item(s)${published ? `, ${published} published` : ''}`,
      output: { staged, published },
    };
  } catch (err) {
    await ctx.vault.invoke({
      command: 'sync.finish_run',
      input: { run_id: runId, ok: false, error: String((err && err.message) || err) },
      purpose: PURPOSE,
    });
    throw err;
  }
};
