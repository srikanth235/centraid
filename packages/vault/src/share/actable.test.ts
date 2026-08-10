import { describe, expect, test } from "vitest";

import { isCommonsCommandActable } from "./actable.js";

describe("Commons command registry", () => {
  test("structurally refuses commands that delete the shared root", () => {
    expect(
      isCommonsCommandActable("core.document", "core.delete_document")
    ).toBe(false);
    expect(isCommonsCommandActable("docs.folder", "core.delete_folder")).toBe(
      false
    );
    expect(
      isCommonsCommandActable("core.collection", "core.delete_collection")
    ).toBe(false);

    // Deleting a child document does not delete a docs.folder root. It remains
    // declared so the surviving folder can recompile its smaller closure.
    expect(isCommonsCommandActable("docs.folder", "core.delete_document")).toBe(
      true
    );
  });
});
