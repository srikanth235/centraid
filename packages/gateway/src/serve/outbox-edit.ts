/*
 * Server-side outbox edit support (issue #308 A5 UI slice — "edit before
 * send"). `outbox.decide` (packages/vault/src/commands/outbox.ts) requires
 * the artifact and its injectable wire request to replace TOGETHER — an
 * edit that swaps only the human-readable artifact while the original
 * request goes on the wire would let the owner's approval quietly diverge
 * from what actually sends. The owner surface only ever shows the artifact
 * (`GET /outbox` / `GET /blocking` never carry `request_json` — vault-
 * plane's `listOutbox` doc comment: "it may carry placeholder plumbing the
 * owner shouldn't have to parse"), so it has no way to submit an edited
 * request honestly. This module lets the GATEWAY rebuild the request from
 * an edited artifact instead, keyed by the item's `verb` — one rebuilder
 * per verb, registered below.
 *
 * `gmail.send` ships first, porting the RFC 2822 raw-message construction
 * VERBATIM from the gmail-send automation handler
 * (packages/blueprints/automations/google-gmail-send/automations/google-gmail-send/handler.js,
 * `rawRfc2822`) — same headers, same base64url encoding. This is a
 * deliberate, commented duplication rather than a shared import: the
 * handler is sandboxed automation JS bundled standalone (it builds a FRESH
 * artifact+request pair when staging); this module runs in the gateway
 * process and rebuilds a request from an EDITED artifact when approving.
 * A change to one raw-message shape must be mirrored in the other by hand.
 */

/** The wire shape `outbox.stage`/`outbox.decide` validate a request against (`REQUEST_SCHEMA` in packages/vault/src/commands/outbox.ts). */
export interface OutboxWireRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Rebuild the wire request from an edited artifact, given the ORIGINAL
 * (staged) request. Everything not derived from the artifact — URL,
 * method, auth-placeholder headers — is expected to carry over unchanged;
 * a rebuilder only touches the parts the artifact actually drives.
 */
export type OutboxRequestRebuilder = (
  original: OutboxWireRequest,
  artifact: Record<string, unknown>,
) => OutboxWireRequest;

/**
 * `artifact.to` is a recipient address or a list of them (the gmail-send
 * template's real shape is an array; the desktop DTO's `recipientFrom`
 * handles both defensively too) — normalize rather than assume one shape.
 * Returns an empty list on anything that isn't a non-empty string or a
 * list of non-empty strings.
 */
function normalizeRecipients(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (strings.length === value.length && strings.length > 0) return strings;
  }
  return [];
}

/**
 * Verbatim port of the gmail-send handler's `rawRfc2822` — see the module
 * doc comment for why this duplicates rather than imports.
 */
function rawRfc2822(to: string[], subject: string, body: string): string {
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

/**
 * `gmail.send`: the artifact drives `to` / `subject` / `body`; the rebuilt
 * request keeps the original method/url/headers (including the
 * `{{connection:access_token}}` placeholder, resolved later by the
 * executor) and replaces only `body` with the freshly-encoded raw message.
 */
function rebuildGmailSend(
  original: OutboxWireRequest,
  artifact: Record<string, unknown>,
): OutboxWireRequest {
  const to = normalizeRecipients(artifact.to);
  if (to.length === 0) {
    throw new Error('gmail.send needs at least one recipient in "to"');
  }
  const subject = typeof artifact.subject === 'string' ? artifact.subject : '';
  const body = typeof artifact.body === 'string' ? artifact.body : '';
  return {
    ...original,
    body: JSON.stringify({ raw: rawRfc2822(to, subject, body) }),
  };
}

const REBUILDERS: Record<string, OutboxRequestRebuilder> = {
  'gmail.send': rebuildGmailSend,
};

/** Whether an outbox item's verb has a request rebuilder — the owner surface's `canEdit` signal. */
export function outboxVerbIsEditable(verb: string): boolean {
  return Object.hasOwn(REBUILDERS, verb);
}

/** The rebuilder for a verb, or `undefined` when editing isn't supported yet. */
export function rebuilderForVerb(verb: string): OutboxRequestRebuilder | undefined {
  return REBUILDERS[verb];
}

/**
 * Reject shape drift in an edited artifact: the owner surface can only ever
 * offer controls for the staged artifact's OWN fields, and only for
 * string / string[] values — no adding or removing fields, no changing a
 * field's kind. Fields the surface has no control for (numbers, nested
 * objects, booleans, null) must come back byte-identical. Throws with a
 * message safe to surface as a 400.
 */
export function assertArtifactShapeUnchanged(
  staged: Record<string, unknown>,
  edited: Record<string, unknown>,
): void {
  const stagedKeys = Object.keys(staged).sort();
  const editedKeys = Object.keys(edited).sort();
  const sameKeys =
    stagedKeys.length === editedKeys.length && stagedKeys.every((k, i) => k === editedKeys[i]);
  if (!sameKeys) {
    throw new Error(
      `edited artifact must have exactly the staged fields (${stagedKeys.join(', ')}) — fields can't be added or removed`,
    );
  }
  for (const key of stagedKeys) {
    const stagedVal = staged[key];
    const editedVal = edited[key];
    if (typeof stagedVal === 'string') {
      if (typeof editedVal !== 'string') {
        throw new Error(`field "${key}" must stay a string`);
      }
      continue;
    }
    if (Array.isArray(stagedVal)) {
      if (!Array.isArray(editedVal) || editedVal.some((v) => typeof v !== 'string')) {
        throw new Error(`field "${key}" must stay a list of strings`);
      }
      continue;
    }
    // Not an editable primitive — the owner surface offers no control for
    // it, so it must come back untouched.
    if (JSON.stringify(stagedVal) !== JSON.stringify(editedVal)) {
      throw new Error(`field "${key}" isn't editable — it must match the staged value exactly`);
    }
  }
}
