/**
 * pull.gdrive connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 * Files stage as core.content_item so file metadata never masquerades as correspondence.
 */

const KIND = 'pull.gdrive';
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
  const sourceId = 'gdrive:' + file.id;
  const owner = file.owners && file.owners[0];
  return {
    entity_type: 'core.content_item',
    external_id: sourceId,
    payload: {
      sourceId,
      title: file.name || '(untitled)',
      mediaType: file.mimeType || 'application/octet-stream',
      sourceUrl: file.webViewLink || file.webContentLink || sourceId,
      modifiedAt: file.modifiedTime || file.createdTime || null,
      owner: (owner && (owner.emailAddress || owner.displayName)) || null,
      body: file.description || '',
    },
    updatedAt: file.modifiedTime || file.createdTime,
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const about = await api(ctx, '/about?fields=user');
    return (about.user && about.user.emailAddress) || 'drive';
  },
  async pull({ ctx, cursor }) {
    const modifiedAt = cursor.highWater('gdrive.modifiedTime');
    let pageToken = null;
    const rows = [];
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const params = new URLSearchParams({
        pageSize: '50',
        fields:
          'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,webContentLink,description,owners)',
        orderBy: 'modifiedTime asc',
        q: modifiedAt.current
          ? `trashed = false and modifiedTime >= '${String(modifiedAt.current)}'`
          : 'trashed = false',
      });
      if (pageToken) params.set('pageToken', String(pageToken));
      const listing = await api(ctx, '/files?' + params.toString());
      for (const item of listing.files || []) {
        const row = toRow(item);
        modifiedAt.observe(row.updatedAt);
        delete row.updatedAt;
        rows.push(row);
      }
      pageToken = listing.nextPageToken || null;
      if (!pageToken) break;
    }
    return { rows, summary: `pulled ${rows.length} item(s)` };
  },
};
