/*
 * The packaging config, asserted (#1020, D-1020-F7).
 *
 * Census §F seam 6 makes the case: `electron-builder.yml`'s `files:` list is a
 * RUNTIME DEPENDENCY, not packaging trivia — a file not on it is absent in the
 * built app with an empty tray icon as the only symptom — and the protocol
 * scheme lived in a *second* config file, so a lane that rewrote one lost
 * `centraid://`. Neither failure shows up in a unit run or a typecheck, and
 * both show up in a signed installer a week later. So they are tests.
 *
 * The YAML is read as text and matched, rather than parsed with a YAML library
 * this tree does not depend on. That is enough for what is being asserted:
 * that specific keys are present, and that two specific ones are **absent**.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const builderYaml = fs.readFileSync(
  path.join(ROOT, "electron-builder.yml"),
  "utf8"
);
const entitlements = fs.readFileSync(
  path.join(ROOT, "build/entitlements.mac.plist"),
  "utf8"
);
const appId = JSON.parse(
  fs.readFileSync(path.join(ROOT, "electron-builder/app-id.json"), "utf8")
) as { appId: string; protocols: Array<{ schemes: string[] }>; _note: string };

describe("the `centraid://` registration", () => {
  it("is in electron-builder.yml itself, not only in a second file", () => {
    // The seam: v0's scheme lived in `electron-builder/app-id.json` alone.
    expect(builderYaml).toMatch(/^protocols:/mu);
    expect(builderYaml).toMatch(/- centraid$/mu);
  });

  it("agrees with the file that used to hold it, which now says it is not the source", () => {
    expect(appId.appId).toBe("dev.centraid.desktop");
    expect(appId.protocols[0]?.schemes).toStrictEqual(["centraid"]);
    expect(appId._note).toContain("NOT the source of truth");
    expect(builderYaml).toContain(`appId: ${appId.appId}`);
  });
});

describe("the files list", () => {
  it("packs the built main, preload and renderer, and drops the maps", () => {
    expect(builderYaml).toContain("- dist/**/*");
    expect(builderYaml).toContain('- "!dist/**/*.map"');
    expect(builderYaml).toContain("main: dist/main.js");
  });

  it("carries the seat binary as a resource, because the seat is a process", () => {
    expect(builderYaml).toMatch(/^extraResources:/mu);
    expect(builderYaml).toContain("from: resources/centraid");
    expect(builderYaml).toContain("to: centraid");
  });

  it("keeps the updater's two targets: zip for the updater, dmg for humans", () => {
    expect(builderYaml).toContain("target: dmg");
    expect(builderYaml).toContain("target: zip");
    // A version-less AppImage name, so a self-update overwrites in place.
    // Built from pieces so the `${...}` stays electron-builder's own
    // placeholder rather than something this file tries to interpolate.
    const placeholder = (name: string) => `$${"{"}${name}}`;
    expect(builderYaml).toContain(
      `artifactName: Centraid-${placeholder("arch")}.${placeholder("ext")}`
    );
  });

  it("ships unsigned scaffolding until enrolment, and says so in one place", () => {
    expect(builderYaml).toContain("identity: null");
    expect(builderYaml).toContain("hardenedRuntime: true");
  });
});

/**
 * The GRANTED keys, not the file's text: the file's comment names the two
 * removals on purpose, and a text match would read the explanation as the
 * thing it explains.
 */
const grantedEntitlements = (source: string): string[] =>
  [...source.matchAll(/<key>(?<name>[^<]+)<\/key>/gu)].map(
    (match) => match.groups?.["name"] ?? ""
  );

describe("the mac entitlements, re-derived", () => {
  /**
   * THE TWO REMOVALS. Each is a capability this product does not have, and an
   * entitlement for a capability nothing uses is an entitlement a reviewer has
   * to ask about — and an attacker gets for free.
   */
  it("does not grant network.server: the seat listens on nothing", () => {
    expect(grantedEntitlements(entitlements)).not.toContain(
      "com.apple.security.network.server"
    );
    // And the claim is held in code, not only here: the file names the gate
    // rule that keeps it true.
    expect(entitlements).toContain("no-listening-socket");
  });

  it("does not disable library validation: the seat is a binary, not a dylib", () => {
    expect(grantedEntitlements(entitlements)).not.toContain(
      "com.apple.security.cs.disable-library-validation"
    );
  });

  it("keeps exactly the three Chromium needs", () => {
    expect(grantedEntitlements(entitlements)).toStrictEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.network.client",
    ]);
  });

  it("keeps the inherit plist the child processes are signed with", () => {
    const inherit = fs.readFileSync(
      path.join(ROOT, "build/entitlements.mac.inherit.plist"),
      "utf8"
    );
    expect(inherit).toContain("com.apple.security.inherit");
  });
});

describe("the updater's fail-closed state", () => {
  it("enrols no release key, so every packaged update refuses", async () => {
    const { TRUSTED_RELEASE_KEYS } = await import("./update-signature-gate.js");
    // The honest state of the world, not a placeholder: there is no release a
    // build could legitimately trust yet. Enrolling a key flips this test, and
    // the flip is the review signal that signed updates went live.
    expect(TRUSTED_RELEASE_KEYS).toHaveLength(0);
  });

  it("keeps all twelve refusal reasons distinct", async () => {
    const source = fs.readFileSync(
      path.join(ROOT, "src/main/update-signature-core.ts"),
      "utf8"
    );
    const block = /export type UpdateRefusalReason =(?<body>[\s\S]*?);/u.exec(
      source
    );
    expect(block).not.toBeNull();
    const reasons = [
      ...(block?.groups?.["body"] ?? "").matchAll(/"(?<reason>[a-z-]+)"/gu),
    ].map((match) => match.groups?.["reason"]);
    // Twelve, not collapsed into "invalid": "the operator's next action
    // differs" (census §F seam 7).
    expect(new Set(reasons).size).toBe(12);
  });

  it("fetches the manifest from a constant, so a feed cannot redirect it", async () => {
    const { RELEASE_ASSET_BASE, MAX_MANIFEST_BYTES } =
      await import("./update-signature-gate.js");
    expect(RELEASE_ASSET_BASE).toBe(
      "https://github.com/srikanth235/centraid/releases/download"
    );
    expect(MAX_MANIFEST_BYTES).toBe(512 * 1024);
  });
});
