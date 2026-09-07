// Activity trail (#352). Non-owner reads obey provenanceScopeFailure
// (activity-read.test.ts): exactly one eq pair + read consent on the entity's own table.
//
// THE TRAIL OF ONE DOCUMENT IS A WALK, NOT A WINDOW (#996 wave 4, R8). The read
// said "accept truncation", which on a long-lived document meant the rail
// showed whichever end of its history the reader's default happened to reach —
// and a trail that silently omits events is worse than one that says it cannot
// be shown. The walk states its ceiling and throws at it.

import { readPages } from "../../_shared/paged-reads.ts";

const DOCUMENT_TARGET_TYPE = "core.document";

interface ProvenanceRow {
  prov_activity: string;
  agent_kind: string;
  occurred_at: string;
}

export default async function activityHandler({ input, ctx }: HandlerArgs) {
  const documentId = String(input?.document_id ?? "");
  if (!documentId) return { events: [] };
  try {
    const rows = await readPages<ProvenanceRow>(ctx, {
      name: "docs.activity.provenance",
      select: "prov_id, prov_activity, agent_kind, occurred_at",
      from: "access_provenance",
      where: "entity_type = ? AND entity_id = ?",
      bind: [DOCUMENT_TARGET_TYPE, documentId],
      order: {
        sortColumn: "occurred_at",
        pkColumn: "prov_id",
        descending: true,
      },
    });
    // The walk already ordered by `occurred_at`; the sort survives because the
    // rail's order is the rail's own claim, not a page boundary's.
    const events = rows
      .map((r) => ({
        activity: r.prov_activity,
        agent_kind: r.agent_kind,
        occurred_at: r.occurred_at,
      }))
      .toSorted((a, b) =>
        String(b.occurred_at ?? "").localeCompare(String(a.occurred_at ?? ""))
      );
    return { events };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { events: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
