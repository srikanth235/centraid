// Permanent reachability gate for issue #630. A handler file and a manifest
// entry are not product: every capability must have a real UI dispatch on each
// shipped surface, or one of the three explicitly permitted markings below.
//
// WebView-backed mobile covers execute the same blueprint UI, so a proven web
// dispatch is also a mobile dispatch. Native covers are scanned independently;
// their intentional gaps are enumerated by capability, with the assistant as
// the documented mobile fallback until that native workflow exists.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

type Kind = "action" | "query";
type ExceptionKind = "agent-only" | "extension-only" | "platform-fallback";

interface ManifestHandler {
  name: string;
}

interface AppManifest {
  id: string;
  actions?: ManifestHandler[];
  queries?: ManifestHandler[];
}

interface ReachabilityException {
  kind: ExceptionKind;
  rationale: string;
}

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const APPS_ROOT = path.join(PACKAGE_ROOT, "apps");
const MOBILE_APPS_ROOT = path.join(REPO_ROOT, "apps/mobile/src/apps");

const WEBVIEW_APPS = new Set(["notes", "people", "tally", "tasks"]);

const WEB_EXCEPTIONS: Readonly<Record<string, ReachabilityException>> = {
  "locker.query.autofill-candidates": {
    kind: "extension-only",
    rationale:
      "The browser extension calls this origin-scoped candidate endpoint; list UI must never expose it.",
  },
  "locker.query.autofill-item": {
    kind: "extension-only",
    rationale:
      "The browser extension calls this per-origin reveal endpoint after user selection.",
  },
  "locker.query.watchtower": {
    kind: "agent-only",
    rationale:
      "The Locker UI receives the sealed Watchtower aggregate through items; the standalone query remains available to the assistant.",
  },
};

const NATIVE_QUERY_UI: Readonly<Record<string, readonly string[]>> = {
  agenda: ["upcoming", "parties", "search"],
  docs: ["drive", "search"],
  locker: ["auth", "items", "item"],
  photos: ["library", "faces", "duplicates", "enrichment-status", "search"],
};

const NATIVE_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  agenda: ["action.attach", "action.detach"],
  docs: [
    "action.upload",
    "action.rename",
    "action.restore",
    "action.tag",
    "action.untag",
    "action.edit",
    "action.replace",
    "action.restore-version",
    "action.rename-folder",
    "action.delete-folder",
    "query.history",
    "query.activity",
  ],
  locker: [
    "action.add-item",
    "action.edit-item",
    "action.trash-item",
    "action.restore-item",
    "action.purge-item",
    "action.star-item",
    "action.unstar-item",
    "query.search",
    "query.trash",
  ],
  photos: ["action.restore-album", "action.tag-asset", "action.untag-asset"],
};

const MOBILE_EXCEPTION_RATIONALE =
  "The native cover links to the always-available Assistant surface, which invokes this manifested handler with the same consent and receipt contract.";

function sourceTree(root: string, skipHandlers: boolean): string {
  if (!existsSync(root)) return "";
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (
        entry.name.startsWith(".") ||
        (skipHandlers &&
          entry.isDirectory() &&
          (entry.name === "actions" || entry.name === "queries"))
      )
        return [];
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return [sourceTree(target, skipHandlers)];
      if (
        !/\.(?:js|jsx|ts|tsx)$/u.test(entry.name) ||
        /\.test\.(?:ts|tsx)$/u.test(entry.name)
      )
        return [];
      return [readFileSync(target, "utf8")];
    })
    .join("\n");
}

function hasLiteral(source: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`["']${escaped}["']`, "u").test(source);
}

function handlers(manifest: AppManifest): Array<{ kind: Kind; name: string }> {
  return [
    ...(manifest.actions ?? []).map((entry) => ({
      kind: "action" as const,
      name: entry.name,
    })),
    ...(manifest.queries ?? []).map((entry) => ({
      kind: "query" as const,
      name: entry.name,
    })),
  ];
}

function manifests(): AppManifest[] {
  return readdirSync(APPS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .flatMap((entry) => {
      const file = path.join(APPS_ROOT, entry.name, "app.json");
      return existsSync(file)
        ? [JSON.parse(readFileSync(file, "utf8")) as AppManifest]
        : [];
    });
}

function mobileException(
  appId: string,
  kind: Kind,
  name: string
): ReachabilityException | undefined {
  const web = WEB_EXCEPTIONS[`${appId}.${kind}.${name}`];
  if (web?.kind === "extension-only" || web?.kind === "agent-only") return web;
  return (NATIVE_FALLBACK[appId] ?? []).includes(`${kind}.${name}`)
    ? {
        kind: "platform-fallback",
        rationale: MOBILE_EXCEPTION_RATIONALE,
      }
    : undefined;
}

describe("manifest handler reachability", () => {
  describe.each(manifests())("$id", (manifest) => {
    const webSource = sourceTree(path.join(APPS_ROOT, manifest.id), true);
    const mobileSource = sourceTree(
      path.join(MOBILE_APPS_ROOT, manifest.id),
      false
    ).concat(
      manifest.id === "photos"
        ? sourceTree(path.join(REPO_ROOT, "apps/mobile/src/lib/upload"), false)
        : ""
    );

    test("every web handler is dispatched or explicitly marked", () => {
      const missing = handlers(manifest).filter(({ kind, name }) => {
        if (WEB_EXCEPTIONS[`${manifest.id}.${kind}.${name}`]) return false;
        if (hasLiteral(webSource, name)) return false;
        // The shared file-staging helper dispatches the manifest's conventional
        // `attach` action after the input is armed for a specific entity.
        return !(
          kind === "action" &&
          name === "attach" &&
          webSource.includes("wireAttachInput")
        );
      });
      expect(missing).toStrictEqual([]);
    });

    test("every mobile handler is dispatched or explicitly marked", () => {
      const missing = handlers(manifest).filter(({ kind, name }) => {
        if (WEBVIEW_APPS.has(manifest.id))
          return (
            !hasLiteral(webSource, name) &&
            !WEB_EXCEPTIONS[`${manifest.id}.${kind}.${name}`] &&
            !(
              kind === "action" &&
              name === "attach" &&
              webSource.includes("wireAttachInput")
            )
          );
        if (hasLiteral(mobileSource, name)) return false;
        if (
          kind === "query" &&
          (NATIVE_QUERY_UI[manifest.id] ?? []).includes(name)
        )
          return false;
        return !mobileException(manifest.id, kind, name);
      });
      expect(missing).toStrictEqual([]);
    });
  });

  test("every explicit exception is justified and names a live capability", () => {
    const known = new Set(
      manifests().flatMap((manifest) =>
        handlers(manifest).map(
          ({ kind, name }) => `${manifest.id}.${kind}.${name}`
        )
      )
    );
    for (const [key, entry] of Object.entries(WEB_EXCEPTIONS)) {
      expect(known.has(key), key).toBe(true);
      expect(entry.rationale.trim().length, key).toBeGreaterThan(20);
    }
    for (const [appId, entries] of Object.entries(NATIVE_FALLBACK)) {
      for (const entry of entries) {
        const key = `${appId}.${entry}`;
        expect(known.has(key), key).toBe(true);
        expect(MOBILE_EXCEPTION_RATIONALE.length).toBeGreaterThan(20);
      }
    }
  });
});
