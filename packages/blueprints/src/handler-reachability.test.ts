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
type ExceptionKind =
  | "agent-only"
  | "extension-only"
  | "platform-fallback"
  | "awaiting-handoff";

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

const WEBVIEW_APPS = new Set(["notes"]);

/**
 * Apps whose UI on a given surface has been REMOVED pending its Binding Layer
 * v11 design handoff, and which therefore dispatch nothing there.
 *
 * This is the one exception in this file that is not about a capability - it is
 * about a surface. The other three say "this handler is reached another way";
 * this one says "there is no screen here at all yet". Recording it per app
 * rather than per handler is deliberate: enumerating ~35 People handlers as
 * individually-excused would read as thirty-five decisions when it is one, and
 * the day the rebuild lands the fix is to delete an app id, not to audit a
 * list.
 *
 * What was NOT removed, and so is not excused: the manifests, `./actions/*`,
 * `./queries/*` and the vault scopes. The assistant still invokes every one of
 * these handlers. The gate is suspended over the UI that is gone, not over the
 * contract that stayed.
 *
 * Removing an app id here is the last step of its rebuild. The justification
 * test below fails on an id that is not a real manifest, so an entry cannot
 * outlive the app it names.
 */
const AWAITING_HANDOFF: Readonly<Record<"web" | "mobile", readonly string[]>> =
  {
    web: [],
    mobile: ["docs", "people"],
  };

const AWAITING_HANDOFF_RATIONALE =
  "The surface was removed pending its Binding Layer v11 design handoff; the manifest, actions, queries and vault scopes are untouched and the assistant still reaches every handler.";

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
  "docs.action.edit": {
    kind: "agent-only",
    rationale:
      "Docs holds, versions and files a document; it does not open one to type into. The v11 drive has no editor on any seat (docs/design-divergences.md), so this write is the assistant's alone.",
  },
  "locker.query.watchtower": {
    kind: "agent-only",
    rationale:
      "The Locker UI receives the sealed Watchtower aggregate through items; the standalone query remains available to the assistant.",
  },
  // People, rebuilt to the Binding Layer v12 handoff (#821). The handoff draws
  // the roster, the person, Touch, Search, Trash, Log, Edit and Merge — and
  // EXCLUDES seven record sections outright. The queries still return that data
  // and the writes still land, so these are not dark handlers: they are the
  // vault contract outliving a screen the handoff chose not to draw. The
  // register is docs/design-divergences.md § "People — v12 parity state and
  // sanctioned withholdings"; the handoff bans placeholders, so nothing here
  // gets a stub UI to satisfy this gate.
  "people.action.create-list": {
    kind: "agent-only",
    rationale:
      "Lists are one of the seven sections the v12 handoff excludes from the UI; the assistant still files a person into a list the member names.",
  },
  "people.action.rename-list": {
    kind: "agent-only",
    rationale:
      "Same excluded lists section: with no list surface drawn there is nothing on screen to rename, and the assistant keeps the write.",
  },
  "people.action.delete-list": {
    kind: "agent-only",
    rationale:
      "Same excluded lists section. A delete offered without the list it deletes would be a control naming nothing.",
  },
  "people.action.move-person": {
    kind: "agent-only",
    rationale:
      "Moving a person between lists needs the excluded lists section to move them between; the assistant performs it on the member's word.",
  },
  "people.action.add-journal-entry": {
    kind: "agent-only",
    rationale:
      "The journal is excluded by the v12 handoff, so no screen composes an entry; the assistant writes one whenever the member dictates it.",
  },
  "people.query.journal": {
    kind: "agent-only",
    rationale:
      "The read side of that excluded journal: entries stay retrievable by the assistant even though no People screen lists them.",
  },
  "people.action.add-task": {
    kind: "agent-only",
    rationale:
      "Tasks about a person are excluded here because Tasks is its own app; the assistant files them without People growing a second board.",
  },
  "people.action.toggle-task": {
    kind: "agent-only",
    rationale:
      "Same excluded tasks section: People draws no checkbox to tick, and the assistant completes the task the member names.",
  },
  "people.action.add-gift": {
    kind: "agent-only",
    rationale:
      "Gifts are an excluded section in the v12 handoff; the assistant records a gift idea against a person with no screen to host it.",
  },
  "people.action.toggle-gift": {
    kind: "agent-only",
    rationale:
      "Same excluded gifts section — marking one given is the assistant's, because the list it would be marked in is not drawn.",
  },
  "people.action.add-debt": {
    kind: "agent-only",
    rationale:
      "Debts are excluded from People's UI because Tally owns shared money; the assistant keeps the person-scoped write for one-off IOUs.",
  },
  "people.action.settle-debt": {
    kind: "agent-only",
    rationale:
      "Same excluded debts section: settling is the assistant's for the same reason the debt was never drawn beside the person.",
  },
  "people.action.add-relationship": {
    kind: "agent-only",
    rationale:
      "Typed relationships between two people are an excluded section; the assistant records who is whose sibling without a screen for it.",
  },
  "people.action.undo-person": {
    kind: "agent-only",
    rationale:
      "Edit history is excluded, and the app offers Undo only where a true reverse write exists (star, trash, edit, cadence) — this replays a stored revision instead, which is the assistant's.",
  },
  "people.query.history": {
    kind: "agent-only",
    rationale:
      "The read side of that excluded edit history: the assistant can recount what changed and when, and no People screen shows a revision log.",
  },
  "people.action.undo-contact-channel": {
    kind: "agent-only",
    rationale:
      "A channel's revision undo has no surface for the same reason: the person screen removes a channel outright and reports it, rather than drawing a history to step back through.",
  },
};

