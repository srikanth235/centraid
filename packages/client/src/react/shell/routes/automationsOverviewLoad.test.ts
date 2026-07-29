import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getBlocking,
  listAgents,
  listAutomations,
  listOutboxGrants,
  listTemplates,
} from "../../../gateway-client.js";
import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import type { ShellActions } from "../actions.js";
import { openWebhookReveal } from "../webhookReveal.js";
import type * as TypeImport_1f3slmz from "../webhookReveal.js";
import { collectAutomationRuns } from "./automationsData.js";
import type * as TypeImport_17pturf from "./automationsData.js";
import {
  adoptOverviewSuggestion,
  loadAutomationsOverviewData,
} from "./automationsOverviewLoad.js";
import {
  cloneAutomationTemplate,
  surfaceMintedWebhook,
} from "./templatesData.js";
import type * as TypeImport_13kqdum from "./templatesData.js";

vi.mock(import("../../../gateway-client.js"), () => ({
  listAutomations: vi.fn<typeof TypeImport_1gl5zx7.listAutomations>(),
  listAutomationTurns: vi.fn<typeof TypeImport_1gl5zx7.listAutomationTurns>(),
  getBlocking: vi.fn<typeof TypeImport_1gl5zx7.getBlocking>(),
  listOutboxGrants: vi.fn<typeof TypeImport_1gl5zx7.listOutboxGrants>(),
  listAgents: vi.fn<typeof TypeImport_1gl5zx7.listAgents>(),
  listTemplates: vi.fn<typeof TypeImport_1gl5zx7.listTemplates>(),
}));

vi.mock(import("./automationsData.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof TypeImport_17pturf>();
  return {
    ...actual,
    collectAutomationRuns:
      vi.fn<typeof TypeImport_17pturf.collectAutomationRuns>(),
  };
});

vi.mock(import("./templatesData.js"), () => ({
  cloneAutomationTemplate:
    vi.fn<typeof TypeImport_13kqdum.cloneAutomationTemplate>(),
  surfaceMintedWebhook: vi.fn<typeof TypeImport_13kqdum.surfaceMintedWebhook>(),
}));

vi.mock(import("../webhookReveal.js"), () => ({
  openWebhookReveal: vi
    .fn<typeof TypeImport_1f3slmz.openWebhookReveal>()
    .mockResolvedValue(undefined),
}));

const listAutomationsMock = listAutomations as unknown as ReturnType<
  typeof vi.fn
>;
const getBlockingMock = getBlocking as unknown as ReturnType<typeof vi.fn>;
const listOutboxGrantsMock = listOutboxGrants as unknown as ReturnType<
  typeof vi.fn
>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;
const listTemplatesMock = listTemplates as unknown as ReturnType<typeof vi.fn>;
const collectRunsMock = collectAutomationRuns as unknown as ReturnType<
  typeof vi.fn
>;
const cloneMock = cloneAutomationTemplate as unknown as ReturnType<
  typeof vi.fn
>;
const surfaceMock = surfaceMintedWebhook as unknown as ReturnType<typeof vi.fn>;
const revealMock = openWebhookReveal as unknown as ReturnType<typeof vi.fn>;

const DIGEST_ROW = {
  id: "digest",
  ref: "auto.digest/digest",
  name: "Daily Digest",
  enabled: true,
  ownerApp: "auto.digest",
  triggers: [{ kind: "cron", expr: "0 9 * * *" }],
  manifest: { requires: { mcps: [] } },
};

