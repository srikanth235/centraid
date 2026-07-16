// Bounded random-access reads over a local file (#419 M0.4).
//
// Injected rather than imported so the queue and sealer stay testable under
// vitest: `expo-file-system` is a native module. The expo-backed implementation
// lives in `expo-file-source.ts`, which only app boot imports.

export interface FileSource {
  readonly size: number;
  /** Read exactly `length` plaintext bytes at absolute `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}

export type FileSourceOpener = (localUri: string) => Promise<FileSource>;

/** In-memory source; the test double, and the shape the expo one satisfies. */
export function bytesFileSource(bytes: Uint8Array): FileSource {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length);
    },
    close() {
      // Nothing to release.
    },
  };
}