// Native covers that DO render, and the queries their screens answer directly.
// `docs` and `people` were here until those two native screens were removed
// (AWAITING_HANDOFF above); their rows are gone rather than kept as a shopping
// list, so this table never describes a screen that is not on the phone.
const NATIVE_QUERY_UI: Readonly<Record<string, readonly string[]>> = {
  agenda: ["upcoming", "parties", "search"],
  locker: ["auth", "items", "item"],
  photos: [
    "library",
    "faces",
    "face-queue",
    "duplicates",
    "enrichment-status",
    "search",
    // The phone's Backup screen is a FRAME surface since #712 B2: it reads
    // the gateway's storage/status route (which now carries the custody
    // rollup) rather than dispatching this app query, which remains the web
    // Storage screen's read path.
    "storage",
  ],
  tally: ["dashboard", "group"],
  tasks: ["board"],
};

const NATIVE_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  agenda: ["action.attach", "action.detach"],
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
  tally: [
    "action.add-receipt-expense",
    "action.edit-expense",
    "action.delete-expense",
    "action.undo-expense",
    "action.restore-expense",
    "action.settle-up",
    "action.add-friend",
    "action.rename-group",
    "action.add-group-member",
    "action.remove-group-member",
    "action.delete-group",
    "query.friend",
    "query.activity",
    "query.search",
    "query.history",
  ],
  tasks: [
    "action.edit",
    "action.attach",
    "action.detach",
    "action.add-tag",
    "action.remove-tag",
    "query.search",
  ],
};

// `docs` and `people` had entries here too - the actions their native covers
// deferred to the assistant. Both apps are now excused wholesale by
// AWAITING_HANDOFF, and a per-action list beside that would be two records of
// one fact, the finer one already false.
const MOBILE_EXCEPTION_RATIONALE =
  "The native cover links to the always-available Assistant surface, which invokes this manifested handler with the same consent and receipt contract.";

/**
 * A blueprint app's source, for the "is this name called anywhere" scan.
 *
 * `skipFiles` exists for the suspension check below. A file that DECLARES every
 * action by name — `pending-projection.ts` is the whole set, `app-inline.tsx`
 * the query map — would make any app look like it dispatches everything, which
 * is harmless for the normal scan (a false pass there is caught by the app
 * actually having a UI) but fatal for an assertion that the UI is GONE.
 */
