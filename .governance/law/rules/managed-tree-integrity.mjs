// The managed tree matches the digests recorded when it was applied (#1005).
//
// Ported from the vendored `governance-kit/audit` shell directive of the same
// name. Three checks, unchanged: every locked directive folder matches its
// recorded digest, no unrecorded directive folder appears in a pack that
// records digests, and every file in `install.yaml`'s `managed_digests` matches
// its recorded digest and carries a stamp consistent with the pinned kit
// version.
//
// Dropped in the port, and named rather than left implicit: the legacy
// seed-once sweep assets (`.github/workflows/governance-sweep.yml`,
// `.governance/sweep.sh`) and the generated schedule workflows
// (`.github/workflows/governance-schedule*.yml`) had a marker exemption. None
// of those files exists in this repository, and none is recorded in
// `install.yaml`, so the exemption governed nothing here. If one is ever
// generated, this rule must grow the exemption back with it.
import { defineArrivalRule } from "../lib/rule.mjs";

export default defineArrivalRule({
  id: "managed-tree-integrity",
  statute: "#managed-tree-integrity",
  door: "hook",
  description: "Managed and vendored governance files match the digests recorded at apply time.",
  enforces: "a hand edit to a managed or vendored governance file cannot be committed",
  schema: [{ type: "object", additionalProperties: true }],
  check(arrival, ctx) {
    const waived = new Set(ctx.options.waivedUnits);
    const tree = arrival.managedTree ?? { packs: [], files: [], unrecorded: [] };

    for (const [index, row] of tree.packs.entries()) {
      const unit = `${row.id}/${row.directive}`;
      if (waived.has(unit)) continue;
      const at = ["managedTree", "packs", index];
      // An empty actual digest is what a missing folder digests to.
      if (row.actual === "") {
        ctx.report(at, `${unit}: managed directive folder is missing — restore it, or record its removal`);
        continue;
      }
      if (row.actual !== row.recorded) {
        ctx.report(
          at,
          `${unit}: content drifted from the digest recorded at apply time — hand-edited or stale (do not hand-edit .governance/)`
        );
      }
    }

    for (const [index, row] of (tree.unrecorded ?? []).entries()) {
      const unit = `${row.id}/${row.directive}`;
      if (waived.has(unit)) continue;
      ctx.report(
        ["managedTree", "unrecorded", index],
        `${unit}: directive folder is not recorded in packs.lock — installed by hand; record it or remove it`
      );
    }

    for (const [index, row] of tree.files.entries()) {
      if (waived.has(row.path)) continue;
      const at = ["managedTree", "files", index];
      if (row.actual === "") {
        ctx.report(at, `${row.path}: managed file is missing — restore it`);
        continue;
      }
      if (row.actual !== row.recorded) {
        ctx.report(
          at,
          `${row.path}: drifted from the digest recorded at apply time. If you meant to change it, re-record it (\`node .governance/law/digest.mjs --record\` for the law's own generator) — otherwise restore it`
        );
        continue;
      }
      if (tree.kitVersion && row.marker && row.marker !== tree.kitVersion) {
        ctx.report(
          at,
          `${row.path}: stamped kit-version=${row.marker} but install.yaml pins kit_version=${tree.kitVersion} — half-applied update or an out-of-band version edit`
        );
      }
    }
  },
});
