/**
 * pull.gitlab connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const KIND = 'pull.gitlab';
const API = 'https://gitlab.com/api/v4';
const AUTH = { 'PRIVATE-TOKEN': '{{connection:api_key}}' };
const PAGE_SIZE = 100;

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
  const sourceId = 'gitlab:' + kindWord + ':' + item.id;
  return {
    entity_type: 'core.content_item',
    external_id: sourceId,
    payload: {
      sourceId,
      title: '[' + ref + '] ' + (item.title || ''),
      mediaType: 'application/vnd.gitlab.' + kindWord,
      sourceUrl: item.web_url || sourceId,
      modifiedAt: item.updated_at || item.created_at || null,
      owner: (item.author && item.author.username) || null,
      body:
        kindWord +
        ' is ' +
        (item.state || 'open') +
        (item.description ? '\n\n' + String(item.description).slice(0, 4000) : ''),
    },
    updatedAt: item.updated_at,
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const me = await api(ctx, '/user');
    return me.username || String(me.id);
  },
  async pull({ ctx, cursor }) {
    const rows = [];
    for (const [path, kindWord, highWater] of [
      ['/issues?', 'issue', cursor.highWater('gitlab.issues.updated_after')],
      ['/merge_requests?', 'mr', cursor.highWater('gitlab.merge_requests.updated_after')],
    ]) {
      // Issues and merge requests are independent mutable collections. Each
      // gets its own watermark, and every page is drained before that
      // watermark advances.
      let page = 1;
      let items;
      do {
        const params = new URLSearchParams({
          scope: 'all',
          state: 'all',
          order_by: 'updated_at',
          sort: 'asc',
          per_page: String(PAGE_SIZE),
          page: String(page),
        });
        if (highWater.current) params.set('updated_after', String(highWater.current));
        items = await api(ctx, path + params.toString());
        for (const item of items) {
          const row = toRow(item, kindWord);
          highWater.observe(row.updatedAt);
          delete row.updatedAt;
          rows.push(row);
        }
        page += 1;
      } while (items.length === PAGE_SIZE);
    }
    return { rows, summary: `pulled ${rows.length} item(s)` };
  },
};
