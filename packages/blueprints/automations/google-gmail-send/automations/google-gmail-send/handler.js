/**
 * Gmail send (issue #306) — the first outbox consumer, proving the #304
 * write half. The fire itself performs NO network call: it renders each
 * released email message into an outbox ARTIFACT (to / subject / body plus
 * the exact Gmail API request, `{{connection:access_token}}` placeholder
 * and all) via `outbox.stage`. The owner approves the thing itself — or an
 * "always allow this recipient" standing grant matches — and the gateway's
 * executor performs the send on the `allowWrites` lane the fire never gets.
 *
 * Shape per fire:
 *   1. matched rows arrive from the condition trigger (delivery='sent'
 *      messages with no external_id — released locally, not yet carried
 *      out); a manual run re-scans the same window.
 *   2. per message: skip non-email threads and already-staged ids
 *      (ctx.state remembers what this connector staged); resolve the
 *      recipients (participant handle, else the party's primary email);
 *      fetch the body text derivative.
 *   3. build the RFC 2822 raw message and stage the outbox item —
 *      verb `gmail.send`, target = recipient list — then remember it.
 */

const KIND = 'pull.gmail';
const LABEL = 'personal';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
/** Bound one fire's staging work; the next fire continues. */
const MAX_STAGED_PER_RUN = 10;

const looksLikeEmail = (value) => typeof value === 'string' && /^[^@\s]+@[^@\s]+$/.test(value);

async function rowsOf(ctx) {
  const input = ctx.input || {};
  if (Array.isArray(input.rows) && input.rows.length > 0) return input.rows;
  const read = await ctx.vault.read({
    entity: 'social.message',
    where: [
      { column: 'delivery', op: 'eq', value: 'sent' },
      { column: 'external_id', op: 'is-null' },
    ],
    orderBy: { column: 'message_id', dir: 'desc' },
    limit: 25,
  });
  return read.rows || [];
}

async function recipientsOf(ctx, message) {
  const participants = await ctx.vault.read({
    entity: 'social.thread_participant',
    where: [{ column: 'thread_id', op: 'eq', value: message.thread_id }],
    limit: 50,
  });
  const emails = [];
  for (const p of participants.rows || []) {
    if (message.sender_party_id && p.party_id === message.sender_party_id) continue;
    if (looksLikeEmail(p.handle)) {
      emails.push(p.handle);
      continue;
    }
    if (!p.party_id) continue;
    const ids = await ctx.vault.read({
      entity: 'core.party_identifier',
      where: [
        { column: 'party_id', op: 'eq', value: p.party_id },
        { column: 'scheme', op: 'eq', value: 'email' },
      ],
      limit: 5,
    });
    const rows = ids.rows || [];
    const primary = rows.find((r) => r.is_primary === 1) || rows[0];
    if (primary && looksLikeEmail(primary.value)) emails.push(primary.value);
  }
  return [...new Set(emails)];
}

async function bodyTextOf(ctx, message) {
  const outcome = await ctx.vault.content({
    contentId: message.body_content_id,
    variant: 'text',
  });
  return outcome && outcome.status === 'ok' && outcome.kind === 'text' ? outcome.text : '';
}

function rawRfc2822(to, subject, body) {
  const lines = [
    `To: ${to.join(', ')}`,
    `Subject: ${subject || '(no subject)'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export default async ({ ctx, log }) => {
  let staged = 0;
  let skipped = 0;
  for (const message of await rowsOf(ctx)) {
    if (staged >= MAX_STAGED_PER_RUN) break;
    const already = await ctx.state.get(`staged:${message.message_id}`);
    if (already) {
      skipped += 1;
      continue;
    }
    const thread = await ctx.vault.read({
      entity: 'social.thread',
      where: [{ column: 'thread_id', op: 'eq', value: message.thread_id }],
      limit: 1,
    });
    const threadRow = (thread.rows || [])[0];
    if (!threadRow || threadRow.channel !== 'email') {
      skipped += 1;
      continue;
    }
    const to = await recipientsOf(ctx, message);
    if (to.length === 0) {
      // No resolvable address yet — leave it unstaged so a later fire heals.
      log.warn(`message ${message.message_id} has no email recipient; skipping`);
      skipped += 1;
      continue;
    }
    const body = await bodyTextOf(ctx, message);
    const subject = threadRow.subject || '(no subject)';
    const outcome = await ctx.vault.invoke({
      command: 'outbox.stage',
      input: {
        kind: KIND,
        label: LABEL,
        verb: 'gmail.send',
        target: to.join(', '),
        artifact: {
          to,
          subject,
          body,
          message_id: message.message_id,
        },
        request: {
          method: 'POST',
          url: SEND_URL,
          headers: {
            authorization: 'Bearer {{connection:access_token}}',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ raw: rawRfc2822(to, subject, body) }),
        },
      },
    });
    if (!outcome || outcome.status !== 'executed') {
      throw new Error(
        `outbox.stage refused for ${message.message_id}: ${(outcome && outcome.reason) || 'unknown'}`,
      );
    }
    await ctx.state.set(`staged:${message.message_id}`, outcome.output.item_id);
    staged += 1;
    log.info(
      `staged gmail.send → ${to.join(', ')} (${outcome.output.status}) as ${outcome.output.item_id}`,
    );
  }
  return {
    summary: `staged ${staged} outbox item(s), skipped ${skipped}`,
    output: { staged, skipped },
  };
};
