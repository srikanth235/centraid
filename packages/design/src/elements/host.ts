// The shell surface this layer is allowed to reach.
//
// The element substrate runs inside a host document that owns the vault
// credential, the change feed and the native bridges; it addresses that host
// through the one object the host installs on `globalThis`. The shape below
// MIRRORS the shell's client structurally rather than importing it: the
// implementation is `packages/client`'s `centraid-inline.ts`, which sits
// DOWNSTREAM of this package, and the app-facing declaration is blueprints'
// ambient `CentraidClient` — so a shared nominal type would point the wrong
// way whichever side owned it. (`packages/blueprints/apps/inline-types.ts`
// mirrors the same boundary for the React descriptor.)
//
// Every member is optional and every call site feature-detects: a harness, a
// test page, or an older shell simply does not install the method, and the
// substrate degrades to the behaviour it had before that method existed.

/** One doorbell from the host's change feed. */
export interface CentraidChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
}

/** The staging receipt the host's blob door returns. */
export interface StagedBlob {
  sha256: string;
  mediaType?: string | null;
  byteSize?: number;
  existingContentId?: string | null;
  casAck?: string | null;
  custody?: string | null;
  alreadyPresent?: boolean;
  [key: string]: unknown;
}

/** The members of the host client this layer reads. */
export interface CentraidHost {
  onChange?: (cb: (detail: CentraidChangeDetail) => void) => () => void;
  /** An authed `blob:` URL for a `/_vault/blobs/…` path in one scope. */
  blobUrl?: (pathname: string, scope?: string) => Promise<string | null>;
  /** Stream a File into the vault's blob CAS through the host's credential. */
  stageBlob?: (
    file: File,
    extra?: string,
    options?: { hash?: boolean; scope?: string }
  ) => Promise<StagedBlob>;
  /** Submit a typed derivative contribution against a staged parent. */
  stageDerivative?: (
    parentSha: string,
    variant: string,
    body: BodyInit,
    mediaType?: string
  ) => Promise<StagedBlob>;
  /** Native haptics bridge (mobile shell only; feature-detected). */
  haptic?: Record<string, (() => void) | undefined>;
}

/**
 * The host client, or `undefined` when nothing installed one. Read through a
 * cast rather than a `declare global`: augmenting `Window` here would collide
 * with blueprints' ambient `interface Window { centraid: CentraidClient }`,
 * and this package must stay importable by surfaces that have no DOM at all.
 */
export function host(): CentraidHost | undefined {
  return (globalThis as { centraid?: CentraidHost }).centraid;
}

/**
 * Fire a native haptic if the host bridges one. Feature-detected and
 * failure-swallowing so the substrate behaves identically wherever it renders
 * — visual feedback already covers the case where there is no bridge.
 */
export function haptic(kind: string): void {
  try {
    host()?.haptic?.[kind]?.();
  } catch {
    /* bridge absent or refused */
  }
}
