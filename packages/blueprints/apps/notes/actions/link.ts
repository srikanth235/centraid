/** Compile one reviewed [[wikilink]] target into the vault's core.link fabric. */
export default async function linkNote({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "core.link_entities",
      input: {
        from_type: "knowledge.note",
        from_id: String(input.note_id ?? ""),
        to_type: String(input.target_type ?? ""),
        to_id: String(input.target_id ?? ""),
        relation: "references",
        ...(typeof input.start === "number" &&
        typeof input.exact === "string" &&
        input.exact
          ? {
              selector: {
                exact: input.exact,
                prefix: typeof input.prefix === "string" ? input.prefix : "",
                suffix: typeof input.suffix === "string" ? input.suffix : "",
                start: input.start,
              },
            }
          : {}),
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
