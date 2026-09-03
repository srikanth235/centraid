import {
  MAX_INLINE_DATA_URI_CHARS,
  mintContentFromDataUri,
} from "../blob/mint.js";
import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { assertInlineDataUriWithinBudget } from "./inline-body-guard.js";
import { releaseContentIfUnreferenced } from "./media.js";

const SUBJECT_PK: Record<string, string> = {
  "core.event": "event_id",
  "core.party": "party_id",
  "core.transaction": "txn_id",
  "schedule.task": "task_id",
  "knowledge.note": "note_id",
  "social.thread": "thread_id",
  "social.message": "message_id",
  "media.asset": "asset_id",
  "locker.item": "item_id",
};

const ROLES = [
  "photo",
  "manual",
  "receipt",
  "warranty",
  "contract",
  "embed",
  "other",
] as const;

const ATTACH: CommandDefinition = {
  name: "core.attach",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["subject_type", "subject_id"],
    additionalProperties: false,
    properties: {
      subject_type: { type: "string", enum: Object.keys(SUBJECT_PK) },
      subject_id: { type: "string", minLength: 1 },
      data_uri: { type: "string", minLength: 6 },
      content_id: { type: "string", minLength: 1 },
      staged_sha: { type: "string", minLength: 64, maxLength: 64 },
      title: { type: "string" },
      role: { type: "string", enum: [...ROLES] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["attachment_id", "content_id"],
    properties: {
      attachment_id: { type: "string" },
      content_id: { type: "string" },
      is_primary: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "exactly_one_source",
      sql: "SELECT ((:data_uri IS NOT NULL) + (:content_id IS NOT NULL) + (:staged_sha IS NOT NULL)) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "is_data_uri",
      sql: "SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (:data_uri LIKE 'data:%') END AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "within_size_cap",
      sql: `SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (length(:data_uri) <= ${MAX_INLINE_DATA_URI_CHARS}) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "staged_or_owned",
      sql: `SELECT CASE WHEN :staged_sha IS NULL THEN 1 ELSE
              (EXISTS(SELECT 1 FROM blob_staging WHERE sha256 = :staged_sha AND variant IS NULL)
               OR EXISTS(SELECT 1 FROM core_content_item WHERE sha256 = :staged_sha)) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "content_exists",
      sql: `SELECT CASE WHEN :content_id IS NULL THEN 1 ELSE
              (SELECT count(*) FROM core_content_item
                WHERE content_id = :content_id AND deleted_at IS NULL) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "attachment_links_subject_to_content",
      sql: `SELECT count(*) AS n FROM core_attachment
             WHERE attachment_id = :attachment_id
               AND target_type = :subject_type AND target_id = :subject_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: attach,
};

function attach(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    subject_type: string;
    subject_id: string;
    data_uri?: string;
    content_id?: string;
    staged_sha?: string;
    title?: string;
    role?: string;
  };
  const pk = SUBJECT_PK[input.subject_type];
  if (!pk) throw new Error(`cannot attach to ${input.subject_type}`);
  const table = input.subject_type.replace(".", "_");
  const subject = ctx.db
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${pk} = ?`)
    .get(input.subject_id) as { n: number };
  if (subject.n !== 1)
    throw new Error(`no ${input.subject_type} with id ${input.subject_id}`);

  let contentId: string;
  let mediaType: string;
  let byteSize: number;
  if (input.staged_sha !== undefined) {
    const claimed = ctx.blobs.claimStaged(input.staged_sha, {
      title: input.title,
    });
    contentId = claimed.contentId;
    mediaType = claimed.mediaType;
    byteSize = claimed.byteSize;
  } else if (input.data_uri !== undefined) {
    assertInlineDataUriWithinBudget(input.data_uri);
    const minted = mintContentFromDataUri(ctx, input.data_uri, {
      title: input.title,
    });
    contentId = minted.contentId;
    mediaType = minted.mediaType;
    byteSize = minted.byteSize;
  } else if (input.content_id === undefined) {
    throw new Error("attach needs a staged_sha, data_uri or content_id"); // precondition guards this
  } else {
    const existing = ctx.db
      .prepare(
        "SELECT media_type, byte_size FROM core_content_item WHERE content_id = ? AND deleted_at IS NULL"
      )
      .get(input.content_id) as
      | { media_type: string; byte_size: number }
      | undefined;
    if (!existing) throw new Error(`no live content item ${input.content_id}`);
    contentId = input.content_id;
    mediaType = existing.media_type;
    byteSize = existing.byte_size;
  }
  const role =
    input.role ?? (mediaType.startsWith("image/") ? "photo" : "other");
  const existing = ctx.db
    .prepare(
      "SELECT count(*) AS n FROM core_attachment WHERE target_type = ? AND target_id = ?"
    )
    .get(input.subject_type, input.subject_id) as { n: number };
  const isPrimary = existing.n === 0 ? 1 : 0;
  const attachmentId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_attachment (attachment_id, target_type, target_id, content_id, role, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      attachmentId,
      input.subject_type,
      input.subject_id,
      contentId,
      role,
      isPrimary,
      ctx.now
    );
  ctx.wrote("core.attachment", attachmentId);
  ctx.cite({
    claim: `${mediaType} (${byteSize} bytes) attached to ${input.subject_type} ${input.subject_id}`,
    entityType: input.subject_type,
    entityId: input.subject_id,
  });
  return {
    attachment_id: attachmentId,
    content_id: contentId,
    is_primary: isPrimary,
  };
}

const DETACH: CommandDefinition = {
  name: "core.detach",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["attachment_id"],
    additionalProperties: false,
    properties: { attachment_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["attachment_id"],
    properties: {
      attachment_id: { type: "string" },
      content_released: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "attachment_exists",
      sql: "SELECT count(*) AS n FROM core_attachment WHERE attachment_id = :attachment_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "attachment_removed",
      sql: "SELECT count(*) AS n FROM core_attachment WHERE attachment_id = :attachment_id",
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: detach,
};

function detach(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { attachment_id: string };
  const attachment = ctx.db
    .prepare("SELECT content_id FROM core_attachment WHERE attachment_id = ?")
    .get(input.attachment_id) as { content_id: string } | undefined;
  ctx.db
    .prepare("DELETE FROM core_attachment WHERE attachment_id = ?")
    .run(input.attachment_id);
  ctx.wrote("core.attachment", input.attachment_id);
  const released = attachment
    ? releaseContentIfUnreferenced(ctx, attachment.content_id)
    : false;
  if (released)
    ctx.cite({
      claim: `nothing else references content ${attachment?.content_id ?? ""}: its bytes go to the storage sweep`,
      entityType: "core.content_item",
      entityId: attachment?.content_id ?? "",
    });
  return {
    attachment_id: input.attachment_id,
    content_released: released ? 1 : 0,
  };
}

export function registerAttachmentCommands(gateway: Gateway): void {
  gateway.registerCommand(ATTACH);
  gateway.registerCommand(DETACH);
}

export const ATTACHABLE_SUBJECTS = Object.keys(SUBJECT_PK);
