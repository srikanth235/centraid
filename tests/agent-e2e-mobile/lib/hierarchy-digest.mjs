// What was actually on the screen when a chunk failed (#905).
//
// WHY THIS EXISTS RATHER THAN "read the artifact". The failures this lane
// reports most often — `Element not found` on a launcher tile — are answered by
// ONE fact: which handles the screen was carrying. Printing it costs a dozen log
// lines and answers the question where the failure is already being read, rather
// than in an artifact that is only evidence to someone who can download it.
//
// AND THERE IS NO HIERARCHY IN THE ARTIFACT ANYWAY. Under
// `--flatten-debug-output` Maestro writes only `commands-(<chunk>.yaml).json`,
// `maestro.log` and a screenshot — established by run 33465058064, whose digest
// reported exactly that directory listing. So `harness.mjs` captures the tree
// from the DEVICE (`maestro hierarchy`) on the failure path: Maestro has exited
// but the app is still foregrounded on the failing screen, which makes the live
// capture both available and more truthful than a file would have been.
//
// The concrete case: `notes-library` and `native-v0-resilience` both died on
// `Tap on "Open Notes.*"` / `"Open Photos.*"`. Home renders `DayOne` INSTEAD of
// `LauncherGrid` when `springboardState` sees every tile settled and empty, and
// `HOME_READY_MARKER` ("All apps and places") renders in BOTH — so the assertion
// before the tap passes either way and the log cannot tell the two apart. The
// digest can: `day-one` present and no `home-tile-*` is the first-run branch,
// `home-tile-*` present is something else entirely.
//
// KEEP IT PURE. No fs, no device, no Maestro — a tree in, strings out — so the
// shapes it has to survive are covered by `hierarchy-digest.test.mjs` rather
// than by a 28-minute lane.

/** Android ids arrive fully qualified; the handle is the part a flow names. */
const RESOURCE_ID = /^(?:[\w.]+:id\/)?(?<handle>.+)$/u;

/** Enough to characterise a screen, short enough that it cannot become a dump.
 *  A springboard carries ~8 tiles plus chrome; 60 covers it with room. */
const DIGEST_LIMIT = 60;

/** Text long enough to be prose is a body, not a handle — it says nothing about
 *  which branch rendered and it is the part most likely to carry member data. */
const MAX_TEXT = 48;

function attributesOf(node) {
  if (!node || typeof node !== "object") return {};
  const { attributes } = node;
  return attributes && typeof attributes === "object" ? attributes : node;
}

function handleOf(attributes) {
  const raw = attributes["resource-id"] ?? attributes.resourceId;
  if (typeof raw !== "string" || raw === "") return undefined;
  return RESOURCE_ID.exec(raw)?.groups?.handle;
}

function labelOf(attributes) {
  for (const key of ["text", "accessibilityText", "hintText"]) {
    const value = attributes[key];
    if (typeof value === "string" && value !== "" && value.length <= MAX_TEXT)
      return value;
  }
  return undefined;
}

function childrenOf(node) {
  if (Array.isArray(node)) return node;
  const { children } = node ?? {};
  return Array.isArray(children) ? children : [];
}

/**
 * Every handle and short label the tree carries, deduped, in encounter order.
 *
 * Handles come out as `id:<handle>` and labels quoted, so a reader can tell at a
 * glance which of the two a flow's selector was matching against — the
 * `Element not found: Text matching regex` failures name a LABEL, and the
 * commonest cause of one is that the handle is there under a different label.
 */
export function digestHierarchy(root, { limit = DIGEST_LIMIT } = {}) {
  const seen = new Set();
  // Explicit stack rather than recursion: a hierarchy from a scrollable screen
  // nests deep enough that this is a real stack-overflow risk, not a style one.
  const stack = [root];
  while (stack.length > 0 && seen.size < limit) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const attributes = attributesOf(node);
    const handle = handleOf(attributes);
    if (handle !== undefined) seen.add(`id:${handle}`);
    const label = labelOf(attributes);
    if (label !== undefined) seen.add(JSON.stringify(label));
    // Reversed so a popped stack yields the document order a reader expects.
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return [...seen].slice(0, limit);
}

/**
 * The digest as the lines a failing chunk prints, or `[]` when there is nothing
 * to say. Never throws: this runs on the failure path, and a diagnostic that can
 * itself fail replaces the real error with its own.
 */
export function digestLines(json, { limit = DIGEST_LIMIT } = {}) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(sliceJson(json)) : json;
  } catch {
    return [];
  }
  const entries = digestHierarchy(parsed, { limit });
  return entries.length === 0 ? [] : entries;
}

/**
 * The JSON inside whatever else a CLI printed around it.
 *
 * `maestro hierarchy` writes its own banner to stdout before the tree, so
 * parsing the raw capture fails and the digest degrades to "no hierarchy" on a
 * device that answered perfectly well. Widest span between the first opening
 * brace/bracket and the last closing one — a tree is one value, so anything
 * outside that span is banner.
 */
function sliceJson(text) {
  const start = Math.min(
    ...["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0)
  );
  const end = Math.max(...["}", "]"].map((c) => text.lastIndexOf(c)));
  return Number.isFinite(start) && end > start
    ? text.slice(start, end + 1)
    : text;
}
