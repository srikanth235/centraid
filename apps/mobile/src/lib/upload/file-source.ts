export interface FileSource {
  readonly size: number;
  read: (offset: number, length: number) => Promise<Uint8Array>;
  close: () => void;
}

export type FileSourceOpener = (localUri: string) => Promise<FileSource>;

export function bytesFileSource(bytes: Uint8Array): FileSource {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length);
    },
    close() {},
  };
}
