import type { JSX } from "react";

import { vaultImportStage } from "../../gateway-client.js";
import { ErrorNote } from "./OnboardingErrorNote.js";

import a11y from "../styles/a11y.module.css";
import styles from "./OnboardingScreen.module.css";

/**
 * Largest export first run will stage. The import contract is a single JSON
 * POST (`/centraid/_vault/imports`), so the whole file is read into renderer
 * memory — and for binary kinds it is expanded through a per-byte JS array and
 * a base64 string on top of that, several times the file's own size in heap. A
 * multi-GB Takeout therefore hangs or kills the renderer before the request
 * ever leaves the machine, so it is refused up front with a number the copy can
 * actually name. Streaming / chunked upload would need a gateway-side contract
 * change and is deliberately out of scope here.
 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** Human size for import copy — MB below a gigabyte, GB above. */
function fileSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024
    ? `${(mb / 1024).toFixed(1)} GB`
    : `${Math.max(1, Math.round(mb))} MB`;
}

/** Extensions the gateway takes as text; everything else goes up as base64. */
const TEXT_KINDS = new Set([
  "ics",
  "vcf",
  "vcard",
  "mbox",
  "csv",
  "md",
  "markdown",
]);

interface OnboardingImportStepProps {
  submitting: boolean;
  onSubmitting: (value: boolean) => void;
  stagedCount: number;
  onStaged: (total: number) => void;
  error: string | null;
  errorDetail: string | null;
  onError: (summary: string, detail?: unknown) => void;
  onClearError: () => void;
  /** False until the connect result is in hand — there is nothing to finish on. */
  canFinish: boolean;
  onFinish: () => void;
  onBack: () => void;
}

/**
 * The import step — stage one export file as a dry run, then either review it
 * in the shell or skip. Staging is deliberately the only gateway call here:
 * field mappings and conflicts are reviewed later, so nothing typed on this
 * step can change the vault.
 */
export function OnboardingImportStep({
  submitting,
  onSubmitting,
  stagedCount,
  onStaged,
  error,
  errorDetail,
  onError,
  onClearError,
  canFinish,
  onFinish,
  onBack,
}: OnboardingImportStepProps): JSX.Element {
  return (
    <div className={styles.form}>
      <label className={styles.importPicker} htmlFor="cd-onb-import">
        <span>
          {stagedCount > 0
            ? `${stagedCount} row${stagedCount === 1 ? "" : "s"} staged`
            : "Choose an export file…"}
        </span>
        <input
          id="cd-onb-import"
          type="file"
          accept=".ics,.vcf,.vcard,.mbox,.csv,.md,.markdown,.zip"
          disabled={submitting}
          className={a11y.srControl}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            // Checked BEFORE any read: `file.text()` / `arrayBuffer()` is
            // the point of no return for renderer memory, and the failure
            // it used to produce was a dead tab, not a message.
            if (file.size > MAX_IMPORT_BYTES) {
              onError(
                `That file is ${fileSize(file.size)}, and first-run import can take up to ${fileSize(MAX_IMPORT_BYTES)} at a time — bigger than that has to be read into memory here before it can be sent, which would stall Centraid. Export a smaller date range, or split the archive, and stage the pieces one at a time. You can keep importing later from Settings → Data.`
              );
              return;
            }
            onSubmitting(true);
            onClearError();
            const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
            void (async () => {
              const payload = TEXT_KINDS.has(extension)
                ? { filename: file.name, text: await file.text() }
                : {
                    filename: file.name,
                    base64: btoa(
                      Array.from(
                        new Uint8Array(await file.arrayBuffer()),
                        (byte) => String.fromCharCode(byte)
                      ).join("")
                    ),
                  };
              const staged = await vaultImportStage(payload);
              onStaged(staged.total);
            })()
              .catch((caughtError: unknown) =>
                onError(
                  "Couldn't read that export. Nothing was staged, so it is safe to pick a different file.",
                  caughtError
                )
              )
              .finally(() => onSubmitting(false));
          }}
        />
      </label>
      <p className={styles.keychainNote}>
        This is a dry run. You will review field mappings and conflicts before
        publishing; failed validation cannot change your vault.
      </p>
      <button
        type="button"
        className={styles.cta}
        disabled={submitting || !canFinish}
        onClick={() => canFinish && onFinish()}
      >
        <span>{stagedCount > 0 ? "Review in Centraid" : "Skip for now"}</span>
      </button>
      {error ? <ErrorNote summary={error} detail={errorDetail} /> : null}
      {/* Import used to be a one-way door (UX-6): the only exits were
          staging a file or "Skip for now", so a typo in the name, a
          second thought about the color, or an accidental tick of "I have
          data to import" were all unreachable from here. The connect result
          is already held, so stepping back costs nothing — anything already
          staged stays staged on the gateway. */}
      <button
        type="button"
        className={styles.backBtn}
        disabled={submitting}
        data-testid="onboarding-import-back"
        onClick={onBack}
      >
        Back to your name and color
      </button>
    </div>
  );
}
