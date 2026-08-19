/*
 * D9 (#726 P3 decision 9): the audience side of a link's own accept|ask|refuse
 * preference for gives ARRIVING at its vault, read before any bytes moved.
 *
 * NOTHING ARRIVES ANY MORE. Copy-as-share retired with #825 (ruling G-copy):
 * the remote reader (`routes/peer-edge-give-route.ts`) is deleted and a
 * cross-owner pair is refused at `POST /centraid/_gateway/edges`, so the only
 * rows this table can still answer for are same-owner ones, where a person
 * does not ask their own permission. The table and its reads are inventoried
 * for #825's dead-give sweep, which decides the shape of what is left.
 *
 * Deliberately its own table rather than `vault_links` columns: setting a
 * preference must never touch the ceremony/route columns' schema, and
 * `vault_links_store.test.ts` greps that table's live DDL for anything that
 * could carry an EndpointId — a preference string is not that, but keeping it
 * elsewhere keeps that test's blast radius honest.
 */

import type { GatewayDatabase } from "./gateway-db.js";

export type ReceiveSetting = "accept" | "ask" | "refuse";

const VALID: ReadonlySet<string> = new Set<ReceiveSetting>([
  "accept",
  "ask",
  "refuse",
]);

export function isReceiveSetting(value: unknown): value is ReceiveSetting {
  return typeof value === "string" && VALID.has(value);
}

/** No row means 'accept' — an approved link behaves as P2 did before D9. */
export function receiveSettingFor(
  db: GatewayDatabase,
  linkId: string,
  vaultId: string
): ReceiveSetting {
  const row = db.db
    .prepare(
      "SELECT setting FROM link_receive_settings WHERE link_id = ? AND vault_id = ?"
    )
    .get(linkId, vaultId) as { setting: ReceiveSetting } | undefined;
  return row?.setting ?? "accept";
}

/** `vaultId` sets ITS OWN receiving preference for gives over `linkId`. */
export function setReceiveSetting(
  db: GatewayDatabase,
  linkId: string,
  vaultId: string,
  setting: ReceiveSetting
): void {
  db.run(
    `INSERT INTO link_receive_settings (link_id, vault_id, setting, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (link_id, vault_id) DO UPDATE SET
       setting = excluded.setting, updated_at = excluded.updated_at`,
    linkId,
    vaultId,
    setting,
    new Date().toISOString()
  );
}
