import { useEffect, useRef, useState } from "react";

import { applyDelegateCaptureKind, classifyCapture } from "../../capture.js";
import type { CaptureKind, CapturePreview } from "../../capture.js";
import {
  classifyAmbiguousCapture,
  runBlueprintCaptureAction,
  runBlueprintCaptureQuery,
} from "../../gateway-client-capture.js";
import { CaptureScanPanel } from "./CaptureScanPanel.js";

import styles from "./CaptureOverlay.module.css";

interface Outcome {
  status?: string;
  reason?: string;
}
interface AgendaContext {
  calendars?: Array<{ calendar_id?: string; name?: string }>;
}
interface TallyContext {
  me?: string | null;
  currency?: string;
  groups?: Array<{ group_id?: string; name?: string }>;
}

export function CaptureLauncher({
  onOpen,
}: {
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.launcher}
      title="Quick capture (C)"
      onClick={onOpen}
    >
      + Add
    </button>
  );
}

export function CaptureOverlay({
  initialText = "",
  onClose,
}: {
  initialText?: string;
  onClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<CapturePreview | undefined>(() =>
    initialText.trim() ? classifyCapture(initialText) : undefined
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [agenda, setAgenda] = useState<AgendaContext>();
  const [tally, setTally] = useState<TallyContext>();
  const [calendarId, setCalendarId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [scanOpen, setScanOpen] = useState(false);

  useEffect(() => {
    if (typeof dialog.current?.showModal === "function")
      dialog.current.showModal();
  }, []);

  useEffect(() => {
    if (preview?.kind === "event" && !agenda) {
      void (async () => {
        try {
          const next = await runBlueprintCaptureQuery<AgendaContext>(
            "agenda",
            "upcoming"
          );
          setAgenda(next);
          setCalendarId(String(next.calendars?.[0]?.calendar_id ?? ""));
        } catch (error) {
          setAgenda({ calendars: [] });
          setStatus(
            error instanceof Error
              ? error.message
              : "Could not load calendars for this capture."
          );
        }
      })();
    }
    if (preview?.kind === "expense" && !tally) {
      void (async () => {
        try {
          const next = await runBlueprintCaptureQuery<TallyContext>(
            "tally",
            "dashboard"
          );
          setTally(next);
          setGroupId(String(next.groups?.[0]?.group_id ?? ""));
        } catch (error) {
          setTally({ groups: [] });
          setStatus(
            error instanceof Error
              ? error.message
              : "Could not load Tally groups for this capture."
          );
        }
      })();
    }
  }, [agenda, preview?.kind, tally]);

  const review = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    setStatus(undefined);
    const local = classifyCapture(text);
    setPreview(local);
    if (local.confidence === "needs-review") {
      const candidate = await classifyAmbiguousCapture(text).catch(
        () => undefined
      );
      if (candidate) setPreview(applyDelegateCaptureKind(local, candidate));
      else
        setStatus(
          "The local harness is unavailable. Choose the destination before saving."
        );
    }
    setBusy(false);
  };

  const setKind = (kind: CaptureKind): void => {
    const base = preview ?? classifyCapture(text);
    setPreview({ ...base, kind, confidence: "needs-review" });
  };

  const save = async (): Promise<void> => {
    if (!preview || !text.trim()) return;
    setBusy(true);
    setFailed(false);
    setStatus(undefined);
    try {
      let outcome: Outcome;
      if (preview.kind === "task") {
        outcome = await runBlueprintCaptureAction("tasks", "add", {
          title: preview.title,
          description: preview.body,
        });
      } else if (preview.kind === "note") {
        outcome = await runBlueprintCaptureAction("notes", "create-note", {
          title: preview.title,
          body_text: preview.body,
          format: "markdown",
        });
      } else if (preview.kind === "event") {
        if (!calendarId || !preview.startsAt)
          throw new Error("Choose a calendar and event time.");
        const start = new Date(preview.startsAt);
        const end = new Date(
          start.getTime() + (preview.durationMinutes ?? 60) * 60_000
        );
        outcome = await runBlueprintCaptureAction("agenda", "propose", {
          summary: preview.title,
          description: preview.body,
          calendar_id: calendarId,
          dtstart: start.toISOString(),
          dtend: end.toISOString(),
        });
      } else {
        if (!groupId || !tally?.me || !preview.amountMinor)
          throw new Error("Choose a group and enter an amount.");
        outcome = await runBlueprintCaptureAction("tally", "add-expense", {
          group_id: groupId,
          description: preview.title,
          amount_minor: preview.amountMinor,
          paid_by: tally.me,
          spent_on: new Date().toISOString().slice(0, 10),
          category: "general",
          splits: [{ party_id: tally.me, share_minor: preview.amountMinor }],
        });
      }
      if (
        outcome.status === "executed" ||
        outcome.status === "queued" ||
        outcome.status === "in-flight"
      ) {
        setStatus(
          outcome.status === "executed"
            ? `Saved to ${preview.kind}.`
            : "Saved locally and queued for sync."
        );
        window.setTimeout(onClose, 550);
      } else if (outcome.status === "parked") {
        setStatus("Saved for owner approval in Notifications.");
      } else {
        setFailed(true);
        setStatus(outcome.reason ?? "The vault did not apply this capture.");
      }
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="capture-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <header className={styles.head}>
        <h2 id="capture-title">Quick capture</h2>
        <button
          type="button"
          aria-label="Close quick capture"
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <div className={styles.body}>
        <button
          type="button"
          aria-expanded={scanOpen}
          onClick={() => setScanOpen((value) => !value)}
        >
          {scanOpen ? "Hide visual scan" : "Scan an image, receipt, or PDF"}
        </button>
        {scanOpen ? <CaptureScanPanel onSaved={onClose} /> : null}
        <label className={styles.label}>
          What do you want to remember?
          <textarea
            autoFocus
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setPreview(undefined);
            }}
            placeholder="Remind me to call Maya, spent $18 on lunch, meeting tomorrow at 9…"
          />
        </label>
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void review()}
        >
          {busy && !preview ? "Classifying…" : "Preview"}
        </button>
        {preview ? (
          <>
            <p className={styles.hint}>
              Review the destination and parsed fields. Nothing is committed
              until you choose Save.
            </p>
            <div className={styles.kinds} aria-label="Capture destination">
              {(["task", "expense", "note", "event"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={preview.kind === kind ? styles.active : undefined}
                  aria-pressed={preview.kind === kind}
                  onClick={() => setKind(kind)}
                >
                  {kind[0]?.toUpperCase()}
                  {kind.slice(1)}
                </button>
              ))}
            </div>
            <label className={styles.label}>
              Title
              <input
                value={preview.title}
                onChange={(event) =>
                  setPreview({ ...preview, title: event.target.value })
                }
              />
            </label>
            {preview.kind === "event" ? (
              <>
                <label className={styles.label}>
                  Starts
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(preview.startsAt)}
                    onChange={(event) => {
                      const value = event.target.value;
                      setPreview(
                        value
                          ? {
                              ...preview,
                              startsAt: new Date(value).toISOString(),
                            }
                          : withoutStartsAt(preview)
                      );
                    }}
                  />
                </label>
                <label className={styles.label}>
                  Calendar
                  <select
                    value={calendarId}
                    onChange={(event) => setCalendarId(event.target.value)}
                  >
                    {(agenda?.calendars ?? []).map((calendar) => (
                      <option
                        key={String(calendar.calendar_id)}
                        value={String(calendar.calendar_id)}
                      >
                        {String(calendar.name ?? "Calendar")}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            {preview.kind === "expense" ? (
              <>
                <label className={styles.label}>
                  Amount ({preview.currency ?? tally?.currency ?? "currency"})
                  <input
                    inputMode="decimal"
                    value={
                      preview.amountMinor
                        ? (preview.amountMinor / 100).toFixed(2)
                        : ""
                    }
                    onChange={(event) =>
                      setPreview({
                        ...preview,
                        amountMinor: Math.round(
                          Number(event.target.value || 0) * 100
                        ),
                      })
                    }
                  />
                </label>
                <label className={styles.label}>
                  Group
                  <select
                    value={groupId}
                    onChange={(event) => setGroupId(event.target.value)}
                  >
                    {(tally?.groups ?? []).map((group) => (
                      <option
                        key={String(group.group_id)}
                        value={String(group.group_id)}
                      >
                        {String(group.name ?? "Group")}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
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
      </div>
      <footer className={styles.foot}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || !preview || !preview.title.trim()}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </dialog>
  );
}

function toLocalDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function withoutStartsAt(preview: CapturePreview): CapturePreview {
  const { startsAt: _startsAt, ...rest } = preview;
  return rest;
}
