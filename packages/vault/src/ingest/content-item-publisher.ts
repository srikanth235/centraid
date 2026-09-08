// FILING AND RENAME PROPOSALS over `core.content_item` (#299), and the remote
// connector's file listing.
//
// A RENAME PROPOSAL RENAMES A WRAPPER (#996, ruling R20(b)). Bytes carry no
// title, so a proposal reaches `core_document.title` or `media_asset.title`;
// content with neither still files, which is the half that means something
// without one. And a remote file listing MINTS the `core.document` it always
// described, with its own representation — it used to be a bare content item
// carrying the source's title and media type on the byte row, which is exactly
// the shape drift ONT-28 named.

import {
  DOCUMENT_TARGET_TYPE,
  FOLDER_SCHEME_URI,
} from "../commands/documents.js";
import { sha256Hex, uuidv7 } from "../ids.js";
import { setRepresentation } from "../schema/representation.js";
import { ensureConcept, ensureScheme } from "./concept-writes.js";
import { assertPayload } from "./payload-schemas.js";
import type { Publisher, PublishedWrite } from "./staging.js";

// ── core.content_item (filing / rename proposals) ───────────────────────

export interface FilingPayload {
  content_id: string;
  title?: string;
  folder?: string;
}

export interface RemoteContentPayload {
  sourceId: string;
  title: string;
  mediaType: string;
  sourceUrl: string;
  modifiedAt: string | null;
  owner: string | null;
  body?: string;
}

function isFilingPayload(
  payload: Record<string, unknown>
): payload is FilingPayload & Record<string, unknown> {
  return typeof payload.content_id === "string";
}

function remoteContentSha(sourceId: string): string {
  // Remote connectors do not download bytes; source id is the identity.
  return sha256Hex(`remote-content\n${sourceId}`);
}

export const contentItemPublisher: Publisher = {
  entityType: "core.content_item",
  probe(vault, payload) {
    if (!isFilingPayload(payload)) {
      const p = payload as unknown as RemoteContentPayload;
      if (!p.sourceId) return null;
      const existing = vault
        .prepare(
          "SELECT content_id FROM core_content_item WHERE sha256 = ? AND deleted_at IS NULL"
        )
        .get(remoteContentSha(p.sourceId)) as
        | { content_id: string }
        | undefined;
      return existing
        ? {
            entityId: existing.content_id,
            disposition: "update",
            note: "remote content item",
          }
        : null;
    }
    const p = payload;
    const existing = vault
      .prepare(
        "SELECT content_id FROM core_content_item WHERE content_id = ? AND deleted_at IS NULL"
      )
      .get(p.content_id ?? "") as { content_id: string } | undefined;
    if (!existing) return null;
    return {
      entityId: existing.content_id,
      disposition: "update",
      note: "filing proposal",
    };
  },
  create(vault, _owner, payload, now) {
    if (isFilingPayload(payload)) {
      // Filing never mints documents — missing content item fails per-row.
      throw new Error(
        "a filing proposal for a missing core.content_item cannot create it"
      );
    }
    const p = assertPayload<RemoteContentPayload>(
      "RemoteContentPayload",
      payload
    );
    const contentId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, content_uri, sha256, byte_size, language,
            creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?)`
      )
      .run(contentId, p.sourceUrl, remoteContentSha(p.sourceId), now);
    // A REMOTE FILE IS A DOCUMENT (#996, ruling R20(b)). The stub used to be a
    // bare content item carrying the source's title and media type on the byte
    // row — the exact shape ONT-28 names. Bytes have neither now, so the
    // listing gets the wrapper it always described: a `core.document` holding
    // the title, and its own representation saying what the file is.
    const documentId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_document
           (document_id, title, current_content_id, created_at, updated_at, deleted_at, purge_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(documentId, p.title, contentId, now, now);
    setRepresentation(vault, uuidv7, now, {
      contentId,
      ownerType: DOCUMENT_TARGET_TYPE,
      ownerId: documentId,
      mediaType: p.mediaType,
      interpretation: "body",
    });
    return {
      entityId: contentId,
      wrote: [{ type: DOCUMENT_TARGET_TYPE, id: documentId }],
    };
  },
  update(vault, entityId, payload, now) {
    if (!isFilingPayload(payload)) {
      const p = assertPayload<RemoteContentPayload>(
        "RemoteContentPayload",
        payload
      );
      vault
        .prepare(
          `UPDATE core_content_item SET content_uri = ? WHERE content_id = ?`
        )
        .run(p.sourceUrl, entityId);
      const wrapper = vault
        .prepare(
          "SELECT document_id FROM core_document WHERE current_content_id = ? LIMIT 1"
        )
        .get(entityId) as { document_id: string } | undefined;
      if (!wrapper) return { wrote: [] };
      vault
        .prepare(
          "UPDATE core_document SET title = ?, updated_at = ? WHERE document_id = ?"
        )
        .run(p.title, now, wrapper.document_id);
      setRepresentation(vault, uuidv7, now, {
        contentId: entityId,
        ownerType: DOCUMENT_TARGET_TYPE,
        ownerId: wrapper.document_id,
        mediaType: p.mediaType,
        interpretation: "body",
      });
      return { wrote: [] };
    }
    const p = assertPayload<FilingPayload>("FilingPayload", payload);
    const wrote: PublishedWrite[] = [];
    // Title/folder live on core_document (#352); content item is HEAD, not
    // identity. Only the current head resolves; else tag/rename the item.
    const doc = vault
      .prepare(
        "SELECT document_id FROM core_document WHERE current_content_id = ?"
      )
      .get(entityId) as { document_id: string } | undefined;
    const targetType = doc ? DOCUMENT_TARGET_TYPE : "core.content_item";
    const targetId = doc ? doc.document_id : entityId;
    // A RENAME PROPOSAL RENAMES A WRAPPER (#996, ruling R20(b)). Bytes have
    // no title, so a filing proposal for content with no document and no asset
    // has nothing to rename — it still files, which is the half that means
    // something without one.
    if (p.title) {
      if (doc) {
        vault
          .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
          .run(p.title, targetId);
      } else {
        vault
          .prepare(`UPDATE media_asset SET title = ? WHERE content_id = ?`)
          .run(p.title, entityId);
      }
    }
    if (p.folder) {
      const schemeId = ensureScheme(vault, FOLDER_SCHEME_URI, "Folders");
      const byLabel = vault
        .prepare(
          `SELECT concept_id FROM core_concept WHERE scheme_id = ? AND lower(pref_label) = lower(?)`
        )
        .get(schemeId, p.folder) as { concept_id: string } | undefined;
      const conceptId =
        byLabel?.concept_id ?? ensureConcept(vault, schemeId, p.folder);
      vault
        .prepare(
          `DELETE FROM core_tag
            WHERE target_type = ? AND target_id = ?
              AND concept_id IN (SELECT c.concept_id FROM core_concept c WHERE c.scheme_id = ?)`
        )
        .run(targetType, targetId, schemeId);
      const tagId = uuidv7();
      vault
        .prepare(
          `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`
        )
        .run(tagId, targetType, targetId, conceptId, now);
      wrote.push({ type: "core.tag", id: tagId });
    }
    return { wrote };
  },
};
