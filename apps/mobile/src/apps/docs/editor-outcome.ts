// The editor's seven write outcomes (Docs handoff Part 2 §9; #821).
// QUEUED ≠ WAITING FOR APPROVAL: queued is in order on this phone; parked
// waits for owner consent. A byte-identical save writes nothing.
import type { NativeWriteResult } from "../../lib/replica/native-session";

export type EditorPostureId =
  | "unsaved"
  | "saving"
  | "saved"
  | "nochange"
  | "approval"
  | "queued"
  | "refused";

export interface EditorPosture {
  id: EditorPostureId;
  reason?: string;
  savedAt?: string;
  savedVersion?: number | null;
}

export interface EditorOutcomeCopy {
  line: string;
  note: string;
  commit: string;
  net: boolean;
  action?: EditorActionId;
  commitEnabled: boolean;
}

export type EditorActionId = "receipt" | "approvals" | "editable";

export const NOT_TEXT_REASON = "this document is not text";

export const WHAT_CAN_BE_EDITED =
  "A body can only be set on a text document (a kind whose media type is text/…). Every other kind takes a new file through Replace instead — same document, new bytes, each a version in its history.";

const fmtClock = (iso: string): string => {
  const stamp = new Date(iso);
  if (Number.isNaN(stamp.getTime())) return "";
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

export function postureFromResult(result: NativeWriteResult): EditorPosture {
  switch (result.status) {
    case "executed":
      return { id: "saved", savedAt: new Date().toISOString() };
    case "parked":
      return { id: "approval" };
    case "queued":
      return { id: "queued" };
    case "in-flight":
      return { id: "saving" };
    case "denied":
    case "failed":
    case "conflict":
      return {
        id: "refused",
        reason: result.reason ?? "the vault rejected this change",
      };
  }
}

export function editorOutcomeCopy(posture: EditorPosture): EditorOutcomeCopy {
  switch (posture.id) {
    case "unsaved":
      return {
        line: "Unsaved changes on this device · nothing has been committed",
        note: "Closing now keeps the draft here and commits nothing — the library document is unchanged",
        commit: "Save",
        net: false,
        commitEnabled: true,
      };
    case "saving":
      return {
        line: "Saving · one command in flight",
        note: "The command has left this device and has not been acknowledged — nothing else is queued behind it",
        commit: "Saving…",
        net: false,
        commitEnabled: false,
      };
    case "saved": {
      const clock = posture.savedAt ? fmtClock(posture.savedAt) : "";
      const version =
        posture.savedVersion == null ? "" : `version ${posture.savedVersion}`;
      const line = ["Saved", version, clock].filter(Boolean).join(" · ");
      const priorVersion =
        posture.savedVersion == null
          ? ""
          : ` and version ${posture.savedVersion - 1} is still there in full`;
      return {
        line,
        note: `Committed as a new version. The receipt is in this document's history${priorVersion}.`,
        commit: "Saved",
        net: false,
        action: "receipt",
        commitEnabled: false,
      };
    }
    case "nochange":
      return {
        line: "Nothing changed · no new version, no receipt",
        note: "Saved bytes match the current version — a no-op is not a version, so history did not grow",
        commit: "Save",
        net: false,
        commitEnabled: true,
      };
    case "approval":
      return {
        line: "Waiting for the owner's approval · held, not refused",
        note: "Held until the owner consents — it sits in Approvals and is not the same state as queued",
        commit: "Save",
        net: false,
        action: "approvals",
        commitEnabled: false,
      };
    case "queued":
      return {
        line: "Queued on this device · the gateway is unreachable",
        note: "Nobody has to approve it — it sits on this phone in order and goes when the gateway is back",
        commit: "Save",
        net: true,
        commitEnabled: false,
      };
    case "refused": {
      const reason = posture.reason ?? NOT_TEXT_REASON;
      return {
        line: `Refused · ${reason}`,
        note:
          reason === NOT_TEXT_REASON
            ? "A body can only be set on a text document — that is a named rule, not a person to ask"
            : "The vault refused this write and named its reason above — nothing was committed",
        commit: "Save",
        net: true,
        ...(reason === NOT_TEXT_REASON ? { action: "editable" as const } : {}),
        commitEnabled: false,
      };
    }
    default: {
      const exhaustive: never = posture.id;
      throw new Error(`Unhandled editor posture: ${String(exhaustive)}`);
    }
  }
}

export const EDITOR_ACTION_LABELS: Record<EditorActionId, string> = {
  receipt: "Open the version history",
  approvals: "Show it in Approvals",
  editable: "What can be edited?",
};
