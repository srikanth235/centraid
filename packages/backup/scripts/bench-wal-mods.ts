export interface WalFormatMod {
  lastCommitBoundary: (
    buf: Uint8Array,
    offset: number,
    pageSize: number
  ) => number;
  walPageSize: (header: Uint8Array) => number;
  sealWalSegment: (
    dataKey: Uint8Array,
    vaultId: string,
    addr: unknown,
    plain: Uint8Array
  ) => Uint8Array;
  sealWalCloser: (
    dataKey: Uint8Array,
    vaultId: string,
    closer: unknown
  ) => Uint8Array;
  newWalGeneration: (bytes: (n: number) => Uint8Array) => string;
}

export interface WalRestoreMod {
  replayWalSegments: (input: {
    store: unknown;
    dataKey: Uint8Array;
    vaultId: string;
    destDir: string;
    generationByDb: { vault: string };
  }) => Promise<{
    perDb: {
      vault: {
        segmentsApplied: number;
        groupsApplied: number;
        integrityCheck: unknown;
      };
    };
  }>;
}

export interface ObjectStoreMod {
  FsObjectStore: new (dir: string) => {
    put: (key: string, value: Uint8Array) => Promise<void>;
    get: (key: string) => Promise<Uint8Array | undefined>;
    delete: (key: string) => Promise<void>;
  };
}

export interface PartsMod {
  PART_BYTES: number;
  partStream: (
    source: AsyncIterable<Uint8Array>,
    partBytes: number
  ) => AsyncIterable<Uint8Array>;
}

export interface CryptoMod {
  chunkId: (dedupKey: Uint8Array, plain: Uint8Array) => string;
  deriveNonce: (dataKey: Uint8Array, info: string) => Uint8Array;
  encryptWithNonce: (
    dataKey: Uint8Array,
    nonce: Uint8Array,
    plain: Uint8Array
  ) => Uint8Array;
  decrypt: (dataKey: Uint8Array, sealed: Uint8Array) => Uint8Array;
}

export type VaultShipperMod = {
  cloneDbFile: (source: string, dest: string) => void;
};
