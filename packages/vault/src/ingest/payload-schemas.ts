// Runtime schema gate for ingest publisher payloads (issue #374 Tier 3).
// Every DECLARED command's input runs through gateway/json-schema.ts's
// validateJson before it reaches SQLite (execution.ts ~line 316) — the
// staging spine's publishers (publishers.ts, enrich-publishers.ts) were the
// one write path that skipped it: `payload as unknown as X` is a
// compile-time cast only. Today's parsers (csv.ts et al.) happen to produce
// well-typed values, so nothing exploits the gap yet — but a future
// connector that stages a decimal-STRING amount would sail past TypeScript
// straight into a STRICT column with no runtime backstop. assertPayload
// closes that by running the SAME validator every command uses, so no
// publisher is exempt by omission.
//
// Schemas here are intentionally permissive: they assert the primitive
// shapes the publishers actually read off the payload (notably: numeric
// fields like amounts/confidences must be `number`, not a numeric string),
// and required-ness matches the payload interfaces. `additionalProperties`
// is left unset (permissive) everywhere — no publisher rejects a payload for
// carrying an extra field.

import { validateJson } from '../gateway/json-schema.js';

type JsonSchema = Record<string, unknown>;

const identifierSchema: JsonSchema = {
  type: 'object',
  required: ['scheme', 'value', 'label'],
  properties: {
    scheme: { type: 'string' },
    value: { type: 'string' },
  },
};

const SCHEMAS: Record<string, JsonSchema> = {
  EventPayload: {
    type: 'object',
    required: ['uid', 'summary', 'description', 'dtstart', 'dtend', 'startTz', 'rrule', 'status'],
    properties: {
      uid: { type: 'string', minLength: 1 },
      summary: { type: 'string' },
      dtstart: { type: 'string', minLength: 1 },
      status: { type: 'string' },
    },
  },
  PartyPayload: {
    type: 'object',
    required: ['fn', 'sortName', 'bday', 'identifiers'],
    properties: {
      fn: { type: 'string' },
      identifiers: { type: 'array', items: identifierSchema },
    },
  },
  MessagePayload: {
    type: 'object',
    required: ['messageId', 'subject', 'fromName', 'fromEmail', 'sentAt', 'body', 'threadKey'],
    properties: {
      messageId: { type: 'string', minLength: 1 },
      sentAt: { type: 'string', minLength: 1 },
      body: { type: 'string' },
      threadKey: { type: 'string' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['stagedSha', 'filename', 'mediaType', 'byteSize'],
          properties: {
            stagedSha: { type: 'string' },
            filename: { type: 'string' },
            mediaType: { type: 'string' },
            byteSize: { type: 'number' },
          },
        },
      },
    },
  },
  TransactionPayload: {
    type: 'object',
    required: [
      'externalId',
      'postedAt',
      'description',
      'amountMinor',
      'currency',
      'direction',
      'accountName',
    ],
    properties: {
      externalId: { type: 'string', minLength: 1 },
      postedAt: { type: 'string', minLength: 1 },
      // The seam this whole gate exists for: a connector that stages
      // amountMinor as a decimal string ("19.99") must fail HERE, not land
      // in a STRICT `amount_minor INTEGER` column as SQLite's last resort.
      amountMinor: { type: 'number' },
      currency: { type: 'string', minLength: 1 },
      direction: { type: 'string', enum: ['debit', 'credit'] },
      accountName: { type: 'string', minLength: 1 },
    },
  },
  LockerItemPayload: {
    type: 'object',
    required: ['title', 'url', 'username', 'password', 'otpSeed', 'notes'],
    properties: {
      title: { type: 'string', minLength: 1 },
    },
  },
  AnnotationPayload: {
    type: 'object',
    required: ['target_type', 'target_id', 'body', 'author_party_id'],
    properties: {
      target_type: { type: 'string' },
      target_id: { type: 'string' },
      body: { type: 'string' },
    },
  },
  TagPayload: {
    type: 'object',
    required: ['target_type', 'target_id', 'label', 'confidence'],
    properties: {
      target_type: { type: 'string' },
      target_id: { type: 'string' },
      scheme_uri: { type: 'string' },
      label: { type: 'string' },
      confidence: { type: 'number' },
    },
  },
  FaceRegionPayload: {
    type: 'object',
    required: ['asset_id', 'bbox', 'confidence'],
    properties: {
      asset_id: { type: 'string' },
      bbox: { type: 'object' },
      party_id: { type: 'string' },
      confidence: { type: 'number' },
    },
  },
  CollectionPayload: {
    type: 'object',
    required: ['name', 'members'],
    properties: {
      name: { type: 'string', minLength: 1 },
      members: {
        type: 'array',
        items: {
          type: 'object',
          required: ['target_type', 'target_id'],
          properties: {
            target_type: { type: 'string' },
            target_id: { type: 'string' },
          },
        },
      },
    },
  },
  FilingPayload: {
    type: 'object',
    required: ['content_id'],
    properties: {
      content_id: { type: 'string', minLength: 1 },
      title: { type: 'string' },
      folder: { type: 'string' },
    },
  },
};

/**
 * Validate `payload` against the named schema and return it typed as `T`,
 * else throw with every field-level violation — the same failure shape
 * `applyBatchTx` already catches per-row (issue #290): the row lands in
 * `failed`, the rest of the batch still publishes.
 */
export function assertPayload<T>(schemaName: keyof typeof SCHEMAS, payload: unknown): T {
  const schema = SCHEMAS[schemaName]!;
  const errors = validateJson(schema, payload);
  if (errors.length > 0) {
    throw new Error(`${schemaName} payload failed schema validation: ${errors.join('; ')}`);
  }
  return payload as T;
}
