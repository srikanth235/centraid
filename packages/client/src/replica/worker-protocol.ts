import type {
  ApplyChangesResult,
  OptimisticMutation,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaReadRequest,
  ReplicaReadWireResult,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaSnapshot,
  ReplicaShape,
  ReplicaStatus,
  ReplicaWorkerOpenOptions,
} from './types.js';

export type ReplicaWorkerRequest =
  | { id: number; op: 'open'; payload: ReplicaWorkerOpenOptions }
  | { id: number; op: 'status'; payload: undefined }
  | { id: number; op: 'catalog'; payload: undefined }
  | { id: number; op: 'bootstrap'; payload: ReplicaSnapshot }
  | { id: number; op: 'apply-changes'; payload: ReplicaChangeBatch }
  | {
      id: number;
      op: 'read';
      payload: { request: ReplicaReadRequest; mutations: OptimisticMutation[] };
    }
  | {
      id: number;
      op: 'search';
      payload: { request: ReplicaSearchRequest; mutations: OptimisticMutation[] };
    }
  | { id: number; op: 'wipe'; payload: undefined }
  | { id: number; op: 'close'; payload: undefined }
  | { id: number; op: 'purge'; payload: undefined };

export interface ReplicaWorkerResults {
  open: ReplicaStatus;
  status: ReplicaStatus;
  catalog: ReplicaShape[];
  bootstrap: ReplicaCursor;
  'apply-changes': ApplyChangesResult;
  read: ReplicaReadWireResult;
  search: ReplicaSearchWireResult;
  wipe: undefined;
  close: undefined;
  purge: undefined;
}

export interface SerializedReplicaError {
  name: string;
  message: string;
  code?: string;
  reason?: string;
}

export type ReplicaWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: SerializedReplicaError };
