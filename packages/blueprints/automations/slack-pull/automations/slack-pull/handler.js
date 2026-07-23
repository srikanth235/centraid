/**
 * pull.slack connector — read-only ingest through the connection broker.
 * Stages into the vault review band via sync.stage_rows; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.slack';
const LABEL = 'personal';
const API = 'https://slack.com/api';
const AUTH = { authorization: 'Bearer {{connection:api_key}}' };
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

function toRow(msg, channel) {
  return {
    entity_type: 'social.message',
    external_id: 'slack:' + channel + ':' + msg.ts,
    payload: {
      messageId: 'slack:' + channel + ':' + msg.ts,
      subject: 'Slack · ' + channel,
      fromName: msg.username || msg.user || null,
      fromEmail: null,
      sentAt: msg.ts ? new Date(Number(msg.ts) * 1000).toISOString() : null,
      body: msg.text || '',
      threadKey: 'slack:' + channel + ':' + (msg.thread_ts || msg.ts),
    },
  };
}

export default async ({ ctx, log }) => {
  const auth = await api(ctx, '/auth.test');
  if (auth.ok === false) throw new Error('slack auth.test failed: ' + (auth.error || 'unknown'));
  const principal = auth.user || auth.user_id || 'slack';
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
    const oldest = cursors && cursors['slack.oldest'];
    const rows = [];
    let nextCursor = oldest || null;
    const conv = await api(
      ctx,
      '/conversations.list?types=im,mpim,public_channel,private_channel&limit=20&exclude_archived=true',
    );
    if (conv.ok === false)
      throw new Error('slack conversations.list failed: ' + (conv.error || 'unknown'));
    for (const ch of conv.channels || []) {
      const hist = await api(
        ctx,
        '/conversations.history?channel=' +
          encodeURIComponent(ch.id) +
          '&limit=30' +
          (oldest ? '&oldest=' + encodeURIComponent(String(oldest)) : ''),
      );
      if (hist.ok === false) continue;
      for (const msg of hist.messages || []) {
        rows.push(toRow(msg, ch.name || ch.id));
        if (!nextCursor || msg.ts > nextCursor) nextCursor = msg.ts;
      }
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

    if (typeof nextCursor !== 'undefined' && nextCursor) {
      await ctx.vault.invoke({
        command: 'sync.set_cursor',
        input: { connection_id: connectionId, key: 'slack.oldest', value: nextCursor },
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
