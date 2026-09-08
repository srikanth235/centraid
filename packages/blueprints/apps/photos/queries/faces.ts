/** One photo shows this many faces; the picker offers this many names. */
const FACES_PER_PHOTO = 50;
const NAME_PICKER_ROWS = 200;

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
  const assetId = String(input?.asset_id ?? "");
  if (!assetId) return { status: 400, body: { error: "asset_id required" } };
  try {
    const [regions, people] = await Promise.all([
      ctx.vault.page<RawRegion>({
        query: {
          name: "photos.faces.regions",
          select:
            "region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id, review_state",
          from: "media_face_region",
          where: "asset_id = ?",
          bind: [assetId],
          order: {
            sortColumn: "region_id",
            pkColumn: "region_id",
            descending: false,
          },
        },
        limit: FACES_PER_PHOTO,
      }),
      ctx.vault.page<RawParty>({
        query: {
          name: "photos.faces.parties",
          select: "party_id, display_name, kind",
          from: "core_party",
          order: {
            sortColumn: "display_name",
            pkColumn: "party_id",
            descending: false,
          },
        },
        limit: NAME_PICKER_ROWS,
      }),
    ]);
    const persons = people.rows.filter((p) => p.kind === "person");
    const nameOf = new Map(
      persons.map((p) => [p.party_id, p.display_name] as const)
    );
    return {
      status: 200,
      body: {
        regions: regions.rows
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
