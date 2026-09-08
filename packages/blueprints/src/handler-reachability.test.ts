// Reachability gate (#630): every manifested capability needs a real UI
// dispatch on each shipped surface, or one of the markings below. Every seat
// draws its own cover now (#799), so each surface is measured on its own tree.
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

/**
 * Surfaces REMOVED pending a redesign, so they dispatch nothing. The only
 * per-SURFACE exception: recorded per app so a rebuild deletes one id. The
 * gate is suspended over the UI, never over the contract.
 */
const AWAITING_HANDOFF: Readonly<Record<"web" | "mobile", readonly string[]>> =
  {
    web: [],
    mobile: [],
  };

const AWAITING_HANDOFF_RATIONALE =
  "The surface was removed whole pending a ground-up redesign; the manifest, actions, queries and vault scopes are untouched and the assistant still reaches every handler.";

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
  "tally.action.add-receipt-expense": {
    kind: "agent-only",
    rationale:
      "The action requires staged_sha and ocr_text from the origin seat's receipt capture; no web route holds a camera or the OCR pass, so the Receipt surface reconciles and simulates while the assistant carries the write (#872).",
  },
  "docs.action.edit": {
    kind: "agent-only",
    rationale:
      "The WEB drive holds, versions and files a document; it does not open one to type into (docs/design-divergences.md). The v12 phone build is different by design — the handoff's Part 2 draws an editor there, and the mobile scan finds this write itself.",
  },
  "locker.query.watchtower": {
    kind: "agent-only",
    rationale:
      "The Locker UI receives the sealed Watchtower aggregate through items; the standalone query remains available to the assistant.",
  },
  // People (#821): the v12 handoff EXCLUDES seven record sections, so these
  // are the contract outliving screens nobody draws (docs/design-divergences).
  // Placeholders are banned; never add a stub UI to satisfy this gate.
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

// Native covers that render a query's ANSWER without dispatching it: the phone
// runs the emitter's own joins over the replica's transports, same contract.
const NATIVE_QUERY_UI: Readonly<Record<string, readonly string[]>> = {
  agenda: [
    "upcoming",
    "parties",
    "search",
    // Done natively over replica rows in Agenda's read scopes (#834).
    "day-context",
  ],
  docs: ["drive", "search", "history"],
  people: ["people", "person", "dashboard", "search", "trash"],
  // Notes' native session has no named-query seam (#799) — only entity read,
  // FTS search and write. Every answer here is a SHARED computation run over
  // those three: `useNotes`, `useNoteVersions`, and the powerbox's picker.
  notes: ["library", "journal", "note", "link-targets", "search", "history"],
  photos: [
    "library",
    "faces",
    "face-queue",
    "duplicates",
    "enrichment-status",
    "search",
    // The phone's Backup screen reads the gateway's storage route (#712 B2).
    "storage",
    // Collections builds its People rail through `buildPeopleShelf`.
    "people",
  ],
  tasks: ["board"],
};

