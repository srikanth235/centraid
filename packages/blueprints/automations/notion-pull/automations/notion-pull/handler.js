/**
 * pull.notion connector — read-only ingest through the connection broker.
 * Stages into the vault review band via sync.stage_rows; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.notion';
const LABEL = 'personal';
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
    throw new Error(
      `${KIND} ${String(path).split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
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
  return {
    entity_type: 'social.message',
    external_id: 'notion:' + page.id,
    payload: {
      messageId: 'notion:' + page.id,
      subject: titleOf(page),
      fromName: 'Notion',
      fromEmail: null,
      sentAt: page.last_edited_time || page.created_time || null,
      body: 'Notion page ' + (page.url || page.id),
      threadKey: 'notion:' + page.id,
    },
  };
}

export default async ({ ctx, log }) => {
  const me = await api(ctx, '/users/me');
  const principal =
    (me.bot && me.bot.owner && me.bot.owner.user && me.bot.owner.user.name) || me.name || 'notion';
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
    const start = cursors && cursors['notion.start_cursor'];
    const rows = [];
    let nextCursor = null;
    const body = { page_size: 50, filter: { property: 'object', value: 'page' } };
    if (start) body.start_cursor = String(start);
    // search is POST
    const listing = await api(ctx, '/search', { method: 'POST', body: JSON.stringify(body) });
    for (const page of listing.results || []) {
      if (page.object === 'page') rows.push(toRow(page));
    }
    nextCursor = listing.has_more && listing.next_cursor ? listing.next_cursor : null;
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
        input: { connection_id: connectionId, key: 'notion.start_cursor', value: nextCursor },
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
