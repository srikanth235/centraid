/** Restore an album and its ordered membership from a P5 revision. */
export default async function restoreAlbum({ body, ctx }: HandlerArgs) {
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.restore_album",
      input: (body ?? {}) as Record<string, unknown>,
      purpose: "dpv:Personalisation",
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
