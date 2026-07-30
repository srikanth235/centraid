import { useEffect, useState } from "react";

import { parseCard } from "../../capture.js";
import {
  recognizeCaptureImage,
  runBlueprintCaptureAction,
  runBlueprintCaptureQuery,
  stageCaptureFile,
} from "../../gateway-client-capture.js";
import { allocateMinorUnits, parseReceiptText } from "../../receipt-capture.js";
import type { ReceiptDraft, ReceiptLineDraft } from "../../receipt-capture.js";

import styles from "./CaptureOverlay.module.css";

type Destination = "tally" | "docs" | "photos" | "locker";
interface Outcome {
  status?: string;
  reason?: string;
}
interface Dashboard {
  me?: string | null;
  currency?: string;
  groups?: Array<{ group_id?: string; name?: string }>;
}
interface GroupContext {
  members?: Array<{ party_id?: string; name?: string }>;
}

export function CaptureScanPanel({
  onSaved,
}: {
  onSaved: () => void;
}): React.JSX.Element {
  const [file, setFile] = useState<File>();
  const [extraction, setExtraction] = useState<{
    text: string;
    confidence: number;
    engine: string;
  }>();
  const [receipt, setReceipt] = useState<ReceiptDraft>();
  const [destination, setDestination] = useState<Destination>("tally");
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [groupId, setGroupId] = useState("");
  const [members, setMembers] = useState<GroupContext["members"]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (destination !== "tally" || dashboard) return;
    void (async () => {
      try {
        const value = await runBlueprintCaptureQuery<Dashboard>(
          "tally",
          "dashboard"
        );
        setDashboard(value);
        setGroupId(String(value.groups?.[0]?.group_id ?? ""));
      } catch (error) {
        setDashboard({ groups: [] });
        setStatus(
          error instanceof Error
            ? error.message
            : "Could not load Tally groups for this scan."
        );
        setFailed(true);
      }
    })();
  }, [dashboard, destination]);

  useEffect(() => {
    if (!groupId) return;
    void (async () => {
      try {
        const value = await runBlueprintCaptureQuery<GroupContext>(
          "tally",
          "group",
          { group_id: groupId }
        );
        const next = value.members ?? [];
        setMembers(next);
        setSelected(
          next.map((member) => String(member.party_id ?? "")).filter(Boolean)
        );
      } catch (error) {
        setMembers([]);
        setSelected([]);
        setStatus(
          error instanceof Error
            ? error.message
            : "Could not load group members for this scan."
        );
        setFailed(true);
      }
    })();
  }, [groupId]);

  const chooseFile = async (next: File | undefined): Promise<void> => {
    setFile(next);
    setExtraction(undefined);
    setReceipt(undefined);
    setStatus(undefined);
    setFailed(false);
    if (!next) return;
    setBusy(true);
    try {
      const result = await recognizeCaptureImage(next);
      if (!result)
        throw new Error(
          "Gateway OCR is not configured. This PWA fallback needs a local Tesseract-compatible executable."
        );
      setExtraction(result);
      setReceipt(parseReceiptText(result.text));
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (id: string, patch: Partial<ReceiptLineDraft>): void => {
    if (!receipt) return;
    const lines = receipt.lines.map((line) =>
      line.id === id ? { ...line, ...patch } : line
    );
    setReceipt({
      ...receipt,
      lines,
      amountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
      needsReview: false,
    });
  };

  const save = async (): Promise<void> => {
    if (!file || !extraction) return;
    setBusy(true);
    setStatus(undefined);
    setFailed(false);
    try {
      let outcome: Outcome;
      if (destination === "locker") {
        const card = parseCard(extraction.text);
        outcome = await runBlueprintCaptureAction("locker", "add-item", {
          type: "card",
          title: receipt?.merchant || "Scanned card",
          tags: ["scan"],
          cardholder: card.cardholder,
          card_number: card.cardNumber,
          expiry: card.expiry,
          notes:
            "Captured with local OCR. The source image was not stored in Locker.",
        });
      } else {
        const stagedSha = await stageCaptureFile(file);
        if (destination === "docs") {
          outcome = await runBlueprintCaptureAction("docs", "upload", {
            staged_sha: stagedSha,
            title: file.name || "Scanned document",
            extracted_text: extraction.text,
          });
        } else if (destination === "photos") {
          outcome = await runBlueprintCaptureAction("photos", "upload", {
            staged_sha: stagedSha,
            kind: "scan",
            title: file.name || "Scan",
          });
        } else {
          if (!receipt || !dashboard?.me || !groupId)
            throw new Error("Choose a Tally group and review the receipt.");
          if (selected.length === 0)
            throw new Error("Choose at least one participant.");
          const lineItems = receipt.lines.map((line) => ({
            kind: line.kind,
            description: line.description,
            amount_minor: line.amountMinor,
            allocations: allocateMinorUnits(line.amountMinor, selected),
          }));
          const splitMap = new Map<string, number>();
          for (const line of lineItems)
            for (const allocation of line.allocations)
              splitMap.set(
                allocation.party_id,
                (splitMap.get(allocation.party_id) ?? 0) +
                  allocation.share_minor
              );
          outcome = await runBlueprintCaptureAction(
            "tally",
            "add-receipt-expense",
            {
              group_id: groupId,
              description: receipt.merchant,
              amount_minor: receipt.amountMinor,
              paid_by: dashboard.me,
              spent_on: new Date().toISOString().slice(0, 10),
              category: "food",
              staged_sha: stagedSha,
              ocr_text: extraction.text,
              splits: [...splitMap].map(([party_id, share_minor]) => ({
                party_id,
                share_minor,
              })),
              line_items: lineItems,
            }
          );
        }
      }
      if (
        outcome.status === "executed" ||
        outcome.status === "queued" ||
        outcome.status === "in-flight"
      ) {
        setStatus(
          outcome.status === "executed"
            ? `Saved reviewed scan to ${destination}.`
            : "Saved locally and queued for sync."
        );
        window.setTimeout(onSaved, 650);
      } else if (outcome.status === "parked") {
        setStatus("Saved for owner approval in Inbox.");
      } else {
        setFailed(true);
        setStatus(outcome.reason ?? "The vault did not apply this scan.");
      }
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.scanPanel} aria-labelledby="scan-title">
      <h3 id="scan-title">Camera or receipt scan</h3>
      <p className={styles.hint}>
        OCR stays local to the device or your gateway. Review every extracted
        field before anything is committed.
      </p>
      <label className={styles.label}>
        Image
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => void chooseFile(event.target.files?.[0])}
        />
      </label>
      {busy && !extraction ? <p className={styles.hint}>Extracting…</p> : null}
      {extraction ? (
        <>
          <p className={styles.hint}>
            {extraction.engine} · {Math.round(extraction.confidence * 100)}%
            extraction confidence
          </p>
          <div className={styles.kinds} aria-label="Scan destination">
            {(["tally", "docs", "photos", "locker"] as const).map((id) => (
              <button
                key={id}
                type="button"
                className={destination === id ? styles.active : undefined}
                aria-pressed={destination === id}
                onClick={() => setDestination(id)}
              >
                {id === "tally"
                  ? "Tally receipt"
                  : id === "docs"
                    ? "Docs scan"
                    : id === "locker"
                      ? "Locker card"
                      : "Photos"}
              </button>
            ))}
          </div>
          {destination === "tally" && receipt ? (
            <>
              <label className={styles.label}>
                Merchant
                <input
                  value={receipt.merchant}
                  onChange={(event) =>
                    setReceipt({ ...receipt, merchant: event.target.value })
                  }
                />
              </label>
              <label className={styles.label}>
                Group
                <select
                  value={groupId}
                  onChange={(event) => setGroupId(event.target.value)}
                >
                  {(dashboard?.groups ?? []).map((group) => (
                    <option
                      key={String(group.group_id)}
                      value={String(group.group_id)}
                    >
                      {String(group.name ?? "Expense group")}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className={styles.participants}>
                <legend>Allocate every reviewed line to</legend>
                {(members ?? []).map((member) => {
                  const id = String(member.party_id ?? "");
                  return (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(id)}
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(id)
                              ? current.filter((value) => value !== id)
                              : [...current, id]
                          )
                        }
                      />
                      {String(member.name ?? "Member")}
                    </label>
                  );
                })}
              </fieldset>
              <div className={styles.receiptLines}>
                {receipt.lines.map((line) => (
                  <div key={line.id} className={styles.receiptLine}>
                    <span>{line.kind}</span>
                    <input
                      aria-label={`${line.kind} description`}
                      value={line.description}
                      onChange={(event) =>
                        updateLine(line.id, {
                          description: event.target.value,
                        })
                      }
                    />
                    <input
                      aria-label={`${line.description} amount`}
                      inputMode="decimal"
                      value={(line.amountMinor / 100).toFixed(2)}
                      onChange={(event) =>
                        updateLine(line.id, {
                          amountMinor: Math.round(
                            Number(event.target.value || 0) * 100
                          ),
                        })
                      }
                    />
                  </div>
                ))}
              </div>
              <p className={styles.hint}>
                Reviewed total: {(receipt.amountMinor / 100).toFixed(2)}{" "}
                {receipt.currency}
              </p>
            </>
          ) : (
            <label className={styles.label}>
              Reviewed extracted text
              <textarea
                value={extraction.text}
                onChange={(event) =>
                  setExtraction({ ...extraction, text: event.target.value })
                }
              />
            </label>
          )}
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : `Save to ${destination}`}
          </button>
        </>
      ) : null}
      {status ? (
        <output
          className={styles.status}
          aria-live="polite"
          data-failed={failed || undefined}
        >
          {status}
        </output>
      ) : null}
    </section>
  );
}
