/**
 * pull.gdrive connector — read-only ingest through the connection broker.
 * Stages into the vault review band via sync.stage_rows; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 * Files stage as social.message so the assistant can search/summarize without a full blob copy.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.gdrive';
const LABEL = 'personal';
const API = 'https://www.googleapis.com/drive/v3';
const AUTH = { authorization: 'Bearer {{connection:access_token}}' };
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

function toRow(file) {
  return {
    entity_type: 'social.message',
    external_id: 'gdrive:' + file.id,
    payload: {
      messageId: 'gdrive:' + file.id,
      subject: file.name || '(untitled)',
      fromName: (file.owners && file.owners[0] && file.owners[0].displayName) || 'Drive',
      fromEmail: (file.owners && file.owners[0] && file.owners[0].emailAddress) || null,
      sentAt: file.modifiedTime || file.createdTime || null,
      body: [file.mimeType, file.webViewLink || file.webContentLink, file.description]
        .filter(Boolean)
        .join('\n'),
      threadKey: 'gdrive:' + file.id,
    },
  };
}

export default async ({ ctx, log }) => {
  const about = await api(ctx, '/about?fields=user');
  const principal = (about.user && about.user.emailAddress) || 'drive';
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
    const pageToken = cursors && cursors['gdrive.pageToken'];
    const rows = [];
    let nextCursor = null;
    const params = new URLSearchParams({
      pageSize: '50',
      fields:
        'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,webContentLink,description,owners)',
      orderBy: 'modifiedTime desc',
      q: 'trashed = false',
    });
    if (pageToken) params.set('pageToken', String(pageToken));
    const listing = await api(ctx, '/files?' + params.toString());
    for (const file of listing.files || []) rows.push(toRow(file));
    nextCursor = listing.nextPageToken || null;
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
        input: { connection_id: connectionId, key: 'gdrive.pageToken', value: nextCursor },
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
