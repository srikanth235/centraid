import { createRequire } from "node:module";

export interface EndpointId {
  equals: (other: EndpointId) => boolean;
  toBytes: () => Array<number>;
  fmtShort: () => string;
  toString: () => string;
}

export interface SecretKey {
  toBytes: () => Array<number>;
  public: () => EndpointId;
}

export interface EndpointAddr {
  id: () => EndpointId;
  directAddresses: () => Array<string>;
  relayUrl: () => string | null;
  toString: () => string;
}

export interface EndpointTicket {
  endpointAddr: () => EndpointAddr;
  toString: () => string;
}

export interface SendStream {
  write: (buf: Array<number>) => Promise<number>;
  writeAll: (buf: Array<number>) => Promise<void>;
  finish: () => Promise<void>;
  reset: (errorCode: bigint) => Promise<void>;
}

export interface RecvStream {
  read: (sizeLimit: number) => Promise<Array<number>>;
  readExact: (size: number) => Promise<Array<number>>;
  stop: (errorCode: bigint) => Promise<void>;
}

export interface BiStream {
  readonly send: SendStream;
  readonly recv: RecvStream;
}

export interface PathSnapshot {
  id: string;
  isSelected: boolean;
  remoteAddr: string;
  isIp: boolean;
  isRelay: boolean;
  rttMs: number;
}

export interface Connection {
  alpn: () => Array<number>;
  remoteId: () => EndpointId;
  openBi: () => Promise<BiStream>;
  acceptBi: () => Promise<BiStream>;
  closed: () => Promise<string>;
  close: (errorCode: bigint, reason: Array<number>) => void;
  stableId: () => number;
  rtt: () => number | null;
  paths: () => Array<PathSnapshot>;
}

export interface Accepting {
  connect: () => Promise<Connection>;
  alpn: () => Promise<Array<number>>;
}

export interface Incoming {
  accept: () => Promise<Accepting>;
  refuse: () => Promise<void>;
}

export interface RelayMode {
  toString: () => string;
}

export interface EndpointBuilder {
  applyN0: () => void;
  applyMinimal: () => void;
  secretKey: (bytes: Array<number>) => void;
  alpns: (alpns: Array<Array<number>>) => void;
  relayMode: (mode: RelayMode) => void;
  bind: () => Promise<Endpoint>;
}

export interface Endpoint {
  id: () => EndpointId;
  addr: () => EndpointAddr;
  secretKey: () => SecretKey;
  boundSockets: () => Array<string>;
  online: () => Promise<void>;
  connect: (addr: EndpointAddr, alpn: Array<number>) => Promise<Connection>;
  acceptNext: () => Promise<Incoming | null>;
  close: () => Promise<void>;
  isClosed: () => boolean;
}

export interface IrohApi {
  Endpoint: {
    builder: () => EndpointBuilder;
  };
  EndpointId: {
    fromString: (s: string) => EndpointId;
    fromBytes: (bytes: Array<number>) => EndpointId;
  };
  EndpointAddr: new (
    id: EndpointId,
    relayUrl?: string | null,
    addresses?: Array<string> | null
  ) => EndpointAddr;
  SecretKey: {
    generate: () => SecretKey;
    fromBytes: (bytes: Array<number>) => SecretKey;
  };
  EndpointTicket: {
    fromAddr: (addr: EndpointAddr) => EndpointTicket;
    fromString: (s: string) => EndpointTicket;
  };
  RelayMode: {
    disabled: () => RelayMode;
    defaultMode: () => RelayMode;
  };
}

const require = createRequire(import.meta.url);

export const iroh = require("@number0/iroh/index.js") as IrohApi;
