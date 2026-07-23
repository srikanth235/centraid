/**
 * pull.dropbox connector — read-only ingest through the connection broker.
 * Stages into the vault review band via sync.stage_rows; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.dropbox';
const LABEL = 'personal';
const API = 'https://api.dropboxapi.com/2';
const AUTH = {
  authorization: 'Bearer {{connection:access_token}}',
  'content-type': 'application/json',
};
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

function toRow(entry) {
  return {
    entity_type: 'social.message',
    external_id: 'dropbox:' + (entry.id || entry.path_lower),
    payload: {
      messageId: 'dropbox:' + (entry.id || entry.path_lower),
      subject: entry.name || entry.path_display || '(file)',
      fromName: 'Dropbox',
      fromEmail: null,
      sentAt: entry.client_modified || entry.server_modified || null,
      body: [entry.path_display, entry['.tag'], entry.size ? entry.size + ' bytes' : null]
        .filter(Boolean)
        .join('\n'),
      threadKey: 'dropbox:' + (entry.id || entry.path_lower),
    },
  };
}

export default async ({ ctx, log }) => {
  const acct = await api(ctx, '/users/get_current_account', { method: 'POST', body: 'null' });
  const principal = (acct.email || acct.account_id || 'dropbox').toLowerCase();
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
    const cursor = cursors && cursors['dropbox.cursor'];
    const rows = [];
    let nextCursor = null;
    let listing;
    if (cursor) {
      listing = await api(ctx, '/files/list_folder/continue', {
        method: 'POST',
        body: JSON.stringify({ cursor: String(cursor) }),
      });
    } else {
      listing = await api(ctx, '/files/list_folder', {
        method: 'POST',
        body: JSON.stringify({ path: '', recursive: false, limit: 100, include_media_info: false }),
      });
    }
    for (const entry of listing.entries || []) {
      if (entry['.tag'] === 'file') rows.push(toRow(entry));
    }
    nextCursor = listing.cursor || null;
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
        input: { connection_id: connectionId, key: 'dropbox.cursor', value: nextCursor },
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
