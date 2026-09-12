// Shared shapes the law generator and rules read. JSON.parse stays `unknown`
// at the call site; callers narrow through `asRecord` / `asArrival`.

export type Door = "hook" | "window" | "owner";
export type Surface = "arrival" | "documents" | "all";
export type Estate = "law" | "registry" | "territory";

export type FileRow = {
  path: string;
  status: string;
  estate?: Estate | string;
};

export type TaggedFileRow = FileRow & { estate: string };

export type CommitRow = {
  sha: string;
  subject: string;
  body: string;
  parents: string[];
  files: FileRow[];
  authorEmail?: string;
};

export type GitRange = {
  base: string;
  head: string;
  mergeBase?: string | null;
  hasBase?: boolean;
  onDefaultBranch?: boolean | null;
};

export type PendingCommit = {
  message: string;
  files: FileRow[];
};

export type RuleRow = {
  severity?: string | null;
  door?: string | null;
};

export type DoctrineDomain = {
  id: string;
  paths: string[];
  decision: string;
};

export type LawSection = {
  digestAtBase: string;
  digestAtHead: string;
  changed: string[];
  paths: string[];
  rules: Record<string, RuleRow>;
  rulesAtBase: Record<string, RuleRow>;
  domains: DoctrineDomain[];
};

export type DocketRow = {
  id?: string;
  rule?: string;
  path?: string | null;
  reason?: string;
  authority?: string;
  filedBy?: string;
  issue?: number | string;
  expires?: string;
  [key: string]: unknown;
};

export type Waiver = {
  rule?: string;
  path?: string | null;
  docket?: string | null;
  source?: string;
  token?: string;
  [key: string]: unknown;
};

export type GateRow = {
  path?: string;
  key?: string;
  direction?: string;
  verdict?: string;
  [key: string]: unknown;
};

export type TreeSource = {
  rev: string | null;
  list: (pathspec?: string[]) => string[];
  read: (files: string[]) => Map<string, Buffer | null>;
};

export type PackDeclaration = {
  id: string;
  rules: Record<string, RuleRow>;
  options?: Record<string, unknown>;
  lawPaths: string[];
  domains: DoctrineDomain[];
  file: string;
};

export type ReceiptRow = {
  path?: string;
  touched?: boolean;
  issue?: number | string | null;
  cost?: unknown;
  fileWaiver?: unknown;
  name?: string;
  stub?: boolean;
  addedInRange?: boolean;
  addedInPending?: boolean;
  headings?: string[];
  verification?: {
    hasFence?: boolean;
    hasOutcome?: boolean;
    hasUrl?: boolean;
    commandsWithoutOutcome?: unknown[];
  };
  audit?: { hasVerdict?: boolean };
  recordsRuling?: boolean;
  cites?: unknown[];
  rulings?: { id?: string; cites?: unknown[]; line?: number }[];
};

export type ReceiptsRegistry = {
  files?: ReceiptRow[];
  change?: { completed?: boolean; touchesReceipt?: boolean };
};

export type ManagedPackRow = {
  id?: string;
  directive?: string;
  actual?: string;
  recorded?: string;
};

export type DocumentRegistry = {
  issues?: unknown[];
};

/**
 * Arrival record. Parsed JSON is `unknown` at the call site, then asserted
 * here after `isRecord`. Rule bodies read a generated document whose schema
 * is pinned by fixtures rather than restated field-by-field.
 */
export type Arrival = {
  schema?: number;
  stamp?: { door?: string };
  range?: GitRange;
  commits?: CommitRow[];
  files?: FileRow[];
  pending?: PendingCommit | null;
  law?: LawSection;
  managedTree?: {
    packs?: ManagedPackRow[];
    unrecorded?: ManagedPackRow[];
    files?: { path: string; recorded?: string; actual?: string; marker?: string }[];
    kitVersion?: string;
  };
  waivers?: Waiver[];
  registries?: {
    frozen?: {
      path?: string;
      mode?: string;
      deleted?: boolean;
      baseSha?: string;
      headSha?: string;
      heading?: string;
      appendOnly?: { prefixIntact?: boolean };
      section?: { missingLines?: string[] };
    }[];
    receipts?: ReceiptsRegistry;
    changelog?: DocumentRegistry;
    decisions?: DocumentRegistry;
    docket?: { path?: string; exists?: boolean; rows?: DocketRow[]; rowsOnBase?: string[] };
  };
  gates?: GateRow[];
  ci?: Record<string, unknown>;
};

export type LawReport = {
  door: string;
  codeowners?: { paths: number; inSync: boolean };
  lawDigest?: { base?: string; head?: string };
  brief?: {
    stamped: string;
    head: string;
    at: string | null;
    changed: string[];
  } | null;
  lawChanged?: string[];
  range?: GitRange;
  rules: {
    id: string;
    door: string;
    severity: string;
    verdict: string;
    count: number;
  }[];
  messages: {
    path: string;
    line: number;
    column: number;
    ruleId: string | null;
    severity: string;
    message: string;
  }[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArrival(value: unknown): Arrival {
  if (!isRecord(value)) throw new TypeError("arrival record is not an object");
  return value as Arrival;
}
