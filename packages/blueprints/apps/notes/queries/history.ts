// Body history is the note's own REVISION OCCURRENCES (#996, R20(a)), walked
// from `current_revision_id` through `parent_revision_id` for the selected note
// only. No command fabricates history.
//
// It was a `revises` content-item chain — a second history mechanism beside the
// table [#916] ruled the only one, keyed by content, so two notes with
// identical bodies shared one history and a restore could not be told from the
// edit it undid.

import { decodeNoteBody } from "../note-body.ts";
import { noteVersionChain } from "../version-chain.ts";

const MAX_CHAIN_STEPS = 500;

interface NoteRow {
  body_content_id: string;
  current_revision_id?: string | null;
  created_at: string;
}

interface ContentRow {
  content_id: string;
  content_uri?: string | null;
  media_type?: string | null;
  created_at?: string;
}

export default async function noteHistory({ input, ctx }: HandlerArgs) {
  const noteId = String(input?.note_id ?? "");
  if (!noteId) return { versions: [] };
  try {
    const notes = await ctx.vault.read({
      entity: "knowledge.note",
      where: [{ column: "note_id", op: "eq", value: noteId }],
      limit: 1,
    });
    const note = ((notes.rows ?? []) as unknown as NoteRow[])[0];
    if (!note) return { versions: [] };

    const revisions = await ctx.vault.read({
      entity: "core.entity_revision",
      where: [
        { column: "entity_type", op: "eq", value: "knowledge.note" },
        { column: "entity_id", op: "eq", value: noteId },
      ],
      orderBy: { column: "recorded_at", dir: "desc" },
      limit: MAX_CHAIN_STEPS,
    });
    // One spelling of the walk, shared with the phone (`version-chain.ts`).
    const walked = noteVersionChain({
      headContentId: note.body_content_id,
      currentRevisionId: note.current_revision_id ?? null,
      revisions: (revisions.rows ?? []) as never,
      noteId,
    });
    const chain = [...walked.contentIds];
    const assertedAt = walked.assertedAt;

    const contents = await ctx.vault.read({
      acceptTruncation: true,
      entity: "core.content_item",
      where: [{ column: "content_id", op: "in", value: chain }],
    });
    const byId = new Map(
      ((contents.rows ?? []) as unknown as ContentRow[]).map((row) => [
        row.content_id,
        row,
      ])
    );
    return {
      versions: chain.map((contentId, index) => {
        const content = byId.get(contentId);
        return {
          content_id: contentId,
          body: decodeNoteBody(content?.content_uri),
          media_type: content?.media_type ?? null,
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
