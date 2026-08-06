// THE ENRICHMENT GATE (v4 handoff §8, prototype `s==='enrich'`).
//
// What this replaced, and why it was a defect rather than a style: a popover
// status readout ("Face detection is on (cloud model)") with a `Detect faces
// now` button beside it. That is a SETTINGS TOGGLE — the exact shape the
// handoff forbids in so many words (line 4332) — and it fired
// `request-enrichment` on one click, having told the member nothing about
// where the work would run, what would leave the device, what would be
// written, or how to undo it. None of the nine facts the design requires were
// on screen, and the cloud-helper option — the only place the product says
// that photographs can leave the device — did not exist at all.
//
// Now: the control OPENS A QUESTION (EnrichmentConsent.tsx) and this file is
// the gate. THE LOAD-BEARING RULE — no enrichment write is issued without an
// explicit answer:
//
//   * mounting, opening, reading the policy and closing the surface all write
//     nothing;
//   * `act("request-enrichment", …)` is reachable from exactly one place, the
//     `Run on this device` callback;
//   * `Not now` and Escape write nothing and say so;
//   * the answer is latched (`answered`), so the question cannot be answered
//     twice by a double click or a re-open.
//
// The consent surface itself is a pure view; keeping the ONE call site here
// means "can this fire without an answer" is answered by reading one
// function, and the jsdom suite (src/photos-enrichment-consent.test.ts) pins
// it by counting writes.
import { useEffect, useState } from "react";

import {
  CLOUD_ANSWER,
  deviceAnswerFor,
  ENRICHMENT_DECLINED_NOTE,
  ENRICHMENT_REQUESTED_NOTE,
  ENRICHMENT_STATUS_LINE,
  ENRICHMENT_TITLE,
} from "../enrichment-consent.ts";
import { FacesIcon } from "../icons.tsx";
import { act, narrate, notice } from "../outcomes.ts";
import { EnrichmentConsent } from "./EnrichmentConsent.tsx";

import styles from "./Enrichment.module.css";

interface EnrichmentStatus {
  tier?: string | null;
  vaultDenied?: { message?: string } | null;
}

/**
 * The header control and the question it opens.
 *
 * `photographCount` is the live library count for the question's title. It is
 * optional because the mount is a slot that is constructed once and never
 * re-rendered by app-root; absent, the title asks about "these photographs"
 * rather than inventing a number.
 */
export function EnrichmentPanel({
  photographCount,
}: {
  photographCount?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<EnrichmentStatus | null>(null); // null while first read in flight
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<"device" | "declined" | null>(null);

  // The policy read happens when the question is OPENED, not at mount: it is
  // a read the member's own gesture asks for, and a slot constructed once at
  // boot should not query the vault for a screen nobody has asked to see.
  useEffect(() => {
    if (!open || status != null) return undefined;
    let cancelled = false;
    window.centraid
      .read<EnrichmentStatus>({ query: "enrichment-status" })
      .then((data) => {
        if (!cancelled) setStatus(data ?? {});
      })
      .catch(() => {
        if (!cancelled)
          setStatus({
            tier: null,
            vaultDenied: { message: "Could not read." },
          });
      });
    return () => {
      cancelled = true;
    };
  }, [open, status]);

  // The frame's ONE status line carries what is true of this vault right now
  // (prototype cfg 3968). It is posted on open and taken back down on close —
  // never left behind on a screen this surface no longer owns.
  useEffect(() => {
    if (!open) return undefined;
    notice(ENRICHMENT_STATUS_LINE);
    return () => notice("");
  }, [open]);

  // Escape closes the question. Closing is NOT an answer: nothing is written,
  // and the question can be asked again.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // THE ONE WRITE. Reachable from the `Run on this device` answer and from
  // nowhere else in this file.
  async function runOnDevice(): Promise<void> {
    if (busy || answered) return;
    if (!deviceAnswerFor(status?.tier, !!status?.vaultDenied).available) return;
    setBusy(true);
    const outcome = await act("request-enrichment", {
      entity_type: "media.media_asset",
    });
    setBusy(false);
    if (narrate(outcome)) {
      setAnswered("device");
      notice(ENRICHMENT_REQUESTED_NOTE);
    }
  }

  function decline(): void {
    setAnswered("declined");
    notice(ENRICHMENT_DECLINED_NOTE);
    setOpen(false);
  }

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`kit-icon-btn ${styles.toggle}`}
        data-active={open ? "true" : "false"}
        aria-haspopup="dialog"
        aria-expanded={open ? "true" : "false"}
        aria-label={ENRICHMENT_TITLE}
        onClick={() => setOpen((v) => !v)}
      >
        <FacesIcon />
      </button>
      {/* Native <dialog>, never `showModal()` — an app may not take the top
          layer over the frame's own chrome (MoreSheet.tsx holds the same
          rule). `open` is mandatory: a <dialog> without it is display:none. */}
      {open ? (
        <dialog open className={styles.surface} aria-label={ENRICHMENT_TITLE}>
          <EnrichmentConsent
            count={photographCount ?? null}
            onDevice={deviceAnswerFor(status?.tier, !!status?.vaultDenied)}
            cloud={CLOUD_ANSWER}
            busy={busy}
            answered={answered}
            onRunOnDevice={() => void runOnDevice()}
            onDecline={decline}
          />
        </dialog>
      ) : null}
    </div>
  );
}
