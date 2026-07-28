import { useState, type JSX } from "react";

import type {
  LocalUsageReportDTO,
  StorageLimitsDTO,
  StorageLimitsPatchDTO,
} from "../../gateway-client-local-storage.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import { formatBytes, parseBytes } from "./localUsageView.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import gwStyles from "./GatewayScreen.module.css";
import styles from "./StorageLimitsPanel.module.css";

// Storage → Limits (issue #544). Two controls that do DIFFERENT things, and
// the copy says which is which up front — a limits screen where one number
// warns and the other acts is exactly where a user assumes the wrong one.
//
//   Disk budget  — warn-only. Nothing is ever blocked; the gateway degrades a
//                  health component and this page turns amber, then red.
//   Ledger limit — actuating, and safe to be: it makes conversation/audit
//                  archival run early and reach further back. Archival seals
//                  cold rows into the content-addressed store; the delete half
//                  is already gated behind proven custody (issue #438). It
//                  never reaches inside the last 7 days.

/** Presets, in bytes. Chosen to be recognisable ("30 GB") rather than round
 *  in binary — the owner is thinking about their laptop, not about powers. */
const BUDGET_PRESETS: readonly { label: string; bytes: number }[] = [
  { label: "10 GB", bytes: 10 * 1024 ** 3 },
  { label: "30 GB", bytes: 30 * 1024 ** 3 },
  { label: "100 GB", bytes: 100 * 1024 ** 3 },
];

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
}

interface LimitControlProps {
  id: string;
  title: string;
  icon: "Gauge" | "Journal";
  description: string;
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
  description,
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
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
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
      <div className={styles.controlHead}>
        <span className={styles.controlIcon} aria-hidden="true">
          <Icon name={icon} size={14} />
        </span>
        <div className={styles.controlTitles}>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span
          className={styles.controlState}
          data-on={value !== null || undefined}
        >
          {value === null ? "Off" : formatBytes(value)}
        </span>
      </div>

      <div className={styles.controlRow}>
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
}: StorageLimitsPanelProps): JSX.Element {
  const ledger = ledgerBytes(report);

  return (
    <section
      className={cx(gwStyles.panel, styles.card)}
      data-testid="storage-limits-panel"
    >
      <div className={gwStyles.panelHead}>
        <h2>Limits</h2>
      </div>
      <div className={styles.body}>
        {limits === null ? (
          <div className={gwStyles.panelEmpty}>Reading your limits…</div>
        ) : (
          <>
            <LimitControl
              id="budget"
              title="Disk budget"
              icon="Gauge"
              description="How much of this machine Centraid may use. You’ll be warned as it fills — nothing is ever blocked or deleted for you."
              value={limits.totalLimitBytes}
              presets={BUDGET_PRESETS}
              floorBytes={256 * 1024 ** 2}
              floorLabel="budget"
              hereNow={
                report
                  ? `Using ${formatBytes(report.totalBytes)} today` +
                    (limits.totalLimitBytes === null
                      ? "."
                      : ` — you’ll see a warning past ${limits.warnAtPercent}%.`)
                  : null
              }
              onCommit={(bytes) => onSave({ totalLimitBytes: bytes })}
            />

            <LimitControl
              id="ledger"
              title="Ledger limit"
              icon="Journal"
              description="Past this size, conversations and audit rows older than the active window are sealed into the content-addressed store early. Nothing inside the last 7 days is ever archived."
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
          </>
        )}
      </div>
    </section>
  );
}
