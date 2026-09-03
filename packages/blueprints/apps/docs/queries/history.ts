import {
  RELATIONS_SCHEME_URI,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";

const REVISES_RELATION = "revises";
const MAX_CHAIN_STEPS = 500;

interface DocumentRow {
  document_id: string;
  current_content_id: string;
  created_at: string;
}
interface SchemeRow {
  scheme_id: string;
  uri: string;
}
interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}
interface LinkRow {
  to_id: string;
  valid_from: string;
}
interface ContentRow {
  content_id: string;
  media_type?: string | null;
  byte_size?: number | null;
  content_uri?: string | null;
  created_at?: string;
}

export default async function historyHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const documentId = String(input?.document_id ?? "");
  if (!documentId) return { versions: [] };
  try {
    const docRes = await ctx.vault.read({
      entity: "core.document",
      where: [{ column: "document_id", op: "eq", value: documentId }],
      limit: 1,
      purpose,
    });
    const doc = ((docRes.rows ?? []) as unknown as DocumentRow[])[0];
    if (!doc) return { versions: [] };

    const [schemes, concepts] = await Promise.all([
      ctx.vault.read({ entity: "core.concept_scheme", purpose }),
      ctx.vault.read({ entity: "core.concept", purpose }),
    ]);
    const revisesConceptId = findSchemeConcept(
      (schemes.rows ?? []) as unknown as SchemeRow[],
      (concepts.rows ?? []) as unknown as ConceptRow[],
      RELATIONS_SCHEME_URI,
      REVISES_RELATION
    )?.concept_id;

    const chainIds = [doc.current_content_id];
    const assertedAtOf = new Map<string, string>(); // content_id -> the outgoing edge's valid_from
    if (revisesConceptId) {
      const seen = new Set([doc.current_content_id]);
      const followNext = async (cur: string, step: number): Promise<void> => {
        if (step >= MAX_CHAIN_STEPS) return;
        const links = await ctx.vault.read({
          entity: "core.link",
          where: [
            { column: "from_type", op: "eq", value: "core.content_item" },
            { column: "from_id", op: "eq", value: cur },
            { column: "to_type", op: "eq", value: "core.content_item" },
            {
              column: "relation_concept_id",
              op: "eq",
              value: revisesConceptId,
            },
            { column: "valid_to", op: "is-null" },
          ],
          orderBy: { column: "valid_from", dir: "desc" },
          limit: 5,
          purpose,
        });
        const next = ((links.rows ?? []) as unknown as LinkRow[])[0];
        if (!next || seen.has(next.to_id)) return;
        assertedAtOf.set(cur, next.valid_from);
        chainIds.push(next.to_id);
        seen.add(next.to_id);
        return followNext(next.to_id, step + 1);
      };
      await followNext(doc.current_content_id, 0);
    }

    const contents = await ctx.vault.read({
      entity: "core.content_item",
      where: [{ column: "content_id", op: "in", value: chainIds }],
      purpose,
    });
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as ContentRow[]).map((c) => [
        c.content_id,
        c,
      ])
    );

    const srcOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c?.content_uri;
    const posterOf = (c: ContentRow | undefined) =>
      typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
        ? `/centraid/_vault/blobs/${c.content_id}?variant=poster`
        : null;

    const versions = chainIds.map((id, i) => {
      const c = contentById.get(id);
      return {
        content_id: id,
        media_type: c?.media_type ?? null,
        byte_size: c?.byte_size ?? null,
        content_uri: srcOf(c),
        poster_uri: posterOf(c),
        current: i === 0,
        asserted_at: assertedAtOf.get(id) ?? c?.created_at ?? doc.created_at,
      };
    });

    return { versions };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { versions: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
