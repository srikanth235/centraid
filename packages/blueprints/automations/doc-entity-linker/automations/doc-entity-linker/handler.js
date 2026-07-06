/**
 * Document links (issue #299 phase 4) — entity mentions become anchored
 * references, with the #282 machinery and a machine author.
 *
 * Per newly readable document: one bounded text turn extracts PERSON
 * mentions with their exact quoted passage; mentions are then matched —
 * in plain code, case-insensitively — against the party names ALREADY in
 * the vault (the model never invents contacts, and an unmatched mention
 * is simply dropped). Each match asserts `core.link_entities`
 * (document —references→ person) carrying the W3C text-quote selector
 * inline, so the CRM timeline can show "documents mentioning Rahul" and
 * the reference opens at the exact passage. The command's own
 * no-identical-live-link precondition makes re-runs idempotent — a
 * duplicate assertion is a caught refusal, not a second edge.
 */

const BATCH = 6;
const PURPOSE = 'dpv:ServiceProvision';

const MENTIONS_SCHEMA = {
  type: 'object',
  required: ['mentions'],
  additionalProperties: false,
  properties: {
    mentions: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        required: ['name', 'exact'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: "The person's name as the document uses it." },
          exact: {
            type: 'string',
            description: 'The exact short passage (≤200 chars) containing the mention, verbatim.',
          },
          prefix: { type: 'string', description: 'Up to 32 chars immediately before the passage.' },
          suffix: { type: 'string', description: 'Up to 32 chars immediately after the passage.' },
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
  if (derivatives.length === 0) return { summary: 'no newly readable documents to link' };

  const parties = await ctx.vault.read({
    entity: 'core.party',
    limit: 500,
    purpose: PURPOSE,
  });
  const people = (parties.rows ?? []).filter((p) => p.kind === 'person');

  let linked = 0;
  let dropped = 0;
  let lastSeen = cursor;
  for (const derivative of derivatives) {
    lastSeen = derivative.derivative_id;
    const contentId = derivative.content_id;
    const out = await ctx.agent({
      prompt:
        'Find mentions of PEOPLE (personal names) in the attached document text. For each, ' +
        'return the name as written and the exact verbatim passage (≤200 chars) containing it, ' +
        'with short prefix/suffix context. People only — no companies, no places.',
      json: MENTIONS_SCHEMA,
      content: [{ contentId, variant: 'text' }],
    });
    for (const mention of Array.isArray(out?.mentions) ? out.mentions : []) {
      if (typeof mention.name !== 'string' || typeof mention.exact !== 'string') continue;
      // Only people ALREADY in the vault — plain-code matching, the model
      // never decides who exists.
      const needle = mention.name.trim().toLowerCase();
      const person = people.find((p) => {
        const display = String(p.display_name ?? '').toLowerCase();
        return display === needle || (needle.length > 3 && display.includes(needle));
      });
      if (!person) {
        dropped += 1;
        continue;
      }
      try {
        await ctx.vault.invoke({
          command: 'core.link_entities',
          input: {
            from_type: 'core.content_item',
            from_id: contentId,
            to_type: 'core.party',
            to_id: person.party_id,
            relation: 'references',
            selector: {
              exact: mention.exact.slice(0, 200),
              ...(mention.prefix ? { prefix: String(mention.prefix).slice(0, 32) } : {}),
              ...(mention.suffix ? { suffix: String(mention.suffix).slice(0, 32) } : {}),
            },
          },
          purpose: PURPOSE,
        });
        linked += 1;
      } catch (err) {
        // An identical live link is the command's own idempotency refusal —
        // expected on re-runs, never an error worth failing the fire over.
        log.info(`link skipped (${person.display_name}): ${err.message}`);
      }
    }
  }
  await ctx.state.set('cursor', lastSeen);
  return {
    summary: `linked ${linked} mention(s); ${dropped} named nobody in the vault`,
    output: { linked, dropped },
  };
};
