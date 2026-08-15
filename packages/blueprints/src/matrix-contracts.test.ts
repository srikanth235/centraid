/**
 * Matrix cell blueprints.contracts (#535 coverable-today).
 * App id + clone file-map contract is the public surface every app-owning
 * gateway route depends on.
 */
import { describe, expect, it } from "vitest";

import { validateAppId } from "./app-meta.js";
import { cloneTemplateFiles } from "./clone.js";
import { AppScaffoldError } from "./scaffold-types.js";

describe("blueprint clone contracts", () => {
  it("validateAppId accepts canonical slugs and rejects reserved/invalid forms", () => {
    expect(() => validateAppId("todos")).not.toThrow();
    expect(() => validateAppId("my-app-123")).not.toThrow();
    expect(() => validateAppId("_hidden")).toThrow(AppScaffoldError);
    expect(() => validateAppId("Upper")).toThrow(AppScaffoldError);
    expect(() => validateAppId("has.dot")).toThrow(AppScaffoldError);
    expect(() => validateAppId("")).toThrow(AppScaffoldError);
  });

  it("cloneTemplateFiles always emits a complete file map for a valid id", () => {
    const files = cloneTemplateFiles({
      newAppId: "contracts-app",
      newName: "Contracts",
      templateFiles: [
        {
          path: "app.json",
          content:
            JSON.stringify(
              { manifestVersion: 1, id: "source", name: "Source" },
              null,
              2
            ) + "\n",
        },
        {
          path: "package.json",
          content:
            JSON.stringify({ name: "centraid-app-source" }, null, 2) + "\n",
        },
        { path: "actions/add.js", content: "export default async () => ({});" },
      ],
    });
    const paths = new Set(files.map((f) => f.path));
    for (const required of [
      "package.json",
      "app.json",
      "actions/add.js",
      "automations/README.md",
    ]) {
      expect(paths.has(required), required).toBe(true);
    }
    const appJson = JSON.parse(
      files.find((f) => f.path === "app.json")!.content
    ) as {
      id: string;
      name: string;
      manifestVersion: number;
    };
    expect(appJson).toMatchObject({
      id: "contracts-app",
      name: "Contracts",
      manifestVersion: 1,
    });
  });
});
