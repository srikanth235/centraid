/**
 * Google Contacts pull (issue #304 phase 3) — People API → core.party
 * through the merge-aware staging spine: the party publisher probes by
 * email/phone identifier overlap, so a contact you already have becomes an
 * update-or-skip disposition in review, never a blind duplicate. Same
 * cursor discipline as the calendar connector: bounded initial walk on
 * pageToken, then syncToken increments; an expired token (410) restarts.
 */

const API = 'https://people.googleapis.com/v1';
const AUTH = { authorization: 'Bearer {{connection:access_token}}' };
const FIELDS = 'names,emailAddresses,phoneNumbers,birthdays';
const MAX_PAGES_PER_RUN = 4;

async function api(ctx, path) {
  const res = await ctx.fetch({ url: `${API}${path}`, headers: AUTH });
  if (res.status === 410) return { gone: true };
  if (res.status !== 200) {
    throw new Error(
      `people ${path.split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
  }
  return JSON.parse(res.text);
}

function toPartyRow(person) {
  const name = (person.names || [])[0] || {};
  const identifiers = [];
  for (const email of person.emailAddresses || []) {
    if (email.value) {
      identifiers.push({
        scheme: 'email',
        value: String(email.value).trim().toLowerCase(),
        label: email.type || null,
      });
    }
  }
  for (const phone of person.phoneNumbers || []) {
    if (phone.value) {
      identifiers.push({
        scheme: 'tel',
        value: String(phone.value).trim(),
        label: phone.type || null,
      });
    }
  }
  const bday = ((person.birthdays || [])[0] || {}).date;
  const fn = name.displayName || identifiers.map((i) => i.value)[0];
  if (!fn) return null; // a nameless, identifier-less shell is unstageable
  return {
    entity_type: 'core.party',
    external_id: `gcontacts:${person.resourceName}`,
    payload: {
      fn,
      sortName: name.familyName
        ? `${name.familyName}${name.givenName ? `, ${name.givenName}` : ''}`
        : null,
      bday:
        bday && bday.month && bday.day
          ? `${bday.year || '--'}-${String(bday.month).padStart(2, '0')}-${String(bday.day).padStart(2, '0')}`
          : null,
      identifiers,
    },
  };
}

export default {
  protocol: 'centraid.pull/v1',

  async principal({ ctx }) {
    const me = await api(ctx, '/people/me?personFields=emailAddresses');
    return (((me.emailAddresses || [])[0] || {}).value || '').toLowerCase();
  },

  async pull({ ctx, log, cursor }) {
    const syncCursor = cursor.provider('gcontacts.syncToken');
    const pageCursor = cursor.provider('gcontacts.pageToken');
    let syncToken = syncCursor.current;
    let pageToken = pageCursor.current;
    let mode = syncToken ? 'incremental' : 'walk';
    const rows = [];
    let nextSyncToken = null;
    let nextPageToken = null;

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const params = new URLSearchParams({
        personFields: FIELDS,
        pageSize: '200',
        requestSyncToken: 'true',
      });
      if (syncToken && mode === 'incremental') params.set('syncToken', String(syncToken));
      if (pageToken) params.set('pageToken', String(pageToken));
      const listing = await api(ctx, `/people/me/connections?${params.toString()}`);
      if (listing.gone) {
        mode = 'walk';
        syncToken = null;
        pageToken = null;
        nextPageToken = null;
        nextSyncToken = null;
        break;
      }
      for (const person of listing.connections || []) {
        const row = toPartyRow(person);
        if (row) rows.push(row);
      }
      nextPageToken = listing.nextPageToken || null;
      nextSyncToken = listing.nextSyncToken || null;
      if (!nextPageToken) break;
      pageToken = nextPageToken;
    }

    if (nextSyncToken) {
      syncCursor.set(nextSyncToken);
      pageCursor.clear();
    } else {
      pageCursor.set(nextPageToken);
      if (mode === 'walk' && !nextPageToken) {
        syncCursor.clear();
      }
    }
    log.info(`contacts pull: ${rows.length} row(s) returned (${mode})`);
    return {
      rows,
      summary: `pulled ${rows.length} contact(s) (${mode})`,
    };
  },
};
