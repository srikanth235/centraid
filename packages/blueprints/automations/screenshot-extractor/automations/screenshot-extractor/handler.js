/**
 * Screenshot intelligence (issue #299 phase 2) — the cross-domain enricher.
 *
 * The thesis demo: a photographed receipt becomes a reviewed ledger entry,
 * a booking screenshot becomes a tentative calendar event. The cross-silo
 * rule is absolute: extracted rows stage on the `enrichment.extraction`
 * connection and are NEVER auto-published by this handler — the owner's
 * review click is the domain boundary. (Even if the owner flips that
 * connection's trust, that is their standing consent, not ours.)
 *
 * Screenshot heuristic: camera photos carry EXIF (the #296 spool reads it
 * server-side); screenshots and photographed documents mostly don't. Only
 * EXIF-less photos take a vision turn, so the camera roll isn't taxed.
 */

const BATCH = 8;
const PURPOSE = 'dpv:ServiceProvision';

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['receipt', 'booking', 'other'],
      description: 'What this image is: a purchase receipt, a booking/confirmation, or neither.',
    },
    receipt: {
      type: 'object',
      additionalProperties: false,
      properties: {
        merchant: { type: 'string' },
        amount_minor: { type: 'integer', description: 'Total in minor units (cents/paise).' },
        currency: { type: 'string', description: 'ISO 4217, e.g. INR, USD.' },
        posted_at: { type: 'string', description: 'ISO date of the purchase, if visible.' },
      },
    },
    booking: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: 'What is booked, e.g. "Flight BLR → GOI".' },
        dtstart: { type: 'string', description: 'ISO start datetime, if visible.' },
        dtend: { type: 'string', description: 'ISO end datetime, if visible.' },
      },
    },
  },
};

export default async ({ ctx, log }) => {
  const cursor = (await ctx.state.get('cursor')) ?? '';
  const read = await ctx.vault.read({
    entity: 'media.media_asset',
    where: [
      { column: 'asset_id', op: 'gt', value: cursor },
      { column: 'deleted_at', op: 'is-null' },
      { column: 'exif_json', op: 'is-null' },
    ],
    orderBy: { column: 'asset_id', dir: 'asc' },
    limit: BATCH,
    purpose: PURPOSE,
  });
  const assets = read.rows ?? [];
  if (assets.length === 0) return { summary: 'no new screenshots to inspect' };

  const rows = [];
  let receipts = 0;
  let bookings = 0;
  let other = 0;
  let lastSeen = cursor;
  for (const asset of assets) {
    lastSeen = asset.asset_id;
    if (asset.kind !== 'photo' && asset.kind !== 'scan') continue;
    const derivatives = await ctx.vault.read({
      entity: 'core.content_derivative',
      where: [{ column: 'content_id', op: 'eq', value: asset.content_id }],
      limit: 5,
      purpose: PURPOSE,
    });
    const variants = (derivatives.rows ?? []).map((d) => d.variant);
    const variant = variants.includes('preview')
      ? 'preview'
      : variants.includes('thumb')
        ? 'thumb'
        : null;
    if (!variant) continue;
    const out = await ctx.agent({
      prompt:
        'Classify the attached image. Is it a purchase receipt, a booking/confirmation ' +
        '(flight, hotel, ticket, appointment), or neither? Extract only what is VISIBLE — ' +
        'no inferred values. Amounts in minor units (₹123.45 → 12345).',
      json: EXTRACT_SCHEMA,
      content: [{ contentId: asset.content_id, variant }],
    });
    // A dateless extraction is dropped, not defaulted — posted_at/dtstart
    // are NOT NULL in the model, and inventing a date would be a guess.
    if (
      out?.kind === 'receipt' &&
      out.receipt &&
      Number.isInteger(out.receipt.amount_minor) &&
      typeof out.receipt.posted_at === 'string' &&
      out.receipt.posted_at.length > 0
    ) {
      const r = out.receipt;
      rows.push({
        entity_type: 'core.transaction',
        external_id: `screenshot:${asset.asset_id}`,
        payload: {
          externalId: `screenshot:${asset.asset_id}`,
          postedAt: r.posted_at,
          description: typeof r.merchant === 'string' ? r.merchant : 'Receipt (from screenshot)',
          amountMinor: r.amount_minor,
          currency:
            typeof r.currency === 'string' && r.currency.length === 3
              ? r.currency.toUpperCase()
              : 'INR',
          direction: 'debit',
          accountName: 'Receipts (screenshots)',
        },
      });
      receipts += 1;
    } else if (
      out?.kind === 'booking' &&
      out.booking &&
      typeof out.booking.summary === 'string' &&
      typeof out.booking.dtstart === 'string' &&
      out.booking.dtstart.length > 0
    ) {
      const b = out.booking;
      rows.push({
        entity_type: 'core.event',
        external_id: `screenshot:${asset.asset_id}`,
        payload: {
          uid: `screenshot:${asset.asset_id}`,
          summary: b.summary,
          description: 'Extracted from a screenshot — review before trusting.',
          dtstart: b.dtstart,
          dtend: typeof b.dtend === 'string' && b.dtend ? b.dtend : null,
          startTz: null,
          rrule: null,
          status: 'tentative',
        },
      });
      bookings += 1;
    } else {
      other += 1;
    }
  }

  if (rows.length > 0) {
    // Staged, full stop — publishing a cross-domain extraction is the
    // owner's gesture in the review surface (or sync.publish_batch parks).
    await ctx.vault.invoke({
      command: 'sync.stage_rows',
      input: { kind: 'enrichment.extraction', label: 'screenshots', rows },
      purpose: PURPOSE,
    });
  }
  await ctx.state.set('cursor', lastSeen);
  return {
    summary: `staged ${receipts} receipt(s), ${bookings} booking(s); ${other} other screenshot(s)`,
    output: { receipts, bookings, other },
  };
};
