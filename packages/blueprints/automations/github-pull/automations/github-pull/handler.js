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

const PURPOSE = 'dpv:ServiceProvision';
const KIND = 'pull.github';
const LABEL = 'personal';
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
    throw new Error(`github ${path.split('?')[0]} answered ${res.status}: ${res.text.slice(0, 200)}`);
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

export default async ({ ctx, log }) => {
  // whoami: the PAT's owner login — the principal pin.
  const user = await api(ctx, '/user');
  const begin = await ctx.vault.invoke({
    command: 'sync.begin_run',
    input: { kind: KIND, label: LABEL, principal: user.login },
    purpose: PURPOSE,
  });
  const opened = begin && begin.output ? begin.output : begin;
  if (opened.refused) {
    return { summary: `skipped: ${opened.reason}`, output: { skipped: true } };
  }
  const { connection_id: connectionId, run_id: runId, cursors } = opened;

  try {
    const since = cursors && cursors['github.since'];
    const rows = [];
    let maxUpdated = since || null;
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
        if (!maxUpdated || row.updatedAt > maxUpdated) maxUpdated = row.updatedAt;
        delete row.updatedAt;
        rows.push(row);
      }
      if (listing.length < 100) break;
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

    if (maxUpdated) {
      await ctx.vault.invoke({
        command: 'sync.set_cursor',
        input: { connection_id: connectionId, key: 'github.since', value: maxUpdated },
        purpose: PURPOSE,
      });
    }
    await ctx.vault.invoke({
      command: 'sync.finish_run',
      input: { run_id: runId, ok: true, staged, published },
      purpose: PURPOSE,
    });
    log.info(`github pull: ${staged} staged`);
    return {
      summary: `pulled ${staged} issue(s)/PR(s)${published ? `, ${published} published` : ''}`,
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
