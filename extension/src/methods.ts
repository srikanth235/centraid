/*
 * THE CLOSED METHOD TABLE, READ FROM THE CONTRACT (#1020 wave 4 lane
 * extension, D-1020-X2).
 *
 * `contracts/extension/methods.json` and its shipped twin `methods-table.ts` are
 * generated from v0's own two files —
 * `apps/extension/src/types.ts`'s `CompanionRequest` union and
 * `companion-api.ts`'s switch — by
 * `contracts/tools/export-extension-methods.ts`. The native host compiles the
 * same file in (`crates/centraid/src/cmd/native_host/methods.rs`) and asserts
 * its enum against it. This module is the third reader, and the reason all three
 * read one file rather than agreeing by convention is that the failure mode is
 * silent: a method one side knows and the other does not is a button that does
 * nothing.
 *
 * ## Eighteen, and the census says seventeen
 *
 * Census §E2 calls this "the 17 companion methods" and lists eighteen names.
 * `handleCompanionRequest` has eighteen `case` arms. Eighteen is the number and
 * the generator asserts it.
 *
 * ## The host is the authority on retryability, not this file
 *
 * `idempotent` is in the fixture, and the host also answers it on every frame
 * (`retryable`) and in its `pong`. A retry decision is about what may be
 * repeated, and the side that knows is the side that performed it — so
 * `host-link.ts` prefers the host's answer and falls back to this table only
 * when there is no answer to prefer (an attempt that never reached the host).
 */

import table from "./methods-table.js";

/** One method's row, as the generator writes it. */
export interface MethodRow {
  readonly name: string;
  readonly idempotent: boolean;
  readonly http: readonly string[];
  readonly reads_page: boolean;
  readonly stages_bytes: boolean;
  readonly writes: { readonly app: string; readonly action: string } | null;
  readonly fields: readonly {
    readonly name: string;
    readonly type: string;
    readonly optional: boolean;
  }[];
}

interface MethodsFixture {
  readonly version: number;
  readonly max_frame_bytes: number;
  readonly methods: readonly MethodRow[];
}

const FIXTURE = table as unknown as MethodsFixture;

/** Every method, in v0's own order. */
export const METHODS: readonly MethodRow[] = FIXTURE.methods;

/** Every method name, in v0's own order. */
export const METHOD_NAMES: readonly string[] = METHODS.map((row) => row.name);

/**
 * The browser's ceiling on a message from an extension, from the contract.
 *
 * Stated once, in the file both sides read: the extension needs it to decide
 * when to stage and the host needs it to refuse a frame it cannot read, and two
 * copies of a ceiling is how one side stages at a size the other rejects.
 */
export const MAX_FRAME_BYTES = FIXTURE.max_frame_bytes;

/** One method's row, or `undefined` for a name that is not one of the table's. */
export function methodRow(name: string): MethodRow | undefined {
  return METHODS.find((row) => row.name === name);
}

/** Whether this is one of the eighteen. */
export function isMethod(name: unknown): boolean {
  return typeof name === "string" && methodRow(name) !== undefined;
}

/**
 * Whether a failed attempt at this method may be retried on any failure.
 *
 * `false` for a method the table does not know, which is the closed direction:
 * an unknown method is a version mismatch and repeating it will not fix that.
 */
export function isIdempotent(name: string): boolean {
  return methodRow(name)?.idempotent ?? false;
}

/** Whether this method carries page content rather than an intent. */
export function readsPage(name: string): boolean {
  return methodRow(name)?.reads_page ?? false;
}

/**
 * Whether this method's payload is staged rather than inlined.
 *
 * The table's `stages_bytes` marks `capture:document`, which carries a
 * screenshot in v0. `page:capture` carries a captured document here, so the
 * decision is also made by SIZE at send time (`stage-core.ts`) — a small
 * capture rides one frame and a large one is staged, and neither side has to
 * guess which.
 */
export function stagesBytes(name: string): boolean {
  return methodRow(name)?.stages_bytes ?? false;
}
