/**
 * Google Contacts pull (issue #304 phase 3) — People API → core.party
 * through the merge-aware staging spine: the party publisher probes by
 * email/phone identifier overlap, so a contact you already have becomes an
 * update-or-skip disposition in review, never a blind duplicate. Same
 * cursor discipline as the calendar connector: bounded initial walk on
 * pageToken, then syncToken increments; an expired token (410) restarts.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.gcontacts';
const LABEL = 'personal';
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

export default async ({ ctx, log }) => {
  // whoami: the account's own profile email — the principal pin.
  const me = await api(ctx, '/people/me?personFields=emailAddresses');
  const primaryEmail = (((me.emailAddresses || [])[0] || {}).value || '').toLowerCase();
  const begin = await ctx.vault.invoke({
    command: 'sync.begin_run',
    input: {
      kind: KIND,
      label: LABEL,
      ...(primaryEmail ? { principal: primaryEmail } : {}),
    },
    purpose: PURPOSE,
  });
  const opened = begin && begin.output ? begin.output : begin;
  if (opened.refused) {
    return { summary: `skipped: ${opened.reason}`, output: { skipped: true } };
  }
  const { connection_id: connectionId, run_id: runId, cursors } = opened;

  try {
    let syncToken = cursors && cursors['gcontacts.syncToken'];
    let pageToken = cursors && cursors['gcontacts.pageToken'];
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

    if (nextSyncToken) {
      await ctx.vault.invoke({
        command: 'sync.set_cursor',
        input: { connection_id: connectionId, key: 'gcontacts.syncToken', value: nextSyncToken },
        purpose: PURPOSE,
      });
      await ctx.vault.invoke({
        command: 'sync.set_cursor',
        input: { connection_id: connectionId, key: 'gcontacts.pageToken', value: null },
        purpose: PURPOSE,
      });
    } else {
      await ctx.vault.invoke({
        command: 'sync.set_cursor',
        input: { connection_id: connectionId, key: 'gcontacts.pageToken', value: nextPageToken },
        purpose: PURPOSE,
      });
      if (mode === 'walk' && !nextPageToken) {
        await ctx.vault.invoke({
          command: 'sync.set_cursor',
          input: { connection_id: connectionId, key: 'gcontacts.syncToken', value: null },
          purpose: PURPOSE,
        });
      }
    }
    await ctx.vault.invoke({
      command: 'sync.finish_run',
      input: { run_id: runId, ok: true, staged, published },
      purpose: PURPOSE,
    });
    log.info(`contacts pull: ${staged} staged (${mode})`);
    return {
      summary: `pulled ${staged} contact(s) (${mode})${published ? `, ${published} published` : ''}`,
      output: { staged, published, mode },
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
