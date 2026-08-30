import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Only reviewed [[wikilinks]] reach the core.link fabric. */
export default async function linkNote({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
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
  });
}
