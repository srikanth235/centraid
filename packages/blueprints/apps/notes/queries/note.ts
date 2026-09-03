import { decodeNoteBody } from "../note-body.ts";

export default async function noteHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const noteId = String(input?.note_id ?? "").trim();
  if (!noteId) return { note_id: noteId, body: "" };
  try {
    const notes = await ctx.vault.read({
      entity: "knowledge.note",
      where: [{ column: "note_id", op: "eq", value: noteId }],
      limit: 1,
      purpose,
    });
    const note = (notes.rows ?? [])[0];
    if (!note) return { note_id: noteId, body: "", format: null };
    const contents = note.body_content_id
      ? await ctx.vault.read({
          entity: "core.content_item",
          where: [
            { column: "content_id", op: "eq", value: note.body_content_id },
          ],
          limit: 1,
          purpose,
        })
      : { rows: [] };
    const body = decodeNoteBody((contents.rows ?? [])[0]?.content_uri);
    return { note_id: noteId, body, format: note.format };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      note_id: noteId,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
