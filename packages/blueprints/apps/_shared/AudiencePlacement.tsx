import { useState } from "react";

import styles from "./AudiencePlacement.module.css";

export function AudiencePlacement({
  itemType,
  itemId,
  sourceVaultId,
  label = "Share with household",
}: {
  itemType: "core.collection" | "core.document" | "locker.item" | "tally.group";
  itemId: string;
  sourceVaultId?: string;
  label?: string;
}) {
  const scopes = window.centraid.scopes ?? [];
  const source = sourceVaultId ?? scopes[0]?.id ?? "";
  const targets = scopes.filter(
    (scope) => scope.id !== source && scope.canWrite
  );
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  if (targets.length === 0 || typeof window.centraid.place !== "function")
    return null;

  const place = async () => {
    if (!target || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await window.centraid.place!({
        linkToken: crypto.randomUUID(),
        kind: "add",
        itemType,
        itemId,
        sourceVaultId: source,
        targetVaultId: target,
      });
      setStatus(
        result.status === "executed"
          ? `Shared with ${targets.find((scope) => scope.id === target)?.label ?? "household"}.`
          : (result.reason ?? "Share queued.")
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "The item could not be shared."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.root}>
      <select
        aria-label="Household audience"
        value={target}
        onChange={(event) => setTarget(event.target.value)}
      >
        {targets.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="kit-btn"
        disabled={busy}
        onClick={() => void place()}
      >
        {busy ? "Sharing…" : label}
      </button>
      <output className={styles.status} aria-live="polite">
        {status}
      </output>
    </div>
  );
}
