// System `git` binary (Electron ships it; the system binary is the reference),
// not a JS library. Identity is forced to the Centraid harness so the host's
// `~/.gitconfig` user.name/email never leak into app history.

import { spawn } from "node:child_process";

export const HARNESS_IDENTITY = {
  name: "Centraid Harness",
  email: "bot@centraid",
} as const;

export interface GitRunOptions {
  /** Required: we never assume `process.cwd()`. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** Don't throw on non-zero. Used by probes where "missing" is expected. */
  allowNonZero?: boolean;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly code: number,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(
      `git ${args.join(" ")} exited with code ${code}: ${stderr.trim() || stdout.trim() || "(no output)"}`
    );
    this.name = "GitError";
  }
}

export async function run(
  args: readonly string[],
  opts: GitRunOptions
): Promise<string> {
  const result = await runRaw(args, opts);
  if (result.code !== 0 && !opts.allowNonZero) {
    throw new GitError(args, result.code, result.stdout, result.stderr);
  }
  return result.stdout.replace(/\n+$/u, "");
}

export function runRaw(
  args: readonly string[],
  opts: GitRunOptions
): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Forced here, not per-commit `git -c user.*` — a new commit call site would forget it.
      GIT_AUTHOR_NAME: HARNESS_IDENTITY.name,
      GIT_AUTHOR_EMAIL: HARNESS_IDENTITY.email,
      GIT_COMMITTER_NAME: HARNESS_IDENTITY.name,
      GIT_COMMITTER_EMAIL: HARNESS_IDENTITY.email,
      // No interactive prompts (askpass, credential helpers, editor).
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      GIT_EDITOR: "true",
      ...opts.env,
    };
    const child = spawn("git", args as string[], {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(opts.stdin);
    }
  });
}

/** `git rev-parse <ref>` → sha, or `undefined` if the ref doesn't resolve. */
export async function revParse(
  cwd: string,
  ref: string
): Promise<string | undefined> {
  const result = await runRaw(["rev-parse", "--verify", "--quiet", ref], {
    cwd,
    allowNonZero: true,
  });
  if (result.code !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : undefined;
}
