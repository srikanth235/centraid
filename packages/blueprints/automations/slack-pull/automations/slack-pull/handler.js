/**
 * pull.slack connector — read-only ingest through the connection broker.
 * Returns honest rows to the engine-owned staging run; credentials are
 * substituted at the transport layer ({{connection:…}}), never in handler code.
 */

const KIND = 'pull.slack';
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

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const auth = await api(ctx, '/auth.test');
    if (auth.ok === false) throw new Error('slack auth.test failed: ' + (auth.error || 'unknown'));
    return auth.user || auth.user_id || 'slack';
  },
  async pull({ ctx, log, cursor }) {
    const rows = [];
    const channels = [];
    const channelTraversal = cursor.provider('slack.channels_cursor');
    let channelsCursor = channelTraversal.current;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const listing = await api(
        ctx,
        '/conversations.list?types=im,mpim,public_channel,private_channel&limit=100&exclude_archived=true' +
          (channelsCursor ? '&cursor=' + encodeURIComponent(String(channelsCursor)) : ''),
      );
      if (listing.ok === false) {
        throw new Error('slack conversations.list failed: ' + (listing.error || 'unknown'));
      }
      channels.push(...(listing.channels || []));
      channelsCursor = (listing.response_metadata && listing.response_metadata.next_cursor) || null;
      if (!channelsCursor) break;
    }
    channelTraversal.set(channelsCursor);

    for (const channel of channels) {
      const highWater = cursor.highWater('slack.oldest.' + channel.id);
      const historyTraversal = cursor.provider('slack.history_cursor.' + channel.id);
      const oldest = highWater.current;
      let historyCursor = historyTraversal.current;
      let latest = oldest || null;
      let failed = false;
      for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
        const history = await api(
          ctx,
          '/conversations.history?channel=' +
            encodeURIComponent(channel.id) +
            '&limit=100' +
            (oldest ? '&oldest=' + encodeURIComponent(String(oldest)) : '') +
            (historyCursor ? '&cursor=' + encodeURIComponent(String(historyCursor)) : ''),
        );
        if (history.ok === false) {
          log.warn(
            `${KIND}: channel ${channel.id} history failed: ${history.error || 'unknown'}; cursor preserved`,
          );
          failed = true;
          break;
        }
        for (const message of history.messages || []) {
          rows.push(toRow(message, channel.name || channel.id));
          if (!latest || message.ts > latest) latest = message.ts;
        }
        historyCursor =
          (history.response_metadata && history.response_metadata.next_cursor) || null;
        if (!historyCursor) break;
      }
      if (failed) continue;
      historyTraversal.set(historyCursor);
      if (!historyCursor && latest) highWater.observe(latest);
    }

    return { rows, summary: `pulled ${rows.length} message(s)` };
  },
};
