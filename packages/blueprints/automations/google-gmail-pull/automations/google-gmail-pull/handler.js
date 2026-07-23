/**
 * Gmail pull (issue #304 phase 2) — the flagship broker-credential
 * connector. Deterministic published code, fetch-only (`requires.tools`
 * is []): the access token never appears here — `{{connection:access_token}}`
 * substitutes at the transport layer, pinned to gmail.googleapis.com.
 *
 * Shape per fire:
 *   1. whoami probe (users/me/profile) — the observed principal for
 *      the engine's principal-pinning gate, plus the CURRENT historyId (a safe
 *      watermark captured BEFORE listing, so nothing between list and
 *      cursor-set is lost).
 *   2. incremental: users/me/history from the stored cursor; first run (or
 *      an expired cursor, Gmail answers 404): last 30 days, bounded.
 *   3. per message: metadata-format fetch (headers + snippet only — bodies
 *      and attachments are the mbox/file-drop lane, issue #300).
 *   4. return social.message rows plus the provider cursor; the engine owns
 *      staging, cursor persistence, and run finalization.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const AUTH = { authorization: 'Bearer {{connection:access_token}}' };
/** Bound one fire's work; the next fire continues from the cursor. */
const MAX_MESSAGES_PER_RUN = 100;

async function api(ctx, path) {
  const res = await ctx.fetch({ url: `${API}${path}`, headers: AUTH });
  if (res.status === 404) return { notFound: true };
  if (res.status !== 200) {
    throw new Error(
      `gmail ${path.split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
  }
  return JSON.parse(res.text);
}

/** `Name <a@b.c>` → { name, email } — enough for the party resolver. */
function parseFrom(value) {
  if (!value) return { name: null, email: null };
  const m = value.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: value.trim().toLowerCase() };
}

function header(message, name) {
  const h = (message.payload && message.payload.headers) || [];
  const hit = h.find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : null;
}

let observedProfile;

export default {
  protocol: 'centraid.pull/v1',

  async principal({ ctx }) {
    // Capture the next watermark before listing so messages arriving during
    // this pull remain visible to the following run.
    observedProfile = await api(ctx, '/profile');
    return observedProfile.emailAddress;
  },

  async pull({ ctx, log, cursor }) {
    if (!observedProfile) throw new Error('gmail principal probe did not return a profile');
    const historyId = cursor.provider('gmail.historyId');
    // 2. Which message ids are new?
    const startHistoryId = historyId.current;
    const ids = [];
    let mode = 'incremental';
    if (startHistoryId) {
      let pageToken = null;
      do {
        const page = await api(
          ctx,
          `/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded&maxResults=100` +
            (pageToken ? `&pageToken=${pageToken}` : ''),
        );
        if (page.notFound) {
          // The cursor expired upstream — fall back to the bounded window.
          mode = 'window';
          break;
        }
        for (const h of page.history || []) {
          for (const added of h.messagesAdded || []) {
            if (added.message && added.message.id) ids.push(added.message.id);
          }
        }
        pageToken = page.nextPageToken || null;
      } while (pageToken && ids.length < MAX_MESSAGES_PER_RUN);
    } else {
      mode = 'window';
    }
    if (mode === 'window') {
      let pageToken = null;
      do {
        const page = await api(
          ctx,
          `/messages?q=newer_than:30d&maxResults=100` +
            (pageToken ? `&pageToken=${pageToken}` : ''),
        );
        for (const m of page.messages || []) ids.push(m.id);
        pageToken = page.nextPageToken || null;
      } while (pageToken && ids.length < MAX_MESSAGES_PER_RUN);
    }
    const batchIds = [...new Set(ids)].slice(0, MAX_MESSAGES_PER_RUN);

    // 3+4. Metadata per message → social.message staging rows.
    const rows = [];
    for (const id of batchIds) {
      const msg = await api(
        ctx,
        `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      );
      if (msg.notFound) continue; // deleted between list and fetch
      const from = parseFrom(header(msg, 'From'));
      rows.push({
        entity_type: 'social.message',
        external_id: `gmail:${msg.id}`,
        payload: {
          messageId: `gmail:${msg.id}`,
          subject: header(msg, 'Subject'),
          fromName: from.name,
          fromEmail: from.email,
          sentAt: new Date(Number(msg.internalDate)).toISOString(),
          body: msg.snippet || '',
          threadKey: `gmail-thread:${msg.threadId}`,
        },
      });
    }

    historyId.set(observedProfile.historyId);
    log.info(`gmail pull: ${rows.length} row(s) returned (${mode})`);
    return {
      rows,
      summary: `pulled ${rows.length} message(s) (${mode})`,
    };
  },
};
