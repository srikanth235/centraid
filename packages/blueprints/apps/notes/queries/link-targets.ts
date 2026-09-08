// One bounded probe per `LINK_TARGET_KINDS` entry, each isolated so a denied
// scope leaves its column absent rather than emptying the sheet — which is why
// the journal read rides inside the Notes probe (#834).
import { readJournalNoteIds } from "../../_shared/journal-scheme.ts";
import {
  LINK_TARGET_KINDS,
  NOTE_TARGET_ENTITY,
  linkTargetsFrom,
} from "../link-targets-table.ts";

export default async function linkTargets({ input, ctx }: HandlerArgs) {
  const term = String(input?.term ?? "").trim();
  if (!term) return { targets: [] };
  const settled = await Promise.allSettled(
    LINK_TARGET_KINDS.map(async (target) => {
      const isNotes = target.entity === NOTE_TARGET_ENTITY;
      const [result, journalNoteIds] = await Promise.all([
        ctx.vault.search({
          entity: target.entity,
          query: term,
          limit: 8,
        }),
        isNotes
          ? readJournalNoteIds(ctx.vault)
          : Promise.resolve(new Set<string>()),
      ]);
      return linkTargetsFrom(target, result.rows ?? [], journalNoteIds);
    })
  );
  return {
    targets: settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    ),
  };
}
