/**
 * Document deadlines (issue #299 phase 4) — obligations out of documents.
 *
 * Per newly readable document, one bounded text turn extracts DATED
 * obligations (expiry / renewal / due). Each stages a tentative
 * `core.event` (uid `obligation:<content_id>:<n>`) on the
 * `enrichment.obligations` connection — staged for review like every
 * cross-domain write, and once published, the renewal-reminders
 * condition trigger (dtstart within the next 14 days) watches them.
 * A dateless obligation is dropped: inventing a date is a guess.
 */

const BATCH = 6;
const PURPOSE = 'dpv:ServiceProvision';

const OBLIGATIONS_SCHEMA = {
  type: 'object',
  required: ['obligations'],
  additionalProperties: false,
  properties: {
    obligations: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['what', 'kind', 'date'],
        additionalProperties: false,
        properties: {
          what: { type: 'string', description: 'e.g. "Home insurance policy renewal".' },
          kind: { type: 'string', enum: ['expiry', 'renewal', 'due'] },
          date: { type: 'string', description: 'The VISIBLE date, ISO (YYYY-MM-DD).' },
        },
      },
    },
  },
};

export default async ({ ctx, log }) => {
  const cursor = (await ctx.state.get('cursor')) ?? '';
  const read = await ctx.vault.read({
    entity: 'core.content_derivative',
    where: [
      { column: 'derivative_id', op: 'gt', value: cursor },
      { column: 'variant', op: 'eq', value: 'text' },
    ],
    orderBy: { column: 'derivative_id', dir: 'asc' },
    limit: BATCH,
    purpose: PURPOSE,
  });
  const derivatives = read.rows ?? [];
  if (derivatives.length === 0) return { summary: 'no newly readable documents to scan' };

  const rows = [];
  let lastSeen = cursor;
  for (const derivative of derivatives) {
    lastSeen = derivative.derivative_id;
    const contentId = derivative.content_id;
    const out = await ctx.agent({
      prompt:
        'Find dated obligations in the attached document text: expiry dates, renewal ' +
        'deadlines, payment due dates. Return each with what it is, its kind, and the date ' +
        'EXACTLY as visible (ISO). Skip anything without an explicit date.',
      json: OBLIGATIONS_SCHEMA,
      content: [{ contentId, variant: 'text' }],
    });
    (Array.isArray(out?.obligations) ? out.obligations : []).forEach((obligation, n) => {
      if (typeof obligation.date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(obligation.date)) {
        return; // dateless or malformed — dropped, never invented
      }
      rows.push({
        entity_type: 'core.event',
        external_id: `obligation:${contentId}:${n}`,
        payload: {
          uid: `obligation:${contentId}:${n}`,
          summary: `${obligation.what} (${obligation.kind})`,
          description: 'Extracted from a document — review before trusting.',
          dtstart: obligation.date.slice(0, 10),
          dtend: null,
          startTz: null,
          rrule: null,
          status: 'tentative',
        },
      });
    });
  }

  if (rows.length > 0) {
    await ctx.vault.invoke({
      command: 'sync.stage_rows',
      input: { kind: 'enrichment.obligations', label: 'docs', rows },
      purpose: PURPOSE,
    });
    log.info(`${rows.length} obligation(s) staged for review`);
  }
  await ctx.state.set('cursor', lastSeen);
  return {
    summary:
      rows.length > 0
        ? `staged ${rows.length} dated obligation(s) — awaiting your review`
        : 'no dated obligations found',
    output: { obligations: rows.length },
  };
};
