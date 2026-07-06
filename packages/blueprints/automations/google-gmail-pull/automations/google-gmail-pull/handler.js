/**
 * Gmail pull (issue #304 phase 2) — the flagship broker-credential
 * connector. Deterministic published code, fetch-only (`requires.tools`
 * is []): the access token never appears here — `{{connection:access_token}}`
 * substitutes at the transport layer, pinned to gmail.googleapis.com.
 *
 * Shape per fire:
 *   1. whoami probe (users/me/profile) — the observed principal for
 *      `sync.begin_run`'s pinning gate, plus the CURRENT historyId (a safe
 *      watermark captured BEFORE listing, so nothing between list and
 *      cursor-set is lost).
 *   2. incremental: users/me/history from the stored cursor; first run (or
 *      an expired cursor, Gmail answers 404): last 30 days, bounded.
 *   3. per message: metadata-format fetch (headers + snippet only — bodies
 *      and attachments are the mbox/file-drop lane, issue #300).
 *   4. stage as social.message rows; the spine's external-id map dedupes.
 *   5. advance the cursor, close the run. Failures close the run failed —
 *      sync never dies silently (issue #290 decision 4.4).
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.gmail';
const LABEL = 'personal';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const AUTH = { authorization: 'Bearer {{connection:access_token}}' };
/** Bound one fire's work; the next fire continues from the cursor. */
const MAX_MESSAGES_PER_RUN = 100;

async function api(ctx, path) {
  const res = await ctx.fetch({ url: `${API}${path}`, headers: AUTH });
  if (res.status === 404) return { notFound: true };
  if (res.status !== 200) {
    throw new Error(`gmail ${path.split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`);
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

export default async ({ ctx, log }) => {
  // 1. whoami — the principal pin AND the next watermark, in one probe.
  const profile = await api(ctx, '/profile');
  const begin = await ctx.vault.invoke({
    command: 'sync.begin_run',
    input: { kind: KIND, label: LABEL, principal: profile.emailAddress },
    purpose: PURPOSE,
  });
  const opened = begin && begin.output ? begin.output : begin;
  if (opened.refused) {
    return { summary: `skipped: ${opened.reason}`, output: { skipped: true } };
  }
  const { connection_id: connectionId, run_id: runId, cursors } = opened;

  try {
    // 2. Which message ids are new?
    const startHistoryId = cursors && cursors['gmail.historyId'];
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
          `/messages?q=newer_than:30d&maxResults=100` + (pageToken ? `&pageToken=${pageToken}` : ''),
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

    // 5. Advance the watermark (captured at the profile probe) and close.
    await ctx.vault.invoke({
      command: 'sync.set_cursor',
      input: { connection_id: connectionId, key: 'gmail.historyId', value: profile.historyId },
      purpose: PURPOSE,
    });
    await ctx.vault.invoke({
      command: 'sync.finish_run',
      input: { run_id: runId, ok: true, staged, published },
      purpose: PURPOSE,
    });
    log.info(`gmail pull: ${staged} staged (${mode}), ${published} auto-published`);
    return {
      summary: `pulled ${staged} message(s) (${mode})${published ? `, ${published} published` : ''}`,
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
