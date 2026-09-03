import { ReplicaProtocolError } from "./errors.js";
import { validateOptimisticMutation } from "./query.js";
import type {
  OptimisticMutation,
  ReplicaDependency,
  ReplicaShape,
} from "./types.js";

export type ReplicaWriteMutationInput =
  | (Omit<Extract<OptimisticMutation, { op: "upsert" }>, "shapeId"> & {
      shapeId?: string;
      purpose?: string;
    })
  | (Omit<Extract<OptimisticMutation, { op: "delete" }>, "shapeId"> & {
      shapeId?: string;
      purpose?: string;
    });

export interface PreparedReplicaWrite {
  optimistic: OptimisticMutation[];
  dependencies: ReplicaDependency[];
}

export function prepareReplicaWrite(
  appId: string,
  optimistic: readonly ReplicaWriteMutationInput[] | undefined,
  catalog: readonly ReplicaShape[],
  resolveShapeId: (
    appId: string,
    entity: string,
    requested?: string,
    purpose?: string
  ) => string,
  includeAllCatalog = false
): PreparedReplicaWrite {
  const normalized = (optimistic ?? []).map((mutation) => {
    const { purpose, shapeId, ...rest } = mutation;
    return {
      ...rest,
      shapeId: resolveShapeId(appId, mutation.entity, shapeId, purpose),
    };
  }) as OptimisticMutation[];

  for (const mutation of normalized) {
    const shape = catalog.find(
      (candidate) => candidate.shapeId === mutation.shapeId
    );
    const schema = shape?.entities.find(
      (candidate) => candidate.entity === mutation.entity
    );
    if (!schema) {
      throw new ReplicaProtocolError(
        `Optimistic mutation targets unavailable shape ${mutation.shapeId}/${mutation.entity}`
      );
    }
    validateOptimisticMutation(mutation, schema);
  }

  return {
    optimistic: normalized,
    dependencies: catalog
      .filter((shape) => includeAllCatalog || shape.appId === appId)
      .flatMap((shape) =>
        shape.entities.map((entity) => ({
          shapeId: shape.shapeId,
          entity: entity.entity,
        }))
      ),
  };
}
