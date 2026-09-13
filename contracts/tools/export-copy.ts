// THE COPY EMITTER — one writer per `copy/<app>.json`, plus the Kotlin table
// beside it (#1020, D-1020-T5; extends lane E's D-1020-E6).
//
// There is no central copy file in v0: the leaves are per-app `*-copy.ts`
// modules of named strings, deliberately import-free where both the shell and
// the mobile kit read them
// (`packages/blueprints/apps/_shared/shared-copy.ts:1-11`). This emitter takes
// the STRING-VALUED exports of the named leaves and leaves everything else
// behind, listing what did not cross so a reader is never left wondering
// whether a sentence was missed.
//
// WHY IT IS ITS OWN FILE AND STILL NOT A SECOND EMITTER. Lane E's
// `export-native-theme.ts` wrote `copy/*.json` inline; wave 4 has eight app
// lanes each adding a leaf, so the leaf table needs a home of its own. It is
// CALLED by `export-native-theme.ts` — one command still emits every artifact
// — because two emitters writing one `copy/*.json` is exactly the drift the
// arrangement exists to prevent.
//
//   bun contracts/tools/export-copy.ts          # copy only
//   bun contracts/tools/export-native-theme.ts  # tokens, copy and the corpus
//   bun run format && git diff --exit-code design copy mobile
//
// ROUTE IDS TRAVEL WITH THE SENTENCES (census §A0). A route id that exists in
// the copy table and not on the screen — or the other way round — is a SILENT
// EMPTY STRING, so the emitter also reads the app's shelf table and commits
// both sets. `crates/design`'s copy test asserts they agree.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The copy leaves that reach a native surface, per app.
 *
 * READ AS TEXT, not imported. Some leaves are import-free by design — "a leaf
 * with no imports is the only shape both worlds can read"
 * (`packages/blueprints/apps/_shared/shared-copy.ts:1-11`) — and the rest are
 * not, so importing them pulls a `.tsx` app frame and `@centraid/design` into a
 * build script. `contracts/tools/export-v0-registries.ts` already reads v0
 * declarations as text for the same reason, and the precedent is the right one:
 * a script that needed the whole web graph to resolve would be a script that
 * breaks whenever a component moves.
 *
 * An app lane adds its own entry here and nowhere else.
 */
export const COPY_LEAVES: Record<string, readonly string[]> = {
  // Agenda's two leaves: the shell's own chrome and the calendar grid's
  // day-context decorations. Both ship with the screens they belong to.
  agenda: [
    "packages/blueprints/apps/agenda/view-copy.ts",
    "packages/blueprints/apps/agenda/day-context-copy.ts",
  ],
  // Docs' three leaves: the shell's own chrome, a document's detail pane, and
  // the drive. All three ship with the screens they belong to (census §A0): a
  // route id in one and not the other is a silent empty string.
  docs: [
    "packages/blueprints/apps/docs/view-copy.ts",
    "packages/blueprints/apps/docs/document-copy.ts",
    "packages/blueprints/apps/docs/drive-copy.ts",
  ],
  // Locker's three: the route chrome, the shelf view, and the item pane.
  locker: [
    "packages/blueprints/apps/locker/route-copy.ts",
    "packages/blueprints/apps/locker/view-copy.ts",
    "packages/blueprints/apps/locker/item-copy.ts",
  ],
  notes: ["packages/blueprints/apps/notes/view-copy.ts"],
  // People's ONE leaf, and the app with the largest action surface behind it.
  // Nothing here keys on a route id: People's ambient sentences are `STATUS`
  // functions of counts, not a `ROUTE_STATUS` table — so `copy/people.json`
  // carries its shelves and an empty `routes`, and `crates/apps/people`'s own
  // test asserts that shape rather than the route-gap claim Tally makes.
  people: ["packages/blueprints/apps/people/people-copy.ts"],
  photos: ["packages/blueprints/apps/photos/shared-copy.ts"],
  shared: ["packages/blueprints/apps/_shared/shared-copy.ts"],
  tally: [
    "packages/blueprints/apps/tally/route-copy.ts",
    "packages/blueprints/apps/tally/view-copy.ts",
    "packages/blueprints/apps/tally/compose-copy.ts",
  ],
  tasks: ["packages/blueprints/apps/tasks/view-copy.ts"],
};

/**
 * The shelf table an app's route ids come from — the SCREEN's own side of the
 * claim the copy table makes.
 */
export const SHELF_TABLES: Record<string, string> = {
  docs: "packages/blueprints/apps/docs/shelves.ts",
  tasks: "packages/blueprints/apps/tasks/shelves.ts",
  locker: "packages/blueprints/apps/locker/shelves.ts",
  notes: "packages/blueprints/apps/notes/shelves.ts",
  people: "packages/blueprints/apps/people/shelves.ts",
  tally: "packages/blueprints/apps/tally/shelves.ts",
};

