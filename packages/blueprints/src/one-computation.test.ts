/**
 * Mechanical guard for docs/blueprint-seats.md's one-computation rule (#883).
 *
 * TWO LANES, TWO BASELINES, so fixing one moves only its own list. NAMES — the
 * same exported identifier in both trees of a pair. BODIES — the same
 * normalized body whatever the two are called, the only lane that sees a
 * rename.
 *
 * `packages/client/src` pairs twice: the kit lane takes mobile's `kit` + `lib`,
 * the screens lane the rest of `apps/mobile/src/apps`. Each dir pairs once.
 *
 * TIGHTEN-ONLY IN BOTH DIRECTIONS. `toStrictEqual` against a seeded baseline,
 * so a NEW collision fails and a REMOVED one fails too until the baseline is
 * shrunk in the same PR.
 *
 * A TRIPWIRE, NOT A PROOF: a text scanner, so `export default`, destructured
 * exports and re-exported classes are outside its reach.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");

const PAIRED_APPS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
] as const;

const MOBILE_APPS = path.join("apps", "mobile", "src", "apps");

/** DERIVED, so a new mobile app seat is scanned the day it lands. */
function unpairedMobileApps(): string[] {
  return readdirSync(path.join(ROOT, MOBILE_APPS), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !(PAIRED_APPS as readonly string[]).includes(entry.name)
    )
    .map((entry) => path.join(MOBILE_APPS, entry.name))
    .sort();
}

/** `[lane, web-side roots, native-side roots]`, all repo-relative. */
const PAIRED_TREES: readonly (readonly [
  string,
  readonly string[],
  readonly string[],
])[] = [
  ...PAIRED_APPS.map(
    (app) =>
      [
        app,
        [path.join("packages", "blueprints", "apps", app)],
        [path.join("apps", "mobile", "src", "apps", app)],
      ] as const
  ),
  [
    "kit",
    [path.join("packages", "client", "src")],
    [
      path.join("apps", "mobile", "src", "kit"),
      path.join("apps", "mobile", "src", "lib"),
    ],
  ],
  ["screens", [path.join("packages", "client", "src")], unpairedMobileApps()],
];

/** Below this, bodies collide by chance. Ceiling: `assetRatio` is 84. */
const MIN_BODY_CHARS = 40;

const RUNTIME_EXPORT =
  /export\s+(?:async\s+)?(?<kind>function|const)\s+(?<name>[A-Za-z_$][\w$]*)/gu;

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(file, out);
    else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\./u.test(entry.name)
    )
      out.push(file);
  }
  return out;
}

function endOfQuote(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return source.length;
}

/**
 * The `{ … }` block of `function NAME<params>: Ret { … }`. Params and return
 * annotations may themselves contain braces (`{ a }: Props`), so the body
 * opener is the first `{` at paren/bracket depth zero.
 */
function functionBody(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = endOfQuote(source, i);
      continue;
    }
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "{" && depth === 0) return balancedBlock(source, i);
  }
  return "";
}

function balancedBlock(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = endOfQuote(source, i);
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/**
 * The initializer of `const NAME<: Type> = …`, to the first `;` or line break
 * outside every bracket. The `=` search skips `==` and `=>` so an arrow-typed
 * annotation does not end it early.
 */
function constBody(source: string, from: number): string {
  let assign = -1;
  for (let i = from; i < source.length && assign === -1; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = endOfQuote(source, i);
      continue;
    }
    if (char === "=" && source[i + 1] !== "=" && source[i + 1] !== ">")
      assign = i;
  }
  if (assign === -1) return "";
  let depth = 0;
  for (let i = assign + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = endOfQuote(source, i);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (depth === 0 && (char === ";" || char === "\n"))
      return source.slice(assign + 1, i);
  }
  return source.slice(assign + 1);
}

/**
 * Comments and whitespace removed, so a reformat cannot hide a copy. `://` is
 * spared so a URL in a string survives; a `//` inside any other string literal
 * is over-stripped, harmless because both sides normalize the same way.
 */
function normalizeBody(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(?<before>^|[^:])\/\/[^\n]*/gu, "$<before>")
    .replace(/\s+/gu, "");
}

