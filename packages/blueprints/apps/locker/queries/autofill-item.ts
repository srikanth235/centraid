/**
 * One explicit-gesture fill. Only password is revealed; TOTP is requested as
 * a derivative from locker.totp_code, so the OTP seed never leaves the sealed
 * command boundary. The page origin is normalized, matched against the item's
 * stored URL + policy (same rules as Companion origin-matching), and attached
 * to the reveal receipt for the Approvals/audit surface.
 */

import { matchesOrigin, pageOrigin } from "./origin-matching.ts";

interface LoginRow {
  item_id: string;
  type: string;
  username?: string | null;
  url?: string | null;
  url_match_policy?: "registrable-domain" | "exact-host" | null;
  otp_seed?: string | null;
  deleted_at?: string | null;
}

export default async function autofillItem({
  input,
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  const itemId = String(input?.item_id ?? "");
  const origin = pageOrigin(input?.page_origin);
  if (!itemId || !origin)
    return {
      fill: null,
      reason: "A login id and normalized page origin are required.",
    };
  try {
    const response = await ctx.vault.read({
      entity: "locker.item",
      where: [
        { column: "item_id", op: "eq", value: itemId },
        { column: "type", op: "eq", value: "login" },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
    });
    const row = ((response.rows ?? []) as unknown as LoginRow[])[0];
    if (!row) return { fill: null };
    if (typeof row.url !== "string" || !row.url) {
      return {
        fill: null,
        reason: "This login has no stored origin to match against.",
      };
    }
    const policy =
      row.url_match_policy === "exact-host"
        ? "exact-host"
        : "registrable-domain";
    if (!matchesOrigin({ url: row.url, url_match_policy: policy }, origin)) {
      return { fill: null, reason: "Page origin does not match this login." };
    }
    // THE GATEWAY NO LONGER UNSEALS A LOCKER ROW (#996, rulings R13 and
    // W6-D2), so this handler cannot produce a password and must not pretend
    // otherwise. The origin match above still runs — the Companion is told
    // WHICH login it would have filled and why the value is not here — because
    // a blank answer and "the page does not match" are different facts.
    //
    // WHAT THIS COSTS, STATED RATHER THAN HIDDEN. The Companion is a browser
    // extension: it holds no vault, so it cannot decrypt locally the way a
    // seat does, and it must not be handed `K` (W6-D2 — a surface that could
    // read the key could exfiltrate it). Filling therefore has to be served by
    // a host that already holds `K` behind the member's unlock — the desktop
    // shell — and wiring that is a product decision, not a mechanical
    // deletion. Raised as an open question in the wave-6 receipt; refusing
    // honestly is what this handler can do until it is answered.
    return {
      fill: null,
      reason:
        "Filling from the browser needs a device that holds this vault's key — open the item in Centraid to copy it.",
      match: { item_id: itemId, username: row.username ?? undefined },
    };
  } catch (caughtError) {
    const error = caughtError as { code?: string; message?: string };
    return {
      fill: null,
      vaultDenied: { code: error.code, message: error.message },
    };
  }
}
