import { useState } from "react";
import type { JSX } from "react";

import type {
  LocalUsageReportDTO,
  StorageLimitsDTO,
  StorageLimitsPatchDTO,
} from "../../gateway-client-local-storage.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import { formatBytes, parseBytes } from "./localUsageView.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./StorageLimitsPanel.module.css";

// Capacity → the ledger limit (issue #544).
//
// ONE LIMIT, because only one of them is a limit. Offering two side by side,
// in identical form, leaves the copy carrying the whole difference:
//
//   Disk budget  — warn-only. Nothing was ever blocked; setting it degraded a
//                  health component and turned this page amber, then red.
//   Ledger limit — actuating. It makes conversation/audit archival run early
//                  and reach further back. Archival seals cold rows into the
//                  content-addressed store; the delete half is already gated
//                  behind proven custody (issue #438), and it never reaches
//                  inside the last 7 days.
//
// A control that looks exactly like a ceiling and is not one is worse than no
// control: a member who sets "30 GB" and reads the form has every reason to
// believe the vault will stop at 30 GB, and it will not. The disk budget is
// gone from this surface for that reason. Its ROW survives on exactly one
// condition — a budget is already stored — because removing the last control
// that can unset a stored value is a one-way door, and a warning threshold
// somebody set once and can no longer clear is worse again.
//
// NO SECTION OF ITS OWN. A "Limits" head under Capacity is a second head
// restating the same subject — how much room there is, and where the line is —
// as though it were a different question, and on a read-only seat a whole
// bordered card whose entire content is the word "Off" twice.

/** Presets, in bytes. Chosen to be recognisable rather than round in binary —
 *  the owner is thinking about their ledger, not about powers. */
const LEDGER_PRESETS: readonly { label: string; bytes: number }[] = [
  { label: "256 MB", bytes: 256 * 1024 ** 2 },
  { label: "1 GB", bytes: 1024 ** 3 },
  { label: "4 GB", bytes: 4 * 1024 ** 3 },
];

export interface StorageLimitsPanelProps {
  limits: StorageLimitsDTO | null;
  /** Live footprint — powers the "you are here" line under each control. */
  report: LocalUsageReportDTO | null;
  onSave: (patch: StorageLimitsPatchDTO) => Promise<void>;
  /** A read-only seat withholds the verb. The row then says WHERE the limit is
   *  changed instead — a control that is simply missing reads as a limit that
   *  cannot be configured at all, which is not what is true. */
  gatewayLabel?: string;
  readOnly?: boolean;
}

interface LimitControlProps {
  id: string;
  title: string;
  icon: "Gauge" | "Journal";
  /** What this limit currently is, in bytes; `null` when off. */
  value: number | null;
  presets: readonly { label: string; bytes: number }[];
  /** One line of live context ("your ledger is 812 MB today"). */
  hereNow: string | null;
  /** Shown when the entered value would be refused by the gateway. */
  floorBytes: number;
  floorLabel: string;
  onCommit: (bytes: number | null) => Promise<void>;
}

function LimitControl({
  id,
  title,
  icon,
  value,
  presets,
  hereNow,
  floorBytes,
  floorLabel,
  onCommit,
}: LimitControlProps): JSX.Element {
  const [draft, setDraft] = useState(() =>
    value === null ? "" : formatBytes(value)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server is the source of truth: a save elsewhere, or a rejected value,
  // resyncs the field rather than leaving a stale draft that looks committed.
  // Adjusted during render, so the field never paints the stale draft once.
  const [seenValue, setSeenValue] = useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setDraft(value === null ? "" : formatBytes(value));
  }

  const commit = (bytes: number | null): void => {
    setBusy(true);
    setError(null);
    onCommit(bytes)
      .catch((caughtError: unknown) =>
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        )
      )
      .finally(() => setBusy(false));
  };

  const submitDraft = (): void => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      commit(null);
      return;
    }
    const bytes = parseBytes(trimmed);
    if (bytes === null) {
      setError("Enter a size like “30 GB” or “512 MB”.");
      return;
    }
    if (bytes < floorBytes) {
      setError(
        `The smallest usable ${floorLabel} is ${formatBytes(floorBytes)}.`
      );
      return;
    }
    commit(bytes);
  };

  return (
    <div className={styles.control} data-testid={`limit-control-${id}`}>
      {/* NO HEAD: the row above this IS the head — it carries the title, the
          description and the current value, and this is the control it opened. */}
      <div className={styles.controlRow}>
        <span className={styles.controlIcon} aria-hidden="true">
          <Icon name={icon} size={14} />
        </span>
        <div className={styles.presets}>
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={cx(
                controlsCss.chip,
                value === preset.bytes && styles.presetActive
              )}
              disabled={busy}
              onClick={() => commit(preset.bytes)}
            >
              {preset.label}
            </button>
          ))}
          {value === null ? null : (
            <button
              type="button"
              className={controlsCss.chip}
              disabled={busy}
              onClick={() => commit(null)}
            >
              Turn off
            </button>
          )}
        </div>
        <div className={styles.customField}>
          <input
            className={styles.textInput}
            aria-label={`${title} — custom size`}
            placeholder="Custom, e.g. 30 GB"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitDraft();
            }}
          />
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={busy}
            onClick={submitDraft}
          >
            {busy ? "Saving…" : "Set"}
          </button>
        </div>
      </div>

      {error ? (
        <div className={styles.controlError} data-testid={`limit-error-${id}`}>
          {error}
        </div>
      ) : hereNow ? (
        <div className={styles.hereNow}>{hereNow}</div>
      ) : null}
    </div>
  );
}

