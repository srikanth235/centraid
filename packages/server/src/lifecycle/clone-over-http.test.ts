import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { cloneTemplateFiles } from "@centraid/blueprints";
import { provisionPendingWebhooksInFiles } from "@centraid/server/automation";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { serve } from "../serve/serve.ts";
import type { GatewayServeHandle } from "../serve/serve.ts";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

function templateFiles(): { path: string; content: string }[] {
  return [
    {
      path: "app.json",
      content:
        JSON.stringify(
          {
            manifestVersion: 1,
            id: "inbound",
            name: "Inbound",
            version: "1.2.0",
            kind: "automation",
            description: "route inbound hooks",
            actions: [],
            queries: [],
          },
          null,
          2
        ) + "\n",
    },
    {
      path: "automations/inbound/automation.json",
      content:
        JSON.stringify(
          {
            name: "Inbound",
            version: "1.2.0",
            enabled: true,
            prompt: "handle the hook",
            triggers: [{ kind: "webhook", pending: true }],
            requires: {},
            history: { keep: { count: 100 } },
            generated: { by: "tmpl", at: "2020-01-01T00:00:00.000Z" },
          },
          null,
          2
        ) + "\n",
    },
    {
      path: "automations/inbound/handler.js",
      content: "export default async () => ({ ok: true });\n",
    },
  ];
}

describe("clone-over-http scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-clone-${crypto.randomUUID()}-`);
    handle = await serve({ paths: pathsUnder(dataDir) });
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("cloning a template over HTTP publishes a plain-slug automation app with a provisioned webhook", async () => {
    const cloned = cloneTemplateFiles({
      newAppId: "inbound-2",
      templateFiles: templateFiles(),
      newName: "Inbound 2",
      iconKey: "Sparkle",
      colorKey: "rose",
    });
    const appJson = JSON.parse(
      cloned.find((f) => f.path === "app.json")!.content
    ) as {
      id: string;
      name: string;
      version: string;
      kind: string;
      iconKey: string;
      colorKey: string;
    };
    expect(appJson.id).toBe("inbound-2");
    expect(appJson.name).toBe("Inbound 2");
    expect(appJson.version).toBe("0.1.0");
    expect(appJson.kind).toBe("automation");
    expect(appJson.iconKey).toBe("Sparkle");
    expect(appJson.colorKey).toBe("rose");

    const { files, minted } = provisionPendingWebhooksInFiles(
      cloned,
      "inbound-2"
    );
    expect(minted).toHaveLength(1);
    expect(minted[0]!.ownerApp).toBe("inbound-2");
    expect(minted[0]!.automationId).toBe("inbound");
    expect(minted[0]!.secret.length > 0).toBeTruthy();

    await fetch(`${handle.url}/centraid/_apps/_sessions`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    await forEachSequentially(files, async (f) => {
      const res = await fetch(
        `${handle.url}/centraid/_apps/inbound-2/files/${f.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?sessionId=s1`,
        { method: "PUT", headers: auth(), body: f.content }
      );
      expect(res.status).toBe(200);
    });
    const pub = await fetch(`${handle.url}/centraid/_apps/inbound-2/publish`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "clone inbound" }),
    });
    expect(pub.status).toBe(201);

    const listRes = await fetch(`${handle.url}/centraid/_apps`, {
      headers: auth(),
    });
    const list = (await listRes.json()) as Array<{
      id: string;
      kind?: string;
      iconKey?: string;
      colorKey?: string;
    }>;
    const row = list.find((a) => a.id === "inbound-2");
    expect(row).toBeTruthy();
    expect(row!.kind).toBe("automation");
    expect(row!.iconKey).toBe("Sparkle");
    expect(row!.colorKey).toBe("rose");

    const filesRes = await fetch(
      `${handle.url}/centraid/_apps/inbound-2/files?sessionId=s1`,
      {
        headers: auth(),
      }
    );
    const draft = (await filesRes.json()) as {
      files: { path: string; content: string }[];
    };
    const manifestFile = draft.files.find(
      (f) => f.path === "automations/inbound/automation.json"
    );
    expect(manifestFile).toBeTruthy();
    const manifest = JSON.parse(manifestFile!.content) as {
      triggers: {
        kind: string;
        id?: string;
        secretHash?: string;
        pending?: boolean;
      }[];
    };
    const hook = manifest.triggers.find((t) => t.kind === "webhook")!;
    expect(hook.id && hook.secretHash).toBeTruthy();
    expect(hook.pending).toBeUndefined();
    expect(!JSON.stringify(manifest).includes(minted[0]!.secret)).toBeTruthy();
  });
});
