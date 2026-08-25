// The app bar's STATIC half for the six operational routes (#765). What a page
// always says lives here; what it says about data it just read lives in
// `routeVitals.ts`. Keep the split: a title set from an effect paints one frame
// of the previous route's title. `commit` is the ONE filled control (read
// surfaces declare none), `secondary` the quiet verb; handlers stay out —
// `App.tsx` resolves them via `publishRouteVerbs`.

/** These ids are persisted pin-set keys: do not rename them. */
export type OpsPage =
  | "approvals"
  | "automations"
  | "connectors"
  | "insights"
  | "atlas"
  | "household";

/** Colours the ONE inline status-line action and nothing else — never a fill,
 *  never a surface. `ok` is the absence of a tone. */
export type OpsTone = "net" | "ok" | "seam";

export interface OpsVerb {
  label: string;
}

export interface OpsBarDef {
  page: OpsPage;
  title: string;
  /** Absent on the two read surfaces. */
  commit?: OpsVerb;
  secondary?: OpsVerb;
  tone: OpsTone;
}

/** Vault — ONE surface, two persisted keys sharing this ONE object; two entries
 *  that happen to agree is two chances to disagree. The verbs are the
 *  SURFACE's: "Export a kind" loses its subject up here, so it stays out. */
const VAULT: Omit<OpsBarDef, "page"> = {
  commit: { label: "Pair a device" },
  secondary: { label: "Recovery" },
  title: "Vault",
  tone: "seam",
};

const DEFS: Record<OpsPage, OpsBarDef> = {
  approvals: {
    commit: { label: "Review all" },
    page: "approvals",
    secondary: { label: "History" },
    title: "Notifications",
    tone: "net",
  },
  atlas: { ...VAULT, page: "atlas" },
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
  // Exists only because pin sets are persisted (`destinations.ts`).
  household: { ...VAULT, page: "household" },
  insights: {
    page: "insights",
    secondary: { label: "Export CSV" },
    title: "Activity",
    tone: "ok",
  },
};

export const OPS_PAGES: readonly OpsPage[] = [
  "approvals",
  "automations",
  "connectors",
  "insights",
  "atlas",
  "household",
];

/** Bare string: the six route kinds are spelled like their page ids. */
export function isOpsPage(page: string | undefined): page is OpsPage {
  return page !== undefined && Object.hasOwn(DEFS, page);
}

export function opsBarDef(page: OpsPage): OpsBarDef {
  return DEFS[page];
}

/** Declared here, not in `routeVitals.ts`: verb visibility is a property of the
 *  DEFINITION — the bar withdraws verbs before any data arrives. */
export type OpsState = "ready" | "full" | "empty" | "loading" | "error";

/**
 * `loading` withdraws BOTH — a bar offering to act on unread data. `error`
 * withdraws only the commit; the quiet verbs still work when the page's query
 * failed. `undefined` (first frame) shows both, so the bar does not flicker.
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
