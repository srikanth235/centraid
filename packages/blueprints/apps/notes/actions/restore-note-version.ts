/** Append a restore revision and repoint a live note at its prior body. */
export default async function restoreNoteVersion({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "knowledge.restore_note_version",
      input: {
        note_id: String(input.note_id ?? ""),
        content_id: String(input.content_id ?? ""),
      },
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
