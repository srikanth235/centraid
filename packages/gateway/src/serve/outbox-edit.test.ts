// The outbox edit registry (issue #308 A5 UI slice): the gmail.send request
// rebuilder ports `rawRfc2822` from the gmail-send handler verbatim, and the
// artifact shape guard rejects drift the owner surface has no control for.

import { expect, test } from 'vitest';
import {
  assertArtifactShapeUnchanged,
  outboxVerbIsEditable,
  rebuilderForVerb,
  type OutboxWireRequest,
} from './outbox-edit.js';

const stagedRequest: OutboxWireRequest = {
  method: 'POST',
  url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  headers: {
    authorization: 'Bearer {{connection:access_token}}',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ raw: 'original-raw' }),
};

function decodeRaw(request: OutboxWireRequest): string {
  const parsed = JSON.parse(request.body ?? '{}') as { raw: string };
  return Buffer.from(parsed.raw, 'base64url').toString('utf8');
}

test('gmail.send is editable; unknown verbs are not', () => {
  expect(outboxVerbIsEditable('gmail.send')).toBe(true);
  expect(outboxVerbIsEditable('gcal.create_event')).toBe(false);
  expect(rebuilderForVerb('gmail.send')).toBeTypeOf('function');
  expect(rebuilderForVerb('gcal.create_event')).toBeUndefined();
});

test('rebuildGmailSend re-encodes the raw RFC 2822 message from the edited artifact, preserving method/url/headers', () => {
  const rebuild = rebuilderForVerb('gmail.send')!;
  const rebuilt = rebuild(stagedRequest, {
    to: ['ravi@example.com', 'asha@example.com'],
    subject: 'Edited subject',
    body: 'Edited body text.',
    message_id: 'msg-1',
  });
  expect(rebuilt.method).toBe('POST');
  expect(rebuilt.url).toBe(stagedRequest.url);
  expect(rebuilt.headers).toEqual(stagedRequest.headers);
  const decoded = decodeRaw(rebuilt);
  expect(decoded).toContain('To: ravi@example.com, asha@example.com');
  expect(decoded).toContain('Subject: Edited subject');
  expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
  expect(decoded).toContain('Edited body text.');
});

test('rebuildGmailSend accepts a single string "to" like the desktop DTO normalizes to', () => {
  const rebuild = rebuilderForVerb('gmail.send')!;
  const rebuilt = rebuild(stagedRequest, { to: 'solo@example.com', subject: 'Hi', body: 'x' });
  expect(decodeRaw(rebuilt)).toContain('To: solo@example.com');
});

test('rebuildGmailSend falls back to "(no subject)" like the handler does for an empty subject', () => {
  const rebuild = rebuilderForVerb('gmail.send')!;
  const rebuilt = rebuild(stagedRequest, { to: 'x@example.com', subject: '', body: 'body' });
  expect(decodeRaw(rebuilt)).toContain('Subject: (no subject)');
});

test('rebuildGmailSend refuses an empty recipient list', () => {
  const rebuild = rebuilderForVerb('gmail.send')!;
  expect(() => rebuild(stagedRequest, { to: [], subject: 'Hi', body: 'x' })).toThrow(/recipient/);
  expect(() => rebuild(stagedRequest, { to: '', subject: 'Hi', body: 'x' })).toThrow(/recipient/);
});

const stagedArtifact = { to: ['ravi@example.com'], subject: 'Hi', body: 'See you.', message_id: 'm1' };

test('assertArtifactShapeUnchanged allows editing string and string[] fields in place', () => {
  expect(() =>
    assertArtifactShapeUnchanged(stagedArtifact, {
      to: ['ravi@example.com', 'asha@example.com'],
      subject: 'Edited',
      body: 'New body',
      message_id: 'm1',
    }),
  ).not.toThrow();
});

test('assertArtifactShapeUnchanged rejects an added field', () => {
  expect(() =>
    assertArtifactShapeUnchanged(stagedArtifact, { ...stagedArtifact, extra: 'nope' }),
  ).toThrow(/exactly the staged fields/);
});

test('assertArtifactShapeUnchanged rejects a removed field', () => {
  const { message_id: _drop, ...withoutMessageId } = stagedArtifact;
  expect(() => assertArtifactShapeUnchanged(stagedArtifact, withoutMessageId)).toThrow(
    /exactly the staged fields/,
  );
});

test('assertArtifactShapeUnchanged rejects a field changing from string to a non-string', () => {
  expect(() =>
    assertArtifactShapeUnchanged(stagedArtifact, { ...stagedArtifact, subject: 42 }),
  ).toThrow(/must stay a string/);
});

test('assertArtifactShapeUnchanged rejects a string[] field turning into a non-array or mixed-type array', () => {
  expect(() =>
    assertArtifactShapeUnchanged(stagedArtifact, { ...stagedArtifact, to: 'not-an-array' }),
  ).toThrow(/list of strings/);
  expect(() =>
    assertArtifactShapeUnchanged(stagedArtifact, { ...stagedArtifact, to: ['ok', 42] }),
  ).toThrow(/list of strings/);
});

test('assertArtifactShapeUnchanged requires non-editable fields (objects/numbers/null) to stay byte-identical', () => {
  const withExtra = { ...stagedArtifact, meta: { retries: 0 } };
  expect(() => assertArtifactShapeUnchanged(withExtra, { ...withExtra })).not.toThrow();
  expect(() =>
    assertArtifactShapeUnchanged(withExtra, { ...withExtra, meta: { retries: 1 } }),
  ).toThrow(/isn't editable/);
});