/**
 * `export const NAME = "…";` and nothing else.
 *
 * Deliberately narrow: a template literal, a concatenation or a computed value
 * is a DECISION about how a sentence is composed, and the emitter leaves those
 * to the kit rather than half-porting them. What it does not match, it lists.
 */
const STRING_EXPORT =
  /^export const (?<name>[A-Z][A-Z0-9_]*)\s*=\s*(?<literal>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;/gmu;
const FUNCTION_EXPORT = /^export function (?<name>[A-Za-z][A-Za-z0-9_]*)/gmu;
const OTHER_CONST_EXPORT =
  /^export const (?<name>[A-Za-z][A-Za-z0-9_]*)\s*[=:]/gmu;

/** The keys of a `{ key: "sentence" }` record const, by name. */
function recordKeys(source: string, constName: string): string[] {
  const start = source.indexOf(`const ${constName}`);
  if (start < 0) return [];
  const open = source.indexOf("{", start);
  if (open < 0) return [];
  let depth = 0;
  let end = open;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = at;
        break;
      }
    }
  }
  return [
    ...source
      .slice(open + 1, end)
      .matchAll(/^\s{2}(?<key>[A-Za-z][A-Za-z0-9_]*):/gmu),
  ].map((match) => match.groups?.key ?? "");
}

/**
 * THE ROOT SHELF'S ROUTE ID, read off the shelf table rather than assumed.
 *
 * A root shelf's `id` is `null` and its `segment` is the empty string, so the
 * route id it is keyed on is neither — it is the band's, which every shelf table
 * declares as `rootBandId` in its `createShelfRoutes` call. This used to be the
 * literal `"balances"`, which is Tally's; Docs' root is `list`
 * (`docs/shelves.ts:55`), Locker's is `items` (`locker/shelves.ts:62`) and
 * People's is `people`, so those three leaves named a shelf `balances` that no
 * screen of theirs has (#1020, slot 4c, filed twice independently — finding
 * PE-F7 here and the Notes lane's).
 *
 * The declaration is followed one hop: `rootBandId: ALL_ID` and
 * `const ALL_ID = "list"`, or a literal in place.
 */
function rootBandId(source: string): string {
  const declared =
    /rootBandId:\s*(?<value>"(?<literal>[^"]*)"|[A-Za-z][A-Za-z0-9_]*)/u.exec(
      source
    );
  if (!declared?.groups) return "";
  if (declared.groups.literal !== undefined) return declared.groups.literal;
  const name = declared.groups.value ?? "";
  const resolved = new RegExp(
    `const ${name}\\s*=\\s*"(?<literal>[^"]*)"`,
    "u"
  ).exec(source);
  return resolved?.groups?.literal ?? "";
}

/**
 * The `{ id, label, segment }` rows of a shelf table, read as text.
 *
 * **Deduplicated by route id**, because a shelf table may list one destination
 * in two arrays — People's `ROUTED` and `DESTINATION_SHELVES` share three rows
 * (`people/shelves.ts:28`, `:45`) — and a shelf listed twice is still one
 * shelf. Tally's fifteen are distinct, so its emitted table does not move.
 */
function shelfRows(
  source: string
): { id: string; label: string; segment: string }[] {
  const ROW =
    /\{\s*id:\s*(?<id>null|[A-Za-z][A-Za-z0-9_]*),\s*label:\s*"(?<label>[^"]*)",\s*segment:\s*"(?<segment>[^"]*)"\s*\}/gu;
  const root = rootBandId(source);
  const rows = [...source.matchAll(ROW)].map((match) => {
    const groups = match.groups ?? {};
    return {
      // The ROUTE id, which for the root shelf is not its empty segment: the
      // band names it, and `rootBandId` is where the table says so.
      id: groups.id === "null" ? root : (groups.segment ?? ""),
      label: groups.label ?? "",
      segment: groups.segment ?? "",
    };
  });
  return rows.filter(
    (row, at) => rows.findIndex((other) => other.id === row.id) === at
  );
}

/**
 * The banner the Kotlin table carries. ONE function, used by the standalone
 * run and by `export-native-theme.ts`'s call, because two banners for one
 * generated file is a diff that appears whenever the other command ran last.
 */
export function copyHeader(): string {
  return [
    "// GENERATED by contracts/tools/export-copy.ts. Do not edit.",
    "//",
    "// Copy, emitted from v0's per-app `*-copy.ts` leaves (#1020, D-1020-T5).",
    "// A hand-edited copy of this table is a second lowering with no drift gate,",
    "// which is what `git diff --exit-code design copy mobile` in the mobile-jvm",
    "// gate step exists to prevent.",
    "",
  ].join("\n");
}

