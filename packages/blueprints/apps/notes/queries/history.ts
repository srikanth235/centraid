// Body history is the note's own REVISION OCCURRENCES (#996, R20(a)), walked
// from `current_revision_id` through `parent_revision_id` for the selected note
// only. No command fabricates history.
//
// It was a `revises` content-item chain — a second history mechanism beside the
// table [#916] ruled the only one, keyed by content, so two notes with
// identical bodies shared one history and a restore could not be told from the
// edit it undid.

import { inList, readById, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import { decodeNoteBody } from "../note-body.ts";
import { noteVersionChain } from "../version-chain.ts";

const MAX_CHAIN_STEPS = 500;

interface NoteRow {
  note_id: string;
  body_content_id: string;
  current_revision_id?: string | null;
  created_at: string;
}

interface ContentRow {
  content_id: string;
  content_uri?: string | null;
  created_at?: string;
}

export default async function noteHistory({ input, ctx }: HandlerArgs) {
  const noteId = String(input?.note_id ?? "");
  if (!noteId) return { versions: [] };
  try {
    const note = await readById<NoteRow>(
      ctx,
      {
        name: "notes.history.note",
        select: "note_id, body_content_id, current_revision_id, created_at",
        from: "knowledge_note",
        idColumn: "note_id",
      },
      noteId
    );
    if (!note) return { versions: [] };

    // The chain's own length is the window: `MAX_CHAIN_STEPS` caps a malformed
    // chain, and a well-formed one terminates on a null parent long before it.
    const revisions = await ctx.vault.page<Record<string, unknown>>({
      query: {
        name: "notes.history.revisions",
        select:
          "revision_id, entity_type, entity_id, content_id, parent_revision_id, recorded_at",
        from: "core_entity_revision",
        where: "entity_type = ? AND entity_id = ?",
        bind: ["knowledge.note", noteId],
        order: {
          sortColumn: "recorded_at",
          pkColumn: "revision_id",
          descending: true,
        },
      },
      limit: MAX_CHAIN_STEPS,
    });
    // One spelling of the walk, shared with the phone (`version-chain.ts`).
    const walked = noteVersionChain({
      headContentId: note.body_content_id,
      currentRevisionId: note.current_revision_id ?? null,
      revisions: revisions.rows as never,
      noteId,
    });
    const chain = [...walked.contentIds];
    const assertedAt = walked.assertedAt;

    const chainIn = inList("content_id", chain);
    const [contentRows, representations] = await Promise.all([
      // Bounded by the chain the walk produced, so walked to the end of it.
      readPages<ContentRow>(ctx, {
        name: "notes.history.contents",
        select: "content_id, content_uri, created_at",
        from: "core_content_item",
        where: chainIn.sql,
        bind: chainIn.bind,
        order: {
          sortColumn: "content_id",
          pkColumn: "content_id",
          descending: false,
        },
      }),
      // Bytes carry no media type since #996 (R20(b)). A superseded version
      // has no representation of its own — the note's moved with the head —
      // and an edit changes the words, never the format.
      readRepresentations({ ctx, contentIds: chain }),
    ]);
    const noteMediaType =
      representations.byOwner.get(ownerKey("knowledge.note", noteId)) ?? null;
    const byId = new Map(contentRows.map((row) => [row.content_id, row]));
    return {
      versions: chain.map((contentId, index) => {
        const content = byId.get(contentId);
        return {
          content_id: contentId,
          body: decodeNoteBody(content?.content_uri),
          media_type: representations.byContent.get(contentId) ?? noteMediaType,
          current: index === 0,
          asserted_at:
            assertedAt.get(contentId) ?? content?.created_at ?? note.created_at,
        };
      }),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { versions: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
