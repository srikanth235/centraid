/**
 * pull.dropbox connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const KIND = 'pull.dropbox';
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
    const error = new Error(
      `${KIND} ${String(path).split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
    error.status = res.status;
    error.responseText = res.text;
    throw error;
  }
  if (!res.text) return {};
  return JSON.parse(res.text);
}

function toRow(entry, owner) {
  const sourceId = 'dropbox:' + (entry.id || entry.path_lower);
  return {
    entity_type: 'core.content_item',
    external_id: sourceId,
    payload: {
      sourceId,
      title: entry.name || entry.path_display || '(file)',
      mediaType: 'application/octet-stream',
      sourceUrl: entry.path_display ? 'dropbox:' + entry.path_display : sourceId,
      modifiedAt: entry.server_modified || entry.client_modified || null,
      owner: owner || null,
      body: entry.size ? entry.size + ' bytes' : '',
    },
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const account = await api(ctx, '/users/get_current_account', { method: 'POST', body: 'null' });
    return (account.email || account.account_id || 'dropbox').toLowerCase();
  },
  async pull({ ctx, cursor }) {
    const traversal = cursor.provider('dropbox.cursor');
    let providerCursor = traversal.current;
    const rows = [];
    let resetTried = false;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      let listing;
      try {
        listing = providerCursor
          ? await api(ctx, '/files/list_folder/continue', {
              method: 'POST',
              body: JSON.stringify({ cursor: String(providerCursor) }),
            })
          : await api(ctx, '/files/list_folder', {
              method: 'POST',
              body: JSON.stringify({
                path: '',
                recursive: false,
                limit: 100,
                include_media_info: false,
              }),
            });
      } catch (error) {
        const reset =
          providerCursor &&
          error &&
          error.status === 409 &&
          String(error.responseText || error.message || '').includes('reset');
        if (!reset || resetTried) throw error;
        providerCursor = null;
        traversal.clear();
        resetTried = true;
        page -= 1;
        continue;
      }
      for (const entry of listing.entries || []) {
        if (entry['.tag'] === 'file') rows.push(toRow(entry, null));
      }
      providerCursor = listing.cursor || null;
      if (!listing.has_more) break;
    }
    traversal.set(providerCursor);
    return { rows, summary: `pulled ${rows.length} item(s)` };
  },
};
