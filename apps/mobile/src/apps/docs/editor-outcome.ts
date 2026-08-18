// The editor's SEVEN write outcomes (Docs handoff Part 2 §9; issue #821) —
// "a write has seven visible outcomes and the member must always know which
// one is showing."
//
// The copy is the handoff's `DSAVE` table, and each posture maps HONESTLY
// onto the replica's real result union (`NativeWriteResult`,
// lib/replica/native-session.ts): `IntentOutcome` gives executed / parked /
// denied / failed / conflict, the outbox adds queued / in-flight. Three of
// the seven never touch the wire at all:
//
//   * `unsaved`  — local dirt, nothing dispatched.
//   * `nochange` — a byte-identical save WRITES NOTHING. Compared here,
//     before dispatch: "a no-op is not a version" and the history must not
//     grow an entry for it.
//   * `refused` for a non-text kind — the vault's own edit precondition
//     (`media_type LIKE 'text/%'`), known before asking, so the screen wears
//     the Refused posture from the start rather than round-tripping to hear
//     the same no.
//
// The load-bearing distinction: QUEUED ≠ WAITING FOR APPROVAL. Nobody has to
// consent to a queued write — it is in order on this phone and goes when the
// gateway is back; a parked write is held until the owner consents. The two
// notes below say exactly that, in the handoff's own words (generic where the
// handoff used its sample's names — "Ana" is nobody on this vault).
//
// Pure and react-free so all seven mappings are directly assertable.

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
  /** The vault's own reason, on a refusal. */
  reason?: string;
  /** Real facts for the Saved line — never invented. */
  savedAt?: string;
  savedVersion?: number | null;
}

export interface EditorOutcomeCopy {
  /** The status line — the handoff's sentence with real facts interpolated. */
  line: string;
  /** The note names the rule, not the vibe. */
  note: string;
  /** The commit control's label. */
  commit: string;
  /** Drawn in the `net` tone. */
  net: boolean;
  /** The one optional follow-up beside the line. */
  action?: EditorActionId;
  /** The commit control is pressable only where pressing it means something —
   *  "a filled control that cannot be pressed stops being filled." */
  commitEnabled: boolean;
}

export type EditorActionId = "receipt" | "approvals" | "editable";

/** The vault's edit rule, said as the refusal line's second clause. */
export const NOT_TEXT_REASON = "this document is not text";

/** What "What can be edited?" answers — the rule, in the vault's own terms. */
export const WHAT_CAN_BE_EDITED =
  "A body can only be set on a text document (a kind whose media type is text/…). Every other kind takes a new file through Replace instead — same document, new bytes, each a version in its history.";

const fmtClock = (iso: string): string => {
  const stamp = new Date(iso);
  if (Number.isNaN(stamp.getTime())) return "";
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

/**
 * Map ONE real write result to the posture it must show. Total over the
 * union: executed → saved, parked → approval (held, not refused), queued →
 * queued, in-flight → saving, and denied/failed/conflict are all the Refused
 * posture carrying the vault's own reason.
 */
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
    default:
      return {
        id: "refused",
        reason: result.reason ?? "the vault rejected this change",
      };
  }
}

/** The seven postures' words — `DSAVE`, with real facts where the sample had
 *  sample ones. */
export function editorOutcomeCopy(posture: EditorPosture): EditorOutcomeCopy {
  switch (posture.id) {
    case "unsaved":
      return {
        line: "Unsaved changes on this device · nothing has been committed",
        note: "Closing now keeps the draft here and commits nothing. The document in the library is unchanged.",
        commit: "Save",
        net: false,
        commitEnabled: true,
      };
    case "saving":
      return {
        line: "Saving · one command in flight",
        note: "The command has left this device and has not been acknowledged. Nothing else is queued behind it.",
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
        note: "The body you saved is byte-identical to the current version. A no-op is not a version: nothing was written, and the history is not one entry longer.",
        commit: "Save",
        net: false,
        commitEnabled: true,
      };
    case "approval":
      return {
        line: "Waiting for the owner's approval · held, not refused",
        note: "The write is legitimate and it is being held until the owner consents. It is in Approvals, and it commits the moment they do. This is not the same state as queued.",
        commit: "Save",
        net: false,
        action: "approvals",
        commitEnabled: false,
      };
    case "queued":
      return {
        line: "Queued on this device · the gateway is unreachable",
        note: "The write is legitimate and nobody has to approve it. It is on this phone, in order, and it goes the moment the gateway is back. Nothing is lost and nothing is discarded to make room.",
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
            ? 'The rule that refused it can be named: a body can only be set on a text document. This is a different refusal from "not permitted", which names a person to ask instead of a rule.'
            : "The vault refused this write and named its reason above. Nothing was committed and the document is unchanged.",
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

/** The action's visible label, per posture. */
export const EDITOR_ACTION_LABELS: Record<EditorActionId, string> = {
  receipt: "Open the version history",
  approvals: "Show it in Approvals",
  editable: "What can be edited?",
};