interface TreeScan {
  names: Map<string, string[]>;
  bodies: Map<string, Set<string>>;
}

function scanSource(scan: TreeScan, file: string, source: string): TreeScan {
  for (const match of source.matchAll(RUNTIME_EXPORT)) {
    const name = match.groups?.name;
    if (!name || match.index === undefined) continue;
    const after = match.index + match[0].length;
    const declared = scan.names.get(name);
    if (declared) declared.push(file);
    else scan.names.set(name, [file]);
    const body = normalizeBody(
      match.groups?.kind === "function"
        ? functionBody(source, after)
        : constBody(source, after)
    );
    if (body.length < MIN_BODY_CHARS) continue;
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    const carriers = scan.bodies.get(hash);
    if (carriers) carriers.add(name);
    else scan.bodies.set(hash, new Set([name]));
  }
  return scan;
}

function scanTree(roots: readonly string[]): TreeScan {
  const scan: TreeScan = { names: new Map(), bodies: new Map() };
  for (const root of roots)
    for (const file of sourceFiles(path.join(ROOT, root)))
      scanSource(scan, file, readFileSync(file, "utf8"));
  return scan;
}

function scanFixture(source: string): TreeScan {
  return scanSource(
    { names: new Map(), bodies: new Map() },
    "fixture.ts",
    source
  );
}

function nameCollisions(left: TreeScan, right: TreeScan): string[] {
  return [...left.names.keys()].filter((name) => right.names.has(name)).sort();
}

/** `web ↔ native`: an entry names what to collapse, not a hash. */
function bodyCollisions(left: TreeScan, right: TreeScan): string[] {
  return [...left.bodies.entries()]
    .flatMap(([hash, webNames]) => {
      const nativeNames = right.bodies.get(hash);
      if (!nativeNames) return [];
      return [
        `${[...webNames].sort().join(",")} ↔ ${[...nativeNames].sort().join(",")}`,
      ];
    })
    .sort();
}

function scanAllLanes(): {
  names: Record<string, string[]>;
  bodies: Record<string, string[]>;
} {
  const names: Record<string, string[]> = {};
  const bodies: Record<string, string[]> = {};
  for (const [lane, web, native] of PAIRED_TREES) {
    const left = scanTree(web);
    const right = scanTree(native);
    names[lane] = nameCollisions(left, right);
    bodies[lane] = bodyCollisions(left, right);
  }
  return { names, bodies };
}

// Every lane key stays present when empty, so a lane that stops being scanned
// fails loudly instead of passing by absence.

/** Same exported identifier in both seats. Shrinks only. */
const NAME_COLLISIONS = {
  agenda: ["DayRibbon", "ribbonLabel", "shelfLabel"],
  docs: [],
  locker: [],
  notes: [],
  people: [
    "Caption",
    "Commits",
    "CountTiles",
    "PersonAvatar",
    "StarButton",
    "Verb",
    "applyRosterFilter",
    "rosterSub",
  ],
  photos: [
    "DEFAULT_RUNG",
    "EDITOR_RATIOS",
    "NO_LOCATION_KEY",
    "RAIL_WIDTH",
    "RUNGS",
    "RUNG_LABELS",
    "centredCrop",
    "emptyTrashOrder",
    "emptyTrashSummary",
    "isZoomed",
    "justify",
    "placePoints",
    "ratioValue",
    "rungHeight",
    "videoKindLabel",
    "zoomIn",
    "zoomOut",
    "zoomReadout",
  ],
  tally: ["FieldRow", "Hero", "LedgerRow", "Section", "undoIsLive"],
  tasks: [],
  kit: [
    "PROFILE_COLORS",
    "answerCommonsInvitation",
    "claimCommonsInvitation",
    "cloneAutomationTemplate",
    "formatBytes",
    "formatUptime",
    "gatewayAuth",
    "getNotifications",
    "isPinned",
    "json",
    "listAutomationTurns",
    "listAutomations",
    "listCommonsInvitations",
    "listCommonsRecovery",
    "listConnections",
    "listVaults",
    "recoverCommons",
    "relativeTime",
    "setAutomationEnabled",
    "setConnectionStatus",
    "streamAssistantTurn",
    "updateVault",
    "useAppearance",
  ],
  // Empty: screen names are seat-specific.
  screens: [],
} as const;

