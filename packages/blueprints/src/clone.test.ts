import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  cloneTemplate,
  cloneTemplateFiles,
  suggestAppId,
  suggestCloneIdentity,
  suggestCloneIdentityFrom,
} from "./clone.js";
import type { ScaffoldFile } from "./scaffold-types.js";

async function publishApp(
  appsDir: string,
  id: string,
  name: string
): Promise<void> {
  await fs.mkdir(path.join(appsDir, id), { recursive: true });
  await fs.writeFile(
    path.join(appsDir, id, "app.json"),
    JSON.stringify({ id, name, version: "0.1.0" }, null, 2) + "\n"
  );
}

describe(suggestCloneIdentity, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir("centraid-clone-id-");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns the bare (id, name) on a fresh apps dir", async () => {
    const picked = await suggestCloneIdentity(dir, "hydrate", "Hydrate");
    expect(picked.id).toBe("hydrate");
    expect(picked.name).toBe("Hydrate");
  });

  it('returns (id-2, "Name 2") when the bare slot is taken', async () => {
    await publishApp(dir, "hydrate", "Hydrate");
    const picked = await suggestCloneIdentity(dir, "hydrate", "Hydrate");
    expect(picked.id).toBe("hydrate-2");
    expect(picked.name).toBe("Hydrate 2");
  });

  it("skips past existing directory ids", async () => {
    await publishApp(dir, "hydrate", "Hydrate");
    await publishApp(dir, "hydrate-2", "Some unrelated name");
    const picked = await suggestCloneIdentity(dir, "hydrate", "Hydrate");
    expect(picked.id).toBe("hydrate-3");
    expect(picked.name).toBe("Hydrate 3");
  });

  it("skips past existing display-name collisions even when the id slot is free", async () => {
    await publishApp(dir, "hydrate", "Hydrate");
    await publishApp(dir, "something", "Hydrate 2");
    const picked = await suggestCloneIdentity(dir, "hydrate", "Hydrate");
    expect(picked.id).toBe("hydrate-3");
    expect(picked.name).toBe("Hydrate 3");
  });

  it("keeps id and name advancing together when both classes of collision interleave", async () => {
    await publishApp(dir, "hydrate", "Hydrate");
    await publishApp(dir, "hydrate-2", "Hydrate 2");
    await publishApp(dir, "whatever", "Hydrate 3");
    const picked = await suggestCloneIdentity(dir, "hydrate", "Hydrate");
    expect(picked.id).toBe("hydrate-4");
    expect(picked.name).toBe("Hydrate 4");
  });

  it("does case-insensitive display-name comparison", async () => {
    await publishApp(dir, "x", "HYDRATE");
    const picked = await suggestCloneIdentity(dir, "hydrate", "Hydrate");
    expect(picked.id).toBe("hydrate-2");
    expect(picked.name).toBe("Hydrate 2");
  });
});

describe("suggestCloneIdentityFrom (git-store backend — no filesystem)", () => {
  it("returns the bare (id, name) against an empty set", () => {
    const picked = suggestCloneIdentityFrom([], "hydrate", "Hydrate");
    expect(picked).toStrictEqual({ id: "hydrate", name: "Hydrate" });
  });

  it('bumps to (id-2, "Name 2") when the bare id is taken', () => {
    const picked = suggestCloneIdentityFrom(
      [{ id: "hydrate", name: "Hydrate" }],
      "hydrate",
      "Hydrate"
    );
    expect(picked).toStrictEqual({ id: "hydrate-2", name: "Hydrate 2" });
  });

  it("skips a display-name collision even when the id slot is free", () => {
    const picked = suggestCloneIdentityFrom(
      [
        { id: "hydrate", name: "Hydrate" },
        { id: "something", name: "Hydrate 2" },
      ],
      "hydrate",
      "Hydrate"
    );
    expect(picked).toStrictEqual({ id: "hydrate-3", name: "Hydrate 3" });
  });

  it("does case-insensitive display-name comparison", () => {
    const picked = suggestCloneIdentityFrom(
      [{ id: "x", name: "HYDRATE" }],
      "hydrate",
      "Hydrate"
    );
    expect(picked).toStrictEqual({ id: "hydrate-2", name: "Hydrate 2" });
  });

  it("falls back to the id for apps with no display name", () => {
    const picked = suggestCloneIdentityFrom(
      [{ id: "hydrate" }],
      "hydrate",
      "Hydrate"
    );
    expect(picked).toStrictEqual({ id: "hydrate-2", name: "Hydrate 2" });
  });
});

