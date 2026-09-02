/**
 * Outbox fixture builders for the executor suite: they take the plane
 * explicitly rather than closing over suite state, so they lift out of the
 * test file unchanged.
 */

import type { VaultPlane } from "./vault-plane.js";

export function configureApiKey(
  plane: VaultPlane,
  over: Record<string, unknown> = {}
): string {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: "sync.configure_credential",
    input: {
      kind: "pull.gmail",
      label: "personal",
      cred_kind: "api_key",
      api_key: "sk-outbox-test-key",
      allowed_hosts: ["gmail.googleapis.com"],
      ...over,
    },
  });
  if (outcome.status !== "executed")
    throw new Error(`configure failed: ${JSON.stringify(outcome)}`);
  return (outcome as { output: { connection_id: string } }).output
    .connection_id;
}

export function stageItem(
  plane: VaultPlane,
  over: Record<string, unknown> = {}
): string {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: "outbox.stage",
    input: {
      kind: "pull.gmail",
      label: "personal",
      verb: "gmail.send",
      target: "ravi@example.com",
      artifact: { to: "ravi@example.com", subject: "Hi", body: "See you." },
      request: {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers: { authorization: "Bearer {{connection:api_key}}" },
        body: '{"raw":"x"}',
      },
      ...over,
    },
  });
  if (outcome.status !== "executed")
    throw new Error(`stage failed: ${JSON.stringify(outcome)}`);
  return (outcome as { output: { item_id: string } }).output.item_id;
}

export function itemRow(
  plane: VaultPlane,
  itemId: string
): Record<string, unknown> {
  return plane.db.vault
    .prepare(
      "SELECT status, result_json, drained_at FROM outbox_item WHERE item_id = ?"
    )
    .get(itemId) as Record<string, unknown>;
}
