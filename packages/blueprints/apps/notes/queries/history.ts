// Body history is the append-only `revises` content-item chain, walked for the
// selected note only. No command fabricates history.

import {
  RELATIONS_SCHEME_URI,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";
import { conceptTaxonomyReads } from "../../_shared/taxonomy-reads.ts";
import { decodeNoteBody } from "../note-body.ts";

const REVISES_NOTATION = "revises";
const MAX_CHAIN_STEPS = 500;

interface NoteRow {
  body_content_id: string;
  created_at: string;
}

interface LinkRow {
  to_id: string;
  valid_from: string;
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

    const [concepts, schemes] = await Promise.all(
      conceptTaxonomyReads(ctx.vault)
    );
    const relationId = findSchemeConcept(
      schemes.rows as Array<{ scheme_id: string; uri: string }>,
      concepts.rows as Array<{
        concept_id: string;
        scheme_id: string;
        notation: string;
      }>,
      RELATIONS_SCHEME_URI,
      REVISES_NOTATION
    )?.concept_id;

    const chain = [note.body_content_id];
    const assertedAt = new Map<string, string>();
    if (relationId) {
      const seen = new Set(chain);
      const followChain = async (
        current: string,
        step: number
      ): Promise<void> => {
        if (step >= MAX_CHAIN_STEPS) return;
        const links = await ctx.vault.read({
          entity: "core.link",
          where: [
            { column: "from_type", op: "eq", value: "core.content_item" },
            { column: "from_id", op: "eq", value: current },
            { column: "to_type", op: "eq", value: "core.content_item" },
            { column: "relation_concept_id", op: "eq", value: relationId },
            { column: "valid_to", op: "is-null" },
          ],
          orderBy: { column: "valid_from", dir: "desc" },
          limit: 1,
        });
        const next = ((links.rows ?? []) as unknown as LinkRow[])[0];
        if (!next || seen.has(next.to_id)) return;
        assertedAt.set(current, next.valid_from);
        seen.add(next.to_id);
        chain.push(next.to_id);
        await followChain(next.to_id, step + 1);
      };
      await followChain(note.body_content_id, 0);
    }

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
