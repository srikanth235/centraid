/**
 * Linear pull — GraphQL over api.linear.app with an API key.
 */

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.linear';
const LABEL = 'personal';
const API = 'https://api.linear.app/graphql';
const AUTH = { authorization: '{{connection:api_key}}', 'content-type': 'application/json' };

async function gql(ctx, query, variables) {
  const res = await ctx.fetch({
    url: API,
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (res.status !== 200) {
    throw new Error('linear graphql answered ' + res.status + ': ' + res.text.slice(0, 200));
  }
  const body = JSON.parse(res.text);
  if (body.errors && body.errors.length) {
    throw new Error('linear graphql error: ' + JSON.stringify(body.errors[0]).slice(0, 200));
  }
  return body.data;
}

function toRow(issue) {
  return {
    entity_type: 'social.message',
    external_id: 'linear:' + issue.id,
    payload: {
      messageId: 'linear:' + issue.id,
      subject: '[' + (issue.identifier || issue.id) + '] ' + (issue.title || ''),
      fromName:
        (issue.assignee && issue.assignee.name) || (issue.creator && issue.creator.name) || null,
      fromEmail: null,
      sentAt: issue.createdAt,
      body:
        (issue.state && issue.state.name ? 'Status: ' + issue.state.name + '\n\n' : '') +
        (issue.description || '').slice(0, 4000),
      threadKey: 'linear:' + issue.id,
    },
  };
}

export default async ({ ctx, log }) => {
  const viewer = await gql(ctx, '{ viewer { id name email } }');
  const principal = (viewer.viewer && (viewer.viewer.email || viewer.viewer.name)) || 'linear';
  const begin = await ctx.vault.invoke({
    command: 'sync.begin_run',
    input: { kind: KIND, label: LABEL, principal },
    purpose: PURPOSE,
  });
  const opened = begin && begin.output ? begin.output : begin;
  if (opened.refused) return { summary: 'skipped: ' + opened.reason, output: { skipped: true } };
  const { connection_id: connectionId, run_id: runId, cursors } = opened;
  try {
    const after = cursors && cursors['linear.after'];
    const data = await gql(
      ctx,
      `query($after: String) {
      issues(first: 50, after: $after, orderBy: updatedAt) {
        pageInfo { hasNextPage endCursor }
        nodes { id identifier title description createdAt updatedAt state { name } assignee { name } creator { name } }
      }
    }`,
      { after: after || null },
    );
    const rows = (data.issues.nodes || []).map(toRow);
    let staged = 0,
      published = 0;
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
    if (data.issues.pageInfo && data.issues.pageInfo.endCursor) {
      await ctx.vault.invoke({
        command: 'sync.set_cursor',
        input: {
          connection_id: connectionId,
          key: 'linear.after',
          value: data.issues.pageInfo.endCursor,
        },
        purpose: PURPOSE,
      });
    }
    await ctx.vault.invoke({
      command: 'sync.finish_run',
      input: { run_id: runId, ok: true, staged, published },
      purpose: PURPOSE,
    });
    log.info('linear pull: ' + staged + ' staged');
    return { summary: 'pulled ' + staged + ' issue(s)', output: { staged, published } };
  } catch (err) {
    await ctx.vault.invoke({
      command: 'sync.finish_run',
      input: { run_id: runId, ok: false, error: String((err && err.message) || err) },
      purpose: PURPOSE,
    });
    throw err;
  }
};
