/**
 * Face proposals for one asset (#299): the enricher's
 * media.face_region rows — unanswered proposals with confidence, plus
 * whatever the owner already confirmed — and a bounded people list for
 * the confirm picker. A consent denial is a first-class outcome the UI
 * renders as the ask-for-access state.
 *
 * ANSWERED REGIONS NEVER COME BACK (#712). A rejection does not DELETE
 * the row — that would make "gone from this list" and "gone from the vault"
 * the same thing. The row survives carrying its answer, and it is this filter
 * that keeps the lightbox's mini-loop from re-offering a face the owner already
 * rejected or deliberately left unnamed. The lightbox's own progress line
 * (`N of M reviewed`) counts what is left here, so it must not count them
 * either.
 *
 * @type {import('@centraid/server/engine').QueryHandler}
 */

interface RawRegion {
  region_id: string;
  bbox_json?: unknown;
  party_id?: string | null;
  confidence?: number | null;
  confirmed_by_party_id?: string | null;
  /** `proposed` | `confirmed` | `rejected` | `dismissed` (#712). */
  review_state?: string | null;
}

interface RawParty {
  party_id: string;
  kind?: string;
  display_name?: string | null;
}

export default async function faces({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const assetId = String(input?.asset_id ?? "");
  if (!assetId) return { status: 400, body: { error: "asset_id required" } };
  try {
    const [regions, people] = await Promise.all([
      ctx.vault.read({
        entity: "media.face_region",
        where: [{ column: "asset_id", op: "eq", value: assetId }],
        limit: 50,
        purpose,
      }),
      ctx.vault.read({
        entity: "core.party",
        orderBy: { column: "display_name", dir: "asc" },
        limit: 200,
        purpose,
      }),
    ]);
    const persons = ((people.rows ?? []) as unknown as RawParty[]).filter(
      (p) => p.kind === "person"
    );
    const nameOf = new Map(
      persons.map((p) => [p.party_id, p.display_name] as const)
    );
    return {
      status: 200,
      body: {
        regions: ((regions.rows ?? []) as unknown as RawRegion[])
          .filter(
            (r) =>
              r.review_state === "proposed" || r.review_state === "confirmed"
          )
          .map((r) => ({
            region_id: r.region_id,
            bbox: safeParse(r.bbox_json),
            party_id: r.party_id ?? null,
            person_name: r.party_id ? (nameOf.get(r.party_id) ?? null) : null,
            confidence: r.confidence ?? null,
            confirmed: r.confirmed_by_party_id != null,
          })),
        people: persons.map((p) => ({
          party_id: p.party_id,
          name: p.display_name,
        })),
      },
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_ACCESS") {
      return { status: 200, body: { denied: true, reason: e.message } };
    }
    return {
      status: 200,
      body: { regions: [], people: [], error: String(e.message ?? error) },
    };
  }
}

function safeParse(json: unknown): unknown {
  try {
    return JSON.parse(String(json ?? "null"));
  } catch {
    return null;
  }
}
