import type { EnrichmentConsentProps } from "./components/EnrichmentConsent.tsx";
import {
  CLOUD_ANSWER,
  deviceAnswerFor,
  ENRICHMENT_DECLINED_NOTE,
  ENRICHMENT_REQUESTED_NOTE,
} from "./enrichment-consent.ts";
// THE FACE-DETECTION CONSENT GATE'S STATE (#712).
//
// THE GATE LIVES IN THE PEOPLE SHELF'S EMPTY STATE (components/People.tsx),
// never behind a toolbar icon and a `<dialog>`: a member who opens People and
// sees nothing has exactly the question this gate answers, so the empty shelf
// IS the gate's body rather than a control reached from elsewhere.
//
// Same factory idiom as people.ts/duplicates.tsx — a plain closure
// app-root.tsx owns and re-renders from (`onData`), not a React hook, so it
// fits the rest of that file's imperative boot closure.
//
// THE LOAD-BEARING RULE: no enrichment write is issued without an explicit
// answer. Reading the policy
// and declining both write nothing; `runOnDevice` is reachable from exactly
// the `Run on this device` answer, and the answer latches so a second click
// cannot answer twice.
import { act, narrate, notice } from "./outcomes.ts";

interface EnrichmentStatus {
  tier?: string | null;
  vaultDenied?: { message?: string } | null;
}

export interface EnrichmentGate {
  /** Read the vault's enrichment tier once. A no-op while loaded or already
   *  in flight — the same "load once" contract `people.ts`'s `ensureLoaded`
   *  holds, called the moment the gate might be shown rather than at boot. */
  ensurePolicyLoaded: () => void;
  /**
   * The gate's props for a library of `count` photographs, or `null` once
   * the question has been answered — the caller falls back to its own plain
   * empty copy at that point rather than re-asking a question already
   * answered this session.
   */
  props: (count: number) => EnrichmentConsentProps | null;
}

export function createEnrichmentGate({
  onData,
}: {
  onData: () => void;
}): EnrichmentGate {
  let status: EnrichmentStatus | null = null; // null = not yet read
  let statusLoading = false;
  let busy = false;
  let answered: "device" | "declined" | null = null;

  function ensurePolicyLoaded(): void {
    if (status != null || statusLoading) return;
    statusLoading = true;
    window.centraid
      .read<EnrichmentStatus>({ query: "enrichment-status" })
      .then((data) => {
        status = data ?? {};
        statusLoading = false;
        onData();
      })
      .catch(() => {
        status = { tier: null, vaultDenied: { message: "Could not read." } };
        statusLoading = false;
        onData();
      });
  }

  // THE ONE WRITE. Reachable from `props(...).onRunOnDevice` and from
  // nowhere else in this module.
  async function runOnDevice(): Promise<void> {
    if (busy || answered) return;
    if (!deviceAnswerFor(status?.tier, !!status?.vaultDenied).available) return;
    busy = true;
    onData();
    const outcome = await act("request-enrichment", {
      entity_type: "media.asset",
    });
    busy = false;
    if (narrate(outcome)) {
      answered = "device";
      notice(ENRICHMENT_REQUESTED_NOTE);
    }
    onData();
  }

  function decline(): void {
    answered = "declined";
    notice(ENRICHMENT_DECLINED_NOTE);
    onData();
  }

  return {
    ensurePolicyLoaded,
    props: (count) => {
      if (answered) return null;
      return {
        count,
        onDevice: deviceAnswerFor(status?.tier, !!status?.vaultDenied),
        cloud: CLOUD_ANSWER,
        busy,
        answered,
        onRunOnDevice: () => void runOnDevice(),
        onDecline: decline,
      };
    },
  };
}