/** Identical bodies in both seats, name notwithstanding. Shrinks only. */
const BODY_COLLISIONS = {
  agenda: [],
  docs: [],
  locker: [],
  notes: [],
  people: [],
  photos: [
    "RUNGS ↔ RUNGS",
    "assetRatio ↔ aspectRatio",
    "ratioValue ↔ ratioValue",
  ],
  tally: ["undoIsLive ↔ undoIsLive"],
  tasks: [],
  kit: ["gatewayAuth ↔ gatewayAuth"],
  screens: [],
} as const;

describe("[law:one-computation] paired seats compute a rule once", () => {
  const scanned = scanAllLanes();

  it("adds no seat-local runtime export NAME collision", () => {
    expect(scanned.names).toStrictEqual({
      ...NAME_COLLISIONS,
    });
  });

  it("adds no seat-local duplicate BODY, renamed or not", () => {
    expect(scanned.bodies).toStrictEqual({
      ...BODY_COLLISIONS,
    });
  });

  it("every paired lane is really scanned — no lane passes by being empty", () => {
    // A typo'd root scans nothing and reports zero collisions.
    for (const [lane, web, native] of PAIRED_TREES) {
      for (const roots of [web, native]) {
        const scan = scanTree(roots);
        expect(
          scan.names.size,
          `${lane}: ${roots.join(", ")} exported nothing — the root drifted`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("SABOTAGE: the name lane rejects a second face-crop owner", () => {
    const owner = (name: string): TreeScan => ({
      names: new Map([[name, ["seat.ts"]]]),
      bodies: new Map(),
    });
    expect(
      nameCollisions(owner("faceCropStyle"), owner("faceCropStyle"))
    ).toStrictEqual(["faceCropStyle"]);
    expect(
      nameCollisions(owner("faceCropStyle"), owner("otherThing"))
    ).toStrictEqual([]);
  });

  it("SABOTAGE: the body lane rejects a copy that was merely renamed", () => {
    const web = scanFixture(
      `export function assetRatio(a: A): number {
         const w = Number(a.width);
         const h = Number(a.height);
         return w > 0 && h > 0 ? w / h : 1;
       }`
    );
    const native = scanFixture(
      `export function aspectRatio(a: PhotoAsset): number {
         // the packer needs a ratio for every asset
         const w = Number(a.width); const h = Number(a.height);
         return w > 0 && h > 0
           ? w / h
           : 1;
       }`
    );
    expect(bodyCollisions(web, native)).toStrictEqual([
      "assetRatio ↔ aspectRatio",
    ]);
  });

  it("SABOTAGE: the body lane does not fire on two genuinely different rules", () => {
    expect(
      bodyCollisions(
        scanFixture(
          `export function rungHeight(rung: number): number {
             return Math.round(BASE * RUNG_SCALE[rung] + GUTTER);
           }`
        ),
        scanFixture(
          `export function rungHeight(rung: number): number {
             return Math.floor(BASE / RUNG_SCALE[rung]) - GUTTER;
           }`
        )
      )
    ).toStrictEqual([]);
  });

  it("web and mobile import shared crop and people-count implementations", () => {
    const web = path.join(ROOT, "packages/blueprints/apps/photos");
    const mobile = path.join(ROOT, "apps/mobile/src/apps/photos");
    expect(
      readFileSync(path.join(web, "components/FaceReview.tsx"), "utf8")
    ).toContain("_shared/face-crop");
    expect(readFileSync(path.join(mobile, "FaceReview.tsx"), "utf8")).toContain(
      "_shared/face-crop"
    );
    expect(readFileSync(path.join(web, "queries/people.ts"), "utf8")).toContain(
      "_shared/people-counts"
    );
    expect(
      readFileSync(path.join(mobile, "people-model.ts"), "utf8")
    ).toContain("_shared/people-counts");
  });
});
