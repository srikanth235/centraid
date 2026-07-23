/**
 * pull.todoist connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const KIND = 'pull.todoist';
const API = 'https://api.todoist.com/rest/v2';
const AUTH = { authorization: 'Bearer {{connection:api_key}}' };
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

function toRow(task) {
  const sourceId = 'todoist:' + task.id;
  return {
    entity_type: 'core.content_item',
    external_id: sourceId,
    payload: {
      sourceId,
      title: task.content || '(untitled task)',
      mediaType: 'application/vnd.todoist.task',
      sourceUrl: task.url || sourceId,
      modifiedAt: task.created_at || null,
      owner: null,
      body: [
        task.description || '',
        task.due && task.due.date ? 'Due: ' + task.due.date : null,
        task.priority ? 'Priority: ' + task.priority : null,
        task.url || null,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal() {
    return 'todoist';
  },
  async pull({ ctx }) {
    const tasks = await api(ctx, '/tasks');
    const rows = [];
    for (const task of tasks) {
      if (!task.is_completed) rows.push(toRow(task));
    }
    return { rows, summary: `pulled ${rows.length} item(s)` };
  },
};
