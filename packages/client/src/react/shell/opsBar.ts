export type OpsPage =
  | "approvals"
  | "automations"
  | "connectors"
  | "insights"
  | "atlas"
  | "household";

export type OpsTone = "net" | "ok" | "seam";

export interface OpsVerb {
  label: string;
}

export interface OpsBarDef {
  page: OpsPage;
  title: string;
  commit?: OpsVerb;
  secondary?: OpsVerb;
  tone: OpsTone;
}

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

export function isOpsPage(page: string | undefined): page is OpsPage {
  return page !== undefined && Object.hasOwn(DEFS, page);
}

export function opsBarDef(page: OpsPage): OpsBarDef {
  return DEFS[page];
}

export type OpsState = "ready" | "full" | "empty" | "loading" | "error";

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
