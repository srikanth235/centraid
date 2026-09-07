import { readById } from "../../_shared/paged-reads.ts";
import { decodeNoteBody } from "../note-body.ts";

/**
 * A single note's canonical body, decoded — the editor's on-open pull. The
 * library and search projections carry only a preview and the checklist tally
 * (#404), so full text is fetched lazily here.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders the
 * "ask the owner for access" state, receipt id included.
 */
export default async function noteHandler({ input, ctx }: HandlerArgs) {
  const noteId = String(input?.note_id ?? "").trim();
  if (!noteId) return { note_id: noteId, body: "" };
  try {
    // ONE ROW, ASKED FOR AS ONE ROW (#996 wave 4, R8).
    const note = await readById<{
      note_id: string;
      body_content_id?: string | null;
      format?: string | null;
    }>(
      ctx,
      {
        name: "notes.note.row",
        select: "note_id, body_content_id, format",
        from: "knowledge_note",
        idColumn: "note_id",
      },
      noteId
    );
    if (!note) return { note_id: noteId, body: "", format: null };
    const content = note.body_content_id
      ? await readById<{ content_id: string; content_uri?: string | null }>(
          ctx,
          {
            name: "notes.note.body",
            select: "content_id, content_uri",
            from: "core_content_item",
            idColumn: "content_id",
          },
          note.body_content_id
        )
      : undefined;
    const body = decodeNoteBody(content?.content_uri);
    return { note_id: noteId, body, format: note.format };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      note_id: noteId,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
