// Every `invalid` case is a red the shell directive demonstrated: a drifted
// digest, a missing folder, an unrecorded folder, a drifted managed file, and
// a stamp that disagrees with the pinned kit version.
import rule from "./managed-tree-integrity.mjs";
import { ruleTester } from "../lib/rule.mjs";

/**
 * A minimal arrival record carrying one managed tree.
 *
 * @param {object} tree The `managedTree` section.
 * @returns {string} The record, as the JSON a rule lints.
 */
const withTree = (tree) =>
  JSON.stringify(
    {
      schema: 2,
      commits: [],
      pending: null,
      waivers: [],
      registries: {},
      managedTree: { packs: [], unrecorded: [], files: [], kitVersion: "0.15.0", ...tree },
    },
    null,
    2
  );

const pack = { id: "governance-kit/audit", directive: "doc-integrity", recorded: "aaa", actual: "aaa" };
const file = { path: ".governance/run.sh", recorded: "bbb", actual: "bbb", marker: "0.15.0" };

ruleTester().run("managed-tree-integrity", rule, {
  valid: [
    withTree({ packs: [pack], files: [file] }),
    // An unmarked managed file (the law's own generator) has no stamp to check.
    withTree({ files: [{ path: ".governance/law/arrival.mjs", recorded: "b", actual: "b", marker: "" }] }),
    // A waived unit is not reported.
    {
      code: withTree({ packs: [{ ...pack, actual: "zzz" }] }),
      options: [{ waivedUnits: ["governance-kit/audit/doc-integrity"] }],
    },
  ],
  invalid: [
    {
      code: withTree({ packs: [{ ...pack, actual: "zzz" }] }),
      errors: [{ message: /content drifted from the digest recorded at apply time/u }],
    },
    {
      code: withTree({ packs: [{ ...pack, actual: "" }] }),
      errors: [{ message: /managed directive folder is missing/u }],
    },
    {
      code: withTree({ unrecorded: [{ id: "governance-kit/audit", directive: "smuggled" }] }),
      errors: [{ message: /governance-kit\/audit\/smuggled: directive folder is not recorded/u }],
    },
    {
      code: withTree({ files: [{ ...file, actual: "zzz" }] }),
      errors: [{ message: /drifted from the digest recorded at apply time/u }],
    },
    {
      code: withTree({ files: [{ ...file, actual: "" }] }),
      errors: [{ message: /managed file is missing/u }],
    },
    {
      code: withTree({ files: [{ ...file, marker: "0.14.0" }] }),
      errors: [{ message: /stamped kit-version=0\.14\.0 but install\.yaml pins kit_version=0\.15\.0/u }],
    },
  ],
});