/** Bytes the ledger currently occupies, summed across mounted vaults. */
function ledgerBytes(report: LocalUsageReportDTO | null): number | null {
  if (!report) return null;
  let total = 0;
  for (const vault of report.vaults) {
    for (const component of vault.components) {
      if (component.component === "ledger") total += component.bytes;
    }
  }
  return total;
}

export default function StorageLimitsPanel({
  limits,
  report,
  onSave,
  gatewayLabel,
  readOnly,
}: StorageLimitsPanelProps): JSX.Element | null {
  const ledger = ledgerBytes(report);
  // One at a time: two open editors under two rows is a form, and neither of
  // these is a field of the other.
  const [open, setOpen] = useState<"budget" | "ledger" | null>(null);

  if (limits === null) return null;
  // The legacy row, present only to be turned off (see the file header).
  const strandedBudget = limits.totalLimitBytes !== null;

  const row = (
    id: "budget" | "ledger",
    title: string,
    sub: string,
    value: number | null,
    control: JSX.Element
  ): RowDef => ({
    id,
    // The VALUE is the meta, because "where is the line" is the question the
    // row answers at a glance; changing it is the verb beside it.
    meta: value === null ? "off" : formatBytes(value),
    // A withheld verb is explained where it is withheld. Without this the row
    // reads as a limit nobody can set, rather than one set on another machine.
    sub:
      readOnly && gatewayLabel
        ? `${sub} · set in Centraid on ${gatewayLabel}`
        : sub,
    title,
    ...(readOnly
      ? {}
      : {
          action: {
            hint: `Change the ${title.toLowerCase()}`,
            label: open === id ? "Close" : "Change",
            onClick: () => setOpen(open === id ? null : id),
          },
        }),
    ...(open === id && !readOnly ? { children: control } : {}),
  });

  return (
    <div data-testid="storage-limits-panel">
      <RowsBlock
        ariaLabel="Limits"
        rows={[
          ...(strandedBudget
            ? [
                {
                  id: "budget",
                  meta: formatBytes(limits.totalLimitBytes ?? 0),
                  sub: "a warning at this figure, never a block — Centraid does not stop at it, so it is no longer offered",
                  title: "Disk budget (no longer enforced)",
                  ...(readOnly
                    ? {}
                    : {
                        action: {
                          hint: "Clear the stored disk budget",
                          label: "Turn off",
                          onClick: () => void onSave({ totalLimitBytes: null }),
                        },
                      }),
                } satisfies RowDef,
              ]
            : []),
          row(
            "ledger",
            "Ledger limit",
            "Past this size, rows older than the last 7 days seal into the store early",
            limits.journalLimitBytes,
            <LimitControl
              id="ledger"
              title="Ledger limit"
              icon="Journal"
              value={limits.journalLimitBytes}
              presets={LEDGER_PRESETS}
              floorBytes={64 * 1024 ** 2}
              floorLabel="ledger limit"
              hereNow={
                ledger === null
                  ? null
                  : `Your ledger is ${formatBytes(ledger)} today across every vault.`
              }
              onCommit={(bytes) => onSave({ journalLimitBytes: bytes })}
            />
          ),
        ]}
      />
    </div>
  );
}
