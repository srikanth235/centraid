import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateMetaEntry } from "../../../gateway-client.js";
import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import {
  loadAppTemplates,
  loadAutomationTemplates,
  loadOverviewSuggestions,
  surfaceMintedWebhook,
  V0_AUTOMATION_TEMPLATE_IDS,
} from "./templatesData.js";

const { listTemplates, gwCloneTemplate } = vi.hoisted(() => ({
  listTemplates: vi.fn<typeof TypeImport_1gl5zx7.listTemplates>(),
  gwCloneTemplate: vi.fn<typeof TypeImport_1gl5zx7.cloneTemplate>(),
}));
vi.mock(import("../../../gateway-client.js"), () => ({
  listTemplates,
  cloneTemplate: gwCloneTemplate,
}));

const app = {
  id: "todos",
  name: "Todos",
  kind: "app",
  colorKey: "blue",
  iconKey: "Todo",
  desc: "d",
  version: "1",
} satisfies TemplateMetaEntry;
const auto = {
  id: "digest",
  name: "Digest",
  kind: "automation",
  colorKey: "teal",
  iconKey: "Bolt",
  desc: "d",
  version: "1",
} satisfies TemplateMetaEntry;

describe("templatesData", () => {
  beforeEach(() => {
    listTemplates.mockReset();
    gwCloneTemplate.mockReset();
  });

  describe("templatesData", () => {
    it("pins the exact six-template v0 automation gallery", () => {
      expect(V0_AUTOMATION_TEMPLATE_IDS).toStrictEqual([
        "google-gmail-pull",
        "google-calendar-pull",
        "google-contacts-pull",
        "google-drive-pull",
        "obligation-extractor",
        "renewal-reminders",
      ]);
      expect(V0_AUTOMATION_TEMPLATE_IDS).toHaveLength(6);
    });

    it("loadAppTemplates keeps only non-automation entries", async () => {
      listTemplates.mockResolvedValue([
        app,
        { ...auto, id: "obligation-extractor" },
      ]);
      expect((await loadAppTemplates()).map((t) => t.id)).toStrictEqual([
        "todos",
      ]);
    });

    it("loadAutomationTemplates keeps only automation entries", async () => {
      listTemplates.mockResolvedValue([
        app,
        { ...auto, id: "obligation-extractor" },
      ]);
      expect((await loadAutomationTemplates()).map((t) => t.id)).toStrictEqual([
        "obligation-extractor",
      ]);
    });

    it("loadAutomationTemplates passes data/condition triggerKind through unchanged", async () => {
      const dataAuto = {
        ...auto,
        id: "obligation-extractor",
        triggerKind: "data",
      } satisfies TemplateMetaEntry;
      const conditionAuto = {
        ...auto,
        id: "renewal-reminders",
        triggerKind: "condition",
      } satisfies TemplateMetaEntry;
      listTemplates.mockResolvedValue([app, dataAuto, conditionAuto]);
      const result = await loadAutomationTemplates();
      expect(result.map((t) => t.triggerKind)).toStrictEqual([
        "data",
        "condition",
      ]);
    });

    it("returns [] when the catalog fetch fails", async () => {
      listTemplates.mockRejectedValue(new Error("offline"));
      await expect(loadAppTemplates()).resolves.toStrictEqual([]);
      await expect(loadAutomationTemplates()).resolves.toStrictEqual([]);
      await expect(loadOverviewSuggestions()).resolves.toStrictEqual([]);
    });

    it("loadOverviewSuggestions prefers curated ids and caps the list", async () => {
      listTemplates.mockResolvedValue([
        app,
        { ...auto, id: "z-other", name: "Other", desc: "other" },
        {
          ...auto,
          id: "obligation-extractor",
          name: "Document deadlines",
          desc: "Extract due dates",
          triggerLabel: "On document",
        },
        {
          ...auto,
          id: "google-gmail-pull",
          name: "Gmail sync",
          desc: "Pull mail",
        },
      ]);
      const rows = await loadOverviewSuggestions(3);
      expect(rows.map((r) => r.id)).toStrictEqual([
        "obligation-extractor",
        "google-gmail-pull",
      ]);
      expect(rows[0]).toMatchObject({
        name: "Document deadlines",
        desc: "Extract due dates",
        triggerLabel: "On document",
      });
    });

    it("does not suggest unlisted catalog entries", async () => {
      listTemplates.mockResolvedValue([
        { ...auto, id: "alpha", name: "Alpha", desc: "a" },
        { ...auto, id: "beta", name: "Beta", desc: "b" },
        { ...auto, id: "gamma", name: "Gamma", desc: "c" },
        { ...auto, id: "delta", name: "Delta", desc: "d" },
      ]);
      const rows = await loadOverviewSuggestions(3);
      expect(rows).toStrictEqual([]);
    });

    it("surfaceMintedWebhook never logs the URL or plaintext secret", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      surfaceMintedWebhook({
        url: "https://gw.example/_centraid-hook/abc",
        secret: "shh",
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
