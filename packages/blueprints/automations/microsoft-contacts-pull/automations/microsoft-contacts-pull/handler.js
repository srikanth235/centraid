/**
 * pull.outlookcontacts connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const KIND = 'pull.outlookcontacts';
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
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `${KIND} ${String(path).split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
  }
  if (!res.text) return {};
  return JSON.parse(res.text);
}

function toRow(c) {
  const identifiers = [];
  for (const e of c.emailAddresses || []) {
    if (e.address)
      identifiers.push({
        scheme: 'email',
        value: String(e.address).toLowerCase(),
        label: e.name || null,
      });
  }
  for (const p of c.mobilePhone ? [c.mobilePhone] : []) {
    if (p) identifiers.push({ scheme: 'tel', value: String(p).trim(), label: 'mobile' });
  }
  const fn = c.displayName || (identifiers[0] && identifiers[0].value);
  if (!fn) return null;
  return {
    entity_type: 'core.party',
    external_id: 'outlookcontacts:' + c.id,
    payload: {
      fn,
      sortName: c.surname ? c.surname + (c.givenName ? ', ' + c.givenName : '') : null,
      bday: c.birthday ? String(c.birthday).slice(0, 10) : null,
      identifiers,
    },
    updatedAt: c.lastModifiedDateTime,
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const me = await api(ctx, '/me?$select=mail,userPrincipalName');
    return (me.mail || me.userPrincipalName || 'outlook').toLowerCase();
  },
  async pull({ ctx, cursor }) {
    const modifiedAt = cursor.highWater('outlookcontacts.modifiedAt');
    const params = new URLSearchParams({
      $top: '50',
      $orderby: 'lastModifiedDateTime asc',
      $select:
        'id,displayName,givenName,surname,emailAddresses,mobilePhone,birthday,lastModifiedDateTime',
    });
    if (modifiedAt.current) {
      params.set('$filter', `lastModifiedDateTime ge ${String(modifiedAt.current)}`);
    }
    let nextLink = '/me/contacts?' + params.toString();
    const rows = [];
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const listing = await api(ctx, nextLink);
      for (const contact of listing.value || []) {
        const row = toRow(contact);
        if (row) {
          modifiedAt.observe(row.updatedAt);
          delete row.updatedAt;
          rows.push(row);
        }
      }
      nextLink = listing['@odata.nextLink'] || null;
      if (!nextLink) break;
    }
    return { rows, summary: `pulled ${rows.length} item(s)` };
  },
};
