/**
 * Google Calendar pull (issue #304 phase 3) — sibling of the Gmail
 * connector on the SAME Google connection credential shape (its own
 * pull.gcal connection, its own cursor). Deterministic and clock-free:
 * the initial walk pages the whole primary calendar oldest-first (bounded
 * per fire, the pageToken cursor continues next fire) until the Calendar
 * API hands over a nextSyncToken; thereafter every fire is a syncToken
 * increment. A 410 GONE (expired token) restarts the walk honestly.
 */

const API = 'https://www.googleapis.com/calendar/v3';
const AUTH = { authorization: 'Bearer {{connection:access_token}}' };
/** Pages per fire on the initial walk (250 events each). */
const MAX_PAGES_PER_RUN = 4;

async function api(ctx, path) {
  const res = await ctx.fetch({ url: `${API}${path}`, headers: AUTH });
  if (res.status === 410) return { gone: true };
  if (res.status !== 200) {
    throw new Error(
      `calendar ${path.split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
  }
  return JSON.parse(res.text);
}

function toEventRow(event) {
  const start = event.start || {};
  const end = event.end || {};
  return {
    entity_type: 'core.event',
    external_id: `gcal:${event.id}`,
    payload: {
      uid: event.iCalUID || `gcal:${event.id}`,
      summary: event.summary || '(untitled)',
      description: event.description || null,
      dtstart: start.dateTime || start.date || null,
      dtend: end.dateTime || end.date || null,
      startTz: start.timeZone || null,
      rrule: Array.isArray(event.recurrence) ? event.recurrence.join('\n') : null,
      status: event.status || 'confirmed',
    },
  };
}

export default {
  protocol: 'centraid.pull/v1',

  async principal({ ctx }) {
    const primary = await api(ctx, '/calendars/primary');
    return primary.id;
  },

  async pull({ ctx, log, cursor }) {
    const syncCursor = cursor.provider('gcal.syncToken');
    const pageCursor = cursor.provider('gcal.pageToken');
    let syncToken = syncCursor.current;
    let pageToken = pageCursor.current;
    const rows = [];
    let nextSyncToken = null;
    let nextPageToken = null;
    let mode = syncToken ? 'incremental' : 'walk';

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const params = new URLSearchParams({ maxResults: '250', singleEvents: 'false' });
      // Calendar's contract: syncToken and pageToken are MUTUALLY EXCLUSIVE
      // (sending both is a 400). A continuation page — whether within this
      // fire or resumed across fires from a saved pageToken — carries the
      // pageToken alone; syncToken rides only the first page of an
      // incremental sync. (People API differs: it repeats both — see the
      // Contacts connector.)
      if (pageToken) {
        params.set('pageToken', String(pageToken));
      } else if (syncToken && mode === 'incremental') {
        params.set('syncToken', String(syncToken));
      }
      const listing = await api(ctx, `/calendars/primary/events?${params.toString()}`);
      if (listing.gone) {
        // Expired sync token: restart the walk from the top, next fire on.
        mode = 'walk';
        syncToken = null;
        pageToken = null;
        nextPageToken = null;
        nextSyncToken = null;
        break;
      }
      for (const event of listing.items || []) {
        if (event.status === 'cancelled' && !event.summary) continue; // bare tombstone of an uncached event
        rows.push(toEventRow(event));
      }
      nextPageToken = listing.nextPageToken || null;
      nextSyncToken = listing.nextSyncToken || null;
      if (!nextPageToken) break;
      pageToken = nextPageToken;
    }

    // Cursor discipline: a finished listing hands a syncToken (clear the
    // pageToken); an unfinished walk keeps its pageToken for the next fire.
    if (nextSyncToken) {
      syncCursor.set(nextSyncToken);
      pageCursor.clear();
    } else {
      pageCursor.set(nextPageToken);
      if (mode === 'walk' && !nextPageToken) {
        // A reset (410) also clears a stale syncToken so the next fire restarts.
        syncCursor.clear();
      }
    }
    log.info(`calendar pull: ${rows.length} row(s) returned (${mode})`);
    return {
      rows,
      summary: `pulled ${rows.length} event(s) (${mode})`,
    };
  },
};