const NATIVE_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  agenda: ["action.attach", "action.detach"],
  docs: ["action.tag", "action.untag", "action.replace", "query.activity"],
  // The phone DOES issue these eight (`apps/mobile/.../locker-writes.ts`, the
  // Backup surface included); the scan cannot see them because the names are
  // literals in the shared builders (`apps/locker/writes.ts`), where the
  // one-computation rule wants them. No query is listed: the phone RUNS
  // `queries/{items,search,trash}.ts` and its gateway door names access.
  locker: [
    "action.add-item",
    "action.edit-item",
    "action.trash-item",
    "action.restore-item",
    "action.purge-item",
    "action.star-item",
    "action.unstar-item",
    "action.export",
    // Undrawn, not merely unseen: the cover has no archive shelf, duplicate
    // act, custom-field editor or passkey slot. The Assistant carries each,
    // and each entry dies when the phone draws its control.
    "action.archive-item",
    "action.unarchive-item",
    "action.duplicate-item",
    "action.set-field",
    "action.remove-field",
    "action.set-addresses",
    "action.set-passkey",
    "action.clear-passkey",
  ],
  // Attachments are listed read-only on the phone's note: that cover has no
  // native file picker, and a control that opens nothing is banned.
  notes: ["action.attach", "action.detach"],
  photos: ["action.restore-album", "action.untag-asset"],
  // Dispatched but unseen for the same reason Locker's are (#873 U3:
  // `tally-writes.ts` over the builders in `apps/tally/writes.ts`).
  // `add-receipt-expense` is NOT here — the capture flow names it in
  // `apps/mobile/src/lib/upload/media-producer.ts` — and no query is, because
  // the phone's gateway door names all seven itself.
  tally: [
    "action.add-expense",
    "action.edit-expense",
    "action.delete-expense",
    "action.undo-expense",
    "action.restore-expense",
    "action.settle-up",
    "action.add-friend",
    "action.create-group",
    "action.rename-group",
    "action.add-group-member",
    "action.remove-group-member",
    "action.delete-group",
    "action.leave-group",
    "action.archive-group",
    "action.set-group-simplification",
    "action.reallocate-receipt",
    "action.nudge",
    "action.save-recurring-expense",
    "action.materialize-recurring-expense",
    "action.edit-recurring-expense-occurrence",
  ],
  // Same read-only attachments, same missing picker, as Notes above.
  tasks: ["action.attach", "action.detach"],
};

const MOBILE_EXCEPTION_RATIONALE =
  "Reached on the phone where the scan cannot see it: either a shared write builder holds the action name, or the cover links to the always-available Assistant surface, which invokes this manifested handler with the same consent and receipt contract.";

/**
 * Source for the "is this name called anywhere" scan. `skipFiles` serves the
 * suspension check: a file that DECLARES every handler by name makes an app
 * look like it dispatches everything.
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

/** Files that name handlers without calling them. */
const DECLARATION_FILES: ReadonlySet<string> = new Set([
  "pending-projection.ts",
  "app-inline.tsx",
]);

/** Drop line/block comments so a name only in a comment cannot pass. */
function withoutComments(source: string): string {
  // Line comments first, or a `/*` inside one swallows the rest of the file.
  return source
    .replace(/(?<lead>^|[^:])\/\/[^\n]*/gu, "$<lead>")
    .replace(/\/\*[\s\S]*?\*\//gu, " ");
}

/** Words whose parenthesised clause is a condition or a value, not arguments. */
const NOT_A_CALLEE: ReadonlySet<string> = new Set([
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "catch",
  "typeof",
  "instanceof",
  "void",
  "delete",
  "await",
  "yield",
  "throw",
  "in",
  "of",
  "as",
  "is",
]);

/** The request's own `action`/`query` field, reaching only its own value. */
const REQUEST_FIELD = /\b(?:action|query)[\t ]*:[^()[\]{};,]*$/u;

/** The last still-open `(`: a bracket, brace or `;` in the run closes it. */
const CALL_OPEN =
  /(?<callee>[A-Za-z0-9_$]*)(?<generic>\]|(?<!=)>)?[\t ]*\([^()[\]{};]*$/u;

/** The right-hand side of an equality test. */
const COMPARED = /[=!]==?\s*$/u;

/** An argument of a call — the one position that actually dispatches a name. */
function inArgumentList(before: string): boolean {
  const open = CALL_OPEN.exec(before);
  if (!open) return false;
  if (open.groups?.generic) return true;
  const callee = open.groups?.callee ?? "";
  return callee.length > 0 && !NOT_A_CALLEE.has(callee);
}

/**
 * A handler is REACHED only where its name is DISPATCHED (#882): as a
 * request's `action`/`query`, or as an argument of a call. A route key, shelf
 * id, object key, copy constant or comment repeating it is not a call site.
 */
function hasDispatch(source: string, value: string): boolean {
  const body = withoutComments(source);
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const hit of body.matchAll(new RegExp(`["']${escaped}["']`, "gu"))) {
    const before = body.slice(0, hit.index);
    // Comparing a route key against the name reads the name; it never sends it.
    if (COMPARED.test(before)) continue;
    if (REQUEST_FIELD.test(before) || inArgumentList(before)) return true;
  }
  return false;
}

