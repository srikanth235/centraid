/**
 * Release notes drafter — fires on an inbound GitHub `pull_request` webhook
 * (the owner points their repo's Settings -> Webhooks at this automation's
 * minted URL). Only a merge into the PR's base branch is worth a model
 * turn -- every other `pull_request` action (opened, synchronize, closed
 * without merging, ...) is filtered out for free, before anything is
 * billed. One bounded text turn then turns the PR's title and description
 * into a short, end-user-facing note.
 *
 * No vault write: this automation isn't a connector and isn't wired to a
 * blueprint app, so the draft rides back as the run's `output` -- visible
 * in the automation's run history for the owner to read and copy out.
 */

const RELEASE_NOTE_SCHEMA = {
  type: 'object',
  required: ['headline', 'body'],
  additionalProperties: false,
  properties: {
    headline: {
      type: 'string',
      description: 'One line, the most visible user-facing change first.',
    },
    body: {
      type: 'string',
      description: 'A short paragraph in plain language -- no internals, no refactor talk.',
    },
  },
};

export default async ({ ctx, log }) => {
  const payload = ctx.input;
  const pr = payload && typeof payload === 'object' ? payload.pull_request : null;

  if (!pr || payload.action !== 'closed' || pr.merged !== true) {
    return { summary: 'skipped: not a merge event' };
  }

  const repo = payload.repository && payload.repository.full_name;
  const number = pr.number;
  const title = String(pr.title || '').slice(0, 300);
  const body = String(pr.body || '').slice(0, 4000);
  const where = [repo, number ? `#${number}` : null].filter(Boolean).join(' ');

  const draft = await ctx.agent({
    prompt:
      `A pull request just merged${where ? ` in ${where}` : ''}.\n\n` +
      `Title: ${title}\n\nDescription:\n${body || '(none)'}\n\n` +
      'Draft one short release note for end users: lead with the most visible change, ' +
      'skip internal refactors and implementation detail, plain language. If the PR is ' +
      'purely internal (refactor, tests, tooling, CI) with nothing user-visible, say so ' +
      'plainly instead of inventing a change.',
    json: RELEASE_NOTE_SCHEMA,
  });

  const headline =
    draft && typeof draft.headline === 'string' && draft.headline.trim()
      ? draft.headline.trim()
      : 'release note drafted';
  log.info(`drafted release note for ${where || 'merge'}: ${headline}`);
  return { summary: headline, output: draft };
};
