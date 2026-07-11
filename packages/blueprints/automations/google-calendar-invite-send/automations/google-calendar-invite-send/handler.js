/**
 * Calendar invite send — the outbox pattern (issue #306) extended from
 * email to calendar. The fire itself performs NO network call: it renders
 * each needs-action guest into an ICS invite and stages it via
 * `outbox.stage` — verb `gmail.send`, the exact Gmail API request,
 * `{{connection:access_token}}` placeholder and all — the same shape
 * google-gmail-send already proved out. The owner approves the thing
 * itself (or a standing "always allow this recipient" grant matches) and
 * the gateway's executor performs the send on the `allowWrites` lane the
 * fire never gets.
 *
 * Shape per fire:
 *   1. matched rows arrive from the condition trigger (schedule_attendee
 *      rows with partstat='needs-action'); a manual run re-scans the
 *      same window.
 *   2. per attendee: skip already-staged ids (ctx.state remembers what
 *      this connector staged), skip the owner's own row (no email needed
 *      to invite yourself), skip a guest with no resolvable address.
 *   3. resolve the event, build a minimal RFC 5545 VEVENT, wrap it in a
 *      multipart/mixed RFC 2822 message with a text/calendar part, stage
 *      the outbox item.
 */

const KIND = 'pull.gmail';
const LABEL = 'personal';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const MAX_STAGED_PER_RUN = 10;

const looksLikeEmail = (value) => typeof value === 'string' && /^[^@\s]+@[^@\s]+$/.test(value);

async function rowsOf(ctx) {
  const input = ctx.input || {};
  if (Array.isArray(input.rows) && input.rows.length > 0) return input.rows;
  const read = await ctx.vault.read({
    entity: 'schedule.attendee',
    where: [{ column: 'partstat', op: 'eq', value: 'needs-action' }],
    orderBy: { column: 'attendee_id', dir: 'desc' },
    limit: 25,
  });
  return read.rows || [];
}

async function emailOf(ctx, partyId) {
  const ids = await ctx.vault.read({
    entity: 'core.party_identifier',
    where: [
      { column: 'party_id', op: 'eq', value: partyId },
      { column: 'scheme', op: 'eq', value: 'email' },
    ],
    limit: 5,
  });
  const rows = ids.rows || [];
  const primary = rows.find((r) => r.is_primary === 1) || rows[0];
  return primary && looksLikeEmail(primary.value) ? primary.value : null;
}

/** UTC basic format RFC 5545 wants: YYYYMMDDTHHMMSSZ. */
function icsStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function buildIcs({ eventId, summary, description, dtstart, dtend, organizerEmail, attendeeEmail, sequence }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Centraid//Agenda//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${eventId}@centraid.local`,
    `SEQUENCE:${sequence ?? 0}`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(dtstart)}`,
    ...(dtend ? [`DTEND:${icsStamp(dtend)}`] : []),
    `SUMMARY:${icsEscape(summary)}`,
    ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
    ...(organizerEmail ? [`ORGANIZER:mailto:${organizerEmail}`] : []),
    `ATTENDEE;RSVP=TRUE:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

function rawRfc2822WithIcs(to, subject, bodyText, icsBody) {
  const boundary = `centraid-${Math.random().toString(36).slice(2)}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${subject || '(no subject)'}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
    '',
    `--${boundary}`,
    'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
    'Content-Transfer-Encoding: 7bit',
    '',
    icsBody,
    '',
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export default async ({ ctx, log }) => {
  let staged = 0;
  let skipped = 0;
  const vaultRes = await ctx.vault.read({ entity: 'core.vault' });
  const mePartyId = (vaultRes.rows || [])[0]?.owner_party_id ?? null;
  const organizerEmail = mePartyId ? await emailOf(ctx, mePartyId) : null;

  for (const attendee of await rowsOf(ctx)) {
    if (staged >= MAX_STAGED_PER_RUN) break;
    if (mePartyId && attendee.party_id === mePartyId) {
      skipped += 1;
      continue;
    }
    const already = await ctx.state.get(`staged:${attendee.attendee_id}`);
    if (already) {
      skipped += 1;
      continue;
    }
    const eventRead = await ctx.vault.read({
      entity: 'core.event',
      where: [{ column: 'event_id', op: 'eq', value: attendee.event_id }],
      limit: 1,
    });
    const event = (eventRead.rows || [])[0];
    if (!event || event.status === 'cancelled') {
      skipped += 1;
      continue;
    }
    const attendeeEmail = await emailOf(ctx, attendee.party_id);
    if (!attendeeEmail) {
      // No resolvable address yet — leave it unstaged so a later fire heals.
      log.warn(`attendee ${attendee.attendee_id} has no email; skipping`);
      skipped += 1;
      continue;
    }
    const icsBody = buildIcs({
      eventId: event.event_id,
      summary: event.summary,
      description: event.description,
      dtstart: event.dtstart,
      dtend: event.dtend,
      organizerEmail,
      attendeeEmail,
      sequence: event.sequence,
    });
    const bodyText = `You're invited: ${event.summary}\n\nOpen the attached invite to add it to your calendar and RSVP.`;
    const outcome = await ctx.vault.invoke({
      command: 'outbox.stage',
      input: {
        kind: KIND,
        label: LABEL,
        verb: 'gmail.send',
        target: attendeeEmail,
        artifact: {
          to: [attendeeEmail],
          subject: `Invite: ${event.summary}`,
          body: bodyText,
          event_id: event.event_id,
          attendee_id: attendee.attendee_id,
        },
        request: {
          method: 'POST',
          url: SEND_URL,
          headers: {
            authorization: 'Bearer {{connection:access_token}}',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            raw: rawRfc2822WithIcs(attendeeEmail, `Invite: ${event.summary}`, bodyText, icsBody),
          }),
        },
      },
    });
    if (!outcome || outcome.status !== 'executed') {
      throw new Error(
        `outbox.stage refused for attendee ${attendee.attendee_id}: ${(outcome && outcome.reason) || 'unknown'}`,
      );
    }
    await ctx.state.set(`staged:${attendee.attendee_id}`, outcome.output.item_id);
    staged += 1;
    log.info(
      `staged calendar invite → ${attendeeEmail} for "${event.summary}" (${outcome.output.status}) as ${outcome.output.item_id}`,
    );
  }
  return {
    summary: `staged ${staged} outbox item(s), skipped ${skipped}`,
    output: { staged, skipped },
  };
};
