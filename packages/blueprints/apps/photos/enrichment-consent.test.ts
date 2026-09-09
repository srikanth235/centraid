// @vitest-environment jsdom
// PHOTOS' ENRICHMENT COPY + THE PEOPLE EMPTY STATE — a privacy regression net.
// Recognition is ambient (ruled 2026-09-09), so three rules survive:
//   1. THE EMPTY STATE IS HONEST — it names the recipe and its switch, and
//      never presents itself as a consent moment.
//   2. NO WRITE WITHOUT AN EXPLICIT PRESS — the priority action writes exactly
//      ONE manual `enrich.request`, tagged `faces` by the action handler.
//   3. THE EGRESS DISCLOSURE SURVIVES ITS RENDERER — pinned here, where
//      softening it fails, rather than deleted with the panel that showed it.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, ".", rel)).href;

interface AnswerAvailability {
  available: boolean;
  reason?: string;
}
interface PeopleEmptyStateProps {
  count: number;
  statusLine: string;
  line: string;
  action: string;
  prioritise: AnswerAvailability;
  busy: boolean;
  prioritised: boolean;
  onPrioritise: () => void;
}
interface PeopleEmptyState {
  ensurePolicyLoaded: () => void;
  props: (count: number) => PeopleEmptyStateProps;
}
interface ConsentCopy {
  CLOUD_PANEL: {
    eyebrow: string;
    title: string;
    body: string;
    facts: readonly { label: string; value: string; net?: boolean }[];
    action: string;
    net?: boolean;
  };
  CLOUD_EGRESS_DISCLOSURE: string;
  CLOUD_ANSWER: AnswerAvailability;
  ENRICHMENT_STATUS_LINE: string;
  ENRICHMENT_PRIORITISED_NOTE: string;
  ENRICHMENT_QUEUED_NOTE: string;
  ENRICHMENT_UNAVAILABLE: Record<string, string>;
  PEOPLE_EMPTY_LINE: string;
  PRIORITISE_ACTION: string;
  prioritiseAnswerFor: (
    tier: string | null | undefined,
    denied?: boolean
  ) => AnswerAvailability;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const copy = (await import(app("enrichment-consent.ts"))) as ConsentCopy;
const { createPeopleEmptyState } = (await import(
  app("enrichment-gate.ts")
)) as {
  createPeopleEmptyState: (opts: { onData: () => void }) => PeopleEmptyState;
};

describe("the People shelf's empty-state copy", () => {
  it("claims only what an empty roster shows", () => {
    // No client reads a "has recognition ever run" fact.
    expect(copy.ENRICHMENT_STATUS_LINE).toBe(
      "No faces have been grouped here yet"
    );
  });

  it("names the recipe that groups faces, and the switch that stops it", () => {
    expect(copy.PEOPLE_EMPTY_LINE).toContain("Faces recipe");
    expect(copy.PEOPLE_EMPTY_LINE).toContain("Automations → Recognition");
    // Ambient, not answered: the sentence says WHEN, never WHETHER.
    expect(copy.PEOPLE_EMPTY_LINE).toContain("as photographs arrive");
  });

  it("carries no consent doctrine anywhere in the module", () => {
    // The retired handoff's promises: any of them back here is a surface
    // claiming to hold recognition back, which it does not.
    const all = Object.values(copy)
      .flatMap((value) =>
        typeof value === "string"
          ? [value]
          : typeof value === "object" && value !== null
            ? Object.values(value as Record<string, unknown>).map(String)
            : []
      )
      .join(" ");
    for (const banned of [
      "asked once",
      "answered once",
      "Run face detection",
      "Not now",
      "settings toggle",
      "Nothing was requested",
    ])
      expect(all).not.toContain(banned);
  });

  it("promises the priority ask makes a run SOONER, never WHETHER", () => {
    expect(copy.ENRICHMENT_PRIORITISED_NOTE).toContain("sooner");
    expect(copy.ENRICHMENT_PRIORITISED_NOTE).not.toMatch(/whether/iu);
    // The hold says only that DELIVERY waits; the ambient pass runs anyway.
    expect(copy.ENRICHMENT_QUEUED_NOTE).toContain("reconnects");
    expect(copy.ENRICHMENT_QUEUED_NOTE).not.toContain("nothing runs");
  });

  it("labels the action as an action, not a question", () => {
    expect(copy.PRIORITISE_ACTION).toBe("Prioritise faces");
  });
});

describe("the provider-egress disclosure", () => {
  it("states the exact egress sentence, flagged as egress", () => {
    // THE line — it survives the panel that used to render it.
    expect(copy.CLOUD_EGRESS_DISCLOSURE).toBe(
      "a downscaled copy of every photograph"
    );
    const fact = copy.CLOUD_PANEL.facts.find(
      (item) => item.value === copy.CLOUD_EGRESS_DISCLOSURE
    );
    expect(fact?.label).toBe("what leaves the device");
    expect(fact?.net).toBe(true);
    // The panel itself is bordered `--net`: the panel IS the disclosure.
    expect(copy.CLOUD_PANEL.net).toBe(true);
    expect(copy.CLOUD_PANEL.body).toContain(
      "Faster, and the photographs leave this device."
    );
    expect(copy.CLOUD_PANEL.body).toContain(
      "separate consent with its own receipt"
    );
  });

  it("states, rather than hides, that no helper can be chosen from an app", () => {
    expect(copy.CLOUD_ANSWER.available).toBe(false);
    expect(copy.CLOUD_ANSWER.reason).toBe(
      copy.ENRICHMENT_UNAVAILABLE.cloudUnavailable
    );
  });
});

describe("whether the priority ask is offerable", () => {
  it("is takeable on the gateway tier — the Faces recipe's declared lane", () => {
    expect(copy.prioritiseAnswerFor("gateway")).toStrictEqual({
      available: true,
    });
  });

  it("withholds it on the device tier, and says the lane is why", () => {
    expect(copy.prioritiseAnswerFor("device")).toStrictEqual({
      available: false,
      reason: copy.ENRICHMENT_UNAVAILABLE.deviceTier,
    });
    expect(copy.ENRICHMENT_UNAVAILABLE.deviceTier).toContain(
      "runs on the gateway"
    );
  });

  it("keeps `off` meaning what it means: no run to prioritise", () => {
    expect(copy.prioritiseAnswerFor("off")).toStrictEqual({
      available: false,
      reason: copy.ENRICHMENT_UNAVAILABLE.offTier,
    });
    expect(copy.ENRICHMENT_UNAVAILABLE.offTier).toContain("is off");
    // The tier may never be framed as what withholds a RUN elsewhere.
    expect(copy.ENRICHMENT_UNAVAILABLE.deviceTier).not.toContain("is off");
  });

  it("says nothing it cannot know while the policy is unread or denied", () => {
    expect(copy.prioritiseAnswerFor(null)).toStrictEqual({ available: false });
    expect(copy.prioritiseAnswerFor("gateway", true)).toStrictEqual({
      available: false,
      reason: copy.ENRICHMENT_UNAVAILABLE.denied,
    });
  });
});

describe("the People empty state (issue #712 C2, re-homed onto the shelf)", () => {
  // `enrichment-gate.ts` drives `PeopleShelf`'s `emptyState` prop, driven
  // directly. LOAD-BEARING: no write without an explicit press.
  const write = vi.fn<(intent: unknown) => Promise<{ status: string }>>(
    async () => ({ status: "executed" })
  );
  const read = vi.fn<(query: unknown) => Promise<{ tier: string }>>(
    async () => ({
      tier: "gateway",
    })
  );
  const onData = vi.fn<() => void>();

  beforeEach(() => {
    write.mockClear();
    read.mockClear();
    onData.mockClear();
    (window as unknown as { centraid: unknown }).centraid = { read, write };
  });

  async function loaded(): Promise<PeopleEmptyState> {
    const shelf = createPeopleEmptyState({ onData });
    shelf.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    return shelf;
  }

  it("writes nothing on creation, and nothing on reading the policy", async () => {
    const shelf = createPeopleEmptyState({ onData });
    expect(write).not.toHaveBeenCalled();
    shelf.ensurePolicyLoaded();
    expect(write).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    expect(write).not.toHaveBeenCalled();
  });

  it("renders the honest empty state, always — it is never withheld", async () => {
    const shelf = await loaded();
    const props = shelf.props(6214);
    expect(props.statusLine).toBe(copy.ENRICHMENT_STATUS_LINE);
    expect(props.line).toBe(copy.PEOPLE_EMPTY_LINE);
    expect(props.action).toBe(copy.PRIORITISE_ACTION);
    expect(props.count).toBe(6214);
    // No latch, no "answered": there is no question to close.
    expect(props.prioritised).toBe(false);
  });

  it("writes exactly one manual request, from the press alone", async () => {
    const shelf = await loaded();
    expect(shelf.props(6214).prioritise).toStrictEqual({ available: true });
    shelf.props(6214).onPrioritise();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const intent = write.mock.calls[0]?.[0] as {
      action: string;
      input: Record<string, unknown>;
    };
    // `reason: "manual"` + `capability: "faces"` are pinned by the handler.
    expect(intent.action).toBe("request-enrichment");
    expect(intent.input["entity_type"]).toBe("media.asset");
    await vi.waitFor(() => expect(shelf.props(6214).prioritised).toBe(true));
  });

  it("never issues a second request once one has landed", async () => {
    const shelf = await loaded();
    shelf.props(6214).onPrioritise();
    await vi.waitFor(() => expect(shelf.props(6214).prioritised).toBe(true));
    shelf.props(6214).onPrioritise();
    shelf.props(6214).onPrioritise();
    expect(write).toHaveBeenCalledOnce();
  });

  it("refuses to write when the tier could not honour the request", async () => {
    read.mockResolvedValueOnce({ tier: "device" });
    const shelf = await loaded();
    const props = shelf.props(6214);
    expect(props.prioritise.available).toBe(false);
    expect(props.prioritise.reason).toBe(
      copy.ENRICHMENT_UNAVAILABLE.deviceTier
    );
    props.onPrioritise();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses to write when the policy cannot be read at all", async () => {
    read.mockRejectedValueOnce(new Error("denied"));
    const shelf = await loaded();
    const props = shelf.props(6214);
    expect(props.prioritise.reason).toBe(copy.ENRICHMENT_UNAVAILABLE.denied);
    props.onPrioritise();
    expect(write).not.toHaveBeenCalled();
  });
});
