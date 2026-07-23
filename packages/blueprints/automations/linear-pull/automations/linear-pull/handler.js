/**
 * Linear pull — GraphQL over api.linear.app with an API key.
 */

const KIND = 'pull.linear';
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
  const sourceId = 'linear:' + issue.id;
  return {
    entity_type: 'core.content_item',
    external_id: sourceId,
    payload: {
      sourceId,
      title: '[' + (issue.identifier || issue.id) + '] ' + (issue.title || ''),
      mediaType: 'application/vnd.linear.issue',
      sourceUrl: issue.url || sourceId,
      modifiedAt: issue.updatedAt || issue.createdAt || null,
      owner:
        (issue.assignee && issue.assignee.name) || (issue.creator && issue.creator.name) || null,
      body:
        (issue.state && issue.state.name ? 'Status: ' + issue.state.name + '\n\n' : '') +
        (issue.description || '').slice(0, 4000),
    },
  };
}

export default {
  protocol: 'centraid.pull/v1',
  async principal({ ctx }) {
    const viewer = await gql(ctx, '{ viewer { id name email } }');
    return (viewer.viewer && (viewer.viewer.email || viewer.viewer.name)) || 'linear';
  },
  async pull({ ctx, cursor }) {
    const traversal = cursor.provider('linear.after');
    const data = await gql(
      ctx,
      `query($after: String) {
        issues(first: 50, after: $after, orderBy: updatedAt) {
          pageInfo { hasNextPage endCursor }
          nodes { id identifier title description url createdAt updatedAt state { name } assignee { name } creator { name } }
        }
      }`,
      { after: traversal.current || null },
    );
    const rows = (data.issues.nodes || []).map(toRow);
    traversal.set(
      data.issues.pageInfo && data.issues.pageInfo.hasNextPage
        ? data.issues.pageInfo.endCursor
        : null,
    );
    return { rows, summary: `pulled ${rows.length} issue(s)` };
  },
};