/**
 * A seat that RUNS the handler module reaches it more directly than one that
 * names it in a request: the phone imports `apps/<id>/queries/<name>` and runs
 * it against its own replica (#922 E7), so the name is a module specifier
 * rather than a string in a payload. Comments are stripped first — a file that
 * merely talks about `queries/dashboard.ts` dispatches nothing.
 */
function runsQueryModule(source: string, appId: string, name: string): boolean {
  const escaped = `${appId}/queries/${name}`.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&"
  );
  return new RegExp(`["'][^"']*apps/${escaped}(?:\\.[jt]sx?)?["']`, "u").test(
    withoutComments(source)
  );
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
    // The cover alone: absence is asserted over exactly what was removed.
    const nativeCover = sourceTree(
      path.join(MOBILE_APPS_ROOT, manifest.id),
      false
    );
    const mobileSource = nativeCover.concat(
      manifest.id === "photos" || manifest.id === "tally"
        ? sourceTree(path.join(REPO_ROOT, "apps/mobile/src/lib/upload"), false)
        : ""
    );

    // A suspended app is asserted ABSENT, never skipped: once a rebuild
    // dispatches again this fails and its entry must come out.
    const webUnexpected = (): Array<{ kind: Kind; name: string }> => {
      if (awaitingHandoff("web", manifest.id)) {
        const rendered = sourceTree(
          path.join(APPS_ROOT, manifest.id),
          true,
          DECLARATION_FILES
        );
        return handlers(manifest).filter(({ name }) =>
          hasDispatch(rendered, name)
        );
      }
      return handlers(manifest).filter(({ kind, name }) => {
        if (WEB_EXCEPTIONS[`${manifest.id}.${kind}.${name}`]) return false;
        if (hasDispatch(webSource, name)) return false;
        // `wireAttachInput` dispatches the conventional `attach` action.
        return !(
          kind === "action" &&
          name === "attach" &&
          webSource.includes("wireAttachInput")
        );
      });
    };

    test("every web handler is dispatched or explicitly marked", () => {
      expect(
        webUnexpected(),
        `${manifest.id}: draw a web control that dispatches each handler below, or add a WEB_EXCEPTIONS entry saying why the surface never will. A route key, shelf id or copy constant that repeats the name is not a dispatch — the name has to be the request's action/query or an argument of the call.`
      ).toStrictEqual([]);
    });

    const mobileUnexpected = (): Array<{ kind: Kind; name: string }> => {
      // Over the cover alone: the shared upload path outlives a removed
      // cover, and what it still dispatches is reached, not leaked.
      if (awaitingHandoff("mobile", manifest.id))
        return handlers(manifest).filter(({ name }) =>
          hasDispatch(nativeCover, name)
        );
      return handlers(manifest).filter(({ kind, name }) => {
        if (hasDispatch(mobileSource, name)) return false;
        if (
          kind === "query" &&
          runsQueryModule(mobileSource, manifest.id, name)
        )
          return false;
        if (
          kind === "query" &&
          (NATIVE_QUERY_UI[manifest.id] ?? []).includes(name)
        )
          return false;
        return !mobileException(manifest.id, kind, name);
      });
    };

    test("every mobile handler is dispatched or explicitly marked", () => {
      expect(
        mobileUnexpected(),
        `${manifest.id}: draw a native control that dispatches each handler below, or file it — NATIVE_QUERY_UI when the cover renders the answer over the replica's own transports, NATIVE_FALLBACK when the Assistant carries it or a shared write builder holds the name. A route key, shelf id or copy constant that repeats the name is not a dispatch.`
      ).toStrictEqual([]);
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
    // A suspended surface must name a REAL app, so the entry dies with it.
    const appIds = new Set(manifests().map((manifest) => manifest.id));
    for (const ids of Object.values(AWAITING_HANDOFF))
      for (const id of ids) expect(appIds.has(id), id).toBe(true);
    expect(AWAITING_HANDOFF_RATIONALE.length).toBeGreaterThan(20);
  });
});
