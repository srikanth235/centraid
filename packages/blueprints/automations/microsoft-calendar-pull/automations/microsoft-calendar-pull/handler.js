/**
 * pull.outlookcal connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const KIND = 'pull.outlookcal';
const API = 'https://graph.microsoft.com/v1.0';
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
  if (res.status === 410) return { gone: true };
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `${KIND} ${String(path).split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
  }
  if (!res.text) return {};
  return JSON.parse(res.text);
}

function toRow(ev) {
  const start = ev.start || {};
  const end = ev.end || {};
  return {
    entity_type: 'core.event',
    external_id: 'outlookcal:' + ev.id,
    payload: {
      uid: ev.iCalUId || 'outlookcal:' + ev.id,
      summary: ev.subject || '(untitled)',
      description: ev.bodyPreview || null,
      dtstart: start.dateTime || start.date || null,
      dtend: end.dateTime || end.date || null,
      startTz: start.timeZone || null,
      rrule: null,
      status: ev.isCancelled ? 'cancelled' : 'confirmed',
    },
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const me = await api(ctx, '/me?$select=mail,userPrincipalName');
    return (me.mail || me.userPrincipalName || 'outlook').toLowerCase();
  },
  async pull({ ctx, cursor }) {
    const traversal = cursor.provider('outlookcal.deltaLink');
    let nextLink = traversal.current;
    const rows = [];
    let resetTried = false;
    const center = new Date(ctx.now);
    const start = new Date(center);
    const end = new Date(center);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    end.setUTCFullYear(end.getUTCFullYear() + 2);
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const listing = await api(
        ctx,
        nextLink ||
          `/me/calendarView/delta?startDateTime=${encodeURIComponent(start.toISOString())}&endDateTime=${encodeURIComponent(end.toISOString())}`,
      );
      if (listing.gone) {
        if (resetTried) throw new Error(`${KIND} delta token remained invalid after reset`);
        traversal.clear();
        nextLink = null;
        resetTried = true;
        page -= 1;
        continue;
      }
      for (const event of listing.value || []) {
        if (!event['@removed']) rows.push(toRow(event));
      }
      nextLink = listing['@odata.nextLink'] || listing['@odata.deltaLink'] || null;
      if (!listing['@odata.nextLink']) break;
    }
    traversal.set(nextLink);
    return { rows, summary: `pulled ${rows.length} item(s)` };
  },
};