function sourceTree(
  root: string,
  skipHandlers: boolean,
  skipFiles: ReadonlySet<string> = new Set()
): string {
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
      if (entry.isDirectory())
        return [sourceTree(target, skipHandlers, skipFiles)];
      if (
        !/\.(?:js|jsx|ts|tsx)$/u.test(entry.name) ||
        /\.test\.(?:ts|tsx)$/u.test(entry.name) ||
        skipFiles.has(entry.name)
      )
        return [];
      return [readFileSync(target, "utf8")];
    })
    .join("\n");
}

/** The two files that name handlers without calling them. */
const DECLARATION_FILES: ReadonlySet<string> = new Set([
  "pending-projection.ts",
  "app-inline.tsx",
]);

/** Drop line/block comments so a name only in a comment cannot pass. */
function withoutComments(source: string): string {
  // Line comments first: otherwise `// path/*.ts` would open a block comment
  // at the `/*` and swallow the rest of the file until a later `*/`.
  return source
    .replace(/(?<lead>^|[^:])\/\/[^\n]*/gu, "$<lead>")
    .replace(/\/\*[\s\S]*?\*\//gu, " ");
}

function hasLiteral(source: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Comments do not count as reachability — a name only mentioned in a note
  // or disabled block is not a live call site.
  return new RegExp(`["']${escaped}["']`, "u").test(withoutComments(source));
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

function awaitingHandoff(
  surface: "web" | "mobile",
  appId: string
): ReachabilityException | undefined {
  return AWAITING_HANDOFF[surface].includes(appId)
    ? { kind: "awaiting-handoff", rationale: AWAITING_HANDOFF_RATIONALE }
    : undefined;
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
    const webSource = sourceTree(
      path.join(APPS_ROOT, manifest.id),
      true
    ).concat(
      manifest.id === "tally"
        ? sourceTree(
            path.join(REPO_ROOT, "packages/client/src/react/shell"),
            false
          )
        : ""
    );
    const mobileSource = sourceTree(
      path.join(MOBILE_APPS_ROOT, manifest.id),
      false
    ).concat(
      manifest.id === "photos" || manifest.id === "tally"
        ? sourceTree(path.join(REPO_ROOT, "apps/mobile/src/lib/upload"), false)
        : ""
    );

    // ONE assertion, two questions, chosen by whether this surface is
    // suspended. A suspended app is asserted ABSENT rather than skipped: the
    // moment a rebuild starts dispatching again this fails, and the
    // AWAITING_HANDOFF entry has to come out. Skipping would let a half-rebuilt
    // surface sit here unexamined.
    const webUnexpected = (): Array<{ kind: Kind; name: string }> => {
      if (awaitingHandoff("web", manifest.id)) {
        const rendered = sourceTree(
          path.join(APPS_ROOT, manifest.id),
          true,
          DECLARATION_FILES
        );
        return handlers(manifest).filter(({ name }) =>
          hasLiteral(rendered, name)
        );
      }
      return handlers(manifest).filter(({ kind, name }) => {
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
    };

    test("every web handler is dispatched or explicitly marked", () => {
      expect(webUnexpected()).toStrictEqual([]);
    });

    const mobileUnexpected = (): Array<{ kind: Kind; name: string }> => {
      if (awaitingHandoff("mobile", manifest.id))
        return handlers(manifest).filter(({ name }) =>
          hasLiteral(mobileSource, name)
        );
      return handlers(manifest).filter(({ kind, name }) => {
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
    };

    test("every mobile handler is dispatched or explicitly marked", () => {
      expect(mobileUnexpected()).toStrictEqual([]);
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
    // A suspended surface must name a REAL app, so the entry dies with the
    // rebuild instead of quietly excusing an app id that no longer exists.
    const appIds = new Set(manifests().map((manifest) => manifest.id));
    for (const ids of Object.values(AWAITING_HANDOFF))
      for (const id of ids) expect(appIds.has(id), id).toBe(true);
    expect(AWAITING_HANDOFF_RATIONALE.length).toBeGreaterThan(20);
  });
});
