// Types for the shared consent / parked-write flow (issue #420).

export interface FetchJsonResult {
  ok: boolean;
  status: number;
  body: any;
}
export type FetchJson = (url: string, opts?: object) => Promise<FetchJsonResult>;

export interface ParkedEntry {
  invocationId?: string;
  command?: string;
  caller?: string;
  input?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface InvokeOutcome {
  status?: string;
  receiptId?: string;
  reason?: string;
  invocationId?: string;
  [k: string]: unknown;
}

export function outcomeOf(x: unknown): InvokeOutcome | null;
export function shortVal(v: unknown): string;
export function describeParked(entry: ParkedEntry): { title: string; detail: string };
export function fetchParkedEntry(
  invocationId: string,
  deps: { fetchJson: FetchJson },
): Promise<ParkedEntry | null>;
export function confirmParked(
  invocationId: string,
  approve: boolean,
  deps: { fetchJson: FetchJson },
): Promise<InvokeOutcome>;
export function normalizeApproveOutcome(
  outcome: InvokeOutcome | null,
): { ok: true; receipt: string } | { ok: false; note: string };