describe("suggestAppId (sanity — coexists with suggestCloneIdentity)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir("centraid-suggest-id-");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns the bare id when free and alwaysSuffix is omitted", async () => {
    const id = await suggestAppId(dir, "todos");
    expect(id).toBe("todos");
  });

  it("always suffixes when alwaysSuffix: true", async () => {
    const id = await suggestAppId(dir, "todos", { alwaysSuffix: true });
    expect(id).toBe("todos-2");
  });
});

describe(cloneTemplate, () => {
  let appsDir: string;
  let templateDir: string;

  beforeEach(async () => {
    appsDir = await tempDir("centraid-clone-dest-");
    templateDir = await tempDir("centraid-clone-tmpl-");
    await fs.writeFile(
      path.join(templateDir, "app.json"),
      JSON.stringify({ name: "Hydrate", version: "0.1.0" }, null, 2)
    );
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
    await fs.rm(templateDir, { recursive: true, force: true });
  });

  it("backfills the catalog tile identity into app.json (template copy predates the keys)", async () => {
    await cloneTemplate({
      appsDir,
      newAppId: "hydrate-2",
      templateDir,
      newName: "Hydrate 2",
      iconKey: "Water",
      colorKey: "teal",
    });
    const appJson = JSON.parse(
      await fs.readFile(path.join(appsDir, "hydrate-2", "app.json"), "utf8")
    ) as { iconKey: string; colorKey: string; name: string };
    expect(appJson.name).toBe("Hydrate 2");
    expect(appJson.iconKey).toBe("Water");
    expect(appJson.colorKey).toBe("teal");
  });

  it("keeps the template app.json tile identity over the catalog entry", async () => {
    await fs.writeFile(
      path.join(templateDir, "app.json"),
      JSON.stringify({
        name: "Hydrate",
        version: "0.1.0",
        iconKey: "Todo",
        colorKey: "indigo",
      })
    );
    await cloneTemplate({
      appsDir,
      newAppId: "hydrate-3",
      templateDir,
      newName: "Hydrate 3",
      iconKey: "Water",
      colorKey: "teal",
    });
    const appJson = JSON.parse(
      await fs.readFile(path.join(appsDir, "hydrate-3", "app.json"), "utf8")
    ) as { iconKey: string; colorKey: string };
    expect(appJson.iconKey).toBe("Todo");
    expect(appJson.colorKey).toBe("indigo");
  });

  it("seeds the canonical subdirs and an automations brief", async () => {
    await cloneTemplate({
      appsDir,
      newAppId: "hydrate-2",
      templateDir,
      newName: "Hydrate 2",
    });
    const entries = await fs.readdir(path.join(appsDir, "hydrate-2"));
    expect(entries.toSorted()).toStrictEqual([
      "actions",
      "app.json",
      "automations",
      "queries",
    ]);
    await expect(
      fs.readFile(
        path.join(appsDir, "hydrate-2", "automations", "README.md"),
        "utf8"
      )
    ).resolves.toContain("# automations/");
  });

  it("rewrites automation.json#name + stamps generated for automation templates", async () => {
    const templateDirLocal = await tempDir("centraid-auto-tmpl-");
    await fs.writeFile(
      path.join(templateDirLocal, "app.json"),
      JSON.stringify({ name: "Briefing", version: "0.1.0" }, null, 2)
    );
    await fs.mkdir(path.join(templateDirLocal, "automations", "briefing"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(templateDirLocal, "automations", "briefing", "automation.json"),
      JSON.stringify(
        {
          name: "Briefing",
          version: "0.1.0",
          enabled: false,
          prompt: "do the thing",
          triggers: [{ kind: "cron", expr: "0 18 * * 1-5" }],
          requires: {},
          history: { keep: { count: 100 } },
          generated: {
            by: "centraid-template",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(templateDirLocal, "automations", "briefing", "handler.js"),
      'export default async () => ({ summary: "ok" });'
    );

    await cloneTemplate({
      appsDir,
      newAppId: "briefing-2",
      templateDir: templateDirLocal,
      newName: "Briefing 2",
    });

    const mf = JSON.parse(
      await fs.readFile(
        path.join(
          appsDir,
          "briefing-2",
          "automations",
          "briefing",
          "automation.json"
        ),
        "utf8"
      )
    );
    expect(mf.name).toBe("Briefing 2");
    expect(mf.generated.by).toBe("centraid-builder");
    expect(mf.generated.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(mf.prompt).toBe("do the thing");
    expect(mf.triggers).toStrictEqual([{ kind: "cron", expr: "0 18 * * 1-5" }]);

    await fs.rm(templateDirLocal, { recursive: true, force: true });
  });
});

describe(cloneTemplateFiles, () => {
  const template = (): ScaffoldFile[] => [
    {
      path: "app.json",
      content:
        JSON.stringify(
          {
            id: "hydrate",
            name: "Hydrate",
            version: "2.0.0",
            description: "drink water",
          },
          null,
          2
        ) + "\n",
    },
    {
      path: "package.json",
      content: JSON.stringify({ name: "centraid-app-hydrate" }, null, 2) + "\n",
    },
  ];

  function byPath(files: ScaffoldFile[]): Map<string, string> {
    return new Map(files.map((f) => [f.path, f.content]));
  }

  it("rewrites id, name, version and package name", () => {
    const out = byPath(
      cloneTemplateFiles({
        newAppId: "hydrate-2",
        templateFiles: template(),
        newName: "Hydrate 2",
      })
    );
    const appJson = JSON.parse(out.get("app.json")!) as Record<string, unknown>;
    expect(appJson.id).toBe("hydrate-2");
    expect(appJson.name).toBe("Hydrate 2");
    expect(appJson.version).toBe("0.1.0");
    expect(appJson.description).toBe("drink water");
    expect(out.get("package.json")!).toMatch(/"centraid-app-hydrate-2"/u);
  });

  it("stamps generated + rewrites name on a bundled automation manifest", () => {
    const tmpl = [
      ...template(),
      {
        path: "automations/wake/automation.json",
        content:
          JSON.stringify(
            {
              name: "Hydrate",
              generated: { by: "tmpl", at: "2020-01-01T00:00:00.000Z" },
            },
            null,
            2
          ) + "\n",
      },
    ];
    const out = byPath(
      cloneTemplateFiles({
        newAppId: "hydrate-2",
        templateFiles: tmpl,
        newName: "Hydrate 2",
      })
    );
    const mf = JSON.parse(out.get("automations/wake/automation.json")!) as {
      name: string;
      generated: { by: string; at: string };
    };
    expect(mf.name).toBe("Hydrate 2");
    expect(mf.generated.by).toBe("centraid-builder");
    expect(mf.generated.at).not.toBe("2020-01-01T00:00:00.000Z");
    expect(out.has("automations/README.md")).toBe(false);
  });

  it("seeds an automations brief when the template has none", () => {
    const out = byPath(
      cloneTemplateFiles({ newAppId: "hydrate-2", templateFiles: template() })
    );
    expect(out.has("automations/README.md")).toBeTruthy();
  });

  it("backfills the catalog tile identity when the template app.json lacks it", () => {
    const out = byPath(
      cloneTemplateFiles({
        newAppId: "hydrate-2",
        templateFiles: template(),
        iconKey: "Water",
        colorKey: "teal",
      })
    );
    const appJson = JSON.parse(out.get("app.json")!) as {
      iconKey: string;
      colorKey: string;
    };
    expect(appJson.iconKey).toBe("Water");
    expect(appJson.colorKey).toBe("teal");
  });

  it("keeps the template app.json tile identity over the catalog entry", () => {
    const tmpl = template();
    tmpl[0] = {
      path: "app.json",
      content:
        JSON.stringify(
          {
            id: "hydrate",
            name: "Hydrate",
            version: "2.0.0",
            iconKey: "Water",
            colorKey: "teal",
          },
          null,
          2
        ) + "\n",
    };
    const out = byPath(
      cloneTemplateFiles({
        newAppId: "hydrate-2",
        templateFiles: tmpl,
        iconKey: "Sparkle",
        colorKey: "violet",
      })
    );
    const appJson = JSON.parse(out.get("app.json")!) as {
      iconKey: string;
      colorKey: string;
    };
    expect(appJson.iconKey).toBe("Water");
    expect(appJson.colorKey).toBe("teal");
  });
});
