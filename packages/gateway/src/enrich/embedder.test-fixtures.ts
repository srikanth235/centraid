// A stub embedder COMMAND for tests (issue #721 E2/E3).
//
// The embedder is a process contract, not an interface — argv mode, stdin
// payload, JSON on stdout, exit code as the verdict — so the tests that matter
// exercise a real child process rather than a mocked object. Writing the
// program is fiddly enough (shebang, chmod, deterministic vectors) that three
// suites would otherwise each carry their own copy, so it lives here beside
// the module it stands in for.
//
// The stub's vectors are DETERMINISTIC and derived from the payload, so a test
// can predict exactly which photograph a query should rank first without
// pinning float literals: see `stubVectorFor`.

import { promises as fs } from "node:fs";
import path from "node:path";

/** Dimension of every vector the stub produces — small, so fixtures are readable. */
export const STUB_DIM = 4;

/**
 * The vector the stub returns for a payload: the first `STUB_DIM` bytes,
 * scaled into [0,1]. A caller that controls the derivative bytes therefore
 * controls the vector exactly, and cosine ranking over such vectors is
 * predictable by hand.
 */
export function stubVectorFor(payload: Buffer | string): number[] {
  const bytes = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload, "utf8");
  return Array.from({ length: STUB_DIM }, (_, i) => (bytes[i] ?? 0) / 255);
}

const PROGRAM = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const payload = Buffer.concat(chunks);
  if (process.env.CENTRAID_STUB_EMBEDDER_FAIL === "1") {
    process.stderr.write("stub embedder refuses this input");
    process.exit(3);
  }
  const dim = ${STUB_DIM};
  const vector = [];
  for (let i = 0; i < dim; i += 1) vector.push((payload[i] ?? 0) / 255);
  process.stdout.write(JSON.stringify({ vector }));
});
`;

/** Write the stub program into `dir` and return its path, ready to spawn. */
export async function writeStubEmbedder(
  dir: string,
  name = "stub-embedder"
): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, PROGRAM, "utf8");
  await fs.chmod(file, 0o755);
  return file;
}
