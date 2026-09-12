// The People shelf's EMPTY STATE and its one action (#712, ruled 2026-09-09).
// Recognition is ambient: this decides only whether the PRIORITY ask is
// offerable, and issues one manual `enrich.request` per press. LOAD-BEARING:
// mount, policy read and re-render write nothing.
import {
  ENRICHMENT_PRIORITISED_NOTE,
  ENRICHMENT_STATUS_LINE,
  PEOPLE_EMPTY_LINE,
  PRIORITISE_ACTION,
  prioritizeAnswerFor,
} from "./enrichment-consent.ts";
import type { AnswerAvailability } from "./enrichment-consent.ts";
import { act, narrate, notice } from "./outcomes.ts";

interface EnrichmentStatus {
  tier?: string | null;
  vaultDenied?: { message?: string } | null;
}

export interface PeopleEmptyStateProps {
  count: number;
  statusLine: string;
  line: string;
  action: string;
  prioritize: AnswerAvailability;
  busy: boolean;
  prioritized: boolean;
  onPrioritize: () => void;
}

export interface PeopleEmptyState {
  ensurePolicyLoaded: () => void;
  props: (count: number) => PeopleEmptyStateProps;
}

export function createPeopleEmptyState({
  onData,
}: {
  onData: () => void;
}): PeopleEmptyState {
  let status: EnrichmentStatus | null = null;
  let statusLoading = false;
  let busy = false;
  let prioritized = false;

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

  function answer(): AnswerAvailability {
    return prioritizeAnswerFor(status?.tier, !!status?.vaultDenied);
  }

  async function prioritize(): Promise<void> {
    if (busy || prioritized) return;
    if (!answer().available) return;
    busy = true;
    onData();
    const outcome = await act("request-enrichment", {
      entity_type: "media.asset",
    });
    busy = false;
    if (narrate(outcome)) {
      prioritized = true;
      notice(ENRICHMENT_PRIORITISED_NOTE);
    }
    onData();
  }

  return {
    ensurePolicyLoaded,
    props: (count) => ({
      count,
      statusLine: ENRICHMENT_STATUS_LINE,
      line: PEOPLE_EMPTY_LINE,
      action: PRIORITISE_ACTION,
      prioritize: answer(),
      busy,
      prioritized,
      onPrioritize: () => void prioritize(),
    }),
  };
}
