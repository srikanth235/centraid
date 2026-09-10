# Trap: `packages/server` tests run `dist`, not `src`, for `@centraid/server/*` imports

## What goes wrong

`build-gateway.ts` imports `* as automation from "@centraid/server/automation"` (and other self-package specifiers), which resolves through the package `exports` to **`packages/server/dist`**. Editing `src/automation/**` and re-running a `serve()`-booting test shows no change: the test is exercising the last build. The symptom is a fix that "does nothing" — an agent lost a full debugging cycle to it under #1011.

## Rule

After editing anything under `packages/server/src` that another `packages/server` module reaches by package specifier, run `bun run --cwd packages/server build` before trusting a test that boots the gateway. The same applies to `@centraid/model-runtime` (`exports` → `dist`) and `@centraid/vault` consumed from the server.

Unit tests that import by relative path are unaffected.
