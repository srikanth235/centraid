import { describe, expect, it, vi } from "vitest";

import { optimisticRowId, optimisticValues } from "./optimistic";

vi.mock(import("./native-hash"), () => ({
  nativeReplicaIdFactory: () => "uuid",
}));

describe("native optimistic helpers", () => {
  it("keeps canonical columns and strips replica projection metadata", () => {
    expect(
      optimisticValues(
        {
          collection_id: "album-1",
          name: "Before",
          __rowId: "album-1",
          __centraidScopeId: "vault-1",
        },
        { name: "After" }
      )
    ).toStrictEqual({ collection_id: "album-1", name: "After" });
  });

  it("mints namespaced predicted row ids", () => {
    expect(optimisticRowId("album")).toBe("album-uuid");
  });
});
