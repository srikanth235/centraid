// Do not import the shell client (downstream). No `declare global` (blueprints).

export interface CentraidChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
}

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

export interface CentraidHost {
  onChange?: (cb: (detail: CentraidChangeDetail) => void) => () => void;
  blobUrl?: (pathname: string, scope?: string) => Promise<string | null>;
  stageBlob?: (
    file: File,
    extra?: string,
    options?: { hash?: boolean; scope?: string }
  ) => Promise<StagedBlob>;
  stageDerivative?: (
    parentSha: string,
    variant: string,
    body: BodyInit,
    mediaType?: string
  ) => Promise<StagedBlob>;
  haptic?: Record<string, (() => void) | undefined>;
}

export function host(): CentraidHost | undefined {
  return (globalThis as { centraid?: CentraidHost }).centraid;
}

export function haptic(kind: string): void {
  try {
    host()?.haptic?.[kind]?.();
  } catch {
    /* bridge absent or refused */
  }
}
