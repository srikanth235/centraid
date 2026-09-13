// Build the screen-state fixtures: one `.textproto` source, one `.bin` beside
// it, one manifest (#1020, wave 3 lane E, D-1020-E3).
//
// ONE FIXTURE, TWO LANGUAGES. The pattern is v0's own, from the tunnel module:
// `TunnelWireConformanceTest.kt` and `TunnelWireConformanceTests.swift` read
// one golden file, "because a fixture each is two fixtures" (census §E9). Here
// the fixture is a protobuf screen state, Kotlin decodes it with Wire in
// `mobile/shared`'s `jvmTest`, and Swift decodes it with SwiftProtobuf in
// `mobile/iosApp/Tests` — the second of which no machine in this repository's
// CI can run, and which is therefore an owner hand-off named in
// `mobile/README.md` rather than a test that reads green.
//
// WHY THE `.bin` IS COMMITTED AND NOT BUILT AT TEST TIME. The `.textproto` is
// what a human edits and reviews; the `.bin` is what both languages decode. If
// the test generated it, the test would need `buf` and the schema — and the
// Swift side has neither in an Xcode scheme. So both are committed and drift is
// a gate:
//
//   bun contracts/tools/build-screen-fixtures.ts
//   bun run format
//   git diff --exit-code contracts/screens
//
// The second step is not optional: the repository formatter owns JSON, so the
// committed manifest is this script's output AFTER oxfmt.
//
// `buf convert` and not `protoc`: there is no `protoc` on the build machines
// (`crates/api-proto/build.rs` says so and parses the tree with protox for the
// same reason), and `buf` is already a gate step.

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A directory is a screen, and a screen has one state message. The map is here
 * rather than in the manifest because it is a DECISION — "this directory holds
 * states of this type" — and a generated file is a bad place for a decision.
 */
const TYPES: Record<string, string> = {
  notes: "centraid.screen.v1.NotesEditorState",
  photos: "centraid.screen.v1.PhotosGridState",
  seat: "centraid.screen.v1.SeatState",
  tally: "centraid.screen.v1.TallyListState",
};

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const screensDirectory = path.join(repositoryRoot, "contracts/screens");

interface Fixture {
  readonly case: string;
  readonly screen: string;
  readonly type: string;
  readonly textproto: string;
  readonly binary: string;
}

const fixtures: Fixture[] = [];

for (const screen of Object.keys(TYPES).sort()) {
  const directory = path.join(screensDirectory, screen);
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith(".textproto"))
    .sort();
  if (sources.length === 0) {
    throw new Error(
      `contracts/screens/${screen} has no .textproto fixtures. A screen with no ` +
        `fixture is a screen whose contract nothing checks.`
    );
  }
  for (const source of sources) {
    const caseName = source.replace(/\.textproto$/u, "");
    const textproto = path.join(directory, source);
    const binary = path.join(directory, `${caseName}.bin`);
    execFileSync(
      "buf",
      [
        "convert",
        `--type=${TYPES[screen]}`,
        `--from=${textproto}#format=txtpb`,
        `--to=${binary}#format=binpb`,
      ],
      { cwd: repositoryRoot, stdio: "inherit" }
    );
    fixtures.push({
      case: caseName,
      screen,
      type: TYPES[screen],
      textproto: path.relative(repositoryRoot, textproto),
      binary: path.relative(repositoryRoot, binary),
    });
  }
}

const manifest = {
  $generatedBy: "contracts/tools/build-screen-fixtures.ts",
  $note:
    "Screen-state fixtures: one .textproto source, one .bin beside it. Decoded " +
    "by mobile/shared's jvmTest (Wire) and by mobile/iosApp/Tests (SwiftProtobuf). " +
    "Regenerate with `bun contracts/tools/build-screen-fixtures.ts && bun run format`; " +
    "`git diff --exit-code contracts/screens` is the drift check (#1020).",
  fixtures,
};

writeFileSync(
  path.join(screensDirectory, "manifest.json"),
  `${JSON.stringify(manifest, undefined, 2)}\n`
);

console.error(
  `wrote ${fixtures.length} fixtures and contracts/screens/manifest.json`
);