/** Emit `copy/<app>.json` for every app's leaves, plus the one Kotlin table. */
export function emitCopy(repositoryRoot: string): {
  leaves: number;
  strings: number;
} {
  mkdirSync(path.join(repositoryRoot, "copy"), { recursive: true });

  const copyKotlin: string[] = [
    copyHeader(),
    "package dev.centraid.design",
    "",
    "/**",
    " * Copy, emitted from v0's per-app `*-copy.ts` leaves (#1020, D-1020-E6).",
    " *",
    " * STRINGS ONLY. A leaf's function exports are listed in `copy/<app>.json`'s",
    " * `functions` array and are NOT emitted: a function is a decision about how to",
    " * compose a sentence, and a generated Kotlin port of one would be a second",
    " * implementation that drifts.",
    " */",
    "public object CentraidCopy {",
  ];

  let emittedStrings = 0;
  let leaves = 0;
  for (const [app, leafPaths] of Object.entries(COPY_LEAVES).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const strings: Record<string, string> = {};
    const functions: string[] = [];
    const routes: string[] = [];
    const moreRoutes: string[] = [];
    for (const leafPath of leafPaths) {
      leaves += 1;
      const source = readFileSync(path.join(repositoryRoot, leafPath), "utf8");
      for (const match of source.matchAll(FUNCTION_EXPORT)) {
        functions.push(match.groups?.name ?? "");
      }
      const literals = new Map<string, string>();
      for (const match of source.matchAll(STRING_EXPORT)) {
        const literal = match.groups?.literal ?? '""';
        literals.set(
          match.groups?.name ?? "",
          JSON.parse(
            `"${literal.slice(1, -1).replace(/"/gu, '\\"')}"`
          ) as string
        );
      }
      // Every other exported const is NOT emitted, and is listed so a reader
      // can see what did not cross rather than wondering whether it was missed.
      for (const match of source.matchAll(OTHER_CONST_EXPORT)) {
        const name = match.groups?.name ?? "";
        if (!literals.has(name)) functions.push(name);
      }
      routes.push(...recordKeys(source, "ROUTE_STATUS"));
      moreRoutes.push(...recordKeys(source, "MORE_META"));
      for (const [name, value] of [...literals.entries()].sort(
        ([left], [right]) => left.localeCompare(right)
      )) {
        // SENTENCE CASE IS A RULE (`docs/decisions.md:98`), and the mobile kit
        // has its own discipline for it (`apps/mobile/src/kit/copy-case.ts`).
        // The emitter ASSERTS what it can check without a dictionary: a string
        // in Title Case Like This is one it can spot.
        const titleCased = value
          .split(" ")
          .filter((word) => /^[A-Z][a-z]+$/u.test(word));
        if (titleCased.length >= 4) {
          throw new Error(
            `copy/${app}.json: "${name}" looks like Title Case ("${value}"), and ` +
              `DESIGN.md's copy rules are sentence case (docs/decisions.md:98).`
          );
        }
        strings[name] = value;
      }
    }
    emittedStrings += Object.keys(strings).length;
    const shelfTable = SHELF_TABLES[app];
    const shelves = shelfTable
      ? shelfRows(readFileSync(path.join(repositoryRoot, shelfTable), "utf8"))
      : [];
    writeFileSync(
      path.join(repositoryRoot, `copy/${app}.json`),
      `${JSON.stringify(
        {
          $generatedBy: "contracts/tools/export-copy.ts",
          app,
          strings: Object.fromEntries(
            Object.entries(strings).sort(([left], [right]) =>
              left.localeCompare(right)
            )
          ),
          functions,
          routes,
          moreRoutes,
          shelves,
        },
        undefined,
        2
      )}\n`
    );
    copyKotlin.push(
      `    public object ${app[0]?.toUpperCase() ?? ""}${app.slice(1)} {`
    );
    for (const [name, value] of Object.entries(strings)) {
      copyKotlin.push(
        `        public const val ${name}: String = ${JSON.stringify(value)}`
      );
    }
    copyKotlin.push("    }", "");
  }
  copyKotlin.push("}", "");

  writeFileSync(
    path.join(
      repositoryRoot,
      "mobile/shared/src/commonMain/kotlin/dev/centraid/design/Copy.kt"
    ),
    `${copyKotlin.join("\n")}`
  );

  return { leaves, strings: emittedStrings };
}

// Runnable on its own, for a lane that only added a leaf.
if (import.meta.main) {
  const root = new URL("../..", import.meta.url).pathname;
  const counts = emitCopy(root);
  console.error(
    `emitted copy/*.json from ${counts.leaves} leaves (${counts.strings} strings)`
  );
}
