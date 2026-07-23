/**
 * pull.outlook connector — read-only ingest through the connection broker.
 * Stages into the vault review band via sync.stage_rows; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.outlook';
const LABEL = 'personal';
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

function toRow(msg) {
  const from = (msg.from && msg.from.emailAddress) || {};
  return {
    entity_type: 'social.message',
    external_id: 'outlook:' + msg.id,
    payload: {
      messageId: 'outlook:' + msg.id,
      subject: msg.subject || '(no subject)',
      fromName: from.name || null,
      fromEmail: (from.address || '').toLowerCase() || null,
      sentAt: msg.receivedDateTime || msg.sentDateTime || null,
      body: msg.bodyPreview || '',
      threadKey: 'outlook-conv:' + (msg.conversationId || msg.id),
    },
  };
}

export default async ({ ctx, log }) => {
  const me = await api(ctx, '/me?$select=mail,userPrincipalName,displayName');
  const principal = (me.mail || me.userPrincipalName || 'outlook').toLowerCase();
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
    const skip = Number((cursors && cursors['outlook.skip']) || 0);
    const rows = [];
    let nextCursor = null;
    const listing = await api(
      ctx,
      '/me/messages?$top=50&$skip=' +
        skip +
        '&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,sentDateTime,bodyPreview,conversationId',
    );
    for (const msg of listing.value || []) rows.push(toRow(msg));
    nextCursor = listing['@odata.nextLink'] ? String(skip + (listing.value || []).length) : null;
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
        input: { connection_id: connectionId, key: 'outlook.skip', value: nextCursor },
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
