// A note's body history is the same append-only `revises` content-item chain
// used by Docs. This query walks only the selected note's chain and decodes
// text bodies for an owner-visible preview; no command fabricates history.

const RELATIONS_SCHEME_URI = "urn:duaility:relations";
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

function decodeBody(uri: string | null | undefined): string {
  if (!uri?.startsWith("data:")) return "(external content)";
  const comma = uri.indexOf(",");
  if (comma === -1) return "(external content)";
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    return meta.includes(";base64")
      ? typeof Buffer === "undefined"
        ? atob(payload)
        : Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  } catch {
    return "(unreadable content)";
  }
}

export default async function noteHistory({ input, ctx }: HandlerArgs) {
  const noteId = String(input?.note_id ?? "");
  if (!noteId) return { versions: [] };
  const purpose = "dpv:ServiceProvision";
  try {
    const notes = await ctx.vault.read({
      entity: "knowledge.note",
      where: [{ column: "note_id", op: "eq", value: noteId }],
      limit: 1,
      purpose,
    });
    const note = ((notes.rows ?? []) as unknown as NoteRow[])[0];
    if (!note) return { versions: [] };

    const [schemes, concepts] = await Promise.all([
      ctx.vault.read({ entity: "core.concept_scheme", purpose }),
      ctx.vault.read({ entity: "core.concept", purpose }),
    ]);
    const schemeId = (
      schemes.rows as Array<{ scheme_id: string; uri: string }>
    )?.find((row) => row.uri === RELATIONS_SCHEME_URI)?.scheme_id;
    const relationId = (
      concepts.rows as Array<{
        concept_id: string;
        scheme_id: string;
        notation: string;
      }>
    )?.find(
      (row) => row.scheme_id === schemeId && row.notation === "revises"
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
          purpose,
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
      entity: "core.content_item",
      where: [{ column: "content_id", op: "in", value: chain }],
      purpose,
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
          body: decodeBody(content?.content_uri),
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
