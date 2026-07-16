/**
 * Document text (issue #299 phase 1) — the doc enricher.
 *
 * Walks content items forward from a cursor (UUIDv7 ids = time order) and,
 * for each binary document:
 *   - no `text` derivative but a preview/thumb exists → one bounded vision
 *     turn transcribes it (OCR) and `core.set_extracted_text` writes the
 *     text derivative — the #296 FTS triggers index the PARENT document
 *     in-transaction, so the scan becomes searchable the same instant;
 *   - a `text` derivative exists → one bounded turn summarizes it, staged
 *     as a machine annotation on the `enrichment.doctext` connection.
 *
 * A binary document with NEITHER text nor preview is honestly "not
 *  enrichable yet" (issue #299 decision: derivatives egress, never
 * originals — server-side preview codecs are the #296 plug-in seam).
 *
 * Deterministic: cursor in ctx.state, ids derived from content ids,
 * re-runs re-stage the same rows and the spine's dedup skips them.
 */

const BATCH = 6;
const PURPOSE = 'dpv:ServiceProvision';

const OCR_SCHEMA = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description: 'The document text, transcribed faithfully. Empty string if unreadable.',
    },
  },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['summary'],
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      description: 'One factual paragraph: what this document is, key parties, amounts, dates.',
    },
  },
};

export default async ({ ctx, log }) => {
  const cursor = (await ctx.state.get('cursor')) ?? '';
  const derivativeCursor = (await ctx.state.get('derivativeCursor')) ?? '';
  const now = ctx.now;
  // A plugged-in device gets the first chance at PDF.js text. Do not move
  // the backlog cursor past a live lease: after completion the text variant
  // is summarized here; after expiry this gateway backstop takes over.
  const leased = await ctx.vault.read({
    entity: 'enrich.request',
    where: [
      { column: 'entity_type', op: 'eq', value: 'core.content_item' },
      { column: 'required_capability', op: 'eq', value: 'pdfText' },
      { column: 'drained_at', op: 'is-null' },
      { column: 'lease_expires_at', op: 'gt', value: now },
    ],
    limit: 100,
    purpose: PURPOSE,
  });
  const deviceOwned = new Set((leased.rows ?? []).map((request) => request.entity_id));
  const read = await ctx.vault.read({
    entity: 'core.content_item',
    where: [
      { column: 'content_id', op: 'gt', value: cursor },
      { column: 'deleted_at', op: 'is-null' },
    ],
    orderBy: { column: 'content_id', dir: 'asc' },
    limit: BATCH,
    purpose: PURPOSE,
  });
  const items = read.rows ?? [];
  // Originals and derivatives have independent clocks. Following only the
  // content-item cursor permanently misses a preview/text row that arrives
  // after its parent was skipped, so tail the typed derivative stream too.
  const lateRead = await ctx.vault.read({
    entity: 'core.content_derivative',
    where: [
      { column: 'derivative_id', op: 'gt', value: derivativeCursor },
      { column: 'variant', op: 'in', value: ['text', 'preview', 'thumb'] },
    ],
    orderBy: { column: 'derivative_id', dir: 'asc' },
    limit: BATCH,
    purpose: PURPOSE,
  });
  const late = (lateRead.rows ?? []).filter(
    (row) => typeof row.derivative_id === 'string' && typeof row.content_id === 'string',
  );
  if (items.length === 0 && late.length === 0) {
    return { summary: 'no new documents — all readable and summarized' };
  }

  const summaryRows = [];
  let ocred = 0;
  let summarized = 0;
  let skipped = 0;
  let lastSeen = cursor;
  let lastDerivative = derivativeCursor;
  const processed = new Set();
  const processItem = async (item) => {
    const mediaType = String(item.media_type ?? '');
    // Inline text items already feed FTS whole; skip non-documents.
    if (mediaType.startsWith('text/')) return;
    const derivatives = await ctx.vault.read({
      entity: 'core.content_derivative',
      where: [{ column: 'content_id', op: 'eq', value: item.content_id }],
      limit: 5,
      purpose: PURPOSE,
    });
    const variants = (derivatives.rows ?? []).map((d) => d.variant);
    const hasText = variants.includes('text');
    const visual = variants.includes('preview')
      ? 'preview'
      : variants.includes('thumb')
        ? 'thumb'
        : null;

    if (!hasText && visual) {
      // OCR: transcribe what the preview shows, then write the text
      // derivative — the parent document becomes searchable in the same
      // transaction (issue #296 FTS rule).
      const out = await ctx.agent({
        prompt:
          'The attached image is a page of a document. Transcribe ALL legible text faithfully, ' +
          'preserving reading order. Return an empty string if nothing is legible.',
        json: OCR_SCHEMA,
        content: [{ contentId: item.content_id, variant: visual }],
      });
      const text = out && typeof out.text === 'string' ? out.text.trim() : '';
      if (text.length > 0) {
        await ctx.vault.invoke({
          command: 'core.set_extracted_text',
          input: { content_id: item.content_id, text },
          purpose: PURPOSE,
        });
        ocred += 1;
      } else {
        skipped += 1;
      }
      return;
    }

    if (hasText) {
      // Summarize from the text variant — no bytes leave beyond the
      // already-extracted text, size-bounded by the content surface.
      const out = await ctx.agent({
        prompt:
          'Summarize the attached document text in ONE factual paragraph: what it is, the key ' +
          'parties, amounts and dates. No speculation.',
        json: SUMMARY_SCHEMA,
        content: [{ contentId: item.content_id, variant: 'text' }],
      });
      const summary = out && typeof out.summary === 'string' ? out.summary.trim() : '';
      if (summary.length > 0) {
        summaryRows.push({
          entity_type: 'knowledge.annotation',
          external_id: `${item.content_id}:summary`,
          payload: {
            target_type: 'core.content_item',
            target_id: item.content_id,
            body: summary,
          },
        });
        summarized += 1;
      }
      return;
    }

    // Neither text nor a visual derivative: not enrichable yet.
    skipped += 1;
    log.info(`content ${item.content_id}: no text or preview derivative — not enrichable yet`);
  };

  // Derivative rows are processed in their own order and their cursor moves
  // only after the owning content was handled. A live device lease pins this
  // stream exactly like it pins the new-content stream.
  for (const row of late) {
    if (deviceOwned.has(row.content_id)) break;
    if (!processed.has(row.content_id)) {
      await processItem({ content_id: row.content_id, media_type: 'application/octet-stream' });
      processed.add(row.content_id);
    }
    lastDerivative = row.derivative_id;
  }
  for (const item of items) {
    if (deviceOwned.has(item.content_id)) break;
    lastSeen = item.content_id;
    if (processed.has(item.content_id)) continue;
    await processItem(item);
    processed.add(item.content_id);
  }

  if (summaryRows.length > 0) {
    await ctx.vault.invoke({
      command: 'sync.stage_rows',
      input: { kind: 'enrichment.doctext', label: 'docs', rows: summaryRows },
      purpose: PURPOSE,
    });
  }
  await ctx.state.set('cursor', lastSeen);
  await ctx.state.set('derivativeCursor', lastDerivative);
  return {
    summary: `OCRed ${ocred}, summarized ${summarized}, skipped ${skipped}`,
    output: { ocred, summarized, skipped },
  };
};
