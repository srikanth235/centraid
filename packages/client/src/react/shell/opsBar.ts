// The app bar's STATIC half for the six operational routes (issue #765).
//
// The bar renders in the frame ABOVE the outlet. A screen that set its own
// title from an effect would paint one frame carrying the previous route's
// title — the flicker the "chrome is persistent" invariant exists to prevent —
// so identity is split in two: what a page always SAYS lives here as data
// (title + the two verbs + the page's tone), and what it says about the data it
// just read lives in `routeVitals.ts`, published by the route's loader.
//
// The split has a second consequence worth stating: the title is never wrong,
// not even for a frame, because it never waits on a query.
//
// Verb grammar, and the reason there are exactly two:
//   - `commit`    — the ONE filled control on the view. A page that only reads
//                   has none at all: Analytics and Data are read surfaces, and
//                   an "Export" is not a commit, so neither declares one.
//   - `secondary` — the quiet outlined verb beside it.
// Handlers are not here. A verb's identity is stable; what it DOES needs the
// nav surface and, for four of the six, state the route itself owns — so
// `App.tsx` resolves the handler (see `routeVitals.publishRouteVerbs`).

/** The six operational routes, by their shell page id. The v9 brief calls
 *  these `notifs`/`autos`/`conn`/`stats`/`data`/`devices`; the shell's ids are
 *  persisted pin-set keys and stay as they are. */
export type OpsPage =
  | "approvals"
  | "automations"
  | "connectors"
  | "insights"
  | "atlas"
  | "household";

/**
 * The page's tone. It colours the ONE inline status-line action and nothing
 * else — never a fill, never a surface (`--net` means "leaves the device" and
 * is a border or a rule; `--seam` is the pending/expiring/invited role).
 * `ok` is the absence of a tone: a page with nothing to warn about.
 */
export type OpsTone = "net" | "ok" | "seam";

export interface OpsVerb {
  label: string;
}

export interface OpsBarDef {
  page: OpsPage;
  title: string;
  /** The filled commit (`a1`). Absent on the two read surfaces. */
  commit?: OpsVerb;
  /** The quiet outlined verb (`a2`). Every page has one. */
  secondary?: OpsVerb;
  tone: OpsTone;
}

const DEFS: Record<OpsPage, OpsBarDef> = {
  approvals: {
    commit: { label: "Review all" },
    page: "approvals",
    secondary: { label: "History" },
    title: "Notifications",
    tone: "net",
  },
  atlas: {
    // No commit: Data is a read surface. "Export a kind" copies out, which is
    // not a write to the vault.
    page: "atlas",
    secondary: { label: "Export a kind" },
    title: "Data",
    tone: "ok",
  },
  automations: {
    commit: { label: "New automation" },
    page: "automations",
    secondary: { label: "Templates" },
    title: "Automations",
    tone: "net",
  },
  connectors: {
    commit: { label: "Add a connection" },
    page: "connectors",
    secondary: { label: "Catalog" },
    title: "Connectors",
    tone: "net",
  },
  household: {
    commit: { label: "Pair a device" },
    page: "household",
    // The one page whose tone is `seam` — pending pairings and unaccepted
    // recovery invitations are neither an alarm nor nothing.
    secondary: { label: "Recovery" },
    title: "Devices",
    tone: "seam",
  },
  insights: {
    // No commit, as above: Analytics counts what already happened.
    page: "insights",
    secondary: { label: "Export CSV" },
    title: "Analytics",
    tone: "ok",
  },
};

/** Every operational route, in launcher order. */
export const OPS_PAGES: readonly OpsPage[] = [
  "approvals",
  "automations",
  "connectors",
  "insights",
  "atlas",
  "household",
];

/** Is this page one of the six? Narrows, so callers index `opsBarDef` safely.
 *  Takes a bare string because the caller usually has a route KIND, and the six
 *  route kinds are spelled exactly like their page ids. */
export function isOpsPage(page: string | undefined): page is OpsPage {
  return page !== undefined && Object.hasOwn(DEFS, page);
}

/** What the page always says, regardless of what it has read. */
export function opsBarDef(page: OpsPage): OpsBarDef {
  return DEFS[page];
}

/**
 * The five states a route's data can be in. Declared here rather than in
 * `routeVitals.ts` because verb visibility is a property of the DEFINITION —
 * the bar has to know what to withdraw before any data arrives.
 */
export type OpsState = "ready" | "full" | "empty" | "loading" | "error";

/**
 * Which verbs the bar shows in a given state.
 *
 * - loading withdraws BOTH: a bar offering "New automation" over a skeleton is
 *   offering to act on something it has not read yet.
 * - error withdraws only the commit. The quiet verb survives, because History /
 *   Templates / Catalog / Export / Recovery all still work when the page's own
 *   query failed — that is the whole "what failed, what is still safe" shape.
 * - `undefined` (nothing published yet — the first frame) shows both, so the
 *   bar does not flicker its verbs in and out on every navigation.
 */
export function opsBarVerbs(
  page: OpsPage,
  state?: OpsState
): { commit?: OpsVerb; secondary?: OpsVerb } {
  const def = DEFS[page];
  const commit =
    state === "loading" || state === "error" ? undefined : def.commit;
  const secondary = state === "loading" ? undefined : def.secondary;
  return {
    ...(commit ? { commit } : {}),
    ...(secondary ? { secondary } : {}),
  };
}
