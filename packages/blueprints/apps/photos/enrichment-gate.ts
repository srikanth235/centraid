import type { EnrichmentConsentProps } from "./components/EnrichmentConsent.tsx";
import {
  CLOUD_ANSWER,
  deviceAnswerFor,
  ENRICHMENT_DECLINED_NOTE,
  ENRICHMENT_REQUESTED_NOTE,
} from "./enrichment-consent.ts";
// Face-detection consent gate (#712): lives in the People shelf's empty
// state, not behind a toolbar dialog; closure factory as in people.ts.
// LOAD-BEARING: no enrichment write without an explicit latched answer.
import { act, narrate, notice } from "./outcomes.ts";

interface EnrichmentStatus {
  tier?: string | null;
  vaultDenied?: { message?: string } | null;
}

export interface EnrichmentGate {
  ensurePolicyLoaded: () => void;
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

  // THE ONE WRITE — reachable from onRunOnDevice alone.
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