describe("automationsOverviewLoad", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAutomationsMock.mockResolvedValue([DIGEST_ROW]);
    // The rows now ride back with the run feed — the loader no longer fetches
    // the automation list a second time of its own.
    collectRunsMock.mockResolvedValue({ rows: [DIGEST_ROW], entries: [] });
    getBlockingMock.mockResolvedValue({ parked: [], outbox: [] });
    listOutboxGrantsMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([
      { hostKey: "auto.digest", agentId: "agent-1" },
    ]);
  });

  describe(loadAutomationsOverviewData, () => {
    it("builds overview data with zero attention when consent lists are empty", async () => {
      const data = await loadAutomationsOverviewData();
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0]!.name).toBe("Daily Digest");
      expect(data.rows[0]!.attentionCount).toBe(0);
      // The automation list costs a request; the overview must pay for it once.
      // It used to be fetched here AND inside `collectAutomationRuns`.
      expect(listAutomationsMock).not.toHaveBeenCalled();
      expect(collectRunsMock).toHaveBeenCalledOnce();
      expect(getBlockingMock).toHaveBeenCalledOnce();
      expect(listOutboxGrantsMock).toHaveBeenCalledOnce();
      expect(listAgentsMock).toHaveBeenCalledOnce();
    });

    it("counts parked + outbox items as attention when the agent host matches", async () => {
      getBlockingMock.mockResolvedValue({
        parked: [
          {
            callerKind: "agent",
            callerId: "agent-1",
            command: "x",
            input: {},
            invocationId: "i1",
            parkedAt: "t",
          },
          {
            callerKind: "agent",
            callerId: "other",
            command: "y",
            input: {},
            invocationId: "i2",
            parkedAt: "t",
          },
        ],
        outbox: [
          {
            actorKind: "agent",
            actorId: "agent-1",
            artifact: "a",
            canEdit: false,
            connection: { kind: "http", label: "c" },
            itemId: "o1",
            note: "",
            stagedAt: "t",
            status: "pending",
            target: "t",
            verb: "send",
          },
        ],
      });
      listOutboxGrantsMock.mockResolvedValue([]);
      const data = await loadAutomationsOverviewData();
      expect(data.rows[0]!.ref).toBe("auto.digest/digest");
      // 1 parked for agent-1 + 1 outbox for agent-1 (other agent parked ignored).
      expect(data.rows[0]!.attentionCount).toBe(2);
    });
  });

  describe(adoptOverviewSuggestion, () => {
    it("toasts when the template id is missing from the catalog", async () => {
      listTemplatesMock.mockResolvedValue([]);
      const navigate = vi.fn<ShellActions["navigate"]>();
      const showToast = vi.fn<ShellActions["showToast"]>();
      await adoptOverviewSuggestion("missing-tmpl", { navigate, showToast });
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining("no longer available")
      );
      expect(navigate).toHaveBeenCalledTimes(0);
    });

    it("clones, surfaces webhooks, and navigates to the new automation", async () => {
      const tmpl = { id: "obligation-extractor", name: "Deadlines", desc: "x" };
      listTemplatesMock.mockResolvedValue([tmpl]);
      cloneMock.mockResolvedValue({
        ref: "auto.x/y",
        webhooks: [{ url: "https://h/1", secret: "s" }],
      });
      const navigate = vi.fn<ShellActions["navigate"]>();
      const showToast = vi.fn<ShellActions["showToast"]>();
      await adoptOverviewSuggestion("obligation-extractor", {
        navigate,
        showToast,
      });
      expect(cloneMock).toHaveBeenCalledExactlyOnceWith(tmpl);
      expect(surfaceMock).toHaveBeenCalledWith({
        url: "https://h/1",
        secret: "s",
      });
      expect(revealMock).toHaveBeenCalledWith({
        url: "https://h/1",
        secret: "s",
      });
      expect(navigate).toHaveBeenCalledWith({
        kind: "automation-view",
        automationId: "auto.x/y",
      });
    });

    it("falls back to the automations list when clone returns no ref", async () => {
      listTemplatesMock.mockResolvedValue([{ id: "t1", name: "T", desc: "d" }]);
      cloneMock.mockResolvedValue({ ref: null, webhooks: [] });
      const navigate = vi.fn<ShellActions["navigate"]>();
      const showToast = vi.fn<ShellActions["showToast"]>();
      await adoptOverviewSuggestion("t1", { navigate, showToast });
      expect(navigate).toHaveBeenCalledWith({ kind: "automations" });
    });

    it("toasts on clone failure", async () => {
      listTemplatesMock.mockResolvedValue([{ id: "t1", name: "T", desc: "d" }]);
      cloneMock.mockRejectedValue(new Error("clone boom"));
      const navigate = vi.fn<ShellActions["navigate"]>();
      const showToast = vi.fn<ShellActions["showToast"]>();
      await adoptOverviewSuggestion("t1", { navigate, showToast });
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining("clone boom")
      );
      expect(navigate).toHaveBeenCalledTimes(0);
    });
  });
});
