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

// Ledger limit only (#544). Disk budget is warn-only; its row survives only to unset a stored value.

const LEDGER_PRESETS: readonly { label: string; bytes: number }[] = [
  { label: "256 MB", bytes: 256 * 1024 ** 2 },
  { label: "1 GB", bytes: 1024 ** 3 },
  { label: "4 GB", bytes: 4 * 1024 ** 3 },
];

export interface StorageLimitsPanelProps {
  limits: StorageLimitsDTO | null;
  report: LocalUsageReportDTO | null;
  onSave: (patch: StorageLimitsPatchDTO) => Promise<void>;
  gatewayLabel?: string;
  readOnly?: boolean;
}

interface LimitControlProps {
  id: string;
  title: string;
  icon: "Gauge" | "Journal";
  value: number | null;
  presets: readonly { label: string; bytes: number }[];
  hereNow: string | null;
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
      {/* No head: the row above is the head. */}
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

/** ONE file (#916): the ledger band's size IS the vault file's size, which is
 *  the figure the archival duty compares against the limit. */
function ledgerBytes(report: LocalUsageReportDTO | null): number | null {
  if (!report) return null;
  let total = 0;
  for (const vault of report.vaults) {
    for (const component of vault.components) {
      if (component.component === "vault-db") total += component.bytes;
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
  const [open, setOpen] = useState<"budget" | "ledger" | null>(null);

  if (limits === null) return null;
  const strandedBudget = limits.totalLimitBytes !== null;

  const row = (
    id: "budget" | "ledger",
    title: string,
    sub: string,
    value: number | null,
    control: JSX.Element
  ): RowDef => ({
    id,
    meta: value === null ? "off" : formatBytes(value),
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
