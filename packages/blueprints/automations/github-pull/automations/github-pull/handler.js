/**
 * GitHub pull (issue #304 phase 4) — the api_key lane in anger: a
 * fine-grained PAT on the connection's sidecar, injected as
 * `{{connection:api_key}}`, no OAuth machinery at all. Issues and PRs the
 * owner is involved in become threaded messages (one thread per issue);
 * the spine's content-hash dedup turns an unchanged issue into a skip and
 * an updated one into a reviewed update. Incremental via the `since`
 * parameter fed from the max `updated_at` this connector has seen — a
 * cursor, never a wall clock.
 */

const API = 'https://api.github.com';
const AUTH = {
  authorization: 'Bearer {{connection:api_key}}',
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'centraid-connector',
};
const MAX_PAGES_PER_RUN = 3;

async function api(ctx, path) {
  const res = await ctx.fetch({ url: `${API}${path}`, headers: AUTH });
  if (res.status !== 200) {
    throw new Error(
      `github ${path.split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`,
    );
  }
  return JSON.parse(res.text);
}

function toIssueRow(issue) {
  const repo =
    (issue.repository && issue.repository.full_name) ||
    (issue.repository_url || '').split('/repos/')[1] ||
    'unknown/unknown';
  const ref = `${repo}#${issue.number}`;
  const kindWord = issue.pull_request ? 'PR' : 'issue';
  return {
    entity_type: 'social.message',
    external_id: `github:${repo}/${issue.number}`,
    payload: {
      messageId: `github:${repo}/${issue.number}`,
      subject: `[${ref}] ${issue.title}`,
      fromName: (issue.user && issue.user.login) || null,
      fromEmail: null,
      sentAt: issue.created_at,
      body:
        `${kindWord} ${ref} is ${issue.state}` +
        (issue.body ? `\n\n${String(issue.body).slice(0, 4000)}` : ''),
      threadKey: `github:${ref}`,
    },
    updatedAt: issue.updated_at,
  };
}

export default {
  protocol: 'centraid.pull/v1',

  async principal({ ctx }) {
    const user = await api(ctx, '/user');
    return user.login;
  },

  async pull({ ctx, log, cursor }) {
    const updatedAt = cursor.highWater('github.since');
    const since = updatedAt.current;
    const rows = [];
    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      const params = new URLSearchParams({
        filter: 'all',
        state: 'all',
        sort: 'updated',
        direction: 'asc',
        per_page: '100',
        page: String(page),
      });
      if (since) params.set('since', String(since));
      const listing = await api(ctx, `/issues?${params.toString()}`);
      for (const issue of listing) {
        const row = toIssueRow(issue);
        updatedAt.observe(row.updatedAt);
        delete row.updatedAt;
        rows.push(row);
      }
      if (listing.length < 100) break;
    }

    log.info(`github pull: ${rows.length} row(s) returned`);
    return {
      rows,
      summary: `pulled ${rows.length} issue(s)/PR(s)`,
    };
  },
};
