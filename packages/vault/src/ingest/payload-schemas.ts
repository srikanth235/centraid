// Runtime schema gate for ingest publishers (#374 Tier 3): they were the write
// path skipping validateJson — a cast is compile-time only, so a decimal-STRING
// amount would land in a STRICT column with no backstop; assertPayload runs the
// SAME validator every command uses. Schemas stay permissive, primitive shapes.

import { validateJson } from "../gateway/json-schema.js";

type JsonSchema = Record<string, unknown>;

const identifierSchema: JsonSchema = {
  type: "object",
  required: ["scheme", "value", "label"],
  properties: {
    scheme: { type: "string" },
    value: { type: "string" },
  },
};

const SCHEMAS: Record<string, JsonSchema> = {
  EventPayload: {
    type: "object",
    required: [
      "uid",
      "summary",
      "description",
      "dtstart",
      "dtend",
      "startTz",
      "rrule",
      "status",
    ],
    properties: {
      uid: { type: "string", minLength: 1 },
      summary: { type: "string" },
      dtstart: { type: "string", minLength: 1 },
      status: { type: "string" },
    },
  },
  PartyPayload: {
    type: "object",
    required: ["fn", "sortName", "bday", "identifiers"],
    properties: {
      fn: { type: "string" },
      identifiers: { type: "array", items: identifierSchema },
    },
  },
  MessagePayload: {
    type: "object",
    required: [
      "messageId",
      "subject",
      "fromName",
      "fromEmail",
      "sentAt",
      "body",
      "threadKey",
    ],
    properties: {
      messageId: { type: "string", minLength: 1 },
      sentAt: { type: "string", minLength: 1 },
      body: { type: "string" },
      threadKey: { type: "string" },
      attachments: {
        type: "array",
        items: {
          type: "object",
          required: ["stagedSha", "filename", "mediaType", "byteSize"],
          properties: {
            stagedSha: { type: "string" },
            filename: { type: "string" },
            mediaType: { type: "string" },
            byteSize: { type: "number" },
          },
        },
      },
    },
  },
  TransactionPayload: {
    type: "object",
    required: [
      "externalId",
      "postedAt",
      "description",
      "amountMinor",
      "currency",
      "direction",
      "accountName",
    ],
    properties: {
      externalId: { type: "string", minLength: 1 },
      postedAt: { type: "string", minLength: 1 },
      // The seam: a decimal string fails HERE, not in a STRICT column.
      amountMinor: { type: "number" },
      currency: { type: "string", minLength: 1 },
      direction: { type: "string", enum: ["debit", "credit"] },
      accountName: { type: "string", minLength: 1 },
    },
  },
  LockerItemPayload: {
    type: "object",
    required: ["title", "url", "username", "password", "otpSeed", "notes"],
    properties: {
      title: { type: "string", minLength: 1 },
    },
  },
  NotePayload: {
    type: "object",
    required: ["title", "body", "path"],
    properties: {
      title: { type: "string", minLength: 1 },
      body: { type: "string" },
      path: { type: "string", minLength: 1 },
    },
  },
  // Photo import (#721): only never-null fields carry `type`; an archive
  // silent about a photo must publish it, not fail it.
  MediaAssetPayload: {
    type: "object",
    required: [
      "stagedSha",
      "filename",
      "mediaType",
      "byteSize",
      "path",
      "capturedAt",
      "latitude",
      "longitude",
      "caption",
      "favorite",
      "captureGroupId",
      "album",
    ],
    properties: {
      stagedSha: { type: "string", minLength: 64, maxLength: 64 },
      filename: { type: "string", minLength: 1 },
      mediaType: { type: "string", minLength: 1 },
      byteSize: { type: "number" },
      path: { type: "string", minLength: 1 },
      favorite: { type: "integer", enum: [0, 1] },
    },
  },
  AnnotationPayload: {
    type: "object",
    required: ["target_type", "target_id", "body", "author_party_id"],
    properties: {
      target_type: { type: "string" },
      target_id: { type: "string" },
      body: { type: "string" },
    },
  },
  TagPayload: {
    type: "object",
    required: ["target_type", "target_id", "label", "confidence"],
    properties: {
      target_type: { type: "string" },
      target_id: { type: "string" },
      scheme_uri: { type: "string" },
      label: { type: "string" },
      confidence: { type: "number" },
    },
  },
  FaceRegionPayload: {
    type: "object",
    required: ["asset_id", "bbox", "confidence"],
    properties: {
      asset_id: { type: "string" },
      bbox: { type: "object" },
      party_id: { type: "string" },
      confidence: { type: "number" },
    },
  },
  CollectionPayload: {
    type: "object",
    required: ["name", "members"],
    properties: {
      name: { type: "string", minLength: 1 },
      members: {
        type: "array",
        items: {
          type: "object",
          required: ["target_type", "target_id"],
          properties: {
            target_type: { type: "string" },
            target_id: { type: "string" },
          },
        },
      },
    },
  },
  FilingPayload: {
    type: "object",
    required: ["content_id"],
    properties: {
      content_id: { type: "string", minLength: 1 },
      title: { type: "string" },
      folder: { type: "string" },
    },
  },
  RemoteContentPayload: {
    type: "object",
    required: [
      "sourceId",
      "title",
      "mediaType",
      "sourceUrl",
      "modifiedAt",
      "owner",
    ],
    properties: {
      sourceId: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      mediaType: { type: "string", minLength: 1 },
      sourceUrl: { type: "string", minLength: 1 },
      body: { type: "string" },
    },
  },
};

/**
 * Validate `payload` against the named schema, returned as `T`; else throw
 * with every violation — the shape `applyBatchTx` catches per-row (#290):
 * row lands in `failed`, batch still publishes.
 */
export function assertPayload<T>(
  schemaName: keyof typeof SCHEMAS,
  payload: unknown
): T {
  const schema = SCHEMAS[schemaName]!;
  const errors = validateJson(schema, payload);
  if (errors.length > 0) {
    throw new Error(
      `${schemaName} payload failed schema validation: ${errors.join("; ")}`
    );
  }
  return payload as T;
}
