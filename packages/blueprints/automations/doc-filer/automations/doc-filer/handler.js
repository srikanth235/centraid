/**
 * Document filing (issue #299 phase 2) — the scan-dump triage enricher.
 *
 * Watches text derivatives (a document becomes filable the moment it has
 * text — the spool's extraction or the OCR enricher's) and, per document,
 * proposes a human title + folder + doctype tag from ONE bounded text
 * turn. Everything stages on the `enrichment.doctype` connection:
 *   - filing/rename → a core.content_item UPDATE row (the publisher
 *     refuses creates — filing never mints documents);
 *   - doctype → a core.tag row under the machine doctype scheme.
 * Nothing applies until the owner publishes the batch. The existing
 * folder labels ride into the prompt so proposals prefer folders the
 * owner already has over inventing near-duplicates.
 */

const BATCH = 6;
const PURPOSE = 'dpv:ServiceProvision';
const DOCTYPE_SCHEME_URI = 'urn:centraid:doctype';

const FILING_SCHEMA = {
  type: 'object',
  required: ['title', 'folder', 'doctype'],
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'A clear human title for this document, e.g. "Home insurance policy 2026".',
    },
    folder: {
      type: 'string',
      description: 'The folder to file it in — prefer one of the existing folders when it fits.',
    },
    doctype: {
      type: 'string',
      description: 'A short document-type label, e.g. "invoice", "policy", "warranty".',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
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
  if (derivatives.length === 0) return { summary: 'no newly readable documents to file' };

  // The owner's existing folders, so proposals reuse them.
  const folders = await ctx.vault.read({
    entity: 'core.concept',
    limit: 200,
    purpose: PURPOSE,
  });
  const schemes = await ctx.vault.read({
    entity: 'core.concept_scheme',
    limit: 50,
    purpose: PURPOSE,
  });
  const folderScheme = (schemes.rows ?? []).find(
    (s) => s.uri === 'https://centraid.dev/schemes/folders',
  );
  const folderLabels = folderScheme
    ? (folders.rows ?? [])
        .filter((c) => c.scheme_id === folderScheme.scheme_id && c.notation !== 'root')
        .map((c) => c.pref_label)
    : [];

  const rows = [];
  let proposed = 0;
  let lastSeen = cursor;
  for (const derivative of derivatives) {
    lastSeen = derivative.derivative_id;
    const contentId = derivative.content_id;
    const items = await ctx.vault.read({
      entity: 'core.content_item',
      where: [
        { column: 'content_id', op: 'eq', value: contentId },
        { column: 'deleted_at', op: 'is-null' },
      ],
      limit: 1,
      purpose: PURPOSE,
    });
    const item = (items.rows ?? [])[0];
    if (!item) continue;
    if (String(item.media_type ?? '').startsWith('text/')) continue; // notes file themselves
    const out = await ctx.agent({
      prompt:
        'The attached text is a document in my drive. Propose how to file it: a clear human ' +
        `title, a folder, and a short doctype label. Existing folders: ${
          folderLabels.length > 0 ? folderLabels.join(', ') : '(none yet)'
        }. Prefer an existing folder when it fits.`,
      json: FILING_SCHEMA,
      content: [{ contentId, variant: 'text' }],
    });
    if (!out || typeof out.title !== 'string' || typeof out.folder !== 'string') continue;
    rows.push({
      entity_type: 'core.content_item',
      external_id: `${contentId}:filing`,
      payload: { content_id: contentId, title: out.title, folder: out.folder },
    });
    if (typeof out.doctype === 'string' && out.doctype.length > 0) {
      rows.push({
        entity_type: 'core.tag',
        external_id: `${contentId}:doctype`,
        payload: {
          target_type: 'core.content_item',
          target_id: contentId,
          scheme_uri: DOCTYPE_SCHEME_URI,
          label: out.doctype,
          confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0.5)),
        },
      });
    }
    proposed += 1;
  }

  if (rows.length > 0) {
    // Filing proposals ALWAYS stage — moving and renaming the owner's
    // documents is their gesture in the review surface.
    await ctx.vault.invoke({
      command: 'sync.stage_rows',
      input: { kind: 'enrichment.doctype', label: 'docs', rows },
      purpose: PURPOSE,
    });
    log.info(`${proposed} filing proposal(s) staged for review`);
  }
  await ctx.state.set('cursor', lastSeen);
  return {
    summary:
      proposed > 0
        ? `proposed filing for ${proposed} document(s) — awaiting your review`
        : 'nothing new needed filing',
    output: { proposed },
  };
};
