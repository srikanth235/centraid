/**
 * pull.notion connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const KIND = 'pull.notion';
const API = 'https://api.notion.com/v1';
const AUTH = {
  authorization: 'Bearer {{connection:api_key}}',
  'Notion-Version': '2022-06-28',
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

function titleOf(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p && p.type === 'title' && Array.isArray(p.title)) {
      return p.title.map((t) => t.plain_text || '').join('') || '(untitled)';
    }
  }
  return '(untitled)';
}
function toRow(page) {
  const sourceId = 'notion:' + page.id;
  return {
    entity_type: 'core.content_item',
    external_id: sourceId,
    payload: {
      sourceId,
      title: titleOf(page),
      mediaType: 'application/vnd.notion.page',
      sourceUrl: page.url || sourceId,
      modifiedAt: page.last_edited_time || page.created_time || null,
      owner: (page.last_edited_by && (page.last_edited_by.name || page.last_edited_by.id)) || null,
      body: '',
    },
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const me = await api(ctx, '/users/me');
    return (
      (me.bot && me.bot.owner && me.bot.owner.user && me.bot.owner.user.name) || me.name || 'notion'
    );
  },
  async pull({ ctx, cursor }) {
    const traversal = cursor.provider('notion.start_cursor');
    let start = traversal.current;
    const rows = [];
    let resetTried = false;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const body = { page_size: 50, filter: { property: 'object', value: 'page' } };
      if (start) body.start_cursor = String(start);
      let listing;
      try {
        listing = await api(ctx, '/search', { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        const invalidCursor =
          start &&
          error &&
          error.status === 400 &&
          /cursor|start_cursor/i.test(String(error.responseText || error.message || ''));
        if (!invalidCursor || resetTried) throw error;
        traversal.clear();
        start = null;
        resetTried = true;
        page -= 1;
        continue;
      }
      for (const result of listing.results || []) {
        if (result.object === 'page') rows.push(toRow(result));
      }
      start = listing.has_more && listing.next_cursor ? listing.next_cursor : null;
      if (!start) break;
    }
    traversal.set(start);
    return { rows, summary: `pulled ${rows.length} item(s)` };
  },
};
