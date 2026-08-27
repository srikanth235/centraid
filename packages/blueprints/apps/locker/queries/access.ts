/**
 * Access history (README-Locker §1). ONLINE-ONLY: `consent.receipt` lives in
 * journal.db, not the replica, so `ctx.vault.authenticate` marks the run
 * ONLINE_ONLY and the gateway serves it. Never catch that — a flattened
 * ONLINE_ONLY draws an empty history as none.
 *
 * THE ROW FILTER IS THE BOUNDARY: `provenanceScopeFailure` guards
 * `consent.provenance` only, so app.json's rowFilter on `object_type` is all
 * that holds this grant to Locker's own receipts.
 */

const LOCKER_ITEM_TYPE = "locker.item";
const LOCKER_AUTH_TYPE = "locker.auth";
const DEFAULT_WINDOW = 200;
const MAX_WINDOW = 2000;

interface ReceiptRow {
  receipt_id: string;
  action: string;
  object_type: string;
  object_id: string | null;
  decision: string;
  occurred_at: string;
  detail_json: string | null;
}

interface Detail {
  columns?: unknown;
  context?: { kind?: string; origin?: string };
  failing?: string;
  code?: string;
}

function parseDetail(json: string | null): Detail {
  if (!json) return {};
  try {
    return JSON.parse(json) as Detail;
  } catch {
    return {};
  }
}

function kindOf(row: ReceiptRow, detail: Detail): "auth" | "reveal" | "fill" {
  if (row.object_type === LOCKER_AUTH_TYPE) return "auth";
  return detail.context?.kind === "fill" ? "fill" : "reveal";
}

export default async function accessHandler({
  input,
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  const purpose = "dpv:ServiceProvision";
  const window = Math.min(
    Math.max(Number(input?.limit) || DEFAULT_WINDOW, 20),
    MAX_WINDOW
  );
  try {
    const authentication = (await ctx.vault.authenticate({
      operation: "status",
      sessionToken: String(input?.auth_session ?? ""),
    })) as { authenticated?: boolean; configured?: boolean };
    if (!authentication.authenticated) {
      return {
        entries: [],
        authRequired: true,
        configured: authentication.configured ?? false,
      };
    }
    const itemId = String(input?.item_id ?? "");
    const result = await ctx.vault.read({
      entity: "consent.receipt",
      where: [
        {
          column: "object_type",
          op: "in",
          value: [LOCKER_ITEM_TYPE, LOCKER_AUTH_TYPE],
        },
        ...(itemId
          ? [{ column: "object_id", op: "eq" as const, value: itemId }]
          : []),
      ],
      orderBy: { column: "occurred_at", dir: "desc" },
      limit: window,
      purpose,
    });
    const rows = (result.rows ?? []) as unknown as ReceiptRow[];
    const entries = rows
      .toSorted((a, b) =>
        String(b.occurred_at ?? "").localeCompare(String(a.occurred_at ?? ""))
      )
      .map((row) => {
        const detail = parseDetail(row.detail_json);
        const kind = kindOf(row, detail);
        return {
          receipt_id: row.receipt_id,
          kind,
          action: row.action,
          decision: row.decision === "deny" ? "deny" : "allow",
          item_id: row.object_type === LOCKER_ITEM_TYPE ? row.object_id : null,
          occurred_at: row.occurred_at,
          ...(kind === "fill" && detail.context?.origin
            ? { origin: detail.context.origin }
            : {}),
          ...(Array.isArray(detail.columns)
            ? { columns: detail.columns.map(String) }
            : {}),
          ...(detail.failing ? { reason: detail.failing } : {}),
        };
      });
    return {
      entries,
      window,
      truncated: rows.length >= window,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "ONLINE_ONLY") throw error;
    return { entries: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
