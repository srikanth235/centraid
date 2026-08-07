// The external embedder (issue #721 E2/E3): the one place a photograph or a
// search phrase becomes a vector.
//
// SHAPE, AND WHY IT IS THIS ONE. Exactly the `capture/tesseract-ocr.ts`
// precedent, for the same reasons: a bounded, SHELL-FREE child process, OPT-IN
// through an env var, with a hard timeout and an output cap — and, when it is
// not configured, an honest "unavailable" instead of a third-party upload. The
// gateway ships no model weights and contacts no cloud service; a self-hoster
// who wants semantic search points `CENTRAID_EMBEDDER_PATH` at a program they
// chose, and one who does not gets a search surface that says so.
//
// THE CONTRACT WITH THAT PROGRAM, in full:
//
//   argv[1]  "embed-image" | "embed-text"
//   stdin    the raw derivative bytes (image) or UTF-8 text (text)
//   stdout   JSON: a bare array of numbers, or {"vector": [numbers]}
//   exit 0   success; any other exit is a failure with stderr as the reason
//
// Both modes MUST return the same dimension and the same vector space — a
// text query is compared against image vectors by cosine, so an embedder whose
// two modes disagree produces confident nonsense. That is the operator's
// contract to keep; nothing here can check it, and this comment is the
// warning.
//
// MODEL IDENTITY. `CENTRAID_EMBEDDER_MODEL` names the model as
// `"<name>@<version>"` (see `@centraid/vault`'s `enrich/model-id.ts`).
// Operators SHOULD set it to the real model, because that string is what makes
// a later upgrade a backfill: bump the version, and every row of the old
// version is found by a query rather than by remembering which vaults ran
// what. The default below exists only so an unconfigured-but-present embedder
// still writes a well-formed, parseable key.

import { spawn } from "node:child_process";

import { makeModelId, parseModelId } from "@centraid/vault";

/** Mirrors `enrich.upsert_embedding`'s ceiling — ~16 KiB of float32 per row. */
const MAX_EMBEDDING_DIM = 4096;
/** 4096 doubles of JSON is ~90 KB; 1 MiB is slack, not a budget. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Long enough for a cold model load on a Pi, short enough to never wedge a sweep. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Text queries ride a request; they get a fraction of the batch budget. */
const TEXT_TIMEOUT_MS = 15_000;

/**
 * The fallback model id. Deliberately not a real model name: it says "some
 * external embedder, generation 1" and nothing it cannot back up.
 */
export const DEFAULT_EMBEDDER_MODEL = makeModelId("external-embedder", 1);

export type EmbedMode = "embed-image" | "embed-text";

export interface Embedder {
  /** The `enrich_embedding.model` key every row this embedder writes carries. */
  readonly model: string;
  /** Embed one image's DERIVATIVE bytes (never an original — see the indexer). */
  embedImage: (bytes: Buffer) => Promise<number[]>;
  /** Embed a search phrase into the same space. */
  embedText: (text: string) => Promise<number[]>;
}

/** Why no embedder is configured, in a sentence a surface can show a member. */
export const EMBEDDER_UNCONFIGURED_REASON =
  "no embedder is configured on this gateway — set CENTRAID_EMBEDDER_PATH to enable semantic photo search";

/**
 * Resolve the host's embedder, or `null` when none is configured. `null` is the
 * ordinary state, not an error: the indexer stays idle and the search route
 * answers `unavailable`.
 */
export function resolveEmbedder(
  env: NodeJS.ProcessEnv = process.env
): Embedder | null {
  const executable = env.CENTRAID_EMBEDDER_PATH?.trim();
  if (!executable) return null;
  const declared = env.CENTRAID_EMBEDDER_MODEL?.trim();
  // A model id that does not parse is REPLACED, not accepted: a row keyed
  // "my model v2 (final)" can never be found by an upgrade query, and the
  // whole point of E1 is that a version bump is a query.
  const model =
    declared && parseModelId(declared) ? declared : DEFAULT_EMBEDDER_MODEL;
  return {
    model,
    embedImage: (bytes) =>
      runEmbedder(executable, "embed-image", bytes, DEFAULT_TIMEOUT_MS),
    embedText: (text) =>
      runEmbedder(
        executable,
        "embed-text",
        Buffer.from(text, "utf8"),
        TEXT_TIMEOUT_MS
      ),
  };
}

/**
 * Parse the embedder's stdout into a validated vector. Exported for its own
 * test: this is the boundary where a foreign program's output becomes data the
 * vault will store, so every rejection it makes is a behaviour worth pinning.
 */
export function parseEmbedderOutput(raw: string): number[] {
  const parsed: unknown = JSON.parse(raw);
  const values =
    Array.isArray(parsed) ||
    parsed === null ||
    typeof parsed !== "object" ||
    !("vector" in parsed)
      ? parsed
      : (parsed as { vector: unknown }).vector;
  if (!Array.isArray(values))
    throw new Error("embedder output is not a JSON array of numbers");
  if (values.length === 0 || values.length > MAX_EMBEDDING_DIM)
    throw new Error(
      `embedder returned ${values.length} dimensions; the ledger accepts 1..${MAX_EMBEDDING_DIM}`
    );
  const vector = values.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("embedder output contains a non-finite value");
    return value;
  });
  return vector;
}

function runEmbedder(
  executable: string,
  mode: EmbedMode,
  input: Buffer,
  timeoutMs: number
): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    // No shell: the executable comes from the operator's env, the payload
    // never touches argv, and `mode` is one of two literals from this module.
    const child = spawn(executable, [mode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`embedder timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail(new Error("embedder output exceeded the 1 MB limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 4_096)
        stderr.push(chunk);
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(`embedder exited ${code}${detail ? `: ${detail}` : ""}`)
        );
        return;
      }
      try {
        resolve(parseEmbedderOutput(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        // Translation at the process boundary: a JSON syntax error from an
        // operator-supplied program becomes a sentence naming the program.
        reject(
          new Error(
            `embedder produced unusable output: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
    child.stdin.on("error", (error) => {
      fail(error);
    });
    child.stdin.end(input);
  });
}
